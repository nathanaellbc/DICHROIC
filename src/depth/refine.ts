/**
 * Bagian numerik estimasi kedalaman -- semua kecuali jaringan -- bebas worker
 * dan GPU supaya bisa diuji di Node:
 *
 *   guide (sRGB, <= 1536 px) -> resample ke masukan model -> normalisasi
 *   -> [jaringan] -> upsample bilateral bersama kembali ke guide -> normalisasi
 *
 * Jaringan melihat gambar 518 px dan menjawab di resolusi itu. Di-upsample
 * bilinear, disparitas latar depan akan meluber beberapa piksel ke latar, dan
 * gather lalu mem-blur tepi subjek. Upsample bilateral bersama (Kopf dkk.
 * 2007) membiarkan gambar resolusi penuh menentukan letak tepi: sampel
 * disparitas resolusi rendah dipercaya sebanding kemiripan warna dua piksel.
 */

import { DEPTH_MODEL } from './model';

/** `Resize(lower_bound, ensure_multiple_of=14)` Depth Anything V2. */
export function modelInputSize(width: number, height: number, s: number = DEPTH_MODEL.inputSize): [number, number] {
  const m = DEPTH_MODEL.multipleOf;
  const scale = Math.max(s / width, s / height);
  const constrain = (x: number) => {
    let y = Math.round(x / m) * m;
    if (y < s) y = Math.ceil(x / m) * m;
    return y;
  };
  return [constrain(scale * width), constrain(scale * height)];
}

/** Kubik Keys a = -0.75 (kernel `cv2.INTER_CUBIC`). */
function cubic(x: number): number {
  const a = -0.75;
  const t = Math.abs(x);
  if (t < 1) return ((a + 2) * t - (a + 3)) * t * t + 1;
  if (t < 2) return (((t - 5) * t + 8) * t - 4) * a;
  return 0;
}

function taps(src: number, dst: number): { start: Int32Array; count: number; weights: Float32Array } {
  const scale = src / dst;
  // Memperkecil melebarkan kernel supaya setiap piksel sumber terlihat (antialias).
  const stretch = Math.max(scale, 1);
  const count = Math.ceil(2 * stretch) * 2 + 1;
  const start = new Int32Array(dst);
  const weights = new Float32Array(dst * count);
  for (let i = 0; i < dst; i += 1) {
    const centre = (i + 0.5) * scale - 0.5;
    const first = Math.floor(centre - 2 * stretch) + 1;
    start[i] = first;
    let sum = 0;
    for (let k = 0; k < count; k += 1) {
      const w = cubic((first + k - centre) / stretch);
      weights[i * count + k] = w;
      sum += w;
    }
    for (let k = 0; k < count; k += 1) weights[i * count + k]! /= sum || 1;
  }
  return { start, count, weights };
}

/** RGBA8 -> RGB float 0..1 di ukuran baru (kubik terpisah, tepi dijepit). */
export function resampleRGB(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const hx = taps(sw, dw);
  const hy = taps(sh, dh);
  const tmp = new Float32Array(dw * sh * 3);
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      const s0 = hx.start[x]!;
      for (let k = 0; k < hx.count; k += 1) {
        const sx = Math.min(Math.max(s0 + k, 0), sw - 1);
        const w = hx.weights[x * hx.count + k]!;
        const i = (y * sw + sx) * 4;
        r += src[i]! * w;
        g += src[i + 1]! * w;
        b += src[i + 2]! * w;
      }
      const o = (y * dw + x) * 3;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
    }
  }
  const out = new Float32Array(dw * dh * 3);
  for (let y = 0; y < dh; y += 1) {
    const s0 = hy.start[y]!;
    for (let x = 0; x < dw; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < hy.count; k += 1) {
        const sy = Math.min(Math.max(s0 + k, 0), sh - 1);
        const w = hy.weights[y * hy.count + k]!;
        const i = (sy * dw + x) * 3;
        r += tmp[i]! * w;
        g += tmp[i + 1]! * w;
        b += tmp[i + 2]! * w;
      }
      const o = (y * dw + x) * 3;
      out[o] = Math.min(Math.max(r / 255, 0), 1);
      out[o + 1] = Math.min(Math.max(g / 255, 0), 1);
      out[o + 2] = Math.min(Math.max(b / 255, 0), 1);
    }
  }
  return out;
}

/** `NormalizeImage` + `PrepareForNet`: mean/std ImageNet, HWC -> CHW. */
export function toModelTensor(rgb: Float32Array, w: number, h: number): Float32Array {
  const { mean, std } = DEPTH_MODEL;
  const plane = w * h;
  const out = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i += 1) {
    out[i] = (rgb[i * 3]! - mean[0]) / std[0];
    out[plane + i] = (rgb[i * 3 + 1]! - mean[1]) / std[1];
    out[2 * plane + i] = (rgb[i * 3 + 2]! - mean[2]) / std[2];
  }
  return out;
}

/**
 * Upsample bilateral bersama disparitas jaringan (`low`, lw x lh, `lowGuide`
 * = RGB yang dilihat jaringan) ke gambar guide (`hiGuide`, RGBA8, hw x hh).
 * Posisi sampel mengikuti `F.interpolate(..., align_corners=True)`.
 */
export function jointBilateralUpsample(
  low: Float32Array,
  lw: number,
  lh: number,
  lowGuide: Float32Array,
  hiGuide: Uint8ClampedArray,
  hw: number,
  hh: number,
  sigmaSpatial = 0.9,
  sigmaRange = 0.1,
): Float32Array {
  const out = new Float32Array(hw * hh);
  const sx = hw > 1 ? (lw - 1) / (hw - 1) : 0;
  const sy = hh > 1 ? (lh - 1) / (hh - 1) : 0;
  const invS = 1 / (2 * sigmaSpatial * sigmaSpatial);
  const invR = 1 / (2 * sigmaRange * sigmaRange);
  for (let y = 0; y < hh; y += 1) {
    const v = y * sy;
    const j0 = Math.floor(v);
    for (let x = 0; x < hw; x += 1) {
      const u = x * sx;
      const i0 = Math.floor(u);
      const p = (y * hw + x) * 4;
      const gr = hiGuide[p]! / 255;
      const gg = hiGuide[p + 1]! / 255;
      const gb = hiGuide[p + 2]! / 255;
      let sum = 0;
      let wsum = 0;
      // Jawaban bilinear, bila semua bobot rentang underflow.
      let bl = 0;
      let blw = 0;
      for (let j = j0 - 1; j <= j0 + 2; j += 1) {
        if (j < 0 || j >= lh) continue;
        const dy = v - j;
        for (let i = i0 - 1; i <= i0 + 2; i += 1) {
          if (i < 0 || i >= lw) continue;
          const dx = u - i;
          const q = j * lw + i;
          const dr = gr - lowGuide[q * 3]!;
          const dg = gg - lowGuide[q * 3 + 1]!;
          const db = gb - lowGuide[q * 3 + 2]!;
          const w = Math.exp(-(dx * dx + dy * dy) * invS) * Math.exp(-(dr * dr + dg * dg + db * db) * invR);
          sum += low[q]! * w;
          wsum += w;
          const wb = Math.max(0, 1 - Math.abs(dx)) * Math.max(0, 1 - Math.abs(dy));
          bl += low[q]! * wb;
          blw += wb;
        }
      }
      out[y * hw + x] = wsum > 1e-6 ? sum / wsum : bl / Math.max(blw, 1e-6);
    }
  }
  return out;
}

/**
 * Disparitas relatif -> skala 0-di-tak-hingga `host/lens.ts`. Jangkar jauh =
 * persentil 0,5 (bukan minimum, supaya segelintir piksel langit berderau tidak
 * menentukannya), skala = persentil 99,5; yang lebih dekat tetap nilainya
 * sendiri (sampai 1,5).
 */
export function normaliseDisparity(d: Float32Array): Float32Array {
  const step = Math.max(1, Math.floor(d.length / 65536));
  const sample: number[] = [];
  for (let i = 0; i < d.length; i += step) sample.push(d[i]!);
  sample.sort((a, b) => a - b);
  const q = (p: number) => sample[Math.min(sample.length - 1, Math.floor(p * (sample.length - 1)))]!;
  const lo = q(0.005);
  const hi = q(0.995);
  const span = Math.max(hi - lo, 1e-6);
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 1) out[i] = Math.min(Math.max((d[i]! - lo) / span, 0), 1.5);
  return out;
}

/** RGB float 0..1 -> RGBA8 (untuk guide rendah yang di-resample ulang). */
export function rgbaFrom(rgb: Float32Array, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    out[i * 4] = rgb[i * 3]! * 255;
    out[i * 4 + 1] = rgb[i * 3 + 1]! * 255;
    out[i * 4 + 2] = rgb[i * 3 + 2]! * 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}
