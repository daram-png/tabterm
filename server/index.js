import dotenv from 'dotenv';
dotenv.config({ override: true });
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import { resolve, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import { auth } from './auth.js';
import { sessions } from './sessions.js';
import { registerWs } from './ws.js';
import { audit } from './audit.js';
import { ensureHydraReady, hydraStatus } from './hydra.js';
import { loadWorkerEnv, buildClaudeInvocation, buildEngineInvocation, allocFreePort } from './config.js';
import { registerDpProxy } from './dp-proxy.js';
import { killStaleBot } from './kill-stale-bot.js';
import {
  listSessionFolders,
  validateSessionFolderName,
  ensureMeta,
  touchLastUsed,
  setLabel as setFolderLabel,
  readMeta as readFolderMeta,
  writeMeta as writeFolderMeta,
} from './session-folder.js';
import {
  FileExplorerError,
  listDirectory as fxListDirectory,
  readTextFile as fxReadTextFile,
  streamPreview as fxStreamPreview,
  listDirectoryAbsolute as fxListAbs,
  readTextFileAbsolute as fxReadAbs,
  streamPreviewAbsolute as fxStreamAbs,
  mkdirEntry as fxMkdir,
  deleteEntry as fxDelete,
  renameEntry as fxRename,
  writeTextFile as fxWriteText,
  writeUpload as fxWriteUpload,
  mkdirEntryAbsolute as fxMkdirAbs,
  deleteEntryAbsolute as fxDeleteAbs,
  renameEntryAbsolute as fxRenameAbs,
  writeTextFileAbsolute as fxWriteTextAbs,
  writeUploadAbsolute as fxWriteUploadAbs,
} from './file-explorer.js';
import { startWatchdog, stopWatchdog } from './watchdog.js';
import { registerSystemRoutes } from './system.js';
import { createLabelsStore, validateLabel } from './labels.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3007);
const COOKIE_SECRET = process.env.COOKIE_SECRET || randomBytes(32).toString('hex');
const CSRF_HEADER = (process.env.CSRF_HEADER || 'x-tabterm-csrf').toLowerCase();
const WORKERS_ROOT = normalize(process.env.WORKERS_ROOT || 'C:/workspace');
const WORKERS_COUNT = Number(process.env.WORKERS_COUNT || 8);
const WORKER_PREFIX = process.env.WORKER_PREFIX || 'worker-';
const HYDRA_ENABLED = String(process.env.HYDRATEAMS_ENABLED ?? 'true') === 'true';
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'http://localhost:3456';
const NEW_SESSION_PREFIX = process.env.NEW_SESSION_PREFIX || 'session-';
const FILE_LIST_MAX_ENTRIES = Number(process.env.FILE_LIST_MAX_ENTRIES || 2000);
const FILE_TEXT_MAX_BYTES = Number(process.env.FILE_TEXT_MAX_BYTES || 1048576);
const FILE_PREVIEW_MAX_BYTES = Number(process.env.FILE_PREVIEW_MAX_BYTES || 52428800);
const FILE_WRITE_MAX_BYTES = Number(process.env.FILE_WRITE_MAX_BYTES || 5242880); // 5MB text save cap
const FILE_UPLOAD_MAX_BYTES = Number(process.env.FILE_UPLOAD_MAX_BYTES || 104857600); // 100MB drop cap

// On Windows, even after pty.kill() and onExit fire, descendant processes
// or antivirus/indexers can transiently hold the cwd. Retry rm with
// exponential backoff on EBUSY / EPERM / ENOTEMPTY.
// 8 attempts × 100ms base = 100+200+400+800+1600+3200+6400+12800 ≈ 25.5s total
// covering OneDrive/Defender scan windows and slow ConPTY teardown on Windows.
async function rmWithRetry(path, opts, { attempts = 8, baseDelayMs = 100 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(path, opts);
      return;
    } catch (e) {
      lastErr = e;
      const code = e?.code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw e;
      if (i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastErr;
}

// Force-kill the entire process tree rooted at pid using Windows taskkill.
// /F = force, /T = tree (including all child processes). Used before rm -rf
// on a session cwd to evict any descendant cmd/shell/editor/claude processes
// that outlived ConPTY teardown and would otherwise hold file handles.
// Best-effort: taskkill exit code 128 = "no such process" (already gone),
// which is the success case for us. All errors are swallowed and logged.
async function taskkillTree(pid, log) {
  if (!pid) return;
  try {
    await execFileAsync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
  } catch (e) {
    // Code 128 = process not found (already exited). That's fine.
    if (e?.code !== 128 && log) {
      log.warn({ err: e?.message, pid }, '[folder-delete] taskkill tree non-fatal');
    }
  }
}

function preflight() {
  const issues = [];
  if (!existsSync(WORKERS_ROOT)) issues.push(`WORKERS_ROOT missing: ${WORKERS_ROOT}`);
  for (let i = 0; i < WORKERS_COUNT; i++) {
    const dir = resolve(WORKERS_ROOT, `${WORKER_PREFIX}${i}`);
    if (!existsSync(dir)) issues.push(`worker dir missing: ${dir}`);
  }
  return issues;
}

const app = Fastify({
  logger: { level: 'info' },
  trustProxy: true,
  bodyLimit: 1024 * 256,
});

await app.register(fastifyCookie, { secret: COOKIE_SECRET });
await app.register(fastifyRateLimit, { global: false });
await app.register(fastifyWebsocket);
await app.register(fastifyMultipart, {
  limits: { fileSize: FILE_UPLOAD_MAX_BYTES, files: 1, fieldSize: 64 * 1024 },
});

app.addHook('onSend', (req, reply, payload, done) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  done(null, payload);
});

function requireAuth(req, reply) {
  const ok = auth.verifySessionCookie(req);
  if (!ok) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function requireCsrf(req, reply) {
  const expected = req.cookies[`${process.env.COOKIE_NAME || 'tabterm.sid'}.csrf`];
  const got = req.headers[CSRF_HEADER];
  if (!expected || !got || expected !== got) {
    reply.code(403).send({ error: 'csrf' });
    return false;
  }
  return true;
}

app.get('/api/auth/status', async () => ({
  setup: auth.isSetup(),
  cookieName: process.env.COOKIE_NAME || 'tabterm.sid',
}));

app.post('/api/auth/setup', {
  config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
}, async (req, reply) => {
  if (auth.isSetup()) return reply.code(409).send({ error: 'already-setup' });
  const { password } = req.body || {};
  if (!password || password.length < 12) return reply.code(400).send({ error: 'password-too-short' });
  await auth.setup(password);
  audit.log({ event: 'auth.setup', ip: req.ip });
  return { ok: true };
});

app.post('/api/auth/login', {
  config: {
    rateLimit: {
      max: Number(process.env.LOGIN_RATE_PER_MIN || 5),
      timeWindow: '1 minute',
      keyGenerator: (req) => `login:${req.ip}`,
    },
  },
}, async (req, reply) => {
  const { password } = req.body || {};
  const ok = await auth.login(password || '');
  if (!ok) {
    audit.log({ event: 'auth.login.fail', ip: req.ip });
    return reply.code(401).send({ error: 'invalid' });
  }
  const { sid, csrf, expires } = auth.issueSession();
  const cookieName = process.env.COOKIE_NAME || 'tabterm.sid';
  const secure = String(process.env.COOKIE_SECURE || 'true') === 'true';
  reply.setCookie(cookieName, sid, {
    httpOnly: true, sameSite: 'strict', secure, path: '/', expires,
  });
  reply.setCookie(`${cookieName}.csrf`, csrf, {
    httpOnly: false, sameSite: 'strict', secure, path: '/', expires,
  });
  audit.log({ event: 'auth.login.ok', ip: req.ip });
  return { ok: true };
});

app.post('/api/auth/logout', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const cookieName = process.env.COOKIE_NAME || 'tabterm.sid';
  const sid = req.cookies[cookieName];
  if (sid) auth.revokeSession(sid);
  reply.clearCookie(cookieName, { path: '/' });
  reply.clearCookie(`${cookieName}.csrf`, { path: '/' });
  audit.log({ event: 'auth.logout', ip: req.ip });
  return { ok: true };
});

app.get('/api/preflight', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const inv = buildClaudeInvocation();
  return {
    issues: preflight(),
    workersRoot: WORKERS_ROOT,
    workersCount: WORKERS_COUNT,
    workerPrefix: WORKER_PREFIX,
    claudeCommand: inv.cmd,
    claudeArgs: inv.argsStr,
    anthropicBaseUrl: ANTHROPIC_BASE_URL,
    hydra: { enabled: HYDRA_ENABLED, ...hydraStatus() },
    workerLabels: labelsStore.getWorkers(),
    labelsHealth: labelsStore.labelsHealth,
  };
});

app.post('/api/hydra/ensure', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  if (!HYDRA_ENABLED) return { ok: true, skipped: true };
  const r = await ensureHydraReady({ force: true });
  audit.log({ event: 'hydra.ensure', ready: r.ready, ip: req.ip });
  return r;
});

app.get('/api/sessions', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return { sessions: sessions.list() };
});

app.get('/api/sessions/folders', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  try {
    const folders = await listSessionFolders(WORKERS_ROOT, {
      workerPrefix: WORKER_PREFIX,
      sessionPrefix: NEW_SESSION_PREFIX,
    });
    return { folders };
  } catch (e) {
    app.log.error({ err: e?.message }, '[folders] enumerate failed');
    return reply.code(500).send({ error: 'folders-enumerate-failed' });
  }
});

app.get('/api/labels', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return { version: 1, workers: labelsStore.getWorkers() };
});

app.put('/api/labels/worker/:idx', {
  config: { rateLimit: false },
  bodyLimit: 1024,
}, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const raw = req.params.idx;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return reply.code(400).send({ error: 'bad_idx' });
  const idx = Number(raw);
  if (!Number.isSafeInteger(idx) || idx < 0 || idx >= WORKERS_COUNT) {
    return reply.code(400).send({ error: 'bad_idx' });
  }
  const v = validateLabel(req.body?.name);
  if (!v.ok) return reply.code(422).send({ error: 'validation', field: 'name', reason: v.error });

  try {
    const { label, changed } = await labelsStore.setWorkerLabel(idx, v.value);
    // Audit only on actual change — idempotent no-ops produce no log noise and
    // (per the queue-internal check in labels.js) cannot race with concurrent
    // identical PUTs to produce duplicate writes/audits.
    if (changed) {
      audit.log({
        event: 'label.set.worker',
        workerIndex: idx,
        length: v.value.length,
        cleared: v.value === '',
        ip: req.ip,
      });
    }
    return {
      ok: true,
      workerIndex: idx,
      label,
      workers: labelsStore.getWorkers(),
    };
  } catch (e) {
    app.log.error({ err: e?.message, workerIndex: idx }, '[labels] persist failed');
    audit.log({ event: 'labels.persist.failed', workerIndex: idx, errno: e?.code || e?.message });
    return reply.code(500).send({ error: 'labels_persist_failed' });
  }
});

app.put('/api/sessions/:id/label', {
  config: { rateLimit: false },
  bodyLimit: 1024,
}, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const v = validateLabel(req.body?.name);
  if (!v.ok) return reply.code(422).send({ error: 'validation', field: 'name', reason: v.error });
  if (v.value === '') return reply.code(422).send({ error: 'validation', field: 'name', reason: 'empty_not_allowed' });
  const id = req.params.id;
  const summary = sessions.setLabel(id, v.value);
  if (!summary) return reply.code(404).send({ error: 'session_not_found' });
  audit.log({
    event: 'label.set.session',
    id,
    length: v.value.length,
    cleared: false,
    ip: req.ip,
  });
  return { ok: true, id, label: summary.label, session: summary };
});

app.put('/api/sessions/folders/:name/label', {
  config: { rateLimit: false },
  bodyLimit: 1024,
}, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const v = validateSessionFolderName(req.params.name, {
    workerPrefix: WORKER_PREFIX,
    sessionPrefix: NEW_SESSION_PREFIX,
  });
  if (!v.ok) return reply.code(400).send({ error: 'bad-name', reason: v.error });
  const labelV = validateLabel(req.body?.name);
  if (!labelV.ok) return reply.code(422).send({ error: 'validation', field: 'name', reason: labelV.error });

  const cwd = resolve(WORKERS_ROOT, v.value);
  if (!existsSync(cwd)) return reply.code(404).send({ error: 'folder-not-found', cwd });

  try {
    await setFolderLabel(cwd, labelV.value);
  } catch (e) {
    app.log.error({ err: e?.message, cwd }, '[folder-label] persist failed');
    audit.log({ event: 'session.folder.label.set.failed', cwd, err: String(e?.message || e), ip: req.ip });
    return reply.code(500).send({ error: 'persist-failed' });
  }

  // 동일 cwd alive PTY 가 있으면 메모리 라벨 동기화
  const matched = sessions.list().filter((s) => s.kind === 'session' && s.cwd === cwd && s.alive);
  for (const s of matched) sessions.setLabel(s.id, labelV.value || v.value);

  audit.log({
    event: 'session.folder.label.set',
    cwd,
    length: labelV.value.length,
    cleared: labelV.value === '',
    matchedSessions: matched.length,
    ip: req.ip,
  });
  return { ok: true, folder: { name: v.value, cwd, label: labelV.value } };
});


// Extracted so /api/system/boot-all can spawn workers without re-implementing
// hydra preflight, env loading, audit logging, or args building. Returns
// { ok, session, envSource, envWarnings } on success or { ok: false, error: { code, body } }.
async function spawnWorkerSession({ workerIndex, label, cols, rows, ip, force = false }) {
  if (!Number.isInteger(workerIndex) || workerIndex < 0 || workerIndex >= WORKERS_COUNT) {
    return { ok: false, error: { code: 400, body: { error: 'workerIndex out of range' } } };
  }
  const cwd = resolve(WORKERS_ROOT, `${WORKER_PREFIX}${workerIndex}`);
  if (!existsSync(cwd)) {
    return { ok: false, error: { code: 400, body: { error: 'cwd missing', cwd } } };
  }

  // Paired-session guard: telegram bot only pairs with the most recent
  // claude.exe under STATE_DIR. Spawning a second worker-N strands the
  // older tab's bot link. Block on conflict; require explicit force=true
  // to evict.
  const existingSessions = sessions
    .list()
    .filter((s) => s.kind === 'worker' && s.workerIndex === workerIndex && s.alive);
  if (existingSessions.length > 0 && !force) {
    return {
      ok: false,
      error: {
        code: 409,
        body: {
          error: 'worker-session-exists',
          workerIndex,
          existingCount: existingSessions.length,
          existing: existingSessions.map((s) => ({
            id: s.id,
            label: s.label,
            createdAt: s.createdAt,
          })),
        },
      },
    };
  }

  if (HYDRA_ENABLED) {
    const r = await ensureHydraReady();
    if (!r.ready) {
      audit.log({ event: 'session.create.blocked', reason: 'hydra-not-ready', ip });
      return { ok: false, error: { code: 503, body: { error: 'hydra-not-ready', log: r.log } } };
    }
  }
  const inv = buildClaudeInvocation();
  const wEnv = await loadWorkerEnv(cwd);
  const extraEnv = { ANTHROPIC_BASE_URL, ...wEnv.env };
  const sessionLabel = label || `${WORKER_PREFIX}${workerIndex}`;

  // Evict path (force only): await sessions.kill so the PTY's onExit fires
  // before we spawn the replacement — otherwise the new bot races the old
  // one for the telegram poller. Then taskkill /F /T the bot.pid tree to
  // handle orphan bots whose parent CLI lives outside tabterm.
  if (force && existingSessions.length > 0) {
    await Promise.all(existingSessions.map(async (s) => {
      await sessions.kill(s.id);
      audit.log({ event: 'session.evict', id: s.id, workerIndex, ip });
    }));
    const botResult = await killStaleBot(wEnv.env.TELEGRAM_STATE_DIR);
    audit.log({ event: 'bot.evict', workerIndex, ...botResult, ip });
  }

  try {
    const s = sessions.create({
      label: sessionLabel,
      cwd,
      command: inv.cmd,
      claudeArgs: inv.argsStr,
      cols: Math.min(Math.max(Number(cols) || 120, 20), 400),
      rows: Math.min(Math.max(Number(rows) || 32, 8), 200),
      extraEnv,
      meta: { kind: 'worker', workerIndex },
      onExit: ({ id, exitCode }) => audit.log({ event: 'session.exit', id, exitCode, kind: 'worker' }),
    });
    audit.log({
      event: 'session.create',
      id: s.id,
      cwd,
      kind: 'worker',
      envSource: wEnv.source,
      envWarnings: wEnv.warnings,
      ip,
    });
    return { ok: true, session: s.summary(), envSource: wEnv.source, envWarnings: wEnv.warnings };
  } catch (e) {
    app.log.error(e);
    return { ok: false, error: { code: 500, body: { error: 'spawn-failed', message: String(e?.message || e) } } };
  }
}

app.post('/api/sessions', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const { label, kind, workerIndex, cols, rows, force, engine } = req.body || {};
  const sessionKind = kind === 'session' ? 'session' : 'worker';

  if (sessionKind === 'worker') {
    const r = await spawnWorkerSession({
      workerIndex, label, cols, rows, ip: req.ip,
      force: force === true,
    });
    if (!r.ok) return reply.code(r.error.code).send(r.error.body);
    return { session: r.session, envSource: r.envSource, envWarnings: r.envWarnings };
  }

  // general session — no ccx env. 두 모드:
  //   1) cwd 미지정 → 새 폴더 mkdir + tabterm.json 작성 (legacy POST 동작)
  //   2) cwd 지정 → 기존 폴더에 attach (validate 후), tabterm.json touch
  // engine: 'claude' (default) or 'opencode' — picks engine-specific command/args/env
  // Client may omit engine on folder-reattach (mode 2) — server then reads
  // from the folder's tabterm.json so previously-OpenCode folders relaunch as OpenCode.
  const explicitEngine = engine === 'opencode' ? 'opencode' : (engine === 'claude' ? 'claude' : null);

  let cwd;
  let folderName;
  let createdNow = false;

  if (req.body && typeof req.body.cwd === 'string') {
    // Mode 2: attach to existing folder
    const proposedPath = normalize(req.body.cwd);
    folderName = proposedPath.split(/[\\/]+/).pop() || '';
    const v = validateSessionFolderName(folderName, {
      workerPrefix: WORKER_PREFIX,
      sessionPrefix: NEW_SESSION_PREFIX,
    });
    if (!v.ok) return reply.code(400).send({ error: 'bad-cwd', reason: v.error });
    cwd = resolve(WORKERS_ROOT, folderName);
    // Defence in depth: even after basename validation, ensure the original
    // proposedPath resolves to exactly the same absolute path as WORKERS_ROOT/folderName.
    // Blocks traversal attempts like "C:/workspace/../foo/session-abc" where basename
    // looks fine but the parent path escapes WORKERS_ROOT.
    if (resolve(proposedPath) !== cwd) {
      return reply.code(400).send({ error: 'bad-cwd', reason: 'not-in-workspace' });
    }
    if (!existsSync(cwd)) {
      return reply.code(400).send({ error: 'bad-cwd', reason: 'missing', cwd });
    }
    // 동일 cwd alive PTY 검사
    const existing = sessions.list().filter(
      (s) => s.kind === 'session' && s.cwd === cwd && s.alive,
    );
    if (existing.length > 0 && !req.body.force) {
      return reply.code(409).send({
        error: 'session-folder-busy',
        cwd,
        existing: existing.map((s) => ({ id: s.id, createdAt: s.createdAt })),
      });
    }
    if (req.body.force && existing.length > 0) {
      await Promise.all(existing.map(async (s) => {
        await sessions.kill(s.id);
        audit.log({ event: 'session.folder.evict', id: s.id, cwd, ip: req.ip });
      }));
    }
  } else {
    // Mode 1: 신규 폴더 - compact name "session-NNNN" (4-digit random).
    // 10_000 namespace + atomic mkdir (non-recursive) for race-free collision detect.
    // Retry math: first-try success = (10_000 - N) / 10_000 (N = existing folders).
    // 50-retry combined success stays near 100% up to N≈9_000. Beyond that, archive
    // old sessions or extend digit width — see mkdir-exhausted branch below.
    try {
      await mkdir(WORKERS_ROOT, { recursive: true });
    } catch (e) {
      return reply.code(500).send({ error: 'mkdir-failed', message: `root: ${e?.message || e}` });
    }
    let created = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 50;
    while (attempts < MAX_ATTEMPTS && !created) {
      const num = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
      folderName = `${NEW_SESSION_PREFIX}${num}`;
      cwd = resolve(WORKERS_ROOT, folderName);
      try {
        await mkdir(cwd); // non-recursive: throws EEXIST on collision
        created = true;
        createdNow = true;
      } catch (e) {
        if (e?.code === 'EEXIST') { attempts++; continue; }
        return reply.code(500).send({ error: 'mkdir-failed', message: String(e?.message || e) });
      }
    }
    if (!created) {
      return reply.code(500).send({
        error: 'mkdir-exhausted',
        message: `Could not allocate unique ${NEW_SESSION_PREFIX}NNNN after ${MAX_ATTEMPTS} attempts. Archive old sessions or extend digit width.`,
      });
    }
  }

  // Resolve final engine: explicit body > folder meta (mode 2 reattach) > 'claude'.
  let sessionEngine = explicitEngine;
  if (sessionEngine === null && !createdNow) {
    try {
      const meta = await readFolderMeta(cwd);
      sessionEngine = meta.engine || 'claude';
    } catch { sessionEngine = 'claude'; }
  }
  if (sessionEngine === null) sessionEngine = 'claude';

  // For opencode sessions, pre-allocate a free TCP port so we can later
  // proxy /mcp /lsp /path /session/:id/message etc into the right-side sidebar
  // UI. Without --port, opencode binds a random port we have no clean way to
  // discover (TUI takes over PTY → no server banner; no documented lockfile or
  // OPENCODE_PORT env var). Claude sessions don't need this.
  let apiPort = null;
  if (sessionEngine === 'opencode') {
    try {
      apiPort = await allocFreePort();
    } catch (e) {
      app.log.warn({ err: String(e?.message || e) }, '[session] opencode port alloc failed; api sidebar disabled for this session');
      audit.log({ event: 'session.devplatform.port.alloc.failed', cwd, err: String(e?.message || e), ip: req.ip });
    }
  }
  const inv = buildEngineInvocation(sessionEngine, { port: apiPort });
  const claudeArgs = inv.sessionArgsStr;

  // tabterm.json 자동 작성 (Mode 1) 또는 touch (Mode 2)
  // Mode 2 + explicitEngine: persist new engine to meta so future folder-clicks
  // (which omit engine) honor the change instead of reverting to the stored value.
  try {
    if (createdNow) {
      await ensureMeta(cwd, {
        label: typeof label === 'string' ? label : '',
        engine: sessionEngine,
      });
    } else if (explicitEngine !== null) {
      const meta = await readFolderMeta(cwd);
      await writeFolderMeta(cwd, {
        label: meta.label,
        engine: explicitEngine,
        createdAt: meta.createdAt,
        lastUsedAt: Date.now(),
      });
    } else {
      await touchLastUsed(cwd);
    }
  } catch (e) {
    app.log.warn({ err: e?.message, cwd }, '[session] tabterm.json write failed');
    audit.log({ event: 'session.folder.meta.write.failed', cwd, err: String(e?.message || e), ip: req.ip });
    // 메타 실패는 PTY spawn 까지 막지 않음
  }

  const sessionLabel = label || folderName;
  try {
    // engine-specific env: opencode sessions point at Nopersb (18802),
    // claude sessions inherit HydraTeams default (3456).
    const sessionExtraEnv = sessionEngine === 'opencode'
      ? { ANTHROPIC_BASE_URL: inv.anthropicBaseUrl }
      : {};

    const s = sessions.create({
      label: sessionLabel,
      cwd,
      command: inv.cmd,
      claudeArgs,
      cols: Math.min(Math.max(Number(cols) || 120, 20), 400),
      rows: Math.min(Math.max(Number(rows) || 32, 8), 200),
      extraEnv: sessionExtraEnv,
      meta: { kind: 'session', workerIndex: null, engine: sessionEngine, apiPort },
      onExit: ({ id, exitCode }) => audit.log({ event: 'session.exit', id, exitCode, engine: sessionEngine, kind: 'session' }),
    });
    audit.log({
      event: createdNow ? 'session.folder.create' : 'session.folder.attach',
      id: s.id,
      cwd,
      kind: 'session',
      engine: sessionEngine,
      ip: req.ip,
    });
    return { session: s.summary(), envSource: 'none', envWarnings: [], cwd, folderName };
  } catch (e) {
    app.log.error(e);
    if (createdNow) {
      try {
        await rm(cwd, { recursive: true, force: true });
        audit.log({ event: 'session.folder.rollback', cwd, reason: 'spawn-failed', ip: req.ip });
      } catch (cleanupErr) {
        app.log.warn({ err: cleanupErr?.message, cwd }, '[session] rollback rm failed');
      }
    }
    return reply.code(500).send({ error: 'spawn-failed', message: String(e?.message || e) });
  }
});

registerSystemRoutes(app, {
  sessions,
  spawnWorkerSession,
  workersCount: WORKERS_COUNT,
  requireAuth,
  requireCsrf,
});

app.delete('/api/sessions/:id', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const ok = await sessions.kill(req.params.id);
  audit.log({ event: 'session.delete', id: req.params.id, ok, ip: req.ip });
  return { ok };
});

app.delete('/api/sessions/folders/:name', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const v = validateSessionFolderName(req.params.name, {
    workerPrefix: WORKER_PREFIX,
    sessionPrefix: NEW_SESSION_PREFIX,
  });
  if (v.error === 'worker-protected') {
    return reply.code(403).send({ error: 'worker-folder-protected' });
  }
  if (!v.ok) return reply.code(400).send({ error: 'bad-name', reason: v.error });

  const cwd = resolve(WORKERS_ROOT, v.value);
  // Defence in depth: ensure cwd is exactly a direct child of WORKERS_ROOT
  // (validateSessionFolderName already rejects path separators, but containment
  // check protects against future validate changes or env-dependent path normalization)
  const root = resolve(WORKERS_ROOT);
  const sep = cwd.includes('\\') ? '\\' : '/';
  if (!cwd.startsWith(root + sep)) {
    return reply.code(400).send({ error: 'bad-path' });
  }
  if (!existsSync(cwd)) return reply.code(404).send({ error: 'folder-not-found' });

  // 1) Snapshot PTY pids BEFORE kill — sessions.kill removes the session from
  //    the map, so we can't query pty.pid afterwards. Needed for step 2.
  const matched = sessions.list().filter((s) => s.kind === 'session' && s.cwd === cwd && s.alive);
  const ptyPids = matched
    .map((s) => sessions.getPtyPid(s.id))
    .filter((p) => p != null);

  // 2) Graceful kill via sessions.kill (awaits ConPTY onExit). Closes most
  //    handles cleanly. Step 3 catches the descendants that don't.
  await Promise.all(matched.map((s) => sessions.kill(s.id)));

  // 3) Force taskkill /F /T on each PTY's full process tree. ConPTY teardown
  //    can leave orphaned shell descendants (vim, tail, claude.exe etc) that
  //    hold file handles on cwd. Running taskkill AFTER sessions.kill is fine
  //    even though the parent pid may already be dead — Windows still tracks
  //    the tree by parent pid until the system reaps it.
  await Promise.all(ptyPids.map((pid) => taskkillTree(pid, app.log)));

  // 4) 폴더 자체 rm -rf, with EBUSY/EPERM/ENOTEMPTY retry (~25s total budget)
  try {
    await rmWithRetry(cwd, { recursive: true, force: true });
  } catch (e) {
    app.log.error({ err: e?.message, cwd, ptyPids }, '[folder-delete] rm failed');
    audit.log({ event: 'session.folder.delete.failed', cwd, err: String(e?.message || e), ip: req.ip });
    return reply.code(500).send({ error: 'rm-failed', message: String(e?.message || e) });
  }

  audit.log({
    event: 'session.folder.delete',
    cwd,
    killedSessions: matched.length,
    ip: req.ip,
  });
  return { ok: true, deleted: v.value };
});

// File explorer routes (Phase 1: read-only, jailed under WORKERS_ROOT/:name).
// Mutating ops (write/create/move/delete) deferred to Phase 2/3 with CSRF.
function resolveSessionCwd(req, reply) {
  const v = validateSessionFolderName(req.params.name, {
    subagentPrefix: WORKER_PREFIX,
    sessionPrefix: NEW_SESSION_PREFIX,
  });
  if (v.error === 'subagent-protected') {
    reply.code(403).send({ error: 'subagent-folder-protected' });
    return null;
  }
  if (!v.ok) {
    reply.code(400).send({ error: 'bad-name', reason: v.error });
    return null;
  }
  const cwd = resolve(WORKERS_ROOT, v.value);
  if (!existsSync(cwd)) {
    reply.code(404).send({ error: 'folder-not-found' });
    return null;
  }
  return cwd;
}

function sendFileExplorerError(reply, e, log) {
  if (e instanceof FileExplorerError) {
    return reply.code(e.statusCode).send({ error: e.code });
  }
  log.error(e);
  return reply.code(500).send({ error: 'internal' });
}

app.get('/api/sessions/folders/:name/fs/list', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const cwd = resolveSessionCwd(req, reply);
  if (!cwd) return;
  try {
    return await fxListDirectory(cwd, req.query?.path ?? '', {
      maxEntries: FILE_LIST_MAX_ENTRIES,
    });
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

app.get('/api/sessions/folders/:name/fs/read', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const cwd = resolveSessionCwd(req, reply);
  if (!cwd) return;
  try {
    return await fxReadTextFile(cwd, req.query?.path ?? '', {
      maxBytes: FILE_TEXT_MAX_BYTES,
    });
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

app.get('/api/sessions/folders/:name/fs/preview', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const cwd = resolveSessionCwd(req, reply);
  if (!cwd) return;
  try {
    return await fxStreamPreview(cwd, req.query?.path ?? '', reply, {
      maxBytes: FILE_PREVIEW_MAX_BYTES,
    });
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

// Phase 2 jailed write routes — all auth+CSRF gated. fxMkdir/fxDelete/fxRename
// reuse the same resolveSafePath jail as the read routes, so symlink-out and
// path-traversal vectors are covered identically.

app.post('/api/sessions/folders/:name/fs/mkdir', { bodyLimit: 4096 }, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const cwd = resolveSessionCwd(req, reply);
  if (!cwd) return;
  const path = req.body?.path;
  if (typeof path !== 'string') return reply.code(400).send({ error: 'missing-path' });
  try {
    const entry = await fxMkdir(cwd, path);
    audit.log({ event: 'fs.mkdir', cwd, path, ip: req.ip });
    return { ok: true, entry };
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

app.delete('/api/sessions/folders/:name/fs/entry', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const cwd = resolveSessionCwd(req, reply);
  if (!cwd) return;
  const path = req.query?.path;
  if (typeof path !== 'string' || path === '') return reply.code(400).send({ error: 'missing-path' });
  const recursive = req.query?.recursive === 'true';
  try {
    const r = await fxDelete(cwd, path, { recursive });
    audit.log({ event: 'fs.delete', cwd, path, recursive, ip: req.ip });
    return { ok: true, ...r };
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

app.patch('/api/sessions/folders/:name/fs/rename', { bodyLimit: 8192 }, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const cwd = resolveSessionCwd(req, reply);
  if (!cwd) return;
  const { from, to, overwrite } = req.body || {};
  if (typeof from !== 'string' || typeof to !== 'string') {
    return reply.code(400).send({ error: 'missing-from-or-to' });
  }
  try {
    const entry = await fxRename(cwd, from, to, { overwrite: overwrite === true });
    audit.log({ event: 'fs.rename', cwd, from, to, ip: req.ip });
    return { ok: true, entry };
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

app.put('/api/sessions/folders/:name/fs/write', { bodyLimit: FILE_WRITE_MAX_BYTES + 8192 }, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const cwd = resolveSessionCwd(req, reply);
  if (!cwd) return;
  const { path, content, expectedVersion, createIfMissing } = req.body || {};
  if (typeof path !== 'string') return reply.code(400).send({ error: 'missing-path' });
  if (typeof content !== 'string') return reply.code(400).send({ error: 'bad-content' });
  if (Buffer.byteLength(content, 'utf8') > FILE_WRITE_MAX_BYTES) {
    return reply.code(413).send({ error: 'too-large' });
  }
  try {
    const entry = await fxWriteText(cwd, path, content, {
      expectedVersion: expectedVersion || null,
      createIfMissing: createIfMissing === true,
    });
    audit.log({ event: 'fs.write', cwd, path, bytes: entry.version?.size, ip: req.ip });
    return { ok: true, entry };
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

// Multipart upload — single "file" part. Client sends ?dir=<relDir> (default '')
// and the part's filename becomes the leaf. autosuffix=true picks "name (1).ext"
// on collision instead of erroring (Telegram-drop style — never silent overwrite).
app.post('/api/sessions/folders/:name/fs/upload', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const cwd = resolveSessionCwd(req, reply);
  if (!cwd) return;
  if (!req.isMultipart()) return reply.code(400).send({ error: 'expect-multipart' });

  const dir = typeof req.query?.dir === 'string' ? req.query.dir : '';
  const autosuffix = req.query?.autosuffix !== 'false';
  const overwrite = req.query?.overwrite === 'true';

  let data;
  try {
    data = await req.file();
  } catch (e) {
    return reply.code(400).send({ error: 'multipart-parse-failed', message: String(e?.message || e) });
  }
  if (!data) return reply.code(400).send({ error: 'no-file-part' });

  const filename = sanitizeUploadName(data.filename);
  if (!filename) return reply.code(400).send({ error: 'bad-filename' });
  const relPath = dir ? `${dir.replace(/\/+$/, '')}/${filename}` : filename;

  try {
    const entry = await fxWriteUpload(cwd, relPath, data.file, {
      autosuffix, overwrite,
      maxBytes: FILE_UPLOAD_MAX_BYTES,
    });
    audit.log({ event: 'fs.upload', cwd, path: relPath, bytes: entry.bytesWritten, ip: req.ip });
    return { ok: true, entry };
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

// Posix-only basename — strip any directory separators a client might inject
// via the multipart filename field. The leaf still goes through validateRelPath
// (via writeUpload → resolveSafePath) so the only thing this guard does is
// reject filenames that BEGIN with traversal characters before they get there.
function sanitizeUploadName(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  const base = raw.replace(/[\\/]+/g, '_').replace(/^\.+/, '');
  if (!base || base.length > 255) return '';
  return base;
}

// Global filesystem explorer (auth-only, no folder jail). Powers the sidebar
// "Explorer" tab so users can browse anywhere their OS user can read.
async function listDrivesWindows() {
  try {
    const { stdout } = await execFileAsync(
      'wmic.exe',
      ['logicaldisk', 'get', 'caption,drivetype'],
      { windowsHide: true },
    );
    const out = [];
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^([A-Z]):\s+(\d+)/);
      if (!m) continue;
      const letter = m[1];
      const type = Number(m[2]);
      if (type === 0 || type === 5) continue;
      out.push(`${letter}:/`);
    }
    if (out.length === 0) out.push('C:/');
    return out;
  } catch {
    return ['C:/'];
  }
}

app.get('/api/fs/drives', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const drives = process.platform === 'win32' ? await listDrivesWindows() : ['/'];
  return { drives };
});

app.get('/api/fs/list', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const path = req.query?.path;
  if (!path) return reply.code(400).send({ error: 'missing-path' });
  try {
    return await fxListAbs(path, { maxEntries: FILE_LIST_MAX_ENTRIES });
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

app.get('/api/fs/read', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const path = req.query?.path;
  if (!path) return reply.code(400).send({ error: 'missing-path' });
  try {
    return await fxReadAbs(path, { maxBytes: FILE_TEXT_MAX_BYTES });
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

app.get('/api/fs/preview', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const path = req.query?.path;
  if (!path) return reply.code(400).send({ error: 'missing-path' });
  try {
    return await fxStreamAbs(path, reply, { maxBytes: FILE_PREVIEW_MAX_BYTES });
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

// Phase 2 absolute write routes — auth+CSRF gated, no folder jail.
// Mirror the jailed routes but accept absolute paths (Windows drive-letter or
// posix root). Powers global Explorer tab actions + terminal drag-drop into
// session cwd (which can be a subagent dir, outside any jail).

app.post('/api/fs/mkdir', { bodyLimit: 8192 }, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const path = req.body?.path;
  if (typeof path !== 'string') return reply.code(400).send({ error: 'missing-path' });
  try {
    const entry = await fxMkdirAbs(path);
    audit.log({ event: 'fs.mkdir.abs', path, ip: req.ip });
    return { ok: true, entry };
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

app.delete('/api/fs/entry', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const path = req.query?.path;
  if (!path) return reply.code(400).send({ error: 'missing-path' });
  const recursive = req.query?.recursive === 'true';
  try {
    const r = await fxDeleteAbs(path, { recursive });
    audit.log({ event: 'fs.delete.abs', path, recursive, ip: req.ip });
    return { ok: true, ...r };
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

app.patch('/api/fs/rename', { bodyLimit: 16384 }, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const { from, to, overwrite } = req.body || {};
  if (typeof from !== 'string' || typeof to !== 'string') {
    return reply.code(400).send({ error: 'missing-from-or-to' });
  }
  try {
    const entry = await fxRenameAbs(from, to, { overwrite: overwrite === true });
    audit.log({ event: 'fs.rename.abs', from, to, ip: req.ip });
    return { ok: true, entry };
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

app.put('/api/fs/write', { bodyLimit: FILE_WRITE_MAX_BYTES + 8192 }, async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  const { path, content, expectedVersion, createIfMissing } = req.body || {};
  if (typeof path !== 'string') return reply.code(400).send({ error: 'missing-path' });
  if (typeof content !== 'string') return reply.code(400).send({ error: 'bad-content' });
  if (Buffer.byteLength(content, 'utf8') > FILE_WRITE_MAX_BYTES) {
    return reply.code(413).send({ error: 'too-large' });
  }
  try {
    const entry = await fxWriteTextAbs(path, content, {
      expectedVersion: expectedVersion || null,
      createIfMissing: createIfMissing === true,
    });
    audit.log({ event: 'fs.write.abs', path, bytes: entry.version?.size, ip: req.ip });
    return { ok: true, entry };
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

app.post('/api/fs/upload', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  if (!requireCsrf(req, reply)) return;
  if (!req.isMultipart()) return reply.code(400).send({ error: 'expect-multipart' });

  const dir = typeof req.query?.dir === 'string' ? req.query.dir : '';
  if (!dir) return reply.code(400).send({ error: 'missing-dir' });
  const autosuffix = req.query?.autosuffix !== 'false';
  const overwrite = req.query?.overwrite === 'true';

  let data;
  try {
    data = await req.file();
  } catch (e) {
    return reply.code(400).send({ error: 'multipart-parse-failed', message: String(e?.message || e) });
  }
  if (!data) return reply.code(400).send({ error: 'no-file-part' });

  const filename = sanitizeUploadName(data.filename);
  if (!filename) return reply.code(400).send({ error: 'bad-filename' });
  const targetAbs = resolve(dir, filename);

  try {
    const entry = await fxWriteUploadAbs(targetAbs, data.file, {
      autosuffix, overwrite,
      maxBytes: FILE_UPLOAD_MAX_BYTES,
    });
    audit.log({ event: 'fs.upload.abs', path: targetAbs, bytes: entry.bytesWritten, ip: req.ip });
    return { ok: true, entry };
  } catch (e) {
    return sendFileExplorerError(reply, e, app.log);
  }
});

await app.register(fastifyStatic, {
  root: resolve(ROOT, 'public'),
  prefix: '/',
  cacheControl: false,
  setHeaders(res, p) {
    if (p.endsWith('sw.js') || p.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
});

registerWs(app, { auth });

const shuttingDown = { v: false };
async function shutdown(sig) {
  if (shuttingDown.v) return;
  shuttingDown.v = true;
  app.log.info(`[shutdown] signal=${sig}, killing ${sessions.list().length} sessions`);
  sessions.killAll();
  stopWatchdog(app.log);
  audit.log({ event: 'server.shutdown', signal: sig });
  try { await app.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGBREAK', () => shutdown('SIGBREAK'));

await auth.load();
const labelsStore = await createLabelsStore({
  dataDir: resolve(ROOT, 'data'),
  workersCount: WORKERS_COUNT,
  logger: app.log,
});
if (labelsStore.labelsHealth !== 'ok') {
  audit.log({ event: 'labels.load.recovered', from: labelsStore.labelsHealth === 'restored_from_bak' ? 'bak' : 'reset' });
}
const issues = preflight();
if (issues.length) {
  app.log.warn({ issues }, '[preflight] some worker dirs missing — sessions will fail until fixed');
}

if (HYDRA_ENABLED) {
  app.log.info('[hydra] preflight start');
  const r = await ensureHydraReady({ force: true });
  if (r.ready) {
    app.log.info('[hydra] ready');
  } else {
    app.log.warn({ log: r.log }, '[hydra] NOT ready — workers needing ANTHROPIC_BASE_URL will fail');
  }
  audit.log({ event: 'hydra.preflight', ready: r.ready });
}

// ---- opencode API proxy ----
// Registered from server/dp-proxy.js (extracted so the routes are e2e-testable
// against an isolated Fastify instance + fake upstream without booting the full server).
registerDpProxy(app, { sessions, requireAuth });

const wdResult = await startWatchdog(app.log);
audit.log({ event: 'watchdog.start', ...wdResult });

await app.listen({ host: HOST, port: PORT });
app.log.info(`tabterm listening on http://${HOST}:${PORT}`);
audit.log({ event: 'server.start', host: HOST, port: PORT });
