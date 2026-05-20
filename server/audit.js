import { appendFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = resolve(ROOT, process.env.AUDIT_FILE || 'data/audit.log');

let ready = false;
async function ensure() {
  if (ready) return;
  await mkdir(dirname(FILE), { recursive: true });
  ready = true;
}

export const audit = {
  log(obj) {
    const line = JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n';
    ensure().then(() => appendFile(FILE, line).catch(() => {})).catch(() => {});
  },
};
