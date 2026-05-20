import { writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import readline from 'node:readline';
import { stdin, stdout } from 'node:process';

const scryptAsync = promisify(scrypt);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUTH_FILE = resolve(ROOT, process.env.AUTH_FILE || 'data/auth.json');

const SCRYPT = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024, keylen: 64 };

function prompt(q, masked = false) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    if (masked) {
      stdout.write(q);
      let buf = '';
      const onData = (ch) => {
        const c = ch.toString();
        if (c === '\n' || c === '\r' || c === '\x04') {
          stdin.removeListener('data', onData);
          stdin.setRawMode?.(false);
          stdout.write('\n');
          rl.close();
          res(buf);
        } else if (c === '\x03') {
          stdin.setRawMode?.(false);
          stdout.write('\n');
          process.exit(1);
        } else if (c === '\b' || c === '\x7f') {
          buf = buf.slice(0, -1);
        } else {
          buf += c;
        }
      };
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.on('data', onData);
    } else {
      rl.question(q, (a) => { rl.close(); res(a); });
    }
  });
}

await mkdir(dirname(AUTH_FILE), { recursive: true });
try {
  await access(AUTH_FILE);
  const ow = await prompt('auth.json already exists. Overwrite? (y/N) ');
  if (ow.trim().toLowerCase() !== 'y') process.exit(0);
} catch {}

const pw = await prompt('New password (min 12 chars): ', true);
if (!pw || pw.length < 12) {
  console.error('Password too short.');
  process.exit(1);
}
const pw2 = await prompt('Confirm password: ', true);
if (pw !== pw2) {
  console.error('Mismatch.');
  process.exit(1);
}

const salt = randomBytes(16);
const t0 = Date.now();
const hash = await scryptAsync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
const ms = Date.now() - t0;

const data = {
  v: 1,
  scrypt: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen, maxmem: SCRYPT.maxmem },
  salt: salt.toString('base64'),
  hash: hash.toString('base64'),
  createdAt: new Date().toISOString(),
};
await writeFile(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
console.log(`Saved ${AUTH_FILE} (scrypt ${ms}ms).`);
