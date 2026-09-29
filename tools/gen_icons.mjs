/**
 * Ikon dan layar pembuka PWA DICHROIC, dirasterisasi langsung (tanpa browser)
 * supaya bisa dibangkitkan ulang persis: `node tools/gen_icons.mjs`.
 *
 * Motif: tiga cakram warna sistem Apple (merah, hijau, biru) yang bertumpuk
 * dengan blend "screen" di atas hitam -- cahaya yang dipisah lalu disatukan
 * kembali, seperti cermin dikroik. Semua isi berada di dalam lingkaran 80%
 * (zona aman ikon maskable), jadi satu gambar melayani `any` dan `maskable`.
 *
 * Keluaran: public/icons/*.png, public/favicon.svg, dan
 * tools/splash-screens.json (dibaca vite.config.ts untuk tag
 * `apple-touch-startup-image` di index.html).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from 'fast-png';

const OUT = join('public', 'icons');
const DISCS = [
  { angle: -90, color: [255, 69, 58] },
  { angle: 30, color: [48, 209, 88] },
  { angle: 150, color: [10, 132, 255] },
];
/** Relatif terhadap sisi ikon. */
const OFFSET = 0.118;
const RADIUS = 0.2;
const SAMPLES = 4;

/**
 * Menggambar motif berukuran `size` berpusat di (cx, cy) ke kanvas RGB
 * `width` x `height` berlatar hitam. Supersampling 4x4 hanya di tepi cakram.
 */
function drawMark(pixels, width, height, cx, cy, size) {
  const discs = DISCS.map((d) => ({
    x: cx + Math.cos((d.angle * Math.PI) / 180) * OFFSET * size,
    y: cy + Math.sin((d.angle * Math.PI) / 180) * OFFSET * size,
    r: RADIUS * size,
    c: d.color.map((v) => v / 255),
  }));
  const reach = (OFFSET + RADIUS) * size + 2;
  const x0 = Math.max(0, Math.floor(cx - reach));
  const x1 = Math.min(width, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach));
  const y1 = Math.min(height, Math.ceil(cy + reach));
  const shade = (px, py) => {
    const inv = [1, 1, 1];
    for (const d of discs) {
      if ((px - d.x) ** 2 + (py - d.y) ** 2 <= d.r * d.r) {
        for (let k = 0; k < 3; k += 1) inv[k] *= 1 - d.c[k];
      }
    }
    return inv.map((v) => 1 - v);
  };
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const nearEdge = discs.some((d) => Math.abs(Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y) - d.r) < 1.5);
      let rgb;
      if (nearEdge) {
        rgb = [0, 0, 0];
        for (let sy = 0; sy < SAMPLES; sy += 1) {
          for (let sx = 0; sx < SAMPLES; sx += 1) {
            const s = shade(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES);
            for (let k = 0; k < 3; k += 1) rgb[k] += s[k] / (SAMPLES * SAMPLES);
          }
        }
      } else {
        rgb = shade(x + 0.5, y + 0.5);
      }
      const p = (y * width + x) * 3;
      for (let k = 0; k < 3; k += 1) pixels[p + k] = Math.round(rgb[k] * 255);
    }
  }
}

function png(width, height, markSize) {
  const pixels = new Uint8Array(width * height * 3);
  drawMark(pixels, width, height, width / 2, height / 2, markSize);
  return encode({ width, height, data: pixels, channels: 3, depth: 8 });
}

mkdirSync(OUT, { recursive: true });

// Ikon persegi penuh tanpa transparansi (iOS menolak alpha pada apple-touch-icon).
for (const size of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${size}.png`), png(size, size, size));
}

/**
 * Layar pembuka iOS (potret) per ukuran layar dalam titik dan skala. iOS
 * hanya memakai gambar yang ukurannya persis cocok dengan media query.
 */
const SCREENS = [
  [440, 956, 3], // iPhone 16/17 Pro Max
  [420, 912, 3], // iPhone Air
  [402, 874, 3], // iPhone 16/17 Pro, iPhone 17
  [430, 932, 3], // iPhone 14 Pro Max, 15/16 Plus, 15 Pro Max
  [393, 852, 3], // iPhone 14 Pro, 15, 15 Pro, 16, 16e
  [428, 926, 3], // iPhone 12/13 Pro Max, 14 Plus
  [390, 844, 3], // iPhone 12, 13, 14
  [375, 812, 3], // iPhone X, XS, 11 Pro, 12/13 mini
  [414, 896, 3], // iPhone XS Max, 11 Pro Max
  [414, 896, 2], // iPhone XR, 11
  [375, 667, 2], // iPhone SE (2/3), 8
];

const splash = [];
for (const [w, h, scale] of SCREENS) {
  const width = w * scale;
  const height = h * scale;
  const file = `splash-${width}x${height}.png`;
  writeFileSync(join(OUT, file), png(width, height, Math.round(width * 0.42)));
  splash.push({ file, media: `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${scale}) and (orientation: portrait)` });
}

const svgDiscs = DISCS.map((d) => {
  const x = 50 + Math.cos((d.angle * Math.PI) / 180) * OFFSET * 100;
  const y = 50 + Math.sin((d.angle * Math.PI) / 180) * OFFSET * 100;
  return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${RADIUS * 100}" fill="rgb(${d.color.join(',')})"/>`;
}).join('');
writeFileSync(
  join('public', 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#000"/><g style="isolation:isolate">${svgDiscs.replaceAll('<circle', '<circle style="mix-blend-mode:screen"')}</g></svg>\n`,
);

writeFileSync(join('tools', 'splash-screens.json'), `${JSON.stringify(splash, null, 2)}\n`);
console.log(`ikon + ${splash.length} layar pembuka ditulis ke ${OUT}`);
