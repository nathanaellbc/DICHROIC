/**
 * Ikon dan layar pembuka PWA DICHROIC, dirasterisasi langsung (tanpa browser)
 * supaya bisa dibangkitkan ulang persis: `node tools/gen_icons.mjs`.
 *
 * Motif "Exposure": cakram cahaya (Signal Blue) jatuh di atas selembar kertas
 * (putih, sudut kontinu seperti UI). Di bagian yang terkena cahaya, kertas
 * tercetak hitam -- tumpang tindihnya dilubangi. Master vektor dan panduan
 * pemakaian ada di docs/brand/. Geometri di bawah memakai grid 256 yang sama.
 *
 * Semua isi berada di dalam lingkaran 80% (zona aman ikon maskable), jadi satu
 * gambar melayani `any` dan `maskable`.
 *
 * Keluaran: public/icons/*.png, public/favicon.svg, dan
 * tools/splash-screens.json (dibaca vite.config.ts untuk tag
 * `apple-touch-startup-image` di index.html).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from 'fast-png';

const OUT = join('public', 'icons');
const WHITE = [255, 255, 255];
const BLUE = [0, 145, 255]; // Signal Blue #0091FF

// Geometri pada grid 256 (sama dengan docs/brand/*.svg).
const DISC = { x: 101, y: 101, r: 70 };
const SHEET = { x0: 89, y0: 89, x1: 225, y1: 225, r: 30 };
const N = 3.26; // eksponen superelips sudut kontinu
const A = 1.528 * SHEET.r; // panjang lengkung sudut di tiap sisi
const BBOX = { x0: DISC.x - DISC.r, y0: DISC.y - DISC.r, x1: SHEET.x1, y1: SHEET.y1 };
const BBOX_W = BBOX.x1 - BBOX.x0;
const BBOX_CX = (BBOX.x0 + BBOX.x1) / 2;
const BBOX_CY = (BBOX.y0 + BBOX.y1) / 2;
const SAMPLES = 4;

function inDisc(x, y) {
  return (x - DISC.x) ** 2 + (y - DISC.y) ** 2 <= DISC.r * DISC.r;
}

function inSheet(x, y) {
  if (x < SHEET.x0 || x > SHEET.x1 || y < SHEET.y0 || y > SHEET.y1) return false;
  const dx = x < SHEET.x0 + A ? SHEET.x0 + A - x : x > SHEET.x1 - A ? x - (SHEET.x1 - A) : 0;
  const dy = y < SHEET.y0 + A ? SHEET.y0 + A - y : y > SHEET.y1 - A ? y - (SHEET.y1 - A) : 0;
  return (dx / A) ** N + (dy / A) ** N <= 1;
}

/**
 * Warna satu titik pada grid 256, versi signature untuk ikon app: cakram dan
 * kertas Signal Blue, tumpang tindihnya dilubangi ke latar putih.
 */
function shade(x, y) {
  return inSheet(x, y) !== inDisc(x, y) ? BLUE : WHITE;
}

/**
 * Menggambar motif ke kanvas RGB `width` x `height` berlatar putih; lebar
 * kotak pembatas motif `markWidth` piksel, berpusat di (cx, cy).
 */
function drawMark(pixels, width, height, cx, cy, markWidth) {
  const k = BBOX_W / markWidth; // piksel -> grid 256
  const half = markWidth / 2 + 2;
  const x0 = Math.max(0, Math.floor(cx - half));
  const x1 = Math.min(width, Math.ceil(cx + half));
  const y0 = Math.max(0, Math.floor(cy - half));
  const y1 = Math.min(height, Math.ceil(cy + half));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const rgb = [0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const gx = BBOX_CX + (x + (sx + 0.5) / SAMPLES - cx) * k;
          const gy = BBOX_CY + (y + (sy + 0.5) / SAMPLES - cy) * k;
          const c = shade(gx, gy);
          for (let i = 0; i < 3; i += 1) rgb[i] += c[i] / (SAMPLES * SAMPLES);
        }
      }
      const p = (y * width + x) * 3;
      for (let i = 0; i < 3; i += 1) pixels[p + i] = Math.round(rgb[i]);
    }
  }
}

function png(width, height, markWidth) {
  const pixels = new Uint8Array(width * height * 3).fill(255);
  drawMark(pixels, width, height, width / 2, height / 2, markWidth);
  return encode({ width, height, data: pixels, channels: 3, depth: 8 });
}

mkdirSync(OUT, { recursive: true });

// Ikon persegi penuh tanpa transparansi (iOS menolak alpha pada apple-touch-icon).
// Lebar motif 62% sisi: titik terjauhnya tetap di dalam lingkaran aman 80%.
for (const size of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${size}.png`), png(size, size, size * 0.62));
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
  writeFileSync(join(OUT, file), png(width, height, Math.round(width * 0.27)));
  splash.push({ file, media: `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${scale}) and (orientation: portrait)` });
}

// favicon.svg: motif biru di atas petak putih membulat. Sudut kertas memakai kubik
// yang mendekati superelips yang sama.
const fmt = (v) => String(Number(v.toFixed(2)));
const q = ((8 * 2 ** (-1 / N) - 4) / 3) * A;
const { x0: sx0, y0: sy0, x1: sx1, y1: sy1 } = SHEET;
const pt = (x, y) => `${fmt(x)},${fmt(y)}`;
const sheetD =
  `M${pt(sx0 + A, sy0)}H${fmt(sx1 - A)}C${pt(sx1 - A + q, sy0)} ${pt(sx1, sy0 + A - q)} ${pt(sx1, sy0 + A)}` +
  `V${fmt(sy1 - A)}C${pt(sx1, sy1 - A + q)} ${pt(sx1 - A + q, sy1)} ${pt(sx1 - A, sy1)}` +
  `H${fmt(sx0 + A)}C${pt(sx0 + A - q, sy1)} ${pt(sx0, sy1 - A + q)} ${pt(sx0, sy1 - A)}` +
  `V${fmt(sy0 + A)}C${pt(sx0, sy0 + A - q)} ${pt(sx0 + A - q, sy0)} ${pt(sx0 + A, sy0)}Z`;
const { x: dcx, y: dcy, r: dr } = DISC;
const discD = `M${pt(dcx - dr, dcy)}A${dr},${dr} 0 1 1 ${pt(dcx + dr, dcy)}A${dr},${dr} 0 1 1 ${pt(dcx - dr, dcy)}Z`;
const fs = (0.7 * 256) / BBOX_W;
writeFileSync(
  join('public', 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="56" fill="#fff"/>` +
    `<g transform="translate(${fmt(128 - BBOX_CX * fs)} ${fmt(128 - BBOX_CY * fs)}) scale(${fmt(fs)})">` +
    // Satu path evenodd: kertas + cakram biru, tumpang tindihnya berlubang.
    `<path fill="#0091ff" fill-rule="evenodd" d="${sheetD}${discD}"/></g></svg>\n`,
);

writeFileSync(join('tools', 'splash-screens.json'), `${JSON.stringify(splash, null, 2)}\n`);
console.log(`ikon + ${splash.length} layar pembuka ditulis ke ${OUT}`);
