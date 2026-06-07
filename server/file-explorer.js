// File explorer service: directory listing + text read + binary preview stream,
// jailed under a session folder cwd. Walks each path segment with lstat to
// reject symlinks/junctions/reparse points, then realpath-checks the final
// target stays inside the realpath-resolved root. Used by Phase 1 read-only
// routes; write/delete routes (Phase 2/3) will add expectedVersion + preview
// token semantics on top of resolveSafePath.

import { resolve as resolvePath, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath, lstat, stat, readdir, readFile, mkdir, rename, unlink, rm, rmdir, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';

const CONTROL_RE = /[\x00-\x1F]/;
const MAX_REL_PATH_LEN = 4096;

// The global (unjailed) file explorer must never serve the server's own runtime
// state: data/ holds auth.json (password scrypt hash) + devices.json (device
// token hashes). Defense-in-depth ONLY — an authenticated session also has a PTY
// shell and could read these via the terminal; this closes the quieter,
// scriptable /api/fs path. The real boundary is "authenticated == full host" by design.
const SERVER_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const PROTECTED_DIR = resolvePath(SERVER_ROOT, 'data');

export function isProtectedAbsolutePath(p) {
  if (typeof p !== 'string' || !p) return false;
  let n;
  try { n = resolvePath(p); } catch { return false; }
  // Windows paths are case-insensitive — compare case-folded there so
  // C:\TOOLS\...\data cannot slip past the C:\tools\...\data prefix.
  const ci = process.platform === 'win32';
  const a = ci ? n.toLowerCase() : n;
  const b = ci ? PROTECTED_DIR.toLowerCase() : PROTECTED_DIR;
  return a === b || a.startsWith(b + sep);
}

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.toml',
  '.ini', '.conf', '.log', '.csv', '.tsv',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg',
  '.py', '.rs', '.go', '.java', '.kt', '.swift', '.rb',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.env', '.gitignore', '.dockerignore',
]);

const TEXT_BASENAMES = new Set([
  'dockerfile', 'makefile', 'license', 'readme', 'changelog',
  'authors', 'contributors', 'contributing', 'codeowners',
  '.env', '.gitignore', '.dockerignore',
]);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);
const PDF_EXTS = new Set(['.pdf']);

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf',
};

export class FileExplorerError extends Error {
  constructor(statusCode, code, message) {
    super(message || code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function lowercaseExt(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return '';
  return name.slice(i).toLowerCase();
}

export function isTextName(name) {
  const ext = lowercaseExt(name);
  if (ext && TEXT_EXTS.has(ext)) return true;
  return TEXT_BASENAMES.has(name.toLowerCase());
}

export function languageForName(name) {
  const ext = lowercaseExt(name);
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (isTextName(name)) return 'text';
  return null;
}

export function previewKindForName(name) {
  const ext = lowercaseExt(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (PDF_EXTS.has(ext)) return 'pdf';
  return 'none';
}

export function previewMimeForName(name) {
  const ext = lowercaseExt(name);
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// Strict posix-only relPath validator. Rejects backslash (Windows escape),
// colon (drive letter / NTFS ADS), absolute paths, dot segments, control chars.
export function validateRelPath(input) {
  if (input === '' || input == null) return { ok: true, segments: [] };
  if (typeof input !== 'string') return { ok: false, error: 'bad-type' };
  if (input.length > MAX_REL_PATH_LEN) return { ok: false, error: 'too-long' };
  if (CONTROL_RE.test(input)) return { ok: false, error: 'control-chars' };
  if (input.includes('\\')) return { ok: false, error: 'backslash' };
  if (input.includes(':')) return { ok: false, error: 'drive-or-ads' };
  if (input.startsWith('/')) return { ok: false, error: 'absolute' };
  const segments = input.split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') return { ok: false, error: 'bad-segment' };
  }
  return { ok: true, segments };
}

// Walk each segment lstat. Any symlink/junction/reparse point in the path
// is rejected — leominal-equivalent guard, also catches Windows NTFS junctions.
export async function assertNoSymlinkSegments(rootReal, segments, { allowMissingFinal = false } = {}) {
  let current = rootReal;
  for (let i = 0; i < segments.length; i++) {
    current = resolvePath(current, segments[i]);
    let st;
    try {
      st = await lstat(current);
    } catch (e) {
      if (e?.code === 'ENOENT') {
        if (i === segments.length - 1 && allowMissingFinal) return;
        throw new FileExplorerError(404, 'not-found');
      }
      throw e;
    }
    if (st.isSymbolicLink()) {
      throw new FileExplorerError(400, 'symlink-not-allowed');
    }
    if (i < segments.length - 1 && !st.isDirectory()) {
      throw new FileExplorerError(400, 'not-a-directory');
    }
  }
}

export function assertContained(rootReal, targetReal) {
  if (targetReal === rootReal) return;
  if (!targetReal.startsWith(rootReal + sep)) {
    throw new FileExplorerError(400, 'escape');
  }
}

// Two-stage jail: 1) lstat-walk segments under realpath(cwd) to catch symlinks,
// 2) realpath(target) containment check to catch any residual escape vectors
// (trailing-dots Windows quirk, case-insensitive normalization, etc.).
export async function resolveSafePath(cwd, relPath, { allowMissingFinal = false } = {}) {
  const v = validateRelPath(relPath);
  if (!v.ok) throw new FileExplorerError(400, v.error);
  const rootReal = await realpath(cwd);
  if (v.segments.length === 0) {
    return { absolutePath: rootReal, segments: [], rootReal };
  }
  await assertNoSymlinkSegments(rootReal, v.segments, { allowMissingFinal });
  const absolutePath = resolvePath(rootReal, ...v.segments);
  try {
    const finalReal = await realpath(absolutePath);
    assertContained(rootReal, finalReal);
    return { absolutePath: finalReal, segments: v.segments, rootReal };
  } catch (e) {
    if (e?.code === 'ENOENT' && allowMissingFinal) {
      const parentReal = await realpath(resolvePath(absolutePath, '..'));
      assertContained(rootReal, parentReal);
      return { absolutePath, segments: v.segments, rootReal, missing: true };
    }
    if (e instanceof FileExplorerError) throw e;
    throw new FileExplorerError(404, 'not-found');
  }
}

function entryKindFromStat(st) {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  if (st.isFile()) return 'file';
  return 'other';
}

// Classify a directory child for the explorer UI. lstat reports junctions /
// symlinks as `isSymbolicLink()=true, isDirectory()=false` on Windows, which
// the bare entryKindFromStat() reports as kind='symlink'. The explorer client
// treats only kind==='directory' as expandable and only kind==='file' as
// openable, so junctions (e.g. C:\Documents and Settings -> C:\Users) became
// unclickable dead entries that triggered "binary file not previewable".
//
// Fix: when lstat sees a symlink, follow with stat() to learn the *target*
// kind and report THAT, with an isLink:true flag so the UI can show a hint.
// If stat fails (dangling link / broken junction / permission denied at the
// target), we fall back to kind='symlink' isBroken:true so the client can
// show an error state instead of trying to open it.
async function classifyChildEntry(absPath, lstatResult) {
  if (!lstatResult.isSymbolicLink()) {
    return {
      kind: entryKindFromStat(lstatResult),
      size: lstatResult.isFile() ? lstatResult.size : null,
      mtime: lstatResult.mtime ? lstatResult.mtime.toISOString() : null,
      isLink: false,
      isBroken: false,
    };
  }
  let target;
  try {
    target = await stat(absPath);
  } catch {
    return {
      kind: 'symlink',
      size: null,
      mtime: lstatResult.mtime ? lstatResult.mtime.toISOString() : null,
      isLink: true,
      isBroken: true,
    };
  }
  return {
    kind: entryKindFromStat(target),
    size: target.isFile() ? target.size : null,
    mtime: lstatResult.mtime ? lstatResult.mtime.toISOString() : null,
    isLink: true,
    isBroken: false,
  };
}

export async function listDirectory(cwd, relPath, { maxEntries }) {
  const r = await resolveSafePath(cwd, relPath, { allowMissingFinal: false });
  const dirStat = await lstat(r.absolutePath);
  if (!dirStat.isDirectory()) throw new FileExplorerError(400, 'not-a-directory');

  let dirents;
  try {
    dirents = await readdir(r.absolutePath, { withFileTypes: true });
  } catch (e) {
    if (e?.code === 'EACCES') throw new FileExplorerError(403, 'access-denied');
    throw e;
  }

  dirents.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const truncated = dirents.length > maxEntries;
  if (truncated) dirents.length = maxEntries;

  const baseRelDir = (relPath || '').replace(/\/+$/, '');
  const entries = [];
  for (const d of dirents) {
    const entryRelPath = baseRelDir ? `${baseRelDir}/${d.name}` : d.name;
    let st;
    try {
      st = await lstat(resolvePath(r.absolutePath, d.name));
    } catch {
      continue;
    }
    // Jailed variant: deliberately do NOT follow symlinks for classification.
    // resolveSafePath()/assertNoSymlinkSegments() reject symlink traversal as a
    // jail-escape guard, so if we reported a junction as kind='directory' the
    // client would offer an expand affordance that the server then refuses
    // with 'symlink-not-allowed'. Keep symlinks as kind='symlink' so the UI
    // can show them as inert. The follow-target classifier is only safe on
    // the auth-gated absolute variant (listDirectoryAbsolute below).
    const kind = entryKindFromStat(st);
    let preview = 'none';
    let editable = false;
    if (kind === 'file') {
      preview = previewKindForName(d.name);
      editable = languageForName(d.name) !== null;
    }
    entries.push({
      name: d.name,
      path: entryRelPath,
      kind,
      size: kind === 'file' ? st.size : null,
      mtime: st.mtime ? st.mtime.toISOString() : null,
      editable,
      previewKind: preview,
    });
  }

  return {
    rootPath: r.rootReal,
    path: baseRelDir,
    entries,
    truncated,
  };
}

export async function readTextFile(cwd, relPath, { maxBytes }) {
  const r = await resolveSafePath(cwd, relPath, { allowMissingFinal: false });
  const st = await lstat(r.absolutePath);
  if (!st.isFile()) throw new FileExplorerError(400, 'not-a-file');
  const name = r.segments[r.segments.length - 1] || '';
  const lang = languageForName(name);
  if (lang === null) throw new FileExplorerError(415, 'not-text');
  if (st.size > maxBytes) throw new FileExplorerError(413, 'too-large');
  const buf = await readFile(r.absolutePath);
  // Renamed-binary guard: text extensions don't normally contain NUL bytes.
  // >2% NUL in first 4KB indicates UTF-16/binary content masquerading as text.
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let nul = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) nul++;
  if (sample.length > 0 && nul / sample.length > 0.02) {
    throw new FileExplorerError(415, 'binary-content');
  }
  return {
    path: relPath || '',
    content: buf.toString('utf8'),
    language: lang,
    version: { size: st.size, mtimeMs: Math.floor(st.mtimeMs) },
  };
}

// Absolute-path variants for the global explorer tab. No jail / no symlink
// guard — the server is auth-gated on localhost and the user is expected to
// be able to read anywhere they could read in their own terminal. Path is
// passed through realpath() so trailing dots / case quirks normalize, but
// containment is NOT checked.
function assertAbsolute(absPath) {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    throw new FileExplorerError(400, 'bad-path');
  }
  if (absPath.length > MAX_REL_PATH_LEN) {
    throw new FileExplorerError(400, 'too-long');
  }
  if (CONTROL_RE.test(absPath)) {
    throw new FileExplorerError(400, 'control-chars');
  }
  const isWinAbs = /^[a-zA-Z]:[\\/]/.test(absPath);
  const isPosixAbs = absPath.startsWith('/');
  if (!isWinAbs && !isPosixAbs) {
    throw new FileExplorerError(400, 'not-absolute');
  }
  // Block the global explorer from the server's own secret store (defense-in-depth).
  if (isProtectedAbsolutePath(absPath)) {
    throw new FileExplorerError(403, 'forbidden-path');
  }
}

export async function listDirectoryAbsolute(absPath, { maxEntries }) {
  assertAbsolute(absPath);
  let resolvedPath;
  try {
    resolvedPath = await realpath(absPath);
  } catch (e) {
    if (e?.code === 'ENOENT') throw new FileExplorerError(404, 'not-found');
    if (e?.code === 'EACCES') throw new FileExplorerError(403, 'access-denied');
    throw e;
  }
  if (isProtectedAbsolutePath(resolvedPath)) throw new FileExplorerError(403, 'forbidden-path');
  const st = await lstat(resolvedPath);
  if (!st.isDirectory()) throw new FileExplorerError(400, 'not-a-directory');

  let dirents;
  try {
    dirents = await readdir(resolvedPath, { withFileTypes: true });
  } catch (e) {
    if (e?.code === 'EACCES') throw new FileExplorerError(403, 'access-denied');
    throw e;
  }

  dirents.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const truncated = dirents.length > maxEntries;
  if (truncated) dirents.length = maxEntries;

  const entries = [];
  for (const d of dirents) {
    const childAbs = resolvePath(resolvedPath, d.name);
    let est;
    try {
      est = await lstat(childAbs);
    } catch {
      continue;
    }
    const c = await classifyChildEntry(childAbs, est);
    let preview = 'none';
    let editable = false;
    if (c.kind === 'file') {
      preview = previewKindForName(d.name);
      editable = languageForName(d.name) !== null;
    }
    entries.push({
      name: d.name,
      path: childAbs,
      kind: c.kind,
      size: c.size,
      mtime: c.mtime,
      editable,
      previewKind: preview,
      isLink: c.isLink,
      isBroken: c.isBroken,
    });
  }

  return {
    path: resolvedPath,
    entries,
    truncated,
  };
}

export async function readTextFileAbsolute(absPath, { maxBytes }) {
  assertAbsolute(absPath);
  let resolved;
  try {
    resolved = await realpath(absPath);
  } catch (e) {
    if (e?.code === 'ENOENT') throw new FileExplorerError(404, 'not-found');
    if (e?.code === 'EACCES') throw new FileExplorerError(403, 'access-denied');
    throw e;
  }
  if (isProtectedAbsolutePath(resolved)) throw new FileExplorerError(403, 'forbidden-path');
  const st = await lstat(resolved);
  if (!st.isFile()) throw new FileExplorerError(400, 'not-a-file');
  const name = resolved.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const lang = languageForName(name);
  if (lang === null) throw new FileExplorerError(415, 'not-text');
  if (st.size > maxBytes) throw new FileExplorerError(413, 'too-large');
  const buf = await readFile(resolved);
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let nul = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) nul++;
  if (sample.length > 0 && nul / sample.length > 0.02) {
    throw new FileExplorerError(415, 'binary-content');
  }
  return {
    path: resolved,
    content: buf.toString('utf8'),
    language: lang,
    version: { size: st.size, mtimeMs: Math.floor(st.mtimeMs) },
  };
}

export async function streamPreviewAbsolute(absPath, reply, { maxBytes }) {
  assertAbsolute(absPath);
  let resolved;
  try {
    resolved = await realpath(absPath);
  } catch (e) {
    if (e?.code === 'ENOENT') throw new FileExplorerError(404, 'not-found');
    if (e?.code === 'EACCES') throw new FileExplorerError(403, 'access-denied');
    throw e;
  }
  if (isProtectedAbsolutePath(resolved)) throw new FileExplorerError(403, 'forbidden-path');
  const st = await lstat(resolved);
  if (!st.isFile()) throw new FileExplorerError(400, 'not-a-file');
  const name = resolved.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const kind = previewKindForName(name);
  if (kind === 'none') throw new FileExplorerError(415, 'not-previewable');
  if (st.size > maxBytes) throw new FileExplorerError(413, 'too-large');
  reply.header('Content-Type', previewMimeForName(name));
  reply.header('Content-Length', String(st.size));
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Disposition', 'inline');
  reply.header('Cache-Control', 'private, no-cache');
  return reply.send(createReadStream(resolved));
}

// Streams a binary preview file (image/PDF) to reply.
// On success, the reply is consumed and this function returns the reply object.
export async function streamPreview(cwd, relPath, reply, { maxBytes }) {
  const r = await resolveSafePath(cwd, relPath, { allowMissingFinal: false });
  const st = await lstat(r.absolutePath);
  if (!st.isFile()) throw new FileExplorerError(400, 'not-a-file');
  const name = r.segments[r.segments.length - 1] || '';
  const kind = previewKindForName(name);
  if (kind === 'none') throw new FileExplorerError(415, 'not-previewable');
  if (st.size > maxBytes) throw new FileExplorerError(413, 'too-large');
  reply.header('Content-Type', previewMimeForName(name));
  reply.header('Content-Length', String(st.size));
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Disposition', 'inline');
  reply.header('Cache-Control', 'private, no-cache');
  return reply.send(createReadStream(r.absolutePath));
}

/* ============================================================
 * Phase 2: write operations (jailed under WORKERS_ROOT/<folder>)
 *
 * All five mutating ops mirror the read-path security model:
 *   1. resolveSafePath (relPath form) → segment-walk + realpath jail
 *   2. final containment re-checked via parent-dir realpath for missing leaves
 *   3. atomic write: tmp-file in SAME dir + fs.rename to target
 *      (rename is atomic on NTFS / ext4 / APFS; if target exists Windows
 *       overwrites since Vista, posix overwrites by spec)
 *   4. expectedVersion = { size, mtimeMs } compare-and-swap to detect
 *      stale-save races — same shape readTextFile returned to client
 * ============================================================ */

// Generate a tmp filename in the same directory as the target. Keeping the
// tmp on the SAME volume guarantees fs.rename is atomic; cross-volume rename
// silently downgrades to copy+unlink which loses the atomicity guarantee.
function tmpSiblingPath(targetAbs) {
  const dir = dirname(targetAbs);
  const rand = randomBytes(8).toString('hex');
  return resolvePath(dir, `.tabterm-tmp-${process.pid}-${Date.now()}-${rand}`);
}

// Best-effort tmp cleanup. Swallows ENOENT (already gone) and EBUSY (Windows
// indexer may briefly hold the file handle after we abort the write).
async function cleanupTmp(tmpPath) {
  try { await unlink(tmpPath); } catch {}
}

// Last segment must not start with our own tmp prefix — defence against a
// client constructing relPath that would race with an in-flight atomic write
// from another tab. Also rejects an empty relPath (which would resolve to
// the jail root and mean "create/delete the entire session folder").
function requireWritableLeaf(segments) {
  if (segments.length === 0) throw new FileExplorerError(400, 'empty-path');
  const leaf = segments[segments.length - 1];
  if (leaf.startsWith('.tabterm-tmp-')) throw new FileExplorerError(400, 'tmp-reserved');
}

// Build the entry summary the client expects (matches listDirectory shape).
async function entrySummary(absPath, name) {
  const st = await lstat(absPath);
  const kind = entryKindFromStat(st);
  return {
    name,
    path: absPath,
    kind,
    size: st.isFile() ? st.size : null,
    mtime: st.mtime ? st.mtime.toISOString() : null,
    version: st.isFile() ? { size: st.size, mtimeMs: Math.floor(st.mtimeMs) } : null,
  };
}

// Parent must already exist (404). EEXIST → 409 lets client choose to use
// existing or pick a new name without retry-loop races.
export async function mkdirEntry(cwd, relPath) {
  const r = await resolveSafePath(cwd, relPath, { allowMissingFinal: true });
  requireWritableLeaf(r.segments);
  if (!r.missing) throw new FileExplorerError(409, 'already-exists');
  try {
    await mkdir(r.absolutePath);
  } catch (e) {
    if (e?.code === 'EEXIST') throw new FileExplorerError(409, 'already-exists');
    if (e?.code === 'ENOENT') throw new FileExplorerError(404, 'parent-missing');
    if (e?.code === 'EACCES') throw new FileExplorerError(403, 'access-denied');
    throw e;
  }
  return entrySummary(r.absolutePath, r.segments[r.segments.length - 1]);
}

// Refuses to follow symlinks — the jail variant treats symlinks as inert
// (listDirectory returns kind='symlink', client offers no expand) so unlink
// of a junction-as-symlink would be inconsistent with the read model.
export async function deleteEntry(cwd, relPath, { recursive = false } = {}) {
  const r = await resolveSafePath(cwd, relPath, { allowMissingFinal: false });
  requireWritableLeaf(r.segments);
  const st = await lstat(r.absolutePath);
  if (st.isSymbolicLink()) throw new FileExplorerError(400, 'symlink-not-allowed');
  try {
    if (st.isDirectory()) {
      if (recursive === true) {
        await rm(r.absolutePath, { recursive: true, force: false });
      } else {
        await rmdir(r.absolutePath);
      }
    } else {
      await unlink(r.absolutePath);
    }
  } catch (e) {
    // rmdir throws ENOTEMPTY on non-empty dir; rm w/o recursive throws EISDIR
    // on a dir (we route around that, but keep mapping defensive). EEXIST on
    // Windows for some non-empty dir paths.
    if (e?.code === 'ENOTEMPTY' || e?.code === 'EEXIST' || e?.code === 'EISDIR' || e?.code === 'ERR_FS_EISDIR') {
      throw new FileExplorerError(409, 'dir-not-empty');
    }
    if (e?.code === 'EACCES' || e?.code === 'EPERM') throw new FileExplorerError(403, 'access-denied');
    if (e?.code === 'EBUSY') throw new FileExplorerError(409, 'busy');
    throw e;
  }
  return { deleted: r.segments.join('/') };
}

// Atomic rename within the jail. Source must exist, target must not (unless
// overwrite=true — but even with overwrite we refuse if target is a directory).
export async function renameEntry(cwd, fromRel, toRel, { overwrite = false } = {}) {
  const from = await resolveSafePath(cwd, fromRel, { allowMissingFinal: false });
  const to = await resolveSafePath(cwd, toRel, { allowMissingFinal: true });
  requireWritableLeaf(from.segments);
  requireWritableLeaf(to.segments);
  const fromSt = await lstat(from.absolutePath);
  if (fromSt.isSymbolicLink()) throw new FileExplorerError(400, 'symlink-not-allowed');
  if (!to.missing) {
    if (!overwrite) throw new FileExplorerError(409, 'target-exists');
    const toSt = await lstat(to.absolutePath);
    if (toSt.isDirectory()) throw new FileExplorerError(409, 'target-is-directory');
  }
  try {
    await rename(from.absolutePath, to.absolutePath);
  } catch (e) {
    if (e?.code === 'EXDEV') throw new FileExplorerError(400, 'cross-device');
    if (e?.code === 'EACCES' || e?.code === 'EPERM') throw new FileExplorerError(403, 'access-denied');
    if (e?.code === 'EBUSY') throw new FileExplorerError(409, 'busy');
    throw e;
  }
  return entrySummary(to.absolutePath, to.segments[to.segments.length - 1]);
}

// Save text content. CAS: if file exists and expectedVersion is provided,
// stat-compare {size, mtimeMs} — mismatch → 409 stale-version. Atomic write
// via tmp-sibling + rename so partial-write crashes never leave half-files.
export async function writeTextFile(cwd, relPath, content, { expectedVersion = null, createIfMissing = false } = {}) {
  if (typeof content !== 'string') throw new FileExplorerError(400, 'bad-content');
  const r = await resolveSafePath(cwd, relPath, { allowMissingFinal: true });
  requireWritableLeaf(r.segments);
  const name = r.segments[r.segments.length - 1];
  if (languageForName(name) === null) throw new FileExplorerError(415, 'not-text');

  if (r.missing) {
    if (!createIfMissing) throw new FileExplorerError(404, 'not-found');
    if (expectedVersion) throw new FileExplorerError(409, 'unexpected-create');
  } else {
    const st = await lstat(r.absolutePath);
    if (st.isSymbolicLink()) throw new FileExplorerError(400, 'symlink-not-allowed');
    if (!st.isFile()) throw new FileExplorerError(400, 'not-a-file');
    if (expectedVersion) {
      const cur = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
      if (cur.size !== expectedVersion.size || cur.mtimeMs !== expectedVersion.mtimeMs) {
        throw new FileExplorerError(409, 'stale-version');
      }
    }
  }

  const tmp = tmpSiblingPath(r.absolutePath);
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, r.absolutePath);
  } catch (e) {
    await cleanupTmp(tmp);
    if (e?.code === 'EACCES' || e?.code === 'EPERM') throw new FileExplorerError(403, 'access-denied');
    if (e?.code === 'ENOENT') throw new FileExplorerError(404, 'parent-missing');
    throw e;
  }
  return entrySummary(r.absolutePath, name);
}

// Stream an upload (e.g. multipart file part) into the target path. Same
// atomic tmp+rename as writeTextFile. autosuffix=true picks "name (1).ext"
// on collision so Telegram-style drag-drop never silently overwrites.
// Returns the final entry (its name may differ from request if autosuffixed).
export async function writeUpload(cwd, relPath, readable, { overwrite = false, autosuffix = false, maxBytes = Infinity } = {}) {
  let r = await resolveSafePath(cwd, relPath, { allowMissingFinal: true });
  requireWritableLeaf(r.segments);
  if (!r.missing) {
    if (autosuffix) {
      r = await resolveAutosuffix(cwd, r);
    } else if (!overwrite) {
      throw new FileExplorerError(409, 'target-exists');
    } else {
      const st = await lstat(r.absolutePath);
      if (st.isSymbolicLink()) throw new FileExplorerError(400, 'symlink-not-allowed');
      if (st.isDirectory()) throw new FileExplorerError(409, 'target-is-directory');
    }
  }

  const tmp = tmpSiblingPath(r.absolutePath);
  let bytesWritten = 0;
  try {
    const out = createWriteStream(tmp);
    readable.on('data', (chunk) => {
      bytesWritten += chunk.length;
      if (bytesWritten > maxBytes) {
        readable.destroy(new FileExplorerError(413, 'too-large'));
      }
    });
    await pipeline(readable, out);
    await rename(tmp, r.absolutePath);
  } catch (e) {
    await cleanupTmp(tmp);
    if (e instanceof FileExplorerError) throw e;
    if (e?.code === 'EACCES' || e?.code === 'EPERM') throw new FileExplorerError(403, 'access-denied');
    if (e?.code === 'ENOENT') throw new FileExplorerError(404, 'parent-missing');
    throw e;
  }
  const summary = await entrySummary(r.absolutePath, r.segments[r.segments.length - 1]);
  summary.bytesWritten = bytesWritten;
  return summary;
}

// Find the first non-colliding "name (N).ext" sibling. Capped at 999 to
// prevent runaway loops on a pathological dir. Mutates a copy of resolved r.
async function resolveAutosuffix(cwd, resolved) {
  const leaf = resolved.segments[resolved.segments.length - 1];
  const dot = leaf.lastIndexOf('.');
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
  const ext = dot > 0 ? leaf.slice(dot) : '';
  const parentSegs = resolved.segments.slice(0, -1);
  for (let i = 1; i <= 999; i++) {
    const candidate = `${stem} (${i})${ext}`;
    const candidateRel = [...parentSegs, candidate].join('/');
    try {
      const cr = await resolveSafePath(cwd, candidateRel, { allowMissingFinal: true });
      if (cr.missing) return cr;
    } catch {}
  }
  throw new FileExplorerError(409, 'autosuffix-exhausted');
}

/* ============================================================
 * Phase 2: write operations (absolute, auth-gated, no jail)
 * Powers the global Explorer tab + terminal drop overlay.
 * Same security note as the read variants: no folder jail — auth+localhost
 * + the user can write anywhere their OS user can write.
 * ============================================================ */

// Resolve an absolute path that may not yet exist. realpath normalizes the
// parent dir (so trailing dots / case quirks settle), then resolves the
// final segment against that. allowMissingFinal mirrors resolveSafePath.
async function resolveAbsoluteWritable(absPath, { allowMissingFinal = false } = {}) {
  assertAbsolute(absPath);
  try {
    const resolved = await realpath(absPath);
    if (isProtectedAbsolutePath(resolved)) throw new FileExplorerError(403, 'forbidden-path');
    return { absolutePath: resolved, missing: false };
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      if (e?.code === 'EACCES') throw new FileExplorerError(403, 'access-denied');
      throw e;
    }
    if (!allowMissingFinal) throw new FileExplorerError(404, 'not-found');
    // Resolve parent dir, then append the leaf so trailing-dot quirks settle.
    const parentReal = await realpath(dirname(absPath)).catch((err) => {
      if (err?.code === 'ENOENT') throw new FileExplorerError(404, 'parent-missing');
      throw err;
    });
    const leaf = absPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
    const target = resolvePath(parentReal, leaf);
    if (isProtectedAbsolutePath(target)) throw new FileExplorerError(403, 'forbidden-path');
    return { absolutePath: target, missing: true };
  }
}

export async function mkdirEntryAbsolute(absPath) {
  const r = await resolveAbsoluteWritable(absPath, { allowMissingFinal: true });
  if (!r.missing) throw new FileExplorerError(409, 'already-exists');
  try {
    await mkdir(r.absolutePath);
  } catch (e) {
    if (e?.code === 'EEXIST') throw new FileExplorerError(409, 'already-exists');
    if (e?.code === 'ENOENT') throw new FileExplorerError(404, 'parent-missing');
    if (e?.code === 'EACCES') throw new FileExplorerError(403, 'access-denied');
    throw e;
  }
  const name = r.absolutePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  return entrySummary(r.absolutePath, name);
}

export async function deleteEntryAbsolute(absPath, { recursive = false } = {}) {
  const r = await resolveAbsoluteWritable(absPath, { allowMissingFinal: false });
  const st = await lstat(r.absolutePath);
  // No symlink refusal in absolute variant: the global Explorer follows
  // junctions on read (classifyChildEntry) so refusing them on delete would
  // be inconsistent. Users still see kind='symlink' badges so the action
  // is visible.
  try {
    if (st.isDirectory()) {
      if (recursive === true) {
        await rm(r.absolutePath, { recursive: true, force: false });
      } else {
        await rmdir(r.absolutePath);
      }
    } else {
      await unlink(r.absolutePath);
    }
  } catch (e) {
    if (e?.code === 'ENOTEMPTY' || e?.code === 'EEXIST' || e?.code === 'EISDIR' || e?.code === 'ERR_FS_EISDIR') {
      throw new FileExplorerError(409, 'dir-not-empty');
    }
    if (e?.code === 'EACCES' || e?.code === 'EPERM') throw new FileExplorerError(403, 'access-denied');
    if (e?.code === 'EBUSY') throw new FileExplorerError(409, 'busy');
    throw e;
  }
  return { deleted: r.absolutePath };
}

export async function renameEntryAbsolute(fromAbs, toAbs, { overwrite = false } = {}) {
  const from = await resolveAbsoluteWritable(fromAbs, { allowMissingFinal: false });
  const to = await resolveAbsoluteWritable(toAbs, { allowMissingFinal: true });
  if (!to.missing) {
    if (!overwrite) throw new FileExplorerError(409, 'target-exists');
    const toSt = await lstat(to.absolutePath);
    if (toSt.isDirectory()) throw new FileExplorerError(409, 'target-is-directory');
  }
  try {
    await rename(from.absolutePath, to.absolutePath);
  } catch (e) {
    if (e?.code === 'EXDEV') throw new FileExplorerError(400, 'cross-device');
    if (e?.code === 'EACCES' || e?.code === 'EPERM') throw new FileExplorerError(403, 'access-denied');
    if (e?.code === 'EBUSY') throw new FileExplorerError(409, 'busy');
    throw e;
  }
  const name = to.absolutePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  return entrySummary(to.absolutePath, name);
}

export async function writeTextFileAbsolute(absPath, content, { expectedVersion = null, createIfMissing = false } = {}) {
  if (typeof content !== 'string') throw new FileExplorerError(400, 'bad-content');
  const r = await resolveAbsoluteWritable(absPath, { allowMissingFinal: true });
  const name = r.absolutePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  if (languageForName(name) === null) throw new FileExplorerError(415, 'not-text');

  if (r.missing) {
    if (!createIfMissing) throw new FileExplorerError(404, 'not-found');
    if (expectedVersion) throw new FileExplorerError(409, 'unexpected-create');
  } else {
    const st = await lstat(r.absolutePath);
    if (!st.isFile()) throw new FileExplorerError(400, 'not-a-file');
    if (expectedVersion) {
      const cur = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
      if (cur.size !== expectedVersion.size || cur.mtimeMs !== expectedVersion.mtimeMs) {
        throw new FileExplorerError(409, 'stale-version');
      }
    }
  }

  const tmp = tmpSiblingPath(r.absolutePath);
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, r.absolutePath);
  } catch (e) {
    await cleanupTmp(tmp);
    if (e?.code === 'EACCES' || e?.code === 'EPERM') throw new FileExplorerError(403, 'access-denied');
    if (e?.code === 'ENOENT') throw new FileExplorerError(404, 'parent-missing');
    throw e;
  }
  return entrySummary(r.absolutePath, name);
}

export async function writeUploadAbsolute(absPath, readable, { overwrite = false, autosuffix = false, maxBytes = Infinity } = {}) {
  let r = await resolveAbsoluteWritable(absPath, { allowMissingFinal: true });
  if (!r.missing) {
    if (autosuffix) {
      r = await resolveAutosuffixAbsolute(r);
    } else if (!overwrite) {
      throw new FileExplorerError(409, 'target-exists');
    } else {
      const st = await lstat(r.absolutePath);
      if (st.isDirectory()) throw new FileExplorerError(409, 'target-is-directory');
    }
  }

  const tmp = tmpSiblingPath(r.absolutePath);
  let bytesWritten = 0;
  try {
    const out = createWriteStream(tmp);
    readable.on('data', (chunk) => {
      bytesWritten += chunk.length;
      if (bytesWritten > maxBytes) {
        readable.destroy(new FileExplorerError(413, 'too-large'));
      }
    });
    await pipeline(readable, out);
    await rename(tmp, r.absolutePath);
  } catch (e) {
    await cleanupTmp(tmp);
    if (e instanceof FileExplorerError) throw e;
    if (e?.code === 'EACCES' || e?.code === 'EPERM') throw new FileExplorerError(403, 'access-denied');
    if (e?.code === 'ENOENT') throw new FileExplorerError(404, 'parent-missing');
    throw e;
  }
  const name = r.absolutePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const summary = await entrySummary(r.absolutePath, name);
  summary.bytesWritten = bytesWritten;
  return summary;
}

async function resolveAutosuffixAbsolute(resolved) {
  const leaf = resolved.absolutePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const dot = leaf.lastIndexOf('.');
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
  const ext = dot > 0 ? leaf.slice(dot) : '';
  const parent = dirname(resolved.absolutePath);
  for (let i = 1; i <= 999; i++) {
    const candidate = `${stem} (${i})${ext}`;
    const candidateAbs = resolvePath(parent, candidate);
    try {
      await lstat(candidateAbs);
    } catch (e) {
      if (e?.code === 'ENOENT') return { absolutePath: candidateAbs, missing: true };
    }
  }
  throw new FileExplorerError(409, 'autosuffix-exhausted');
}
