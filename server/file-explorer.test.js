import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { readFileSync, statSync } from 'node:fs';
import {
  FileExplorerError,
  validateRelPath,
  previewKindForName,
  languageForName,
  isTextName,
  listDirectory,
  listDirectoryAbsolute,
  readTextFile,
  resolveSafePath,
  mkdirEntry,
  deleteEntry,
  renameEntry,
  writeTextFile,
  writeUpload,
  mkdirEntryAbsolute,
  deleteEntryAbsolute,
  renameEntryAbsolute,
  writeTextFileAbsolute,
  writeUploadAbsolute,
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

test('listDirectoryAbsolute: directory junction reports kind=directory with isLink=true (Windows junction / *nix dir-symlink)', async () => {
  const parent = tmp();
  const targetDir = tmp();
  try {
    let created = false;
    try {
      symlinkSync(targetDir, join(parent, 'linkdir'), 'junction');
      created = true;
    } catch {
      return;
    }
    if (!created) return;
    const r = await listDirectoryAbsolute(parent, { maxEntries: 100 });
    const link = r.entries.find((e) => e.name === 'linkdir');
    assert.ok(link, 'linkdir entry present');
    assert.equal(link.kind, 'directory', 'junction must follow to target kind=directory');
    assert.equal(link.isLink, true, 'isLink flag set so client can show indicator');
    assert.equal(link.isBroken, false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('listDirectoryAbsolute: file symlink reports kind=file (best-effort, skipped if symlink creation fails)', async () => {
  const parent = tmp();
  const targetDir = tmp();
  try {
    const targetFile = join(targetDir, 'target.txt');
    writeFileSync(targetFile, 'hello');
    let created = false;
    try {
      symlinkSync(targetFile, join(parent, 'linkfile.txt'), 'file');
      created = true;
    } catch {
      return;
    }
    if (!created) return;
    const r = await listDirectoryAbsolute(parent, { maxEntries: 100 });
    const link = r.entries.find((e) => e.name === 'linkfile.txt');
    assert.ok(link);
    assert.equal(link.kind, 'file');
    assert.equal(link.isLink, true);
    assert.equal(link.editable, true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('listDirectoryAbsolute: broken symlink reports kind=symlink isBroken=true (best-effort)', async () => {
  const parent = tmp();
  try {
    const missing = join(parent, '__does_not_exist__');
    let created = false;
    try {
      symlinkSync(missing, join(parent, 'dangling'), 'junction');
      created = true;
    } catch {
      return;
    }
    if (!created) return;
    const r = await listDirectoryAbsolute(parent, { maxEntries: 100 });
    const link = r.entries.find((e) => e.name === 'dangling');
    if (!link) return;
    assert.equal(link.kind, 'symlink');
    assert.equal(link.isLink, true);
    assert.equal(link.isBroken, true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

/* ---------- Phase 2: write op tests (jailed) ---------- */

test('mkdirEntry: creates a new directory and returns summary', async () => {
  const dir = tmp();
  try {
    const r = await mkdirEntry(dir, 'fresh');
    assert.equal(r.name, 'fresh');
    assert.equal(r.kind, 'directory');
    assert.ok(statSync(join(dir, 'fresh')).isDirectory());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mkdirEntry: existing target → 409 already-exists', async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'sub'));
    await assert.rejects(
      mkdirEntry(dir, 'sub'),
      (e) => e instanceof FileExplorerError && e.statusCode === 409 && e.code === 'already-exists',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mkdirEntry: missing parent → 404 parent-missing', async () => {
  const dir = tmp();
  try {
    await assert.rejects(
      mkdirEntry(dir, 'no-such-parent/leaf'),
      (e) => e instanceof FileExplorerError && e.statusCode === 404,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mkdirEntry: empty relPath → 400 empty-path', async () => {
  const dir = tmp();
  try {
    await assert.rejects(
      mkdirEntry(dir, ''),
      (e) => e instanceof FileExplorerError && e.statusCode === 400 && e.code === 'empty-path',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mkdirEntry: traversal rejected (..)', async () => {
  const dir = tmp();
  try {
    await assert.rejects(
      mkdirEntry(dir, '../escape'),
      (e) => e instanceof FileExplorerError && e.statusCode === 400,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteEntry: removes a file', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'a.txt'), 'hi');
    const r = await deleteEntry(dir, 'a.txt');
    assert.equal(r.deleted, 'a.txt');
    assert.throws(() => statSync(join(dir, 'a.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteEntry: non-empty dir without recursive → 409 dir-not-empty', async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.txt'), 'x');
    await assert.rejects(
      deleteEntry(dir, 'sub'),
      (e) => e instanceof FileExplorerError && e.statusCode === 409 && e.code === 'dir-not-empty',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteEntry: recursive=true removes non-empty dir', async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.txt'), 'x');
    await deleteEntry(dir, 'sub', { recursive: true });
    assert.throws(() => statSync(join(dir, 'sub')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renameEntry: renames a file within the jail', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'old.txt'), 'content');
    const r = await renameEntry(dir, 'old.txt', 'new.txt');
    assert.equal(r.name, 'new.txt');
    assert.equal(readFileSync(join(dir, 'new.txt'), 'utf8'), 'content');
    assert.throws(() => statSync(join(dir, 'old.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renameEntry: target exists without overwrite → 409 target-exists', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'a.txt'), '1');
    writeFileSync(join(dir, 'b.txt'), '2');
    await assert.rejects(
      renameEntry(dir, 'a.txt', 'b.txt'),
      (e) => e instanceof FileExplorerError && e.statusCode === 409 && e.code === 'target-exists',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renameEntry: target = directory refuses even with overwrite', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'a.txt'), '1');
    mkdirSync(join(dir, 'b'));
    await assert.rejects(
      renameEntry(dir, 'a.txt', 'b', { overwrite: true }),
      (e) => e instanceof FileExplorerError && e.statusCode === 409 && e.code === 'target-is-directory',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeTextFile: creates new file when createIfMissing=true', async () => {
  const dir = tmp();
  try {
    const r = await writeTextFile(dir, 'fresh.md', '# hi', { createIfMissing: true });
    assert.equal(r.name, 'fresh.md');
    assert.equal(readFileSync(join(dir, 'fresh.md'), 'utf8'), '# hi');
    assert.ok(r.version.size > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeTextFile: missing file without createIfMissing → 404', async () => {
  const dir = tmp();
  try {
    await assert.rejects(
      writeTextFile(dir, 'nope.txt', 'x'),
      (e) => e instanceof FileExplorerError && e.statusCode === 404,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeTextFile: expectedVersion match overwrites; mismatch → 409 stale-version', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'a.txt'), 'orig');
    const st = statSync(join(dir, 'a.txt'));
    const goodVer = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
    const r = await writeTextFile(dir, 'a.txt', 'updated content longer', { expectedVersion: goodVer });
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'updated content longer');
    assert.equal(r.version.size, Buffer.byteLength('updated content longer'));
    // Try with stale version → 409
    await assert.rejects(
      writeTextFile(dir, 'a.txt', 'second', { expectedVersion: goodVer }),
      (e) => e instanceof FileExplorerError && e.statusCode === 409 && e.code === 'stale-version',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeTextFile: non-text extension → 415 not-text', async () => {
  const dir = tmp();
  try {
    await assert.rejects(
      writeTextFile(dir, 'a.png', 'x', { createIfMissing: true }),
      (e) => e instanceof FileExplorerError && e.statusCode === 415 && e.code === 'not-text',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeUpload: streams bytes to new file', async () => {
  const dir = tmp();
  try {
    const payload = Buffer.from('hello-upload');
    const r = await writeUpload(dir, 'up.bin', Readable.from(payload));
    assert.equal(r.name, 'up.bin');
    assert.equal(r.bytesWritten, payload.length);
    assert.deepEqual(readFileSync(join(dir, 'up.bin')), payload);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeUpload: target exists without overwrite → 409 target-exists', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'a.txt'), 'orig');
    await assert.rejects(
      writeUpload(dir, 'a.txt', Readable.from(Buffer.from('new'))),
      (e) => e instanceof FileExplorerError && e.statusCode === 409 && e.code === 'target-exists',
    );
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'orig');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeUpload: autosuffix picks "name (1).ext" on collision', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'photo.png'), 'first');
    const r = await writeUpload(dir, 'photo.png', Readable.from(Buffer.from('second')), { autosuffix: true });
    assert.equal(r.name, 'photo (1).png');
    assert.equal(readFileSync(join(dir, 'photo.png'), 'utf8'), 'first');
    assert.equal(readFileSync(join(dir, 'photo (1).png'), 'utf8'), 'second');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeUpload: exceeds maxBytes → 413 too-large + no file left behind', async () => {
  const dir = tmp();
  try {
    const payload = Buffer.alloc(2048, 0x41);
    await assert.rejects(
      writeUpload(dir, 'big.bin', Readable.from(payload), { maxBytes: 1024 }),
      (e) => e instanceof FileExplorerError && e.statusCode === 413,
    );
    assert.throws(() => statSync(join(dir, 'big.bin')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mkdirEntry rejects tmp-prefix leaf (race defence)', async () => {
  const dir = tmp();
  try {
    await assert.rejects(
      mkdirEntry(dir, '.tabterm-tmp-evil'),
      (e) => e instanceof FileExplorerError && e.statusCode === 400 && e.code === 'tmp-reserved',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- Phase 2: write op tests (absolute, no jail) ---------- */

test('mkdirEntryAbsolute / deleteEntryAbsolute / renameEntryAbsolute roundtrip', async () => {
  const dir = tmp();
  try {
    const created = await mkdirEntryAbsolute(join(dir, 'abs-new'));
    assert.ok(created.path.endsWith('abs-new'));
    const renamed = await renameEntryAbsolute(join(dir, 'abs-new'), join(dir, 'abs-renamed'));
    assert.equal(renamed.name, 'abs-renamed');
    await deleteEntryAbsolute(join(dir, 'abs-renamed'));
    assert.throws(() => statSync(join(dir, 'abs-renamed')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeTextFileAbsolute: CAS works the same as jailed variant', async () => {
  const dir = tmp();
  try {
    const created = await writeTextFileAbsolute(join(dir, 'cas.txt'), 'a', { createIfMissing: true });
    await assert.rejects(
      writeTextFileAbsolute(join(dir, 'cas.txt'), 'b', { expectedVersion: { size: 99, mtimeMs: 0 } }),
      (e) => e instanceof FileExplorerError && e.statusCode === 409 && e.code === 'stale-version',
    );
    await writeTextFileAbsolute(join(dir, 'cas.txt'), 'b', { expectedVersion: created.version });
    assert.equal(readFileSync(join(dir, 'cas.txt'), 'utf8'), 'b');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeUploadAbsolute: autosuffix + non-text extension allowed', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'doc.pdf'), 'old');
    const r = await writeUploadAbsolute(join(dir, 'doc.pdf'), Readable.from(Buffer.from('new')), { autosuffix: true });
    assert.equal(r.name, 'doc (1).pdf');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
