// Hardening from the post-push security re-audit:
//  1. authRateLimitKey — rate-limit on the real TCP peer, not the spoofable
//     X-Forwarded-For (trustProxy:true makes req.ip client-controlled).
//  2. isProtectedAbsolutePath — the global file explorer must refuse to read the
//     server's own data/ dir (auth.json password hash, devices.json token hashes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRateLimitKey } from './device-auth.js';
import { isProtectedAbsolutePath } from './file-explorer.js';

const DATA_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'data');

/* ---------------- authRateLimitKey ---------------- */

test('rate-key: uses the real socket address, NOT the spoofable X-Forwarded-For', () => {
  const req = {
    socket: { remoteAddress: '100.64.0.5' },
    ip: '9.9.9.9', // what trustProxy derived from a spoofed XFF
    headers: { 'x-forwarded-for': '9.9.9.9' },
  };
  assert.equal(authRateLimitKey(req), '100.64.0.5');
});

test('rate-key: an attacker rotating X-Forwarded-For cannot rotate the key', () => {
  const k1 = authRateLimitKey({ socket: { remoteAddress: '127.0.0.1' }, ip: '1.1.1.1' });
  const k2 = authRateLimitKey({ socket: { remoteAddress: '127.0.0.1' }, ip: '2.2.2.2' });
  assert.equal(k1, k2, 'same TCP peer → same key regardless of XFF');
});

test('rate-key: falls back to req.ip then a constant when no socket', () => {
  assert.equal(authRateLimitKey({ ip: '5.5.5.5' }), '5.5.5.5');
  assert.equal(authRateLimitKey({}), 'global');
  assert.equal(authRateLimitKey(null), 'global');
});

/* ---------------- isProtectedAbsolutePath ---------------- */

test('protected-path: the secret stores under data/ are refused', () => {
  assert.equal(isProtectedAbsolutePath(resolvePath(DATA_DIR, 'auth.json')), true);
  assert.equal(isProtectedAbsolutePath(resolvePath(DATA_DIR, 'devices.json')), true);
  assert.equal(isProtectedAbsolutePath(DATA_DIR), true);
});

test('protected-path: normalizes .. so the data dir cannot be reached indirectly', () => {
  assert.equal(isProtectedAbsolutePath(resolvePath(DATA_DIR, 'sub', '..', 'auth.json')), true);
});

test('protected-path: Windows case-insensitive — uppercase data path still protected', () => {
  if (process.platform !== 'win32') return; // Windows paths are case-insensitive
  assert.equal(isProtectedAbsolutePath(resolvePath(DATA_DIR, 'auth.json').toUpperCase()), true);
});

test('protected-path: unrelated absolute paths are allowed', () => {
  assert.equal(isProtectedAbsolutePath(resolvePath(DATA_DIR, '..', 'server', 'index.js')), false);
  assert.equal(isProtectedAbsolutePath('C:/Users/x/notes.txt'), false);
  assert.equal(isProtectedAbsolutePath(''), false);
  assert.equal(isProtectedAbsolutePath(null), false);
});
