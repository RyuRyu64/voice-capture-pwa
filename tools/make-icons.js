'use strict';
// アイコンPNGを依存ライブラリなしで生成する（青地 + 白マイク）
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(file, size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      const off = y * (size * 4 + 1) + 1 + x * 4;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  console.log(`${file} (${size}x${size}, ${png.length} bytes)`);
}

// 距離関数: 点pからカプセル(a-b, 半径r)表面までの距離
function capsuleDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby || 1)));
  const dx = apx - abx * t, dy = apy - aby * t;
  return Math.hypot(dx, dy);
}

function micPixel(x, y, S) {
  const px = x + 0.5, py = y + 0.5;
  // 背景: 縦グラデーションの青
  const t = py / S;
  const bg = [
    Math.round(0x33 + (0x00 - 0x33) * t),
    Math.round(0x95 + (0x66 - 0x95) * t),
    Math.round(0xff + (0xe0 - 0xff) * t),
  ];
  const cx = S / 2;
  const aa = 1.2; // アンチエイリアス幅(px)
  let cov = 0; // 白の被覆率

  const add = (d, r) => { cov = Math.max(cov, Math.min(1, Math.max(0, (r - d) / aa + 0.5))); };

  // マイク本体（カプセル）
  add(capsuleDist(px, py, cx, 0.335 * S, cx, 0.485 * S), 0.088 * S);
  // 下半分のアーク（リング）
  const dc = Math.hypot(px - cx, py - 0.50 * S);
  if (py >= 0.50 * S) {
    const ring = Math.abs(dc - 0.155 * S);
    add(ring, 0.0175 * S);
  }
  // ステム
  add(capsuleDist(px, py, cx, 0.655 * S, cx, 0.725 * S), 0.0165 * S);
  // ベース
  add(capsuleDist(px, py, cx - 0.075 * S, 0.735 * S, cx + 0.075 * S, 0.735 * S), 0.0165 * S);

  return [
    Math.round(bg[0] + (255 - bg[0]) * cov),
    Math.round(bg[1] + (255 - bg[1]) * cov),
    Math.round(bg[2] + (255 - bg[2]) * cov),
    255,
  ];
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
writePng(path.join(outDir, 'icon-192.png'), 192, micPixel);
writePng(path.join(outDir, 'icon-512.png'), 512, micPixel);
writePng(path.join(outDir, 'apple-touch-icon.png'), 180, micPixel);
