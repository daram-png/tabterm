// Regression test for the PTY kill vs rm EBUSY race on Windows.
//
// What we cover here:
//   1. sessions.kill(id) returns a Promise that resolves AFTER onExit fires.
//   2. Subsequent fs.rm on the PTY cwd succeeds even immediately after kill
//      resolves (i.e. the awaitable kill is sufficient on a quiescent shell).
//   3. The rmWithRetry-style backoff swallows transient EBUSY by retrying.
//
// rmWithRetry itself lives in server/index.js; this test reproduces the same
// logic inline rather than importing index.js (which boots the full server).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessions } from './sessions.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'tabterm-pty-kill-race-'));
}

async function rmWithRetry(path, opts, { attempts = 5, baseDelayMs = 50 } = {}) {
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

test('sessions.kill awaits PTY onExit before resolving', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, 'marker.txt'), 'hello');
  const s = sessions.create({
    label: 'race-test', cwd,
    command: process.platform === 'win32' ? 'cmd' : 'sh',
    cols: 80, rows: 24,
    meta: { kind: 'session' },
  });
  assert.equal(s.alive, true);

  // give the PTY a beat to fully spawn
  await new Promise((r) => setTimeout(r, 200));

  const killed = await sessions.kill(s.id);
  assert.equal(killed, true, 'sessions.kill should return true');

  // After awaiting kill, the PTY's own alive flag must be false (i.e. onExit
  // fired). This is the contract the folder DELETE handler relies on.
  assert.equal(s.pty.alive, false, 'pty.alive must be false after kill resolves');

  // The map should no longer contain the session.
  assert.equal(sessions.get(s.id), undefined);

  // Cleanup
  await rmWithRetry(cwd, { recursive: true, force: true });
});

test('rm on PTY cwd succeeds after awaited kill', async () => {
  const cwd = tmp();
  writeFileSync(join(cwd, 'a.txt'), '1');
  const s = sessions.create({
    label: 'race-rm', cwd,
    command: process.platform === 'win32' ? 'cmd' : 'sh',
    cols: 80, rows: 24,
    meta: { kind: 'session' },
  });

  await new Promise((r) => setTimeout(r, 200));
  await sessions.kill(s.id);

  // Without onExit-await this would frequently throw EBUSY on Windows; with
  // it, rmWithRetry's first attempt should suffice in the common case.
  await rmWithRetry(cwd, { recursive: true, force: true });
  assert.equal(existsSync(cwd), false);
});

test('rmWithRetry retries on EBUSY and eventually succeeds', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'f.txt'), 'x');

  let attempts = 0;
  const fakeRm = async () => {
    attempts++;
    if (attempts < 3) {
      const err = new Error('EBUSY: simulated');
      err.code = 'EBUSY';
      throw err;
    }
    rmSync(dir, { recursive: true, force: true });
  };

  // Inline copy of rmWithRetry with the rm fn injected, to exercise retry
  // semantics without needing a real EBUSY to occur.
  async function rmWithRetryInj(rmFn, attemptsMax = 5, baseDelayMs = 10) {
    let lastErr;
    for (let i = 0; i < attemptsMax; i++) {
      try { await rmFn(); return; }
      catch (e) {
        lastErr = e;
        if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'ENOTEMPTY') throw e;
        if (i === attemptsMax - 1) break;
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
      }
    }
    throw lastErr;
  }

  await rmWithRetryInj(fakeRm);
  assert.equal(attempts, 3, 'should have retried twice before succeeding on attempt 3');
  assert.equal(existsSync(dir), false);
});

test('rmWithRetry rethrows non-EBUSY errors immediately', async () => {
  let attempts = 0;
  const fakeRm = async () => {
    attempts++;
    const err = new Error('ENOSPC: disk full');
    err.code = 'ENOSPC';
    throw err;
  };
  async function rmWithRetryInj(rmFn) {
    let lastErr;
    for (let i = 0; i < 5; i++) {
      try { await rmFn(); return; }
      catch (e) {
        lastErr = e;
        if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'ENOTEMPTY') throw e;
      }
    }
    throw lastErr;
  }
  await assert.rejects(rmWithRetryInj(fakeRm), /ENOSPC/);
  assert.equal(attempts, 1, 'should not retry on ENOSPC');
});

test('sessions.kill is idempotent (second call returns false)', async () => {
  const cwd = tmp();
  const s = sessions.create({
    label: 'idem', cwd,
    command: process.platform === 'win32' ? 'cmd' : 'sh',
    cols: 80, rows: 24,
    meta: { kind: 'session' },
  });
  await new Promise((r) => setTimeout(r, 100));
  const first = await sessions.kill(s.id);
  const second = await sessions.kill(s.id);
  assert.equal(first, true);
  assert.equal(second, false);
  await rmWithRetry(cwd, { recursive: true, force: true });
});
