/**
 * "Natural" (ekstensi DICHROIC, di luar spektrafilm): membalik gaya ISP HP
 * pada foto ter-encode (JPEG/HEIC/PNG) supaya masuk ke film seperti hasil
 * develop RAW yang netral. Tidak ada informasi yang kembali -- highlight yang
 * terpotong dan detail yang dihapus denoise tetap hilang -- tapi perilakunya
 * mendekati RAW. Urutan ISP: linear -> tone mapping lokal -> gamma -> kurva S;
 * dibalik dari ujung (Brooks dkk., "Unprocessing Images for Learned Raw
 * Denoising", CVPR 2019, untuk kurva tone):
 *
 *  1. kurva S kamera (smoothstep per kanal) dibalik di nilai ter-encode;
 *  2. decode CCTF input (tabel yang sama dengan `filmExposure`);
 *  3. kontras skala besar yang dipipihkan HDR/tone mapping lokal dikembalikan
 *     dari peta log-luminans kasar SELURUH foto (global: tile tanpa sambungan);
 *  4. highlight dekat-terpotong diperluas di atas 1.0 dan diredam satunya,
 *     supaya bahu film yang melandaikannya, bukan potongan JPEG;
 *  5. vibrance dibalik: saturasi tinggi diturunkan paling banyak;
 *  6. derau sensor halus (tembakan foton, ~akar luminans) di atas permukaan
 *     yang dihaluskan denoise;
 *  7. encode lagi ke kurva input -- tahap berikutnya tidak berubah.
 *
 * Halo sharpening ditangani Soften Detail yang sudah ada (`plan.ts`
 * menaikkannya bersama Natural). `naturalPixel` adalah referensi CPU tahap
 * GPU (`stages/natural.ts`), membaca nilai yang sama.
 */

/** Kekuatan tiap langkah pada Natural = 1. */
export const NATURAL_STRENGTH = Object.freeze({
  tone: 0.55,
  local: 0.3,
  highlight: 0.55,
  vibrance: 0.18,
  clipDesaturate: 0.4,
  noise: 0.0035,
  /** Soften Detail ikut naik sampai sekian (halo sharpening). */
  soften: 0.5,
});

/** Sel sisi panjang peta kontras skala besar. */
export const NATURAL_GRID_EDGE = 48;

export interface NaturalFrame {
  amount: number;
  /** Bobot luminans primer input. */
  luma: readonly [number, number, number];
  /** Tabel decode CCTF input di [lutMin, lutMax] (sama dengan filmExposure). */
  lut: Float32Array;
  lutMin: number;
  lutMax: number;
  /** Rata-rata log luminans peta kasar. */
  logMean: number;
  /** Peta log-luminans kasar yang dihaluskan, baris atas-bawah, uv 0..1 seluruh foto. */
  grid: { width: number; height: number; data: Float32Array };
  /**
   * Kompensasi eksposur: Natural mengubah BENTUK kontras, bukan terang
   * keseluruhan -- rata-rata log luminans foto dijaga (
aturalExposureGain).
   */
  gain: number;
}

function decodeWith(f: Pick<NaturalFrame, 'lut' | 'lutMin' | 'lutMax'>, v: number): number {
  const n = f.lut.length;
  const t = Math.min(Math.max((v - f.lutMin) / (f.lutMax - f.lutMin), 0), 1) * (n - 1);
  const i = Math.min(Math.floor(t), n - 2);
  const a = f.lut[i]!, b = f.lut[i + 1]!;
  return a + (b - a) * (t - i);
}

/** Kebalikan `decodeWith` (tabel monoton): pencarian biner + interpolasi. */
function encodeWith(f: Pick<NaturalFrame, 'lut' | 'lutMin' | 'lutMax'>, x: number): number {
  const n = f.lut.length;
  if (x <= f.lut[0]!) return f.lutMin;
  if (x >= f.lut[n - 1]!) return f.lutMax;
  let lo = 0, hi = n - 1;
  for (let k = 0; k < 13; k += 1) {
    const mid = (lo + hi) >> 1;
    if (f.lut[mid]! <= x) lo = mid; else hi = mid;
  }
  const a = f.lut[lo]!, b = f.lut[lo + 1]!;
  const t = b > a ? (x - a) / (b - a) : 0;
  return f.lutMin + ((lo + t) / (n - 1)) * (f.lutMax - f.lutMin);
}

/** Kebalikan smoothstep 3x^2 - 2x^3 di [0, 1]. */
export function inverseSmoothstep(y: number): number {
  const c = Math.min(Math.max(y, 0), 1);
  return 0.5 - Math.sin(Math.asin(1 - 2 * c) / 3);
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Hash PCG 32-bit (sama persis dengan `natural.wgsl`). */
function pcg(v: number): number {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/** Derau ~N(0,1) deterministik per piksel absolut (jumlah empat seragam). */
export function pixelNoise(x: number, y: number): number {
  let h = pcg((Math.imul(y >>> 0, 65537) + x) >>> 0);
  let s = 0;
  for (let k = 0; k < 4; k += 1) {
    h = pcg(h);
    s += h / 4294967296;
  }
  return (s - 2) * 1.7320508075688772;
}

function gridAt(g: NaturalFrame['grid'], u: number, v: number): number {
  const px = Math.min(Math.max(u * g.width - 0.5, 0), g.width - 1);
  const py = Math.min(Math.max(v * g.height - 0.5, 0), g.height - 1);
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, g.width - 1), y1 = Math.min(y0 + 1, g.height - 1);
  const tx = px - x0, ty = py - y0;
  const d = g.data;
  const a = d[y0 * g.width + x0]! + (d[y0 * g.width + x1]! - d[y0 * g.width + x0]!) * tx;
  const b = d[y1 * g.width + x0]! + (d[y1 * g.width + x1]! - d[y1 * g.width + x0]!) * tx;
  return a + (b - a) * ty;
}

/**
 * Satu piksel ter-encode -> ter-encode (f64). `x, y` piksel absolut di foto
 * penuh berukuran `fullW x fullH` (derau dan peta kasar memakai posisi ini).
 */
export function naturalPixel(rgb: readonly [number, number, number], x: number, y: number, fullW: number, fullH: number, f: NaturalFrame): [number, number, number] {
  const s = f.amount;
  const S = NATURAL_STRENGTH;
  // 1. Kurva S kamera dibalik di nilai ter-encode (kontinu di 0 dan 1).
  const enc = rgb.map((e) => (e >= 0 && e <= 1 ? e + (inverseSmoothstep(e) - e) * S.tone * s : e));
  // 2. Linear.
  const lin = enc.map((e) => decodeWith(f, e));
  const Y = f.luma[0] * lin[0]! + f.luma[1] * lin[1]! + f.luma[2] * lin[2]!;
  if (!(Y > 1e-5)) return [rgb[0], rgb[1], rgb[2]];
  // 3. Kontras skala besar.
  const base = gridAt(f.grid, (x + 0.5) / fullW, (y + 0.5) / fullH);
  let Yn = Y * f.gain * Math.exp(s * S.local * (base - f.logMean));
  // 4. Highlight dekat-terpotong (diukur dari encode asli).
  const knee = smoothstep(0.82, 1, Math.max(rgb[0], rgb[1], rgb[2]));
  Yn *= 1 + s * S.highlight * knee * knee;
  let c = lin.map((v) => (v * Yn) / Y);
  // 5. Vibrance dibalik + redam warna di dekat potongan.
  const mx = Math.max(c[0]!, c[1]!, c[2]!), mn = Math.min(c[0]!, c[1]!, c[2]!);
  const sat = (mx - mn) / Math.max(mx, 1e-6);
  const keep = Math.min(Math.max(1 - s * S.vibrance * smoothstep(0.15, 0.85, sat) - s * S.clipDesaturate * knee, 0), 1);
  c = c.map((v) => Yn + (v - Yn) * keep);
  // 6. Derau sensor halus.
  const n = pixelNoise(x, y) * s * S.noise * Math.sqrt(Math.max(Yn, 0));
  // 7. Kembali ke kurva input.
  return [encodeWith(f, Math.max(c[0]! + n, 0)), encodeWith(f, Math.max(c[1]! + n, 0)), encodeWith(f, Math.max(c[2]! + n, 0))];
}

/**
 * Pengali luminans yang menjaga rata-rata log luminans foto: Natural dengan
 * `gain` 1 dijalankan pada sampel foto, lalu selisih rata-rata log masuk-keluar
 * dibalik. Tanpa ini membalik kurva S mengangkat bayangan dan foto jadi lebih
 * terang -- padahal yang diubah mestinya bentuk kontras, bukan eksposur.
 */
export function naturalExposureGain(
  rgba: Float32Array, width: number, height: number,
  frame: Omit<NaturalFrame, 'gain'>,
  samples = 96,
): number {
  const f: NaturalFrame = { ...frame, gain: 1 };
  const sw = Math.max(1, Math.round((samples * width) / Math.max(width, height)));
  const sh = Math.max(1, Math.round((samples * height) / Math.max(width, height)));
  const luma = (c: readonly number[]) => f.luma[0] * decodeWith(f, c[0]!) + f.luma[1] * decodeWith(f, c[1]!) + f.luma[2] * decodeWith(f, c[2]!);
  let before = 0, after = 0, n = 0;
  for (let j = 0; j < sh; j += 1) {
    const y = Math.min(height - 1, Math.floor(((j + 0.5) * height) / sh));
    for (let i = 0; i < sw; i += 1) {
      const x = Math.min(width - 1, Math.floor(((i + 0.5) * width) / sw));
      const p = (y * width + x) * 4;
      const rgb: [number, number, number] = [rgba[p]!, rgba[p + 1]!, rgba[p + 2]!];
      const yin = luma(rgb);
      if (!(yin > 1e-4)) continue;
      // Posisi di koordinat foto penuh berukuran `width x height` (uv peta sama).
      const yout = luma(naturalPixel(rgb, x, y, width, height, f));
      if (!(yout > 1e-4)) continue;
      before += Math.log(yin);
      after += Math.log(yout);
      n += 1;
    }
  }
  return n ? Math.exp((before - after) / n) : 1;
}

/**
 * Peta log-luminans kasar seluruh foto (sisi panjang `NATURAL_GRID_EDGE`
 * sel), dihaluskan Gauss sigma 1,2 sel, dan rata-ratanya.
 */
export function naturalGrid(
  rgba: Float32Array, width: number, height: number,
  luma: readonly [number, number, number],
  decode: (v: number) => number,
): { grid: NaturalFrame['grid']; logMean: number } {
  const scale = NATURAL_GRID_EDGE / Math.max(width, height);
  const gw = Math.max(2, Math.round(width * scale)), gh = Math.max(2, Math.round(height * scale));
  const raw = new Float64Array(gw * gh);
  const SAMPLES = 6;
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      let sum = 0;
      for (let j = 0; j < SAMPLES; j += 1) {
        const sy = Math.min(height - 1, Math.floor(((gy + (j + 0.5) / SAMPLES) * height) / gh));
        for (let i = 0; i < SAMPLES; i += 1) {
          const sx = Math.min(width - 1, Math.floor(((gx + (i + 0.5) / SAMPLES) * width) / gw));
          const p = (sy * width + sx) * 4;
          const Y = luma[0] * decode(rgba[p]!) + luma[1] * decode(rgba[p + 1]!) + luma[2] * decode(rgba[p + 2]!);
          sum += Math.log(Math.max(Y, 1e-4));
        }
      }
      raw[gy * gw + gx] = sum / (SAMPLES * SAMPLES);
    }
  }
  // Gauss terpisah, tepi dijepit.
  const sigma = 1.2, R = 3;
  const w = Array.from({ length: 2 * R + 1 }, (_, k) => Math.exp(-0.5 * ((k - R) / sigma) ** 2));
  const blur = (src: Float64Array, horizontal: boolean) => {
    const out = new Float64Array(src.length);
    for (let y = 0; y < gh; y += 1) for (let x = 0; x < gw; x += 1) {
      let s = 0, t = 0;
      for (let k = -R; k <= R; k += 1) {
        const xx = horizontal ? Math.min(Math.max(x + k, 0), gw - 1) : x;
        const yy = horizontal ? y : Math.min(Math.max(y + k, 0), gh - 1);
        s += w[k + R]! * src[yy * gw + xx]!;
        t += w[k + R]!;
      }
      out[y * gw + x] = s / t;
    }
    return out;
  };
  const smooth = blur(blur(raw, true), false);
  let mean = 0;
  for (const v of smooth) mean += v;
  return { grid: { width: gw, height: gh, data: Float32Array.from(smooth) }, logMean: mean / smooth.length };
}
