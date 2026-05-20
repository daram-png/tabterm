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
import { startWatchdog, stopWatchdog } from './watchdog.js';
import { registerSystemRoutes } from './system.js';

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

  // general session — no ccx env, fresh dir under WORKERS_ROOT
  const inv = buildClaudeInvocation();
  const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const rand = randomBytes(2).toString('hex');
  const name = `${NEW_SESSION_PREFIX}${ts}-${rand}`;
  const cwd = resolve(WORKERS_ROOT, name);
  try {
    await mkdir(cwd, { recursive: true });
  } catch (e) {
    return reply.code(500).send({ error: 'mkdir-failed', message: String(e?.message || e) });
  }
  const sessionLabel = label || name;
  const claudeArgs = process.env.SESSION_CLAUDE_ARGS || '';
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
      event: 'session.create',
      id: s.id,
      cwd,
      kind: 'session',
      envSource: 'none',
      envWarnings: [],
      ip: req.ip,
    });
    return { session: s.summary(), envSource: 'none', envWarnings: [] };
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
