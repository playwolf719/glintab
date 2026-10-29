import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// Original, code-drawn artwork. No external branding or licensed reference assets.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(data));
  return Buffer.concat([size, data, checksum]);
}
function star(x, y, cx, cy, radius) {
  return Math.sqrt(Math.abs((x - cx) / radius)) + Math.sqrt(Math.abs((y - cy) / radius)) <= 1;
}
mkdirSync('public/icon', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const color = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const px = (x + sx / 4) / size,
            py = (y + sy / 4) / size;
          const dx = Math.max(0.19 - px, 0, px - 0.81),
            dy = Math.max(0.19 - py, 0, py - 0.81);
          if (dx * dx + dy * dy > 0.18 ** 2) continue;
          const white =
            star(px, py, 0.45, 0.53, 0.32) ||
            star(px, py, 0.75, 0.24, 0.14) ||
            star(px, py, 0.76, 0.78, 0.11);
          const rgb = white ? [255, 255, 255] : [53, 108, 226];
          rgb.forEach((value, i) => {
            color[i] += value;
          });
          color[3] += 255;
        }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      const coverage = color[3] / 255;
      for (let c = 0; c < 3; c++)
        pixels[offset + c] = coverage ? Math.round(color[c] / coverage) : 0;
      pixels[offset + 3] = Math.round(color[3] / 16);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  writeFileSync(
    `public/icon/${size}.png`,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
