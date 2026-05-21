import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readMeta, writeMeta, ensureMeta, touchLastUsed,
  SCHEMA_VERSION,
} from './session-folder.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'tabterm-sf-'));
}

test('readMeta: missing tabterm.json → inferred from fs.stat', async () => {
  const dir = tmp();
  try {
    const meta = await readMeta(dir);
    assert.equal(meta.hasTabtermJson, false);
    assert.equal(meta.schemaVersion, null);
    assert.equal(meta.label, '');
    assert.equal(typeof meta.createdAt, 'number');
    assert.equal(typeof meta.lastUsedAt, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readMeta: valid tabterm.json → parsed', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'tabterm.json'), JSON.stringify({
      version: 1, label: 'my work', createdAt: 1000, lastUsedAt: 2000,
    }));
    const meta = await readMeta(dir);
    assert.equal(meta.hasTabtermJson, true);
    assert.equal(meta.schemaVersion, 1);
    assert.equal(meta.label, 'my work');
    assert.equal(meta.createdAt, 1000);
    assert.equal(meta.lastUsedAt, 2000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readMeta: corrupt JSON → fallback to inferred + hasTabtermJson true', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'tabterm.json'), '{ not json');
    const meta = await readMeta(dir);
    assert.equal(meta.hasTabtermJson, true);
    assert.equal(meta.schemaVersion, null);
    assert.equal(meta.label, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readMeta: unknown schema version → read-only mode (label preserved, version null)', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'tabterm.json'), JSON.stringify({
      version: 99, label: 'future', createdAt: 1, lastUsedAt: 2,
    }));
    const meta = await readMeta(dir);
    assert.equal(meta.hasTabtermJson, true);
    assert.equal(meta.schemaVersion, null);
    assert.equal(meta.label, 'future');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeMeta: atomic write produces parseable JSON', async () => {
  const dir = tmp();
  try {
    await writeMeta(dir, { label: 'hello', createdAt: 100, lastUsedAt: 200 });
    const meta = await readMeta(dir);
    assert.equal(meta.label, 'hello');
    assert.equal(meta.createdAt, 100);
    assert.equal(meta.lastUsedAt, 200);
    assert.equal(meta.schemaVersion, SCHEMA_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeMeta: rejects non-existent dir', async () => {
  await assert.rejects(
    writeMeta('/nonexistent/path/xyz', { label: '', createdAt: 1, lastUsedAt: 1 })
  );
});

test('ensureMeta: creates tabterm.json if missing', async () => {
  const dir = tmp();
  try {
    const before = await readMeta(dir);
    assert.equal(before.hasTabtermJson, false);
    const result = await ensureMeta(dir, { label: 'init' });
    assert.equal(result.created, true);
    const after = await readMeta(dir);
    assert.equal(after.hasTabtermJson, true);
    assert.equal(after.label, 'init');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureMeta: preserves existing tabterm.json (no-op)', async () => {
  const dir = tmp();
  try {
    await writeMeta(dir, { label: 'existing', createdAt: 50, lastUsedAt: 60 });
    const result = await ensureMeta(dir, { label: 'new' });
    assert.equal(result.created, false);
    const meta = await readMeta(dir);
    assert.equal(meta.label, 'existing');
    assert.equal(meta.createdAt, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('touchLastUsed: updates lastUsedAt without touching other fields', async () => {
  const dir = tmp();
  try {
    await writeMeta(dir, { label: 'lbl', createdAt: 100, lastUsedAt: 200 });
    await new Promise((r) => setTimeout(r, 10));
    await touchLastUsed(dir);
    const meta = await readMeta(dir);
    assert.equal(meta.label, 'lbl');
    assert.equal(meta.createdAt, 100);
    assert.ok(meta.lastUsedAt > 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
