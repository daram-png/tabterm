import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateLabel, createLabelsStore } from './labels.js';

test('validateLabel: non-string -> type', () => {
  for (const v of [null, undefined, 123, {}, [], true]) {
    const r = validateLabel(v);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'type');
  }
});

test('validateLabel: empty string after trim -> ok, cleared', () => {
  for (const v of ['', '   ', '\t\n  ']) {
    const r = validateLabel(v);
    assert.equal(r.ok, true);
    assert.equal(r.value, '');
  }
});

test('validateLabel: too long (33 UTF-16 code units) -> too_long', () => {
  const v = 'a'.repeat(33);
  const r = validateLabel(v);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'too_long');
});

test('validateLabel: exactly 32 code units -> ok', () => {
  const v = 'a'.repeat(32);
  const r = validateLabel(v);
  assert.equal(r.ok, true);
  assert.equal(r.value, v);
});

test('validateLabel: control chars -> control_char', () => {
  for (const c of ['\x00', '\x1f', '\x7f', 'good\x01here']) {
    const r = validateLabel(c);
    assert.equal(r.ok, false, `expected fail for char ${JSON.stringify(c)}`);
    assert.equal(r.error, 'control_char');
  }
});

test('validateLabel: trims surrounding whitespace', () => {
  const r = validateLabel('  pixiechess  ');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'pixiechess');
});

test('validateLabel: emoji allowed', () => {
  const r = validateLabel('🚀 pixie');
  assert.equal(r.ok, true);
  assert.equal(r.value, '🚀 pixie');
});

/* ---------- createLabelsStore integration tests ---------- */

function tmpDataDir() {
  return mkdtempSync(join(tmpdir(), 'tabterm-labels-'));
}

test('labels: fresh dir → empty workers, health ok', async () => {
  const dir = tmpDataDir();
  try {
    const s = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    assert.deepEqual(s.getWorkers(), {});
    assert.equal(s.labelsHealth, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('labels: set + persist + reload', async () => {
  const dir = tmpDataDir();
  try {
    const s1 = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    await s1.setWorkerLabel(0, 'pixiechess');
    await s1.setWorkerLabel(3, 'upbit-bot');
    assert.deepEqual(s1.getWorkers(), { '0': 'pixiechess', '3': 'upbit-bot' });

    const raw = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.workers, { '0': 'pixiechess', '3': 'upbit-bot' });

    const s2 = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    assert.deepEqual(s2.getWorkers(), { '0': 'pixiechess', '3': 'upbit-bot' });
    assert.equal(s2.labelsHealth, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('labels: empty string clears the key', async () => {
  const dir = tmpDataDir();
  try {
    const s = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    await s.setWorkerLabel(0, 'pixiechess');
    await s.setWorkerLabel(0, '');
    assert.deepEqual(s.getWorkers(), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('labels: corrupted main → restored from bak', async () => {
  const dir = tmpDataDir();
  try {
    const good = JSON.stringify({ version: 1, workers: { '2': 'kept' } });
    writeFileSync(join(dir, 'labels.json.bak'), good);
    writeFileSync(join(dir, 'labels.json'), '{not json');
    const s = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    assert.deepEqual(s.getWorkers(), { '2': 'kept' });
    assert.equal(s.labelsHealth, 'restored_from_bak');
    const restored = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
    assert.deepEqual(restored.workers, { '2': 'kept' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('labels: both corrupted → empty + corrupted file preserved', async () => {
  const dir = tmpDataDir();
  try {
    writeFileSync(join(dir, 'labels.json'), '{not json');
    writeFileSync(join(dir, 'labels.json.bak'), 'also broken');
    const s = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    assert.deepEqual(s.getWorkers(), {});
    assert.equal(s.labelsHealth, 'corrupted_reset');
    const files = readdirSync(dir);
    assert.ok(
      files.some((f) => f.startsWith('labels.json.corrupted-')),
      `expected corrupted-* file, got ${files.join(',')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('labels: keys outside [0..workersCount) are silently dropped on load', async () => {
  const dir = tmpDataDir();
  try {
    const bad = JSON.stringify({
      version: 1,
      workers: { '0': 'a', '999': 'too-big', foo: 'not-int', __proto__: 'evil' },
    });
    writeFileSync(join(dir, 'labels.json'), bad);
    const s = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    assert.deepEqual(s.getWorkers(), { '0': 'a' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('labels: concurrent sets are serialized (no lost writes)', async () => {
  const dir = tmpDataDir();
  try {
    const s = await createLabelsStore({ dataDir: dir, workersCount: 8 });
    await Promise.all([
      s.setWorkerLabel(0, 'a'),
      s.setWorkerLabel(1, 'b'),
      s.setWorkerLabel(2, 'c'),
      s.setWorkerLabel(3, 'd'),
    ]);
    const raw = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
    assert.deepEqual(raw.workers, { '0': 'a', '1': 'b', '2': 'c', '3': 'd' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
