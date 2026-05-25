import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileExplorerError,
  validateRelPath,
  previewKindForName,
  languageForName,
  isTextName,
  listDirectory,
  readTextFile,
  resolveSafePath,
} from './file-explorer.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'tabterm-fx-'));
}

test('validateRelPath: empty / null → ok with [] segments', () => {
  assert.deepEqual(validateRelPath(''), { ok: true, segments: [] });
  assert.deepEqual(validateRelPath(null), { ok: true, segments: [] });
});

test('validateRelPath: rejects backslash, colon, absolute, dot segments, control chars', () => {
  assert.equal(validateRelPath('a\\b').error, 'backslash');
  assert.equal(validateRelPath('C:foo').error, 'drive-or-ads');
  assert.equal(validateRelPath('file.txt:ads').error, 'drive-or-ads');
  assert.equal(validateRelPath('/etc/passwd').error, 'absolute');
  assert.equal(validateRelPath('../escape').error, 'bad-segment');
  assert.equal(validateRelPath('a/../b').error, 'bad-segment');
  assert.equal(validateRelPath('a/./b').error, 'bad-segment');
  assert.equal(validateRelPath('a//b').error, 'bad-segment');
  assert.equal(validateRelPath('a\x00b').error, 'control-chars');
  assert.equal(validateRelPath('a\x1Fb').error, 'control-chars');
  assert.equal(validateRelPath(123).error, 'bad-type');
});

test('validateRelPath: accepts nested posix path', () => {
  const r = validateRelPath('foo/bar/baz.txt');
  assert.deepEqual(r, { ok: true, segments: ['foo', 'bar', 'baz.txt'] });
});

test('previewKindForName: image / pdf / none', () => {
  assert.equal(previewKindForName('a.png'), 'image');
  assert.equal(previewKindForName('a.JPG'), 'image');
  assert.equal(previewKindForName('doc.pdf'), 'pdf');
  assert.equal(previewKindForName('a.txt'), 'none');
  assert.equal(previewKindForName('a.svg'), 'none');
});

test('languageForName: markdown / text / null', () => {
  assert.equal(languageForName('readme.md'), 'markdown');
  assert.equal(languageForName('a.markdown'), 'markdown');
  assert.equal(languageForName('script.ts'), 'text');
  assert.equal(languageForName('Dockerfile'), 'text');
  assert.equal(languageForName('Makefile'), 'text');
  assert.equal(languageForName('a.png'), null);
  assert.equal(languageForName('binary.exe'), null);
});

test('isTextName: extension and basename matches', () => {
  assert.equal(isTextName('a.json'), true);
  assert.equal(isTextName('LICENSE'), true);
  assert.equal(isTextName('license'), true);
  assert.equal(isTextName('random.xyz'), false);
});

test('listDirectory: lists files with dirs first, includes size + mtime', async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'a.txt'), 'hello');
    writeFileSync(join(dir, 'b.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    const r = await listDirectory(dir, '', { maxEntries: 100 });
    assert.equal(r.entries.length, 3);
    assert.equal(r.entries[0].kind, 'directory');
    assert.equal(r.entries[0].name, 'sub');
    const a = r.entries.find((e) => e.name === 'a.txt');
    assert.equal(a.kind, 'file');
    assert.equal(a.editable, true);
    assert.equal(a.previewKind, 'none');
    assert.equal(a.size, 5);
    const b = r.entries.find((e) => e.name === 'b.png');
    assert.equal(b.editable, false);
    assert.equal(b.previewKind, 'image');
    assert.equal(r.truncated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listDirectory: truncated=true when entries exceed maxEntries', async () => {
  const dir = tmp();
  try {
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.txt`), '');
    const r = await listDirectory(dir, '', { maxEntries: 3 });
    assert.equal(r.entries.length, 3);
    assert.equal(r.truncated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listDirectory: rejects path-traversal attempt', async () => {
  const dir = tmp();
  try {
    await assert.rejects(
      listDirectory(dir, '../escape', { maxEntries: 100 }),
      (e) => e instanceof FileExplorerError && e.statusCode === 400,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTextFile: reads text content + version stamp', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'note.md'), '# hi\n');
    const r = await readTextFile(dir, 'note.md', { maxBytes: 1024 });
    assert.equal(r.content, '# hi\n');
    assert.equal(r.language, 'markdown');
    assert.equal(typeof r.version.size, 'number');
    assert.equal(typeof r.version.mtimeMs, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTextFile: 413 when size exceeds limit', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(2048));
    await assert.rejects(
      readTextFile(dir, 'big.txt', { maxBytes: 1024 }),
      (e) => e instanceof FileExplorerError && e.statusCode === 413,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTextFile: 415 when extension is non-text (e.g. .png)', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    await assert.rejects(
      readTextFile(dir, 'image.png', { maxBytes: 1024 }),
      (e) => e instanceof FileExplorerError && e.statusCode === 415 && e.code === 'not-text',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTextFile: 415 binary-content when .txt actually contains NUL bytes', async () => {
  const dir = tmp();
  try {
    const buf = Buffer.alloc(200);
    for (let i = 0; i < buf.length; i += 2) buf[i] = 65;
    writeFileSync(join(dir, 'fake.txt'), buf);
    await assert.rejects(
      readTextFile(dir, 'fake.txt', { maxBytes: 1024 }),
      (e) => e instanceof FileExplorerError && e.code === 'binary-content',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSafePath: rejects symlink mid-path (best-effort, skipped if symlink creation fails)', async () => {
  const dir = tmp();
  const outside = tmp();
  try {
    let symlinkCreated = false;
    try {
      symlinkSync(outside, join(dir, 'link'), 'junction');
      symlinkCreated = true;
    } catch {
      return;
    }
    if (!symlinkCreated) return;
    await assert.rejects(
      resolveSafePath(dir, 'link/inside', {}),
      (e) => e instanceof FileExplorerError && e.code === 'symlink-not-allowed',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
