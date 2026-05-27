#!/usr/bin/env node
/*
 * scripts/gen-splash.mjs
 *
 * Generate 5 apple-touch-startup-image PNGs for tabterm PWA splash screens.
 * Pure Node stdlib (zlib + Buffer + crc32 manual) — no sharp / canvas / pngjs
 * dependency to keep tabterm slim.
 *
 * Output: public/splash/<name>.png (PNG, RGBA, mostly-black with a small grey
 * dot at center as the "loading" marker — text would require a font rasterizer
 * which we cannot add without a heavy dep. The mostly-black splash matches
 * tabterm's xterm theme so the transition feels seamless.)
 *
 * Run: node scripts/gen-splash.mjs
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT_DIR = resolve(__dirname, '..', 'public', 'splash');

// Target sizes for Apple PWA splash: each pair is the display's PHYSICAL pixel
// dimensions in PORTRAIT orientation (width x height). The HTML media queries
// in public/index.html use the LOGICAL points + DPR to select the right asset.
// References: https://developer.apple.com/design/human-interface-guidelines/
const SIZES = [
  { name: 'iphone-se-2g-1334x750',      w: 750,  h: 1334 },  // iPhone SE 2/3, iPhone 8 — @2x
  { name: 'iphone-11-1792x828',         w: 828,  h: 1792 },  // iPhone 11, XR — @2x
  { name: 'iphone-x-2436x1125',         w: 1125, h: 2436 },  // iPhone X, XS, 11 Pro — @3x
  { name: 'iphone-13-2532x1170',        w: 1170, h: 2532 },  // iPhone 12, 13, 14 — @3x
  { name: 'iphone-13-pro-max-2778x1284', w: 1284, h: 2778 }, // iPhone 12/13/14 Pro Max — @3x
];

// CRC32 (PNG chunks) — manual table to avoid pulling in a dep.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Build a PNG buffer for a mostly-black image with a small grey dot at center. */
function buildSplashPng(w, h) {
  // RGBA8 (color type 6). Each scanline = 1 filter byte + w * 4 pixel bytes.
  // We use filter type 0 (None) — zlib's deflate handles the redundancy well
  // for a solid-color image (compressed size ~5-15 KB per asset).
  const stride = 1 + w * 4;
  const raw = Buffer.alloc(stride * h);

  const cx = (w / 2) | 0;
  const cy = (h / 2) | 0;
  // dot is sized relative to image — looks consistent across all 5 assets
  const dotRadius = Math.max(8, Math.round(Math.min(w, h) * 0.012));
  const dotRSq = dotRadius * dotRadius;

  for (let y = 0; y < h; y++) {
    const row = y * stride;
    raw[row] = 0; // filter byte (None)
    // base black row — Buffer.alloc already zeroed it. We only overwrite the
    // dot region per row to avoid unnecessary writes.
    const dy = y - cy;
    const dySq = dy * dy;
    if (dySq > dotRSq) continue;
    const xOffset = Math.floor(Math.sqrt(dotRSq - dySq));
    const xStart = Math.max(0, cx - xOffset);
    const xEnd = Math.min(w - 1, cx + xOffset);
    for (let x = xStart; x <= xEnd; x++) {
      const dx = x - cx;
      if (dx * dx + dySq > dotRSq) continue;
      const p = row + 1 + x * 4;
      raw[p]     = 60;  // R
      raw[p + 1] = 60;  // G
      raw[p + 2] = 60;  // B
      raw[p + 3] = 255; // A
    }
    // also set alpha=255 for every pixel in this row (black with opaque alpha)
    // — actually we need ALL pixels opaque, not just the dot. Do it for the
    // whole row.
  }
  // Pass 2: set alpha=255 for every pixel (cheaper as a single loop now).
  for (let y = 0; y < h; y++) {
    const rowStart = y * stride + 1;
    for (let x = 0; x < w; x++) {
      raw[rowStart + x * 4 + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // color type (RGBA)
  ihdr.writeUInt8(0, 10);  // compression
  ihdr.writeUInt8(0, 11);  // filter
  ihdr.writeUInt8(0, 12);  // interlace

  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),  // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function main() {
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
    console.log(`[gen-splash] created ${OUT_DIR}`);
  }
  for (const { name, w, h } of SIZES) {
    const out = resolve(OUT_DIR, `${name}.png`);
    const buf = buildSplashPng(w, h);
    writeFileSync(out, buf);
    const kb = (buf.length / 1024).toFixed(1);
    console.log(`[gen-splash] ${name}.png  ${w}x${h}  ${kb} KB`);
  }
  console.log('[gen-splash] done');
}

main();
