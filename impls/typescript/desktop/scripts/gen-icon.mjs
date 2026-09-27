// 生成图标源 PNG（1024×1024 双色方块）：标准库 zlib 手拼 PNG，零依赖。
// 用法：npm run gen:icon（在 desktop/ 下）；产物 icon-source.png 供 tauri icon 使用。
// （tcode 主题色：青色 #58d5c9）
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icon-source.png');

function crc32(buf) {
  let c;
  const t = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = t[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

const W = 1024;
const H = 1024;
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // 位深
ihdr[9] = 2; // RGB

// tcode 主题色：青色底 + 深色实心矩形 + 顶部一个"光标"竖条（纯像素画）
const raw = Buffer.alloc(H * (1 + W * 3));
const inset = Math.floor(W * 0.14);
for (let y = 0; y < H; y++) {
  const rowStart = y * (1 + W * 3);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const o = rowStart + 1 + x * 3;
    const inside = x >= inset && x < W - inset && y >= inset && y < H - inset;
    const notch = Math.abs(x - W / 2) < W * 0.09 && y >= H * 0.14 && y < H * 0.38;
    if (notch) { raw[o] = 0x58; raw[o + 1] = 0xd5; raw[o + 2] = 0xc9; }
    else if (inside) { raw[o] = 0x1a; raw[o + 1] = 0x22; raw[o + 2] = 0x2b; }
    else { raw[o] = 0x58; raw[o + 1] = 0xd5; raw[o + 2] = 0xc9; }
  }
}

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(OUT, png);
console.log(`已生成 ${OUT}（${png.length} 字节）`);
