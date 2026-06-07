// device-auth.js — persistent per-device token store + ephemeral pairing codes.
//
// The "app engine": a durable device credential (survives server restart) that an
// iPhone PWA exchanges for a normal cookie session on each launch. Existing routes
// and the WS handler stay cookie-authed and untouched — only ONE new endpoint
// (/api/auth/device/session) consumes a device token, so blast radius is minimal.
//
// Security model (see docs/superpowers/specs/2026-06-07-tabterm-ios-app-design.md):
//   - Device token = "<id>.<secret>". secret is 32 bytes of CSPRNG randomness.
//   - We store ONLY sha256(secret) (hex). Plaintext token is returned exactly once,
//     at issue time. SHA-256 (not scrypt) is the correct choice for a 256-bit random
//     token — there is nothing to brute-force, and scrypt would only add latency.
//   - Lookup is O(1) by id prefix, then a single timing-safe hash comparison.
//   - Pairing codes are ephemeral (in-memory, single-use, short TTL) — only a token
//     is persisted, so a 6-digit code is never a standing credential.

import { join } from 'node:path';
import {
  readFile, writeFile, rename, unlink, mkdir, stat,
} from 'node:fs/promises';
import { randomBytes, createHash, timingSafeEqual, randomInt } from 'node:crypto';

const SCHEMA_VERSION = 1;
const CONTROL_RE = /[\x00-\x1f\x7f]/g;
const NAME_MAX = 64;
const DEFAULT_NAME = 'device';

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function sanitizeName(input) {
  if (typeof input !== 'string') return DEFAULT_NAME;
  const cleaned = input.replace(CONTROL_RE, '').trim().slice(0, NAME_MAX);
  return cleaned === '' ? DEFAULT_NAME : cleaned;
}

/* ---------------- pairing codes (ephemeral, in-memory) ---------------- */

// A pairing code proves "an already-authenticated browser approved this device".
// Single-use + short TTL so a leaked/observed code is near-worthless. Nothing is
// persisted: codes die with the process, which is correct — only tokens are durable.
export function createPairingCodes({ ttlMs = 120_000, now = () => Date.now() } = {}) {
  const codes = new Map(); // code -> { expires }

  function gc() {
    const t = now();
    for (const [code, rec] of codes) if (t > rec.expires) codes.delete(code);
  }

  function start() {
    gc();
    // 6 digits, zero-padded, from a CSPRNG (randomInt is uniform, no modulo bias).
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expires = now() + ttlMs;
    codes.set(code, { expires });
    return { code, expires };
  }

  function claim(code) {
    if (typeof code !== 'string' || code === '') return false;
    gc();
    const rec = codes.get(code);
    if (!rec) return false;
    codes.delete(code); // single-use: consume regardless of outcome below
    if (now() > rec.expires) return false;
    return true;
  }

  return { start, claim };
}

/* ---------------- device token store (persistent) ---------------- */

async function safeReadJson(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function isValidSchema(raw) {
  return raw && typeof raw === 'object' && raw.v === SCHEMA_VERSION && Array.isArray(raw.devices);
}

function publicView(d) {
  return {
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    revoked: !!d.revokedAt,
  };
}

export async function createDeviceStore({
  dataDir, logger, tokenTtlMs = 0, now = () => Date.now(),
} = {}) {
  const log = logger || { warn() {}, info() {}, error() {} };
  await mkdir(dataDir, { recursive: true });
  const mainPath = join(dataDir, 'devices.json');
  const bakPath = join(dataDir, 'devices.json.bak');

  let devices = []; // [{ id, name, hash, createdAt, lastSeenAt, revokedAt }]

  // load: main (valid) → else bak (valid, restore main) → else start empty.
  const mainRaw = await safeReadJson(mainPath);
  if (isValidSchema(mainRaw)) {
    devices = mainRaw.devices.filter((d) => d && typeof d.id === 'string' && typeof d.hash === 'string');
  } else {
    const bakRaw = await safeReadJson(bakPath);
    if (isValidSchema(bakRaw)) {
      devices = bakRaw.devices.filter((d) => d && typeof d.id === 'string' && typeof d.hash === 'string');
      log.warn?.('[device-auth] devices.json corrupt/missing — restored from .bak');
    } else if (await pathExists(mainPath)) {
      log.error?.('[device-auth] devices.json + .bak unusable — starting empty');
    }
  }

  // serialized write queue — prevents interleaved writers from clobbering each other.
  let writing = Promise.resolve();

  async function writeAtomic() {
    const payload = JSON.stringify({ v: SCHEMA_VERSION, devices }, null, 2);
    const tmp = join(dataDir, `devices.json.tmp-${process.pid}-${now()}-${randomBytes(4).toString('hex')}`);
    await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    if (await pathExists(mainPath)) {
      try { await rename(mainPath, bakPath); } catch (e) { log.warn?.('[device-auth] bak rotate failed:', e?.message); }
    }
    try {
      await rename(tmp, mainPath);
    } catch (e) {
      try { await unlink(tmp); } catch {}
      throw e;
    }
  }

  function persist() {
    const job = writing.then(() => writeAtomic());
    writing = job.catch(() => {}); // queue survives a failed write
    return job;
  }

  async function issueDevice({ name } = {}) {
    const id = randomBytes(9).toString('base64url'); // 12 url-safe chars, never contains '.'
    const secret = randomBytes(32).toString('base64url');
    const t = now();
    const device = {
      id,
      name: sanitizeName(name),
      hash: sha256Hex(secret),
      createdAt: t,
      lastSeenAt: t,
      revokedAt: null,
    };
    devices.push(device);
    await persist();
    return { id, token: `${id}.${secret}`, device: publicView(device) };
  }

  function findById(id) {
    return devices.find((d) => d.id === id) || null;
  }

  async function verifyToken(token) {
    if (typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return null;
    const id = token.slice(0, dot);
    const secret = token.slice(dot + 1);

    const device = findById(id);
    if (!device || device.revokedAt) return null;
    if (tokenTtlMs > 0 && now() - device.createdAt > tokenTtlMs) return null;

    const expected = Buffer.from(device.hash, 'hex');
    const got = createHash('sha256').update(secret, 'utf8').digest();
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;

    device.lastSeenAt = now();
    await persist();
    return publicView(device);
  }

  function listDevices() {
    return devices.map(publicView);
  }

  async function revokeDevice(id) {
    const device = findById(id);
    if (!device) return false;
    if (!device.revokedAt) {
      device.revokedAt = now();
      await persist();
    }
    return true;
  }

  return { issueDevice, verifyToken, listDevices, revokeDevice };
}
