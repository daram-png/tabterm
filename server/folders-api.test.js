import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessionFolders, validateSessionFolderName } from './session-folder.js';

function setupRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tabterm-root-'));
  // 워커 폴더 (제외돼야 함)
  mkdirSync(join(root, 'worker-0'));
  mkdirSync(join(root, 'worker-7'));
  // 세션 폴더 (포함돼야 함)
  mkdirSync(join(root, 'session-20260521140000-aaaa'));
  writeFileSync(join(root, 'session-20260521140000-aaaa', 'tabterm.json'), JSON.stringify({
    version: 1, label: 'labeled', createdAt: 100, lastUsedAt: 200,
  }));
  // legacy (no tabterm.json)
  mkdirSync(join(root, 'session-legacy'));
  // 무관 폴더 (제외돼야 함)
  mkdirSync(join(root, 'random-folder'));
  return root;
}

test('listSessionFolders: filters worker- and non-session- prefixes', async () => {
  const root = setupRoot();
  try {
    const folders = await listSessionFolders(root, {
      workerPrefix: 'worker-',
      sessionPrefix: 'session-',
    });
    const names = folders.map((f) => f.name).sort();
    assert.deepEqual(names, [
      'session-20260521140000-aaaa',
      'session-legacy',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listSessionFolders: includes meta fields per folder', async () => {
  const root = setupRoot();
  try {
    const folders = await listSessionFolders(root, {
      workerPrefix: 'worker-',
      sessionPrefix: 'session-',
    });
    const labeled = folders.find((f) => f.name === 'session-20260521140000-aaaa');
    assert.equal(labeled.label, 'labeled');
    assert.equal(labeled.hasTabtermJson, true);
    assert.equal(labeled.schemaVersion, 1);
    assert.equal(labeled.createdAt, 100);
    assert.equal(labeled.lastUsedAt, 200);

    const legacy = folders.find((f) => f.name === 'session-legacy');
    assert.equal(legacy.hasTabtermJson, false);
    assert.equal(legacy.label, '');
    assert.equal(legacy.schemaVersion, null);
    assert.ok(legacy.createdAt > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listSessionFolders: returns [] when root missing', async () => {
  const folders = await listSessionFolders('/nonexistent/path/xyz', {
    workerPrefix: 'worker-',
    sessionPrefix: 'session-',
  });
  assert.deepEqual(folders, []);
});

test('validateSessionFolderName: rejects path separators', () => {
  for (const v of ['../escape', 'a/b', 'a\\b', './rel']) {
    const r = validateSessionFolderName(v, { workerPrefix: 'worker-', sessionPrefix: 'session-' });
    assert.equal(r.ok, false, `should reject: ${v}`);
  }
});

test('validateSessionFolderName: rejects worker- prefix', () => {
  const r = validateSessionFolderName('worker-0', { workerPrefix: 'worker-', sessionPrefix: 'session-' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'worker-protected');
});

test('validateSessionFolderName: rejects non-session- prefix', () => {
  const r = validateSessionFolderName('random-folder', { workerPrefix: 'worker-', sessionPrefix: 'session-' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad-prefix');
});

test('validateSessionFolderName: accepts valid session name', () => {
  const r = validateSessionFolderName('session-20260521140000-aaaa', {
    workerPrefix: 'worker-', sessionPrefix: 'session-',
  });
  assert.equal(r.ok, true);
  assert.equal(r.value, 'session-20260521140000-aaaa');
});

test('validateSessionFolderName: rejects empty/non-string', () => {
  for (const v of ['', null, undefined, 123, {}]) {
    const r = validateSessionFolderName(v, { workerPrefix: 'worker-', sessionPrefix: 'session-' });
    assert.equal(r.ok, false);
  }
});
