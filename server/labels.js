// labels.js — worker/session 라벨 검증 + 워커 라벨 영속 저장
// 세션 라벨은 sessions.js 의 PtySession.label in-memory mutate (이 모듈 책임 아님).

import { join } from 'node:path';
import {
  readFile, writeFile, rename, unlink, mkdir, stat,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const CONTROL_RE = /[\x00-\x1f\x7f]/;
const SCHEMA_VERSION = 1;
const MAX_LEN = 32;

export function validateLabel(input) {
  if (typeof input !== 'string') return { ok: false, error: 'type' };
  const value = input.trim();
  if (value === '') return { ok: true, value: '' };
  if (value.length > MAX_LEN) return { ok: false, error: 'too_long' };
  if (CONTROL_RE.test(value)) return { ok: false, error: 'control_char' };
  return { ok: true, value };
}

function intKey(k) {
  return /^(0|[1-9]\d*)$/.test(k);
}

function sanitizeLoaded(raw, workersCount) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  const workers = raw.workers;
  if (!workers || typeof workers !== 'object') return out;
  for (const k of Object.keys(workers)) {
    if (!intKey(k)) continue;
    const idx = Number(k);
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= workersCount) continue;
    const v = workers[k];
    const r = validateLabel(v);
    if (r.ok && r.value !== '') out[String(idx)] = r.value;
  }
  return out;
}

async function safeReadJson(p) {
  try {
    const buf = await readFile(p, 'utf8');
    return JSON.parse(buf);
  } catch {
    return null;
  }
}

function isValidSchema(raw) {
  return (
    raw &&
    typeof raw === 'object' &&
    raw.version === 1 &&
    raw.workers &&
    typeof raw.workers === 'object' &&
    !Array.isArray(raw.workers)
  );
}

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function plain(obj) {
  // Object.create(null) → plain object for JSON.stringify safety
  const out = {};
  for (const k of Object.keys(obj)) out[k] = obj[k];
  return out;
}

export async function createLabelsStore({ dataDir, workersCount, logger }) {
  const log = logger || { warn() {}, info() {}, error() {} };
  await mkdir(dataDir, { recursive: true });
  const mainPath = join(dataDir, 'labels.json');
  const bakPath = join(dataDir, 'labels.json.bak');

  let workers = Object.create(null);
  let labelsHealth = 'ok';

  async function writeMainAtomic(payload) {
    const tmp = join(
      dataDir,
      `labels.json.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`,
    );
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    // rotate current main → bak (if main exists)
    if (await pathExists(mainPath)) {
      try {
        await rename(mainPath, bakPath);
      } catch (e) {
        log.warn?.('[labels] bak rotate failed:', e?.message);
      }
    }
    try {
      await rename(tmp, mainPath);
    } catch (e) {
      try { await unlink(tmp); } catch {}
      throw e;
    }
  }

  // load priority:
  //   1) main present + parses + valid schema → use main
  //   2) main missing/corrupt OR schema invalid → try bak; restore main from bak
  //   3) both missing/corrupt → preserve corrupted main (if any), start empty
  const mainRaw = await safeReadJson(mainPath);
  const mainPresent = await pathExists(mainPath);
  const mainSchemaOk = isValidSchema(mainRaw);

  if (mainSchemaOk) {
    workers = sanitizeLoaded(mainRaw, workersCount);
  } else {
    // main is missing, unreadable, or schema-invalid → consult bak
    const bakRaw = await safeReadJson(bakPath);
    if (isValidSchema(bakRaw)) {
      workers = sanitizeLoaded(bakRaw, workersCount);
      labelsHealth = 'restored_from_bak';
      log.warn?.('[labels] main corrupt or missing — restored from .bak');
      await writeMainAtomic({ version: SCHEMA_VERSION, workers: plain(workers) });
    } else if (mainPresent) {
      // both broken; preserve the corrupted main, start empty
      const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
      const corruptedName = `labels.json.corrupted-${ts}-${randomBytes(2).toString('hex')}`;
      try {
        await rename(mainPath, join(dataDir, corruptedName));
      } catch {}
      labelsHealth = 'corrupted_reset';
      log.error?.('[labels] main + bak corrupt — started empty, preserved as', corruptedName);
    }
    // else: fresh dir — nothing to preserve, workers stays empty, labelsHealth stays 'ok'
  }

  // serialized write queue
  let writing = Promise.resolve();

  function getWorkers() {
    return plain(workers);
  }

  function getWorkerLabel(idx) {
    const v = workers[String(idx)];
    return typeof v === 'string' ? v : null;
  }

  // Returns: { label: string|null, changed: boolean }
  //   changed=false → idempotent no-op (caller skips audit/write side effects).
  async function setWorkerLabel(idx, name) {
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= workersCount) {
      throw new Error('bad_idx');
    }
    const r = validateLabel(name);
    if (!r.ok) {
      const e = new Error(r.error);
      e.code = r.error;
      throw e;
    }
    const job = writing.then(async () => {
      // Idempotency check inside the queue — protects against two concurrent
      // PUTs for the same key seeing the same "current" before either commits.
      const currentKey = String(idx);
      const current = workers[currentKey] ?? '';
      if (current === r.value) {
        return { label: r.value === '' ? null : r.value, changed: false };
      }
      const next = Object.create(null);
      for (const k of Object.keys(workers)) next[k] = workers[k];
      if (r.value === '') delete next[currentKey];
      else next[currentKey] = r.value;
      // disk first, then cache (spec §5.1: cache update only after success)
      await writeMainAtomic({ version: SCHEMA_VERSION, workers: plain(next) });
      workers = next;
      return { label: r.value === '' ? null : r.value, changed: true };
    });
    writing = job.catch(() => {}); // queue continues even if a job throws
    return job;
  }

  return {
    getWorkers,
    getWorkerLabel,
    setWorkerLabel,
    get labelsHealth() { return labelsHealth; },
  };
}
