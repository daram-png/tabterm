// Unit/integration tests for the devplatform port-alloc + invocation wiring
// that backs the dp-proxy feature:
//   - allocFreePort()        (server/config.js)
//   - buildEngineInvocation() port injection           (server/config.js)
//   - PtySession.summary().apiPort passthrough          (server/sessions.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { allocFreePort, buildEngineInvocation } from './config.js';
import { sessions } from './sessions.js';

// ---------------- allocFreePort ----------------

test('allocFreePort returns a usable, bindable TCP port', async () => {
  const port = await allocFreePort();
  assert.equal(typeof port, 'number');
  assert.ok(port > 0 && port < 65536, `port in range: ${port}`);

  // The returned port must actually be bindable (the whole point: hand it to
  // the opencode child to bind). Bind it ourselves to prove it's free.
  await new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(port, '127.0.0.1', () => srv.close(res));
  });
});

test('allocFreePort returns distinct ports across calls', async () => {
  const a = await allocFreePort();
  const b = await allocFreePort();
  const c = await allocFreePort();
  // Ephemeral allocation should not hand back the same port back-to-back.
  assert.ok(new Set([a, b, c]).size >= 2, `expected variety, got ${a},${b},${c}`);
});

// ---------------- buildEngineInvocation ----------------

test('buildEngineInvocation(opencode, {port}) injects --port + --hostname', () => {
  const inv = buildEngineInvocation('opencode', { port: 45678 });
  assert.match(inv.sessionArgsStr, /--port 45678/);
  assert.match(inv.sessionArgsStr, /--hostname 127\.0\.0\.1/);
  assert.equal(inv.cmd, process.env.OPENCODE_COMMAND || 'opencode');
});

test('buildEngineInvocation(opencode) without port omits --port', () => {
  const inv = buildEngineInvocation('opencode');
  assert.doesNotMatch(inv.sessionArgsStr, /--port/);
  assert.doesNotMatch(inv.sessionArgsStr, /--hostname/);
});

test('buildEngineInvocation(opencode, {port:null}) omits --port (alloc-failed path)', () => {
  const inv = buildEngineInvocation('opencode', { port: null });
  assert.doesNotMatch(inv.sessionArgsStr, /--port/);
});

test('buildEngineInvocation merges SESSION_OPENCODE_ARGS with port args', () => {
  const prev = process.env.SESSION_OPENCODE_ARGS;
  process.env.SESSION_OPENCODE_ARGS = '--model gpt-5';
  try {
    const inv = buildEngineInvocation('opencode', { port: 9999 });
    assert.match(inv.sessionArgsStr, /--model gpt-5/);
    assert.match(inv.sessionArgsStr, /--port 9999 --hostname 127\.0\.0\.1/);
    // base args come first, port args appended, single-spaced, trimmed
    assert.equal(inv.sessionArgsStr, '--model gpt-5 --port 9999 --hostname 127.0.0.1');
  } finally {
    if (prev === undefined) delete process.env.SESSION_OPENCODE_ARGS;
    else process.env.SESSION_OPENCODE_ARGS = prev;
  }
});

test('buildEngineInvocation(claude) ignores port entirely', () => {
  const inv = buildEngineInvocation('claude', { port: 12345 });
  assert.doesNotMatch(inv.sessionArgsStr || '', /--port/);
  assert.equal(inv.cmd, process.env.CLAUDE_COMMAND || 'claude');
});

// ---------------- session summary apiPort passthrough ----------------

test('PtySession.summary() exposes meta.apiPort for opencode sessions', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tabterm-dp-summary-'));
  let s;
  try {
    s = sessions.create({
      label: 'dp-summary',
      cwd,
      command: process.platform === 'win32' ? 'cmd' : 'sh',
      cols: 80,
      rows: 24,
      meta: { kind: 'session', engine: 'opencode', apiPort: 54321 },
    });
    await new Promise((r) => setTimeout(r, 150));
    const sum = s.summary();
    assert.equal(sum.engine, 'opencode');
    assert.equal(sum.apiPort, 54321);
    // and it is exposed through the public store listing too
    const listed = sessions.list().find((x) => x.id === s.id);
    assert.equal(listed.apiPort, 54321);
  } finally {
    if (s) await sessions.kill(s.id).catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('PtySession.summary() apiPort is null when meta omits it (claude session)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tabterm-claude-summary-'));
  let s;
  try {
    s = sessions.create({
      label: 'claude-summary',
      cwd,
      command: process.platform === 'win32' ? 'cmd' : 'sh',
      cols: 80,
      rows: 24,
      meta: { kind: 'session', engine: 'claude' },
    });
    await new Promise((r) => setTimeout(r, 150));
    const sum = s.summary();
    assert.equal(sum.engine, 'claude');
    assert.equal(sum.apiPort, null);
  } finally {
    if (s) await sessions.kill(s.id).catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
  }
});
