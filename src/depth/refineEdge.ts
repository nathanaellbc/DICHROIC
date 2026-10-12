/**
 * Refine Edge untuk lens blur, seperti Refine Edge Brush After Effects:
 * pengguna menyapu tepi subjek (rambut), pita sapuan menjadi daerah "ragu"
 * trimap, dan ViTMatte menghitung alfa lapis depan per piksel di resolusi
 * tinggi -- hanya di kotak yang membungkus sapuan. Di luar pita tidak ada
 * yang berubah, jadi tidak ada artefak baru di bagian foto lain.
 *
 *   sapuan (resolusi pratinjau) -> kotak uv -> potongan foto resolusi tinggi
 *   trimap: pita = 128; di luar pita kedalaman > ambang ? 255 : 0
 *   ViTMatte per tile 512 px (tumpang 64, dicampur lembut), hanya tile berpita
 *   lapis depan/belakang di resolusi kedalaman: rata-rata kedalaman sisi
 *   subjek/latar di sekitar pita
 *
 * Bebas DOM dan worker supaya bisa diuji di Node; inferensi diberikan
 * pemanggil (`runTile`).
 */
import type { DepthMap, EdgeMatte } from '../host/lens';

export interface BrushMask {
  width: number;
  height: number;
  /** 1 = disapu. */
  data: Uint8Array;
}

export interface UvRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Kotak uv yang membungkus sapuan, dilebarkan `pad` (bagian sisi) agar sisi pasti ikut. */
export function bandBounds(mask: BrushMask, pad = 0.02): UvRect | undefined {
  let x0 = mask.width, y0 = mask.height, x1 = -1, y1 = -1;
  for (let y = 0; y < mask.height; y += 1) {
    const row = y * mask.width;
    for (let x = 0; x < mask.width; x += 1) {
      if (!mask.data[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return undefined;
  const px = pad * Math.max(1, Math.min(mask.width, mask.height)) / mask.width;
  const py = pad * Math.max(1, Math.min(mask.width, mask.height)) / mask.height;
  const ux0 = Math.max(0, x0 / mask.width - px), uy0 = Math.max(0, y0 / mask.height - py);
  const ux1 = Math.min(1, (x1 + 1) / mask.width + px), uy1 = Math.min(1, (y1 + 1) / mask.height + py);
  return { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };
}

/** Ukuran potongan untuk kotak ini: resolusi sumber, sisi panjang paling besar `maxEdge`. */
export function cropSize(rect: UvRect, sourceWidth: number, sourceHeight: number, maxEdge: number): { width: number; height: number } {
  const w = rect.w * sourceWidth, h = rect.h * sourceHeight;
  const s = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Sapuan (resolusi pratinjau) disampel ke potongan `width x height` dari kotak `rect`. */
export function bandInCrop(mask: BrushMask, rect: UvRect, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const my = Math.min(mask.height - 1, Math.floor((rect.y + ((y + 0.5) / height) * rect.h) * mask.height));
    for (let x = 0; x < width; x += 1) {
      const mx = Math.min(mask.width - 1, Math.floor((rect.x + ((x + 0.5) / width) * rect.w) * mask.width));
      out[y * width + x] = mask.data[my * mask.width + mx] ? 1 : 0;
    }
  }
  return out;
}

/** Kedalaman bilinear di uv (seperti shader). */
export function depthAtUv(depth: DepthMap, u: number, v: number): number {
  const px = Math.min(Math.max(u * depth.width - 0.5, 0), depth.width - 1);
  const py = Math.min(Math.max(v * depth.height - 0.5, 0), depth.height - 1);
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, depth.width - 1), y1 = Math.min(y0 + 1, depth.height - 1);
  const tx = px - x0, ty = py - y0, d = depth.data, w = depth.width;
  const a = d[y0 * w + x0]! + (d[y0 * w + x1]! - d[y0 * w + x0]!) * tx;
  const b = d[y1 * w + x0]! + (d[y1 * w + x1]! - d[y1 * w + x0]!) * tx;
  return a + (b - a) * ty;
}

/**
 * Ambang subjek/latar: tengah persentil 15 dan 85 kedalaman di kotak sapuan
 * (yang memuat kedua sisi tepi).
 */
export function edgeThreshold(depth: DepthMap, rect: UvRect, width: number, height: number): number {
  const samples: number[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40000)));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      samples.push(depthAtUv(depth, rect.x + ((x + 0.5) / width) * rect.w, rect.y + ((y + 0.5) / height) * rect.h));
    }
  }
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * (samples.length - 1)))]!;
  return (q(0.15) + q(0.85)) / 2;
}

/** Trimap ViTMatte: pita = 128, di luar pita kedalaman > ambang ? 255 : 0. */
export function buildTrimap(depth: DepthMap, rect: UvRect, band: Uint8Array, width: number, height: number, threshold: number): Uint8Array {
  const tri = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (band[i]) { tri[i] = 128; continue; }
      const d = depthAtUv(depth, rect.x + ((x + 0.5) / width) * rect.w, rect.y + ((y + 0.5) / height) * rect.h);
      tri[i] = d > threshold ? 255 : 0;
    }
  }
  return tri;
}

export const MATTE_TILE = 512;
const MATTE_OVERLAP = 64;

/**
 * Satu tile ViTMatte: `input` 4 kanal CHW (RGB ternormalisasi 0,5/0,5 dan
 * trimap 0..1), `tw x th` kelipatan 32; kembalikan alfa `tw x th`.
 */
export type MatteTileRunner = (input: Float32Array, tw: number, th: number) => Promise<Float32Array>;

function tileStarts(size: number): number[] {
  if (size <= MATTE_TILE) return [0];
  const step = MATTE_TILE - MATTE_OVERLAP;
  const starts: number[] = [];
  for (let s = 0; s + MATTE_TILE < size; s += step) starts.push(s);
  starts.push(size - MATTE_TILE);
  return starts;
}

/**
 * Alfa ViTMatte untuk potongan `rgba` (sRGB RGBA8) dengan trimap. Hanya tile
 * yang memuat piksel ragu dijalankan; tumpang-tindih dicampur dengan bobot
 * tenda. Piksel pasti = trimap/255.
 */
export async function computeMatte(
  rgba: Uint8ClampedArray,
  trimap: Uint8Array,
  width: number,
  height: number,
  runTile: MatteTileRunner,
  onTile?: (done: number, total: number) => void,
): Promise<Float32Array> {
  const acc = new Float32Array(width * height);
  const weight = new Float32Array(width * height);
  const tiles: Array<[number, number]> = [];
  for (const ty of tileStarts(height)) {
    for (const tx of tileStarts(width)) {
      const tw = Math.min(MATTE_TILE, width), th = Math.min(MATTE_TILE, height);
      let unknown = false;
      for (let y = ty; y < ty + th && !unknown; y += 1) for (let x = tx; x < tx + tw; x += 1) if (trimap[y * width + x] === 128) { unknown = true; break; }
      if (unknown) tiles.push([tx, ty]);
    }
  }
  let done = 0;
  for (const [tx, ty] of tiles) {
    const tw = Math.min(MATTE_TILE, width), th = Math.min(MATTE_TILE, height);
    const pw = Math.ceil(tw / 32) * 32, ph = Math.ceil(th / 32) * 32;
    const input = new Float32Array(4 * pw * ph);
    const plane = pw * ph;
    for (let y = 0; y < th; y += 1) {
      for (let x = 0; x < tw; x += 1) {
        const s = (ty + y) * width + tx + x, d = y * pw + x;
        input[d] = rgba[s * 4]! / 127.5 - 1;
        input[plane + d] = rgba[s * 4 + 1]! / 127.5 - 1;
        input[2 * plane + d] = rgba[s * 4 + 2]! / 127.5 - 1;
        input[3 * plane + d] = trimap[s]! / 255;
      }
    }
    const alpha = await runTile(input, pw, ph);
    for (let y = 0; y < th; y += 1) {
      const wy = Math.min(y + 1, th - y, MATTE_OVERLAP) / MATTE_OVERLAP;
      for (let x = 0; x < tw; x += 1) {
        const wx = Math.min(x + 1, tw - x, MATTE_OVERLAP) / MATTE_OVERLAP;
        const s = (ty + y) * width + tx + x;
        const wgt = Math.max(1e-3, wx * wy);
        acc[s] = acc[s]! + alpha[y * pw + x]! * wgt;
        weight[s] = weight[s]! + wgt;
      }
    }
    onTile?.(++done, tiles.length);
  }
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = trimap[i] === 128 && weight[i]! > 0 ? Math.min(1, Math.max(0, acc[i]! / weight[i]!)) : trimap[i]! / 255;
  }
  return out;
}

/** Matte untuk shader: alfa di dalam pita, 1 di luarnya (di luar pita jalur satu lapis). */
export function shaderMatte(rect: UvRect, alpha: Float32Array, band: Uint8Array, width: number, height: number): EdgeMatte {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i += 1) out[i] = band[i] ? alpha[i]! : 1;
  return { ...rect, width, height, alpha: out };
}

/**
 * Lapis depan/belakang di resolusi kedalaman: di piksel kedalaman yang
 * menyentuh pita, rata-rata kedalaman sisi subjek (> ambang) dan sisi latar
 * di jendela `radius` px; di tempat lain keduanya = kedalaman.
 */
export function layeredDepth(depth: DepthMap, matte: EdgeMatte, threshold: number, radius = 6): { foreground: Float32Array; background: Float32Array } {
  const { width: w, height: h, data } = depth;
  const foreground = data.slice();
  const background = data.slice();
  const x0 = Math.max(0, Math.floor(matte.x * w) - 1), x1 = Math.min(w - 1, Math.ceil((matte.x + matte.w) * w) + 1);
  const y0 = Math.max(0, Math.floor(matte.y * h) - 1), y1 = Math.min(h - 1, Math.ceil((matte.y + matte.h) * h) + 1);
  const touches = (x: number, y: number) => {
    // Sampel matte di sekitar pusat piksel kedalaman (3x3): pita = alfa < 1.
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const u = (x + 0.5 + dx * 0.5) / w, v = (y + 0.5 + dy * 0.5) / h;
      const qx = (u - matte.x) / matte.w, qy = (v - matte.y) / matte.h;
      if (qx < 0 || qy < 0 || qx > 1 || qy > 1) continue;
      const mx = Math.min(matte.width - 1, Math.floor(qx * matte.width)), my = Math.min(matte.height - 1, Math.floor(qy * matte.height));
      if (matte.alpha[my * matte.width + mx]! < 1) return true;
    }
    return false;
  };
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (!touches(x, y)) continue;
      let fs = 0, fn = 0, bs = 0, bn = 0;
      for (let j = Math.max(0, y - radius); j <= Math.min(h - 1, y + radius); j += 1) {
        for (let i = Math.max(0, x - radius); i <= Math.min(w - 1, x + radius); i += 1) {
          const d = data[j * w + i]!;
          if (d > threshold) { fs += d; fn += 1; } else { bs += d; bn += 1; }
        }
      }
      const i = y * w + x;
      if (fn) foreground[i] = fs / fn;
      if (bn) background[i] = bs / bn;
    }
  }
  return { foreground, background };
}
