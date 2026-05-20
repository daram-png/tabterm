import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUTH_FILE = resolve(ROOT, process.env.AUTH_FILE || 'data/auth.json');

class Auth {
  #data = null;
  #sessions = new Map();

  isSetup() {
    return !!this.#data;
  }

  async load() {
    try {
      await access(AUTH_FILE);
      const raw = await readFile(AUTH_FILE, 'utf8');
      this.#data = JSON.parse(raw);
    } catch {
      this.#data = null;
    }
  }

  async setup(password) {
    const salt = randomBytes(16);
    const opts = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
    const hash = await scryptAsync(password, salt, 64, opts);
    const data = {
      v: 1,
      scrypt: { N: opts.N, r: opts.r, p: opts.p, keylen: 64, maxmem: opts.maxmem },
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      createdAt: new Date().toISOString(),
    };
    await mkdir(dirname(AUTH_FILE), { recursive: true });
    await writeFile(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    this.#data = data;
  }

  async login(password) {
    if (!this.#data) return false;
    const { salt, hash, scrypt: p } = this.#data;
    const saltBuf = Buffer.from(salt, 'base64');
    const expected = Buffer.from(hash, 'base64');
    const got = await scryptAsync(password, saltBuf, p.keylen || 64, {
      N: p.N, r: p.r, p: p.p, maxmem: p.maxmem,
    });
    if (got.length !== expected.length) return false;
    return timingSafeEqual(got, expected);
  }

  issueSession() {
    const sid = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const ttl = Number(process.env.SESSION_TTL_HOURS || 168) * 3600 * 1000;
    const expires = new Date(Date.now() + ttl);
    this.#sessions.set(sid, { csrf, expires: expires.getTime() });
    this.#gc();
    return { sid, csrf, expires };
  }

  revokeSession(sid) {
    this.#sessions.delete(sid);
  }

  verifySessionCookie(req) {
    const cookieName = process.env.COOKIE_NAME || 'tabterm.sid';
    const sid = req.cookies?.[cookieName];
    if (!sid) return false;
    const s = this.#sessions.get(sid);
    if (!s) return false;
    if (Date.now() > s.expires) {
      this.#sessions.delete(sid);
      return false;
    }
    return true;
  }

  verifySid(sid) {
    if (!sid) return false;
    const s = this.#sessions.get(sid);
    if (!s) return false;
    if (Date.now() > s.expires) {
      this.#sessions.delete(sid);
      return false;
    }
    return true;
  }

  #gc() {
    const now = Date.now();
    for (const [k, v] of this.#sessions) if (now > v.expires) this.#sessions.delete(k);
  }
}

export const auth = new Auth();
