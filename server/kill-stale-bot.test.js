// Tests for killStaleBot — the helper that taskkill /F /T's a worker's
// stale telegram bot tree before spawning a replacement worker session.
//
// We don't actually kill real processes here. Cases that hit the alive
// branch use process.pid (current process) as the target so isAlive returns
// true; we then assert killPidTree was attempted but DON'T let it succeed
// against ourselves — taskkill on this process would tear the test runner
// down. Instead we use an obviously-unreachable PID for the kill path tests
// and rely on the isAlive(pid, 0) ping to short-circuit before taskkill.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killStaleBot } from './kill-stale-bot.js';

function tmpStateDir() {
  return mkdtempSync(join(tmpdir(), 'tabterm-killstale-'));
}

test('killStaleBot: no stateDir → returns reason no-state-dir', async () => {
  const r = await killStaleBot('');
  assert.equal(r.killed, false);
  assert.equal(r.reason, 'no-state-dir');
  const r2 = await killStaleBot(undefined);
  assert.equal(r2.killed, false);
  assert.equal(r2.reason, 'no-state-dir');
});

test('killStaleBot: stateDir without bot.pid → no-pid-file', async () => {
  const dir = tmpStateDir();
  try {
    const r = await killStaleBot(dir);
    assert.equal(r.killed, false);
    assert.equal(r.reason, 'no-pid-file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('killStaleBot: bot.pid with non-numeric content → invalid-pid', async () => {
  const dir = tmpStateDir();
  try {
    writeFileSync(join(dir, 'bot.pid'), 'not-a-pid');
    const r = await killStaleBot(dir);
    assert.equal(r.killed, false);
    assert.equal(r.reason, 'invalid-pid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('killStaleBot: bot.pid with pid 0 / 1 → invalid-pid (guard against kill -1)', async () => {
  for (const bad of ['0', '1', '-5']) {
    const dir = tmpStateDir();
    try {
      writeFileSync(join(dir, 'bot.pid'), bad);
      const r = await killStaleBot(dir);
      assert.equal(r.killed, false);
      assert.equal(r.reason, 'invalid-pid', `pid ${bad} should be invalid`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('killStaleBot: bot.pid pointing to a dead PID → already-dead with pid echoed', async () => {
  const dir = tmpStateDir();
  try {
    // 999999 is well above typical PID ranges on Win/Linux; isAlive returns
    // false via process.kill(pid, 0) throwing ESRCH (or ERROR_INVALID_PARAMETER).
    writeFileSync(join(dir, 'bot.pid'), '999999');
    const r = await killStaleBot(dir);
    assert.equal(r.killed, false);
    assert.equal(r.reason, 'already-dead');
    assert.equal(r.pid, 999999);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('killStaleBot: trailing whitespace in bot.pid is tolerated', async () => {
  const dir = tmpStateDir();
  try {
    writeFileSync(join(dir, 'bot.pid'), '  999998\n');
    const r = await killStaleBot(dir);
    // parseInt tolerates leading whitespace; trailing \n is fine too. The
    // PID itself is dead, so we expect already-dead, NOT invalid-pid.
    assert.equal(r.reason, 'already-dead');
    assert.equal(r.pid, 999998);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('killStaleBot: never throws even with absurd input', async () => {
  // null stateDir
  await assert.doesNotReject(killStaleBot(null));
  // stateDir that does not exist on disk
  await assert.doesNotReject(killStaleBot('/this/path/does/not/exist/anywhere'));
  // pid file with garbage
  const dir = tmpStateDir();
  try {
    writeFileSync(join(dir, 'bot.pid'), '\x00\x01\x02');
    await assert.doesNotReject(killStaleBot(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
