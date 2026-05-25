// File explorer service: directory listing + text read + binary preview stream,
// jailed under a session folder cwd. Walks each path segment with lstat to
// reject symlinks/junctions/reparse points, then realpath-checks the final
// target stays inside the realpath-resolved root. Used by Phase 1 read-only
// routes; write/delete routes (Phase 2/3) will add expectedVersion + preview
// token semantics on top of resolveSafePath.

import { resolve as resolvePath, sep } from 'node:path';
import { realpath, lstat, readdir, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

const CONTROL_RE = /[\x00-\x1F]/;
const MAX_REL_PATH_LEN = 4096;

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
