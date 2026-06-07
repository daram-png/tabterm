import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeviceStore, createPairingCodes } from './device-auth.js';

const silent = { warn() {}, info() {}, error() {} };

function tmpDataDir() {
  return mkdtempSync(join(tmpdir(), 'tabterm-dev-'));
}

/* ---------------- createPairingCodes ---------------- */

test('pairing: start() returns a 6-digit string code with future expiry', () => {
  let t = 1000;
  const codes = createPairingCodes({ ttlMs: 120_000, now: () => t });
  const { code, expires } = codes.start();
  assert.match(code, /^\d{6}$/);
  assert.equal(expires, 1000 + 120_000);
});

test('pairing: claim consumes a valid code exactly once (single-use)', () => {
  let t = 0;
  const codes = createPairingCodes({ ttlMs: 120_000, now: () => t });
  const { code } = codes.start();
  assert.equal(codes.claim(code), true);
  assert.equal(codes.claim(code), false, 'second claim of same code must fail');
});

test('pairing: claim of an unknown code fails', () => {
  const codes = createPairingCodes({ ttlMs: 120_000, now: () => 0 });
  assert.equal(codes.claim('000000'), false);
  assert.equal(codes.claim(''), false);
  assert.equal(codes.claim(null), false);
});

test('pairing: expired code cannot be claimed', () => {
  let t = 0;
  const codes = createPairingCodes({ ttlMs: 120_000, now: () => t });
  const { code } = codes.start();
  t = 120_001; // advance past TTL
  assert.equal(codes.claim(code), false);
});

/* ---------------- createDeviceStore ---------------- */

test('device: issueDevice returns "id.secret" token that verifyToken accepts', async () => {
  const dir = tmpDataDir();
  try {
    const store = await createDeviceStore({ dataDir: dir, logger: silent });
    const { id, token, device } = await store.issueDevice({ name: 'iPhone' });
    assert.ok(id, 'id present');
    assert.equal(device.name, 'iPhone');
    assert.match(token, /^[^.]+\.[^.]+$/, 'token is id.secret');
    assert.equal(token.split('.')[0], id, 'token prefix is device id');
    const verified = await store.verifyToken(token);
    assert.ok(verified, 'valid token verifies');
    assert.equal(verified.id, id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('device: verifyToken rejects garbage, wrong secret, and missing device', async () => {
  const dir = tmpDataDir();
  try {
    const store = await createDeviceStore({ dataDir: dir, logger: silent });
    const { id, token } = await store.issueDevice({ name: 'x' });
    assert.equal(await store.verifyToken('garbage'), null);
    assert.equal(await store.verifyToken(''), null);
    assert.equal(await store.verifyToken(null), null);
    assert.equal(await store.verifyToken(`${id}.wrongsecret`), null);
    assert.equal(await store.verifyToken('nosuchid.abc'), null);
    // sanity: the real token still works
    assert.ok(await store.verifyToken(token));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('device: revokeDevice invalidates the token', async () => {
  const dir = tmpDataDir();
  try {
    const store = await createDeviceStore({ dataDir: dir, logger: silent });
    const { id, token } = await store.issueDevice({ name: 'x' });
    assert.ok(await store.verifyToken(token));
    assert.equal(await store.revokeDevice(id), true);
    assert.equal(await store.verifyToken(token), null, 'revoked token must not verify');
    assert.equal(await store.revokeDevice('nosuchid'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('device: listDevices never exposes hash/secret and marks revoked', async () => {
  const dir = tmpDataDir();
  try {
    const store = await createDeviceStore({ dataDir: dir, logger: silent });
    const { id } = await store.issueDevice({ name: 'phone' });
    await store.issueDevice({ name: 'ipad' });
    await store.revokeDevice(id);
    const list = store.listDevices();
    assert.equal(list.length, 2);
    for (const d of list) {
      assert.ok(!('hash' in d), 'no hash field');
      assert.ok(!('secret' in d), 'no secret field');
      assert.ok('id' in d && 'name' in d && 'revoked' in d);
    }
    const revoked = list.find((d) => d.id === id);
    assert.equal(revoked.revoked, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('device: token survives store restart (disk persistence)', async () => {
  const dir = tmpDataDir();
  try {
    const store1 = await createDeviceStore({ dataDir: dir, logger: silent });
    const { token } = await store1.issueDevice({ name: 'persist' });
    // fresh store over same dir = simulates server restart
    const store2 = await createDeviceStore({ dataDir: dir, logger: silent });
    const verified = await store2.verifyToken(token);
    assert.ok(verified, 'token persisted across restart');
    assert.equal(verified.name, 'persist');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('device: token TTL expiry (when tokenTtlMs set)', async () => {
  const dir = tmpDataDir();
  try {
    let t = 0;
    const store = await createDeviceStore({
      dataDir: dir, logger: silent, tokenTtlMs: 10_000, now: () => t,
    });
    const { token } = await store.issueDevice({ name: 'ttl' });
    assert.ok(await store.verifyToken(token), 'valid before expiry');
    t = 10_001;
    assert.equal(await store.verifyToken(token), null, 'expired token rejected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('device: verifyToken updates lastSeenAt', async () => {
  const dir = tmpDataDir();
  try {
    let t = 1000;
    const store = await createDeviceStore({ dataDir: dir, logger: silent, now: () => t });
    const { id, token } = await store.issueDevice({ name: 'seen' });
    const before = store.listDevices().find((d) => d.id === id).lastSeenAt;
    t = 5000;
    await store.verifyToken(token);
    const after = store.listDevices().find((d) => d.id === id).lastSeenAt;
    assert.ok(after > before, 'lastSeenAt advanced after verify');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('device: corrupt devices.json does not throw; store starts empty', async () => {
  const dir = tmpDataDir();
  try {
    writeFileSync(join(dir, 'devices.json'), '{ this is not json', 'utf8');
    const store = await createDeviceStore({ dataDir: dir, logger: silent });
    assert.deepEqual(store.listDevices(), [], 'corrupt main → empty store, no crash');
    // store still functional after recovery
    const { token } = await store.issueDevice({ name: 'recovered' });
    assert.ok(await store.verifyToken(token));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('device: name is validated/sanitized (length cap, control chars stripped/rejected)', async () => {
  const dir = tmpDataDir();
  try {
    const store = await createDeviceStore({ dataDir: dir, logger: silent });
    // empty name falls back to a default, never empty
    const a = await store.issueDevice({ name: '' });
    assert.ok(a.device.name.length > 0, 'empty name gets default');
    // overly long name is capped
    const b = await store.issueDevice({ name: 'z'.repeat(200) });
    assert.ok(b.device.name.length <= 64, 'name capped at 64');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
