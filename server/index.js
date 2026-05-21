import dotenv from 'dotenv';
dotenv.config({ override: true });
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { resolve, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

import { auth } from './auth.js';
import { sessions } from './sessions.js';
import { registerWs } from './ws.js';
import { audit } from './audit.js';
import { ensureHydraReady, hydraStatus } from './hydra.js';
import { loadWorkerEnv, buildClaudeInvocation } from './config.js';
import {
  listSessionFolders,
  validateSessionFolderName,
  ensureMeta,
  touchLastUsed,
} from './session-folder.js';
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


// Extracted so /api/system/boot-all can spawn workers without re-implementing
// hydra preflight, env loading, audit logging, or args building. Returns
// { ok, session, envSource, envWarnings } on success or { ok: false, error: { code, body } }.
async function spawnWorkerSession({ workerIndex, label, cols, rows, ip }) {
  if (!Number.isInteger(workerIndex) || workerIndex < 0 || workerIndex >= WORKERS_COUNT) {
    return { ok: false, error: { code: 400, body: { error: 'workerIndex out of range' } } };
  }
  const cwd = resolve(WORKERS_ROOT, `${WORKER_PREFIX}${workerIndex}`);
  if (!existsSync(cwd)) {
    return { ok: false, error: { code: 400, body: { error: 'cwd missing', cwd } } };
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
  const { label, kind, workerIndex, cols, rows } = req.body || {};
  const sessionKind = kind === 'session' ? 'session' : 'worker';

  if (sessionKind === 'worker') {
    const r = await spawnWorkerSession({ workerIndex, label, cols, rows, ip: req.ip });
    if (!r.ok) return reply.code(r.error.code).send(r.error.body);
    return { session: r.session, envSource: r.envSource, envWarnings: r.envWarnings };
  }

  // general session — no ccx env. 두 모드:
  //   1) cwd 미지정 → 새 폴더 mkdir + tabterm.json 작성 (legacy POST 동작)
  //   2) cwd 지정 → 기존 폴더에 attach (validate 후), tabterm.json touch
  const inv = buildClaudeInvocation();
  const claudeArgs = process.env.SESSION_CLAUDE_ARGS || '';

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
      for (const s of existing) {
        sessions.kill(s.id);
        audit.log({ event: 'session.folder.evict', id: s.id, cwd, ip: req.ip });
      }
    }
  } else {
    // Mode 1: 신규 폴더
    const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const rand = randomBytes(2).toString('hex');
    folderName = `${NEW_SESSION_PREFIX}${ts}-${rand}`;
    cwd = resolve(WORKERS_ROOT, folderName);
    try {
      await mkdir(cwd, { recursive: true });
      createdNow = true;
    } catch (e) {
      return reply.code(500).send({ error: 'mkdir-failed', message: String(e?.message || e) });
    }
  }

  // tabterm.json 자동 작성 (Mode 1) 또는 touch (Mode 2)
  try {
    if (createdNow) {
      await ensureMeta(cwd, { label: typeof label === 'string' ? label : '' });
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
    const s = sessions.create({
      label: sessionLabel,
      cwd,
      command: inv.cmd,
      claudeArgs,
      cols: Math.min(Math.max(Number(cols) || 120, 20), 400),
      rows: Math.min(Math.max(Number(rows) || 32, 8), 200),
      extraEnv: {},
      meta: { kind: 'session', workerIndex: null },
      onExit: ({ id, exitCode }) => audit.log({ event: 'session.exit', id, exitCode, kind: 'session' }),
    });
    audit.log({
      event: createdNow ? 'session.folder.create' : 'session.folder.attach',
      id: s.id,
      cwd,
      kind: 'session',
      ip: req.ip,
    });
    return { session: s.summary(), envSource: 'none', envWarnings: [], cwd, folderName };
  } catch (e) {
    app.log.error(e);
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
  const ok = sessions.kill(req.params.id);
  audit.log({ event: 'session.delete', id: req.params.id, ok, ip: req.ip });
  return { ok };
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

const wdResult = await startWatchdog(app.log);
audit.log({ event: 'watchdog.start', ...wdResult });

await app.listen({ host: HOST, port: PORT });
app.log.info(`tabterm listening on http://${HOST}:${PORT}`);
audit.log({ event: 'server.start', host: HOST, port: PORT });
