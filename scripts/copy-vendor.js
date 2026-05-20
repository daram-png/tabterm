import { cp, mkdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = resolve(ROOT, 'public', 'vendor');

const files = [
  ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['node_modules/split.js/dist/split.min.js', 'split.min.js'],
];

await mkdir(VENDOR, { recursive: true });
for (const [src, dst] of files) {
  const from = resolve(ROOT, src);
  try {
    await access(from);
  } catch {
    console.warn('[copy-vendor] skip missing:', src);
    continue;
  }
  await cp(from, resolve(VENDOR, dst));
}
console.log('[copy-vendor] done');
