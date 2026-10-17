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

/**
 * Matte untuk shader: alfa ViTMatte di dalam pita, nilai trimap di luarnya
 * (0 sisi latar, 1 sisi subjek). JANGAN 1 di sisi latar: `layeredDepth`
 * mengisi lapis depan dengan kedalaman subjek di texel kedalaman yang
 * menyentuh pita, dan sampel bilinear shader merembes sekitar satu texel ke
 * luar pita -- dengan alfa 1 di sana latar keluar tajam sebagai garis
 * "outline" tipis di antara pita dan latar yang blur. Dengan alfa 0 sisi
 * latar dirender dari lapis belakang; di tempat lapis depan = belakang
 * hasilnya identik dengan satu lapis.
 */
export function shaderMatte(rect: UvRect, alpha: Float32Array, band: Uint8Array, trimap: Uint8Array, width: number, height: number, feather = 0): EdgeMatte {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i += 1) out[i] = band[i] ? alpha[i]! : trimap[i]! / 255;
  if (feather > 0) featherBandEdge(out, band, width, height, Math.max(1, (feather / Math.max(rect.w, rect.h)) * Math.max(width, height)));
  return { ...rect, width, height, alpha: out };
}

/**
 * Lebar peralihan di tepi dalam pita (bagian sisi panjang foto). Di sana kedua
 * lapis kedalaman dibaurkan ke kedalaman asli (`layeredDepth`); dengan depan =
 * belakang = kedalaman, render identik dengan tanpa Refine Edge berapa pun
 * alfanya, seperti di luar pita. Tanpa ini pita tampil sebagai kotak bertepi
 * lurus di mana pun ViTMatte tidak sepakat dengan peta kedalaman.
 */
export const BAND_FEATHER = 0.01;

/** Jarak (px, chamfer 3-4) tiap piksel pita ke piksel terdekat di luar pita. */
export function distanceToBandEdge(band: Uint8Array, width: number, height: number): Float32Array {
  const big = 1e9, d = new Float32Array(width * height);
  for (let i = 0; i < d.length; i += 1) d[i] = band[i] ? big : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : d[y * width + x]!);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = y * width + x;
    if (!d[i]) continue;
    d[i] = Math.min(d[i]!, at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
  }
  for (let y = height - 1; y >= 0; y -= 1) for (let x = width - 1; x >= 0; x -= 1) {
    const i = y * width + x;
    if (!d[i]) continue;
    d[i] = Math.min(d[i]!, at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
  }
  for (let i = 0; i < d.length; i += 1) d[i] = d[i]! / 3;
  return d;
}

/** Bobot peralihan 0 (tepi pita) .. 1 (`feather` px ke dalam), smoothstep. */
function featherWeight(dist: number, feather: number): number {
  const t = Math.min(1, dist / feather);
  return t * t * (3 - 2 * t);
}

/** Alfa di tepi dalam pita dibaurkan ke 1 (satu lapis), selebar `feather` px. */
export function featherBandEdge(alpha: Float32Array, band: Uint8Array, width: number, height: number, feather: number): void {
  const dist = distanceToBandEdge(band, width, height);
  for (let i = 0; i < alpha.length; i += 1) {
    if (!band[i]) continue;
    alpha[i] = 1 + (alpha[i]! - 1) * featherWeight(dist[i]!, feather);
  }
}

/**
 * Lapis depan/belakang di resolusi kedalaman. Di piksel kedalaman yang
 * menyentuh PITA SAPUAN (bukan alfa < 1: helai yang matte-nya pasti subjek
 * punya alfa 1 dan tetap harus memakai kedalaman subjek), lapis SISI PIKSEL
 * ITU SENDIRI (menurut ambang) = kedalamannya sendiri, dan lapis seberang =
 * rata-rata kedalaman sisi seberang di jendela `radius` px; tanpa tetangga di
 * sisi itu, kedalaman khas sisi itu di seluruh kotak (helai yang mencuat jauh
 * dari tubuh di peta kedalaman). Di tempat lain keduanya = kedalaman.
 *
 * Kedalaman sendiri (bukan rata-rata) untuk sisinya sendiri: piksel yang
 * matte dan kedalaman sepakat dirender persis seperti tanpa Refine Edge, jadi
 * pita tidak tampil sebagai kotak berkabut bertepi lurus (dulu: kabel/tepi
 * berkedalaman sedang di dalam pita didorong ke rata-rata latar yang jauh).
 */
export function layeredDepth(
  depth: DepthMap,
  rect: UvRect,
  band: Uint8Array,
  bandWidth: number,
  bandHeight: number,
  threshold: number,
  feather = 0,
): { foreground: Float32Array; background: Float32Array } {
  const { width: w, height: h, data } = depth;
  const foreground = data.slice();
  const background = data.slice();
  const radius = Math.max(6, Math.round(0.03 * Math.max(w, h)));
  const x0 = Math.max(0, Math.floor(rect.x * w) - 1), x1 = Math.min(w - 1, Math.ceil((rect.x + rect.w) * w) + 1);
  const y0 = Math.max(0, Math.floor(rect.y * h) - 1), y1 = Math.min(h - 1, Math.ceil((rect.y + rect.h) * h) + 1);
  // Kedalaman khas tiap sisi di kotak sapuan (median).
  const fgAll: number[] = [], bgAll: number[] = [];
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
    const d = data[y * w + x]!;
    (d > threshold ? fgAll : bgAll).push(d);
  }
  const median = (v: number[], fallback: number) => (v.length ? v.sort((a, b) => a - b)[v.length >> 1]! : fallback);
  const fgTypical = median(fgAll, threshold);
  const bgTypical = median(bgAll, threshold);
  const touches = (x: number, y: number) => {
    // Pita di sekitar pusat piksel kedalaman (3x3 sampel).
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const qx = ((x + 0.5 + dx * 0.5) / w - rect.x) / rect.w, qy = ((y + 0.5 + dy * 0.5) / h - rect.y) / rect.h;
      if (qx < 0 || qy < 0 || qx > 1 || qy > 1) continue;
      const mx = Math.min(bandWidth - 1, Math.floor(qx * bandWidth)), my = Math.min(bandHeight - 1, Math.floor(qy * bandHeight));
      if (band[my * bandWidth + mx]) return true;
    }
    return false;
  };
  // Jumlah geser lewat summed-area table di kotak + radius: O(1) per piksel.
  const ax0 = Math.max(0, x0 - radius), ay0 = Math.max(0, y0 - radius);
  const ax1 = Math.min(w - 1, x1 + radius), ay1 = Math.min(h - 1, y1 + radius);
  const sw = ax1 - ax0 + 2, sh = ay1 - ay0 + 2;
  const fSum = new Float64Array(sw * sh), fCnt = new Float64Array(sw * sh);
  const bSum = new Float64Array(sw * sh), bCnt = new Float64Array(sw * sh);
  for (let y = ay0; y <= ay1; y += 1) {
    for (let x = ax0; x <= ax1; x += 1) {
      const d = data[y * w + x]!;
      const k = (y - ay0 + 1) * sw + (x - ax0 + 1);
      const fg = d > threshold;
      const up = k - sw, left = k - 1, diag = k - sw - 1;
      fSum[k] = (fg ? d : 0) + fSum[up]! + fSum[left]! - fSum[diag]!;
      fCnt[k] = (fg ? 1 : 0) + fCnt[up]! + fCnt[left]! - fCnt[diag]!;
      bSum[k] = (fg ? 0 : d) + bSum[up]! + bSum[left]! - bSum[diag]!;
      bCnt[k] = (fg ? 0 : 1) + bCnt[up]! + bCnt[left]! - bCnt[diag]!;
    }
  }
  const box = (t: Float64Array, x: number, y: number) => {
    const xa = Math.max(ax0, x - radius) - ax0, xb = Math.min(ax1, x + radius) - ax0 + 1;
    const ya = Math.max(ay0, y - radius) - ay0, yb = Math.min(ay1, y + radius) - ay0 + 1;
    return t[yb * sw + xb]! - t[ya * sw + xb]! - t[yb * sw + xa]! + t[ya * sw + xa]!;
  };
  // Texel yang menyentuh pita, lalu jaraknya ke tepi pita (peralihan ke satu lapis).
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const inBand = new Uint8Array(bw * bh);
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) inBand[(y - y0) * bw + (x - x0)] = touches(x, y) ? 1 : 0;
  const dist = feather > 0 ? distanceToBandEdge(inBand, bw, bh) : undefined;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const k = (y - y0) * bw + (x - x0);
      if (!inBand[k]) continue;
      const fn = box(fCnt, x, y), bn = box(bCnt, x, y);
      const i = y * w + x;
      const d = data[i]!;
      const wgt = dist ? featherWeight(dist[k]!, feather) : 1;
      if (d > threshold) background[i] = d + ((bn > 0 ? box(bSum, x, y) / bn : bgTypical) - d) * wgt;
      else foreground[i] = d + ((fn > 0 ? box(fSum, x, y) / fn : fgTypical) - d) * wgt;
    }
  }
  return { foreground, background };
}
