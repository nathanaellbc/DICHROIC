/**
 * Referensi CPU f64 dari `fast_gaussian_filter`/`fast_exponential_filter`
 * spektrafilm (RGB rapat, per kanal). BUKAN jalur render: dipakai self-test
 * presisi GPU (`precisionSelfTest.ts`) untuk mendeteksi backend yang
 * meruntuhkan df64 `gaussian.wgsl` (reasosiasi fast-math). Digerbangi
 * terhadap oracle Python (`test/gaussianReference.test.ts`).
 */

import { EXPONENTIAL_FIT_3, SMALL_SIGMA_MAX, gaussianKernel1d, yvvCoefficients } from './gaussian';
import type { Vec3 } from './gaussian';

function reflect(i: number, n: number): number {
  if (i >= 0 && i < n) return i;
  if (i >= -n && i < 0) return -i - 1;
  if (i >= n && i < 2 * n) return 2 * n - 1 - i;
  const period = 2 * n;
  let j = i % period;
  if (j < 0) j += period;
  if (j >= n) j = period - 1 - j;
  return j;
}

function fir(src: Float64Array, w: number, h: number, sigma: number, truncate: number): Float64Array {
  const { weights, radius } = gaussianKernel1d(sigma, truncate);
  const tmp = new Float64Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let s = 0;
      for (let k = -radius; k <= radius; k += 1) s += src[reflect(y + k, h) * w + x]! * weights[k + radius]!;
      tmp[y * w + x] = s;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let s = 0;
      for (let k = -radius; k <= radius; k += 1) s += tmp[y * w + reflect(x + k, w)]! * weights[k + radius]!;
      out[y * w + x] = s;
    }
  }
  return out;
}

/** Satu arah rekursi YvV maju lalu mundur di sepanjang `n` sampel ber-langkah `stride`. */
function iirLine(buf: Float64Array, start: number, n: number, stride: number, c: [number, number, number, number]): void {
  const [B, b1, b2, b3] = c;
  const x0 = buf[start]!;
  let w1 = x0;
  let w2 = x0;
  let w3 = x0;
  for (let i = 0; i < n; i += 1) {
    const idx = start + i * stride;
    const v = B * buf[idx]! + b1 * w1 + b2 * w2 + b3 * w3;
    buf[idx] = v;
    w3 = w2;
    w2 = w1;
    w1 = v;
  }
  const xn = buf[start + (n - 1) * stride]!;
  w1 = xn;
  w2 = xn;
  w3 = xn;
  for (let i = n - 1; i >= 0; i -= 1) {
    const idx = start + i * stride;
    const v = B * buf[idx]! + b1 * w1 + b2 * w2 + b3 * w3;
    buf[idx] = v;
    w3 = w2;
    w2 = w1;
    w1 = v;
  }
}

function iir(src: Float64Array, w: number, h: number, sigma: number): Float64Array {
  const c = yvvCoefficients(sigma);
  const out = Float64Array.from(src);
  for (let y = 0; y < h; y += 1) iirLine(out, y * w, w, 1, c);
  for (let x = 0; x < w; x += 1) iirLine(out, x, h, w, c);
  return out;
}

function channelFilter(plane: Float64Array, w: number, h: number, sigma: number, truncate: number): Float64Array {
  if (!(sigma > 0)) return Float64Array.from(plane);
  return sigma >= SMALL_SIGMA_MAX ? iir(plane, w, h, sigma) : fir(plane, w, h, sigma, truncate);
}

export function gaussianFilterCpu(
  rgb: ArrayLike<number>,
  width: number,
  height: number,
  sigma: Vec3,
  truncate = 3,
): Float64Array {
  const out = new Float64Array(width * height * 3);
  for (let c = 0; c < 3; c += 1) {
    const plane = new Float64Array(width * height);
    for (let p = 0; p < width * height; p += 1) plane[p] = rgb[p * 3 + c]!;
    const filtered = channelFilter(plane, width, height, sigma[c]!, truncate);
    for (let p = 0; p < width * height; p += 1) out[p * 3 + c] = filtered[p]!;
  }
  return out;
}

export function exponentialFilterCpu(
  rgb: ArrayLike<number>,
  width: number,
  height: number,
  decay: Vec3,
  truncate = 3,
): Float64Array {
  const out = new Float64Array(width * height * 3);
  EXPONENTIAL_FIT_3.forEach(([amplitude, ratio]) => {
    const component = gaussianFilterCpu(rgb, width, height, decay.map((l) => ratio * l) as Vec3, truncate);
    for (let i = 0; i < out.length; i += 1) out[i] = out[i]! + amplitude * component[i]!;
  });
  return out;
}
