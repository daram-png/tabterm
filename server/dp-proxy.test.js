// e2e tests for the opencode API proxy (server/dp-proxy.js).
//
// True end-to-end: a real fake "opencode" HTTP server stands in for the
// upstream API on apiPort, a real Fastify instance mounts the production proxy
// routes via registerDpProxy(), and we drive them over real HTTP (app.listen +
// fetch). The browser → tabterm proxy → upstream path is exercised verbatim,
// including streaming SSE relay and abort-on-disconnect.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import Fastify from 'fastify';
import { registerDpProxy } from './dp-proxy.js';

// ---- fake opencode upstream (the process that would bind apiPort) ----
let upstream;
let upstreamPort;
let upstreamState; // mutable per-test routing behaviour
let sseClients = 0;

function startUpstream() {
  return new Promise((res) => {
    upstream = createServer((req, reply) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;

      if (path === '/event') {
        if (upstreamState.eventStatus && upstreamState.eventStatus !== 200) {
          reply.writeHead(upstreamState.eventStatus);
          reply.end();
          return;
        }
        sseClients++;
        reply.writeHead(200, { 'content-type': 'text/event-stream' });
        reply.write('event: hello\ndata: {"n":1}\n\n');
        const t = setInterval(() => {
          reply.write(`event: tick\ndata: {"t":${Date.now()}}\n\n`);
        }, 20);
        req.on('close', () => { clearInterval(t); sseClients--; });
        return;
      }

      if (path === '/path') {
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(JSON.stringify({ directory: 'C:/workspace/demo', worktree: 'C:/workspace/demo', home: 'C:/Users/x' }));
        return;
      }
      if (path === '/mcp') {
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(JSON.stringify({ memory: { status: 'connected' }, github: { status: 'error' } }));
        return;
      }
      if (path === '/echo-qs') {
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(JSON.stringify({ qs: url.search }));
        return;
      }
      reply.writeHead(404, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ error: 'upstream-404' }));
    });
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = upstream.address().port;
      res();
    });
  });
}

// ---- fake sessions store ----
function makeSessions(map) {
  return { get: (id) => map.get(id) };
}

let app;
let base;
let sessionMap;

before(async () => {
  upstreamState = {};
  await startUpstream();

  sessionMap = new Map();
  // devplatform session wired to the live fake upstream
  sessionMap.set('dp-1', { meta: { apiPort: 0 /* set below */ } });
  sessionMap.get('dp-1').meta.apiPort = upstreamPort;
  // a claude session (no apiPort)
  sessionMap.set('claude-1', { meta: { apiPort: null, engine: 'claude' } });
  // a opencode session whose upstream port points nowhere (connection refused)
  sessionMap.set('dp-dead', { meta: { apiPort: 1 } });

  app = Fastify({ logger: false });
  registerDpProxy(app, { sessions: makeSessions(sessionMap) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app.close();
  await new Promise((r) => upstream.close(r));
});

beforeEach(() => { upstreamState = {}; });

// ---------------- GET wildcard proxy ----------------

test('GET /dp/path → proxies upstream JSON 200', async () => {
  const r = await fetch(`${base}/api/sessions/dp-1/dp/path`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /application\/json/);
  const body = await r.json();
  assert.equal(body.directory, 'C:/workspace/demo');
});

test('GET /dp/mcp → relays upstream payload verbatim', async () => {
  const r = await fetch(`${base}/api/sessions/dp-1/dp/mcp`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.memory.status, 'connected');
  assert.equal(body.github.status, 'error');
});

test('GET proxy forwards query string to upstream', async () => {
  const r = await fetch(`${base}/api/sessions/dp-1/dp/echo-qs?foo=bar&x=1`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.qs, '?foo=bar&x=1');
});

test('GET proxy preserves upstream non-200 status (404)', async () => {
  const r = await fetch(`${base}/api/sessions/dp-1/dp/nope`);
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.equal(body.error, 'upstream-404');
});

test('GET proxy → 404 when session unknown', async () => {
  const r = await fetch(`${base}/api/sessions/ghost/dp/path`);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'session-not-found');
});

test('GET proxy → 503 when session has no apiPort (claude)', async () => {
  const r = await fetch(`${base}/api/sessions/claude-1/dp/path`);
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.equal(body.error, 'no-api-port');
  assert.equal(body.reason, 'not-a-opencode-session-or-port-alloc-failed');
});

test('GET proxy → 400 when subpath contains ".." (traversal guard)', async () => {
  // Note: undici/fetch normalizes a real "/../" navigation segment away before
  // sending, so we exercise the handler's `subPath.includes('..')` guard with a
  // single segment that embeds "..". This is exactly the substring the guard
  // rejects to block traversal attempts that survive routing.
  const r = await fetch(`${base}/api/sessions/dp-1/dp/evil..config`);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'bad-path');
});

test('GET proxy → 400 on control char in subpath (raw request bypasses client normalization)', async () => {
  // fetch refuses control chars in URLs, so send a raw HTTP request with a
  // literal %01 that Fastify decodes into a control byte → guard returns 400.
  const status = await new Promise((res, rej) => {
    const u = new URL(base);
    const r = httpRequest(
      { host: u.hostname, port: u.port, path: '/api/sessions/dp-1/dp/foo%01bar', method: 'GET' },
      (resp) => { resp.resume(); res(resp.statusCode); },
    );
    r.on('error', rej);
    r.end();
  });
  assert.equal(status, 400);
});

test('GET proxy → 400 on literal "/../" traversal via raw socket', async () => {
  // Bypass undici normalization entirely: write the request line by hand so the
  // literal "/../" reaches Fastify and the handler's guard.
  const u = new URL(base);
  const raw = await new Promise((res, rej) => {
    const sock = netConnect({ host: u.hostname, port: Number(u.port) }, () => {
      sock.write(
        'GET /api/sessions/dp-1/dp/../secret HTTP/1.1\r\n' +
        `Host: ${u.hostname}:${u.port}\r\nConnection: close\r\n\r\n`,
      );
    });
    let buf = '';
    sock.on('data', (d) => { buf += d.toString(); });
    sock.on('end', () => res(buf));
    sock.on('error', rej);
  });
  const statusLine = raw.split('\r\n')[0];
  // Either the handler guard (400) or the router (404) must reject — never a
  // 200 that proxies an escaped path upstream.
  assert.match(statusLine, /\b(400|404)\b/, `traversal must be rejected, got: ${statusLine}`);
});

test('GET proxy → 502 when upstream connection fails', async () => {
  const r = await fetch(`${base}/api/sessions/dp-dead/dp/path`);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, 'upstream');
});

// ---------------- SSE relay ----------------

test('SSE /dp/event → 404 unknown session', async () => {
  const r = await fetch(`${base}/api/sessions/ghost/dp/event`, { headers: { accept: 'text/event-stream' } });
  assert.equal(r.status, 404);
  await r.body?.cancel();
});

test('SSE /dp/event → 503 no apiPort', async () => {
  const r = await fetch(`${base}/api/sessions/claude-1/dp/event`, { headers: { accept: 'text/event-stream' } });
  assert.equal(r.status, 503);
  await r.body?.cancel();
});

test('SSE /dp/event → relays upstream stream then aborts upstream on disconnect', async () => {
  const ctrl = new AbortController();
  const r = await fetch(`${base}/api/sessions/dp-1/dp/event`, {
    headers: { accept: 'text/event-stream' },
    signal: ctrl.signal,
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/event-stream/);

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let acc = '';
  // read until we see the upstream 'hello' event (proves end-to-end relay)
  while (!acc.includes('event: hello')) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += dec.decode(value, { stream: true });
  }
  assert.match(acc, /: ok/);          // proxy preamble
  assert.match(acc, /event: hello/);  // upstream payload relayed

  assert.equal(sseClients, 1, 'upstream should have exactly one subscriber while connected');

  // client disconnects → proxy must abort upstream fetch → upstream req 'close'
  ctrl.abort();
  await reader.cancel().catch(() => {});

  // wait for upstream to observe the close (req.raw.on('close', cleanup) → controller.abort)
  const deadline = Date.now() + 2000;
  while (sseClients !== 0 && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.equal(sseClients, 0, 'upstream subscriber must be released after client disconnect (no zombie)');
});

test('SSE /dp/event → writes error frame when upstream returns non-200', async () => {
  upstreamState.eventStatus = 500;
  const r = await fetch(`${base}/api/sessions/dp-1/dp/event`, { headers: { accept: 'text/event-stream' } });
  assert.equal(r.status, 200); // proxy already committed 200 + preamble before contacting upstream
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let acc = '';
  const deadline = Date.now() + 2000;
  while (!acc.includes('event: error') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += dec.decode(value, { stream: true });
  }
  assert.match(acc, /event: error/);
  assert.match(acc, /"status":500/);
  await reader.cancel().catch(() => {});
});

// ---------------- registration guard ----------------

test('registerDpProxy throws without a sessions store', () => {
  assert.throws(() => registerDpProxy(Fastify({ logger: false }), {}), /sessions store/);
});
