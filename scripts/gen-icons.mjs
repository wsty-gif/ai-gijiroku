// アプリアイコン（PNG）を外部ツールなしで生成する。青地に白い書類のシンプルな絵柄。
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BLUE = [29, 78, 216];
const WHITE = [255, 255, 255];
const LINE = [147, 168, 230];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// u,v は 0..1 の正規化座標。scale を小さくすると絵柄が中央に寄る（maskable 用の余白）。
function drawIcon(size, { rounded, scale }) {
  return encodePng(size, (px, py) => {
    const u = px / size;
    const v = py / size;
    if (rounded && !inRoundRect(u, v, 0, 0, 1, 1, 0.22)) return [0, 0, 0, 0];
    const s = (t) => 0.5 + (t - 0.5) / scale;
    const x = s(u);
    const y = s(v);
    if (inRoundRect(x, y, 0.28, 0.2, 0.72, 0.8, 0.04)) {
      const lines = [0.36, 0.46, 0.56, 0.66];
      for (const [i, ly] of lines.entries()) {
        const right = i === lines.length - 1 ? 0.52 : 0.64;
        if (Math.abs(y - ly) < 0.018 && x > 0.36 && x < right) return [...LINE, 255];
      }
      return [...WHITE, 255];
    }
    return [...BLUE, 255];
  });
}

await mkdir(outDir, { recursive: true });
const icons = [
  ['icon-192.png', 192, { rounded: true, scale: 1 }],
  ['icon-512.png', 512, { rounded: true, scale: 1 }],
  ['icon-maskable-512.png', 512, { rounded: false, scale: 0.8 }],
  ['apple-touch-icon.png', 180, { rounded: false, scale: 1 }],
];
for (const [name, size, opts] of icons) {
  await writeFile(join(outDir, name), drawIcon(size, opts));
  console.log(`saved public/icons/${name}`);
}
