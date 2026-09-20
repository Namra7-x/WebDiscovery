// Generates icons/icon{16,32,48,128}.png locally with zero dependencies
// (Node built-ins only). No network, no global installs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function crc32(buf) {
  let tab = crc32.t;
  if (!tab) {
    tab = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tab[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ tab[(crc ^ buf[i]) & 255];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.slice(y * w * 4, (y + 1) * w * 4)).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// DeepScope mark: dark rounded bg + blue ring + green core, drawn procedurally.
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2, r1 = size * 0.30, r0 = size * 0.10, hole = size * 0.185;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // bg #0f1115
      px[i] = 15; px[i + 1] = 17; px[i + 2] = 21; px[i + 3] = 255;
      const d = Math.hypot(x - cx + 0.5, y - cx + 0.5);
      if (Math.abs(d - (r0 + hole) / 2 - r0 * 0.35) < size * 0.055) {
        px[i] = 77; px[i + 1] = 163; px[i + 2] = 255; // ring #4da3ff
      }
      if (d < r0) { px[i] = 63; px[i + 1] = 208; px[i + 2] = 140; } // core #3fd08c
    }
  }
  return px;
}

mkdirSync(new URL('../icons', import.meta.url), { recursive: true });
for (const s of [16, 32, 48, 128]) {
  writeFileSync(new URL(`../icons/icon${s}.png`, import.meta.url), png(s, s, draw(s)));
  console.log(`icons/icon${s}.png`);
}
