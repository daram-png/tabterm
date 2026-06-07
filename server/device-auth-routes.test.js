// Integration tests for device-auth HTTP routes (registerDeviceAuth).
// Isolated Fastify + fastify-cookie + real store/codes + fake auth, driven via
// app.inject. Focus: the security-critical route behaviors (auth gating, CSRF,
// token→session exchange, pairing/password issue, revoke).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createDeviceStore, createPairingCodes, registerDeviceAuth } from './device-auth.js';

const silent = { warn() {}, info() {}, error() {} };
const COOKIE = 'tabterm.sid';
const CSRF_HEADER = 'x-tabterm-csrf';
const VALID_SID = 'valid-sid';
const TEST_PASSWORD = 'test-password-1234';

function makeAuth() {
  return {
    verifySessionCookie(req) { return req.cookies?.[COOKIE] === VALID_SID; },
    verifySid(sid) { return sid === VALID_SID; },
    issueSession() { return { sid: 'issued-sid', csrf: 'issued-csrf', expires: new Date(Date.now() + 60_000) }; },
    async login(pw) { return pw === TEST_PASSWORD; },
    revokeSession() {},
  };
}

// Test doubles mirroring index.js requireAuth/requireCsrf semantics.
function makeGuards(auth) {
  const requireAuth = (req, reply) => {
    if (!auth.verifySessionCookie(req)) { reply.code(401).send({ error: 'unauthorized' }); return false; }
    return true;
  };
  const requireCsrf = (req, reply) => {
    const expected = req.cookies[`${COOKIE}.csrf`];
    const got = req.headers[CSRF_HEADER];
    if (!expected || !got || expected !== got) { reply.code(403).send({ error: 'csrf' }); return false; }
    return true;
  };
  return { requireAuth, requireCsrf };
}

async function buildApp(dir) {
  const auth = makeAuth();
  const { requireAuth, requireCsrf } = makeGuards(auth);
  const store = await createDeviceStore({ dataDir: dir, logger: silent });
  const codes = createPairingCodes({});
  const app = Fastify();
  await app.register(fastifyCookie);
  registerDeviceAuth(app, {
    auth, requireAuth, requireCsrf, store, codes,
    cookieName: COOKIE, cookieSecure: false, csrfHeader: CSRF_HEADER,
  });
  await app.ready();
  return { app, store, codes };
}

const authedHeaders = {
  cookie: `${COOKIE}=${VALID_SID}; ${COOKIE}.csrf=csrf-val`,
  [CSRF_HEADER]: 'csrf-val',
};

function withTmp(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabterm-route-'));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

test('route: device/session with valid token sets a session cookie', withTmp(async (dir) => {
  const { app, store } = await buildApp(dir);
  const { token } = await store.issueDevice({ name: 'iPhone' });
  const res = await app.inject({ method: 'POST', url: '/api/auth/device/session', payload: { token } });
  assert.equal(res.statusCode, 200);
  const setCookie = String(res.headers['set-cookie'] || '');
  assert.match(setCookie, new RegExp(`${COOKIE}=`), 'session cookie issued');
  await app.close();
}));

test('route: device/session with invalid token → 401, no cookie', withTmp(async (dir) => {
  const { app } = await buildApp(dir);
  const res = await app.inject({ method: 'POST', url: '/api/auth/device/session', payload: { token: 'bogus.token' } });
  assert.equal(res.statusCode, 401);
  assert.ok(!res.headers['set-cookie'], 'no cookie on failure');
  await app.close();
}));

test('route: device/session accepts Bearer token too', withTmp(async (dir) => {
  const { app, store } = await buildApp(dir);
  const { token } = await store.issueDevice({ name: 'x' });
  const res = await app.inject({
    method: 'POST', url: '/api/auth/device/session',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  await app.close();
}));

test('route: pair/start requires auth (401 without cookie)', withTmp(async (dir) => {
  const { app } = await buildApp(dir);
  const res = await app.inject({ method: 'POST', url: '/api/auth/pair/start' });
  assert.equal(res.statusCode, 401);
  await app.close();
}));

test('route: pair/start with auth returns a code', withTmp(async (dir) => {
  const { app } = await buildApp(dir);
  const res = await app.inject({ method: 'POST', url: '/api/auth/pair/start', headers: authedHeaders });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.match(body.code, /^\d{6}$/);
  await app.close();
}));

test('route: pair/claim with valid code issues a working token', withTmp(async (dir) => {
  const { app } = await buildApp(dir);
  const start = await app.inject({ method: 'POST', url: '/api/auth/pair/start', headers: authedHeaders });
  const { code } = start.json();
  const claim = await app.inject({ method: 'POST', url: '/api/auth/pair/claim', payload: { code, name: 'iPhone' } });
  assert.equal(claim.statusCode, 200);
  const { token } = claim.json();
  assert.ok(token, 'token returned');
  // the issued token must authenticate a session exchange
  const sess = await app.inject({ method: 'POST', url: '/api/auth/device/session', payload: { token } });
  assert.equal(sess.statusCode, 200);
  await app.close();
}));

test('route: pair/claim with bad code → 401', withTmp(async (dir) => {
  const { app } = await buildApp(dir);
  const res = await app.inject({ method: 'POST', url: '/api/auth/pair/claim', payload: { code: '000000' } });
  assert.equal(res.statusCode, 401);
  await app.close();
}));

test('route: device/register issues token only with correct password', withTmp(async (dir) => {
  const { app } = await buildApp(dir);
  const bad = await app.inject({ method: 'POST', url: '/api/auth/device/register', payload: { password: 'wrong', name: 'p' } });
  assert.equal(bad.statusCode, 401);
  const ok = await app.inject({ method: 'POST', url: '/api/auth/device/register', payload: { password: TEST_PASSWORD, name: 'p' } });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.json().token);
  await app.close();
}));

test('route: devices GET requires auth; lists after issue', withTmp(async (dir) => {
  const { app, store } = await buildApp(dir);
  await store.issueDevice({ name: 'one' });
  const noauth = await app.inject({ method: 'GET', url: '/api/auth/devices' });
  assert.equal(noauth.statusCode, 401);
  const res = await app.inject({ method: 'GET', url: '/api/auth/devices', headers: authedHeaders });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().devices.length, 1);
  await app.close();
}));

test('route: devices DELETE needs CSRF and then revokes the token', withTmp(async (dir) => {
  const { app, store } = await buildApp(dir);
  const { id, token } = await store.issueDevice({ name: 'kill' });
  // missing CSRF header → 403
  const noCsrf = await app.inject({
    method: 'DELETE', url: `/api/auth/devices/${id}`,
    headers: { cookie: `${COOKIE}=${VALID_SID}; ${COOKIE}.csrf=csrf-val` },
  });
  assert.equal(noCsrf.statusCode, 403);
  // with CSRF → 200, token then invalid
  const ok = await app.inject({ method: 'DELETE', url: `/api/auth/devices/${id}`, headers: authedHeaders });
  assert.equal(ok.statusCode, 200);
  const sess = await app.inject({ method: 'POST', url: '/api/auth/device/session', payload: { token } });
  assert.equal(sess.statusCode, 401, 'revoked token cannot exchange');
  await app.close();
}));
