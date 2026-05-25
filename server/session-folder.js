// session-folder.js — 일반 세션 폴더의 tabterm.json 메타 read/write
// 각 폴더가 자체 라벨 / 타임스탬프 영속. 워커 라벨(중앙 labels.json) 과 분리.

import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  readFile, writeFile, rename, stat, unlink, readdir,
} from 'node:fs/promises';

export const SCHEMA_VERSION = 2;
const META_FILENAME = 'tabterm.json';
const VALID_ENGINES = new Set(['claude', 'opencode']);

function clampEngine(v) {
  return VALID_ENGINES.has(v) ? v : 'claude';
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function parseSafe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

const CONTROL_RE = /[\x00-\x1f\x7f]/g;
const CONTROL_RE_TEST = /[\x00-\x1f\x7f]/;
function clampLabel(v) {
  if (typeof v !== 'string') return '';
  const t = v.trim().replace(CONTROL_RE, '');
  if (t.length > 32) return t.slice(0, 32);
  return t;
}

function clampTimestamp(v, fallback) {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export async function readMeta(cwd) {
  const metaPath = join(cwd, META_FILENAME);
  const dirStat = await stat(cwd);
  const inferredCreated = Math.floor(dirStat.birthtimeMs || dirStat.ctimeMs || Date.now());
  const inferredUsed = Math.floor(dirStat.mtimeMs || Date.now());

  let hasTabtermJson = false;
  let raw = null;
  try {
    const buf = await readFile(metaPath, 'utf8');
    hasTabtermJson = true;
    raw = parseSafe(buf);
  } catch (e) {
    if (e.code !== 'ENOENT') hasTabtermJson = true;
  }

  if (!isPlainObject(raw)) {
    return {
      hasTabtermJson,
      schemaVersion: null,
      label: '',
      engine: 'claude',
      createdAt: inferredCreated,
      lastUsedAt: inferredUsed,
    };
  }

  // schemaVersion: accept current (2) or back-compat (1); both readable.
  const schemaVersion = (raw.version === SCHEMA_VERSION || raw.version === 1) ? raw.version : null;
  return {
    hasTabtermJson: true,
    schemaVersion,
    label: clampLabel(raw.label),
    engine: clampEngine(raw.engine),
    createdAt: clampTimestamp(raw.createdAt, inferredCreated),
    lastUsedAt: clampTimestamp(raw.lastUsedAt, inferredUsed),
  };
}

export async function writeMeta(cwd, { label, engine, createdAt, lastUsedAt }) {
  const metaPath = join(cwd, META_FILENAME);
  const tmpPath = `${metaPath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const body = JSON.stringify({
    version: SCHEMA_VERSION,
    label: clampLabel(label),
    engine: clampEngine(engine),
    createdAt: clampTimestamp(createdAt, Date.now()),
    lastUsedAt: clampTimestamp(lastUsedAt, Date.now()),
  }, null, 2);
  await writeFile(tmpPath, body, 'utf8');
  try {
    await rename(tmpPath, metaPath);
  } catch (e) {
    try { await unlink(tmpPath); } catch {}
    throw e;
  }
}

// 폴더에 tabterm.json 이 없으면 작성. 있으면 no-op. label/engine 은 신규 작성 시에만 사용.
export async function ensureMeta(cwd, { label = '', engine = 'claude' } = {}) {
  const existing = await readMeta(cwd);
  if (existing.hasTabtermJson) return { created: false, meta: existing };
  const now = Date.now();
  await writeMeta(cwd, { label, engine, createdAt: now, lastUsedAt: now });
  return { created: true, meta: await readMeta(cwd) };
}

// lastUsedAt 만 갱신. 폴더에 tabterm.json 이 없으면 lazy migration.
// engine 은 기존 값 보존 (없으면 'claude' 로 lazy-fill).
export async function touchLastUsed(cwd) {
  const meta = await readMeta(cwd);
  await writeMeta(cwd, {
    label: meta.label,
    engine: meta.engine,
    createdAt: meta.createdAt,
    lastUsedAt: Date.now(),
  });
}

// 라벨만 갱신, 다른 필드 보존. 폴더에 tabterm.json 이 없으면 lazy migration.
export async function setLabel(cwd, label) {
  const meta = await readMeta(cwd);
  await writeMeta(cwd, {
    label,
    engine: meta.engine,
    createdAt: meta.createdAt,
    lastUsedAt: meta.lastUsedAt,
  });
}

export function validateSessionFolderName(name, { workerPrefix, sessionPrefix }) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: 'type' };
  }
  if (CONTROL_RE_TEST.test(name)) {
    return { ok: false, error: 'bad-path' };
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { ok: false, error: 'bad-path' };
  }
  if (name.startsWith(workerPrefix)) {
    return { ok: false, error: 'worker-protected' };
  }
  if (!name.startsWith(sessionPrefix)) {
    return { ok: false, error: 'bad-prefix' };
  }
  return { ok: true, value: name };
}

// 주어진 root 의 모든 세션 폴더 enumerate. 워커/무관 폴더 제외.
// ENOENT race 는 정상 skip; unexpected error 는 console.warn 으로 trace.
export async function listSessionFolders(root, { workerPrefix, sessionPrefix }) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(workerPrefix)) continue;
    if (!ent.name.startsWith(sessionPrefix)) continue;
    const cwd = join(root, ent.name);
    try {
      const meta = await readMeta(cwd);
      out.push({ name: ent.name, cwd, ...meta });
    } catch (e) {
      // ENOENT race (폴더 enumerate 후 삭제됨) 은 정상; 그 외는 진단을 위해 warn
      if (e?.code !== 'ENOENT') {
        console.warn('[listSessionFolders] skip', ent.name, e?.code || e?.message);
      }
    }
  }
  return out;
}
