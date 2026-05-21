// session-folder.js — 일반 세션 폴더의 tabterm.json 메타 read/write
// 각 폴더가 자체 라벨 / 타임스탬프 영속. 워커 라벨(중앙 labels.json) 과 분리.

import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  readFile, writeFile, rename, stat, unlink,
} from 'node:fs/promises';

export const SCHEMA_VERSION = 1;
const META_FILENAME = 'tabterm.json';

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function parseSafe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function clampLabel(v) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
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
      createdAt: inferredCreated,
      lastUsedAt: inferredUsed,
    };
  }

  const schemaVersion = raw.version === SCHEMA_VERSION ? SCHEMA_VERSION : null;
  return {
    hasTabtermJson: true,
    schemaVersion,
    label: clampLabel(raw.label),
    createdAt: clampTimestamp(raw.createdAt, inferredCreated),
    lastUsedAt: clampTimestamp(raw.lastUsedAt, inferredUsed),
  };
}

export async function writeMeta(cwd, { label, createdAt, lastUsedAt }) {
  const metaPath = join(cwd, META_FILENAME);
  const tmpPath = `${metaPath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const body = JSON.stringify({
    version: SCHEMA_VERSION,
    label: clampLabel(label),
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

// 폴더에 tabterm.json 이 없으면 작성. 있으면 no-op. label 은 신규 작성 시에만 사용.
export async function ensureMeta(cwd, { label = '' } = {}) {
  const existing = await readMeta(cwd);
  if (existing.hasTabtermJson) return { created: false, meta: existing };
  const now = Date.now();
  await writeMeta(cwd, { label, createdAt: now, lastUsedAt: now });
  return { created: true, meta: await readMeta(cwd) };
}

// lastUsedAt 만 갱신. 폴더에 tabterm.json 이 없으면 lazy migration.
export async function touchLastUsed(cwd) {
  const meta = await readMeta(cwd);
  await writeMeta(cwd, {
    label: meta.label,
    createdAt: meta.createdAt,
    lastUsedAt: Date.now(),
  });
}

// 라벨만 갱신, 다른 필드 보존. 폴더에 tabterm.json 이 없으면 lazy migration.
export async function setLabel(cwd, label) {
  const meta = await readMeta(cwd);
  await writeMeta(cwd, {
    label,
    createdAt: meta.createdAt,
    lastUsedAt: meta.lastUsedAt,
  });
}
