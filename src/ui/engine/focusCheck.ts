/**
 * Cek fokus (seperti mode Focus EMULSION): area di luar kedalaman ruang
 * menjadi abu-abu gelap (30 % luminans), area yang masih tajam tampil apa
 * adanya. Tanpa warna palsu: yang terlihat tetap cetakan itu sendiri.
 *
 * Tajam = CoC di bawah CoC yang masih diterima (diagonal bingkai / 1442),
 * dengan tepi lembut sampai 1,5x-nya + 0,5 px -- rumus dan ambangnya sama
 * dengan overlay komposit EMULSION. CoC dihitung dari peta kedalaman dan
 * setelan lensa yang sama dengan tahap `lensBlur`, pada pitch piksel
 * pratinjau (rasio CoC terhadap ambang tidak bergantung ukuran render).
 *
 * Hanya untuk pratinjau: tidak pernah masuk ke berkas ekspor.
 */
import { FILM_FORMAT_LONG_EDGE_MM } from '../../params/filmFormat';
import type { RenderParams } from '../../params/renderParams';
import { acceptableCocMm, lensSettings, resolveLensFrame, signedCocPx } from '../../host/lens';
import type { DepthMap } from '../../host/lens';
import type { Frame } from './display';

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Bilinear, uv 0..1, baris atas-bawah (konvensi `DepthMap`). */
function depthAt(map: DepthMap, u: number, v: number): number {
  const x = Math.min(Math.max(u * map.width - 0.5, 0), map.width - 1);
  const y = Math.min(Math.max(v * map.height - 0.5, 0), map.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, map.width - 1);
  const y1 = Math.min(y0 + 1, map.height - 1);
  const tx = x - x0;
  const ty = y - y0;
  const d = map.data;
  const a = d[y0 * map.width + x0]! + (d[y0 * map.width + x1]! - d[y0 * map.width + x0]!) * tx;
  const b = d[y1 * map.width + x0]! + (d[y1 * map.width + x1]! - d[y1 * map.width + x0]!) * tx;
  return a + (b - a) * ty;
}

/** Prepare once per rendered photo/depth map. The translucent mask is bounded;
 * the photo underneath remains at its acquired resolution, including zoom.
 * CoC thresholds still use the original preview's pixel pitch. */
export function prepareFocusOverlay(frame: Frame, depth: DepthMap): (params: RenderParams) => Frame {
  const sourceEdge = Math.max(frame.width, frame.height);
  const scale = Math.min(1, 768 / sourceEdge);
  const width = Math.max(1, Math.round(frame.width * scale));
  const height = Math.max(1, Math.round(frame.height * scale));
  const disparities = new Float32Array(width * height);
  const grey = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    const sy = Math.min(frame.height - 1, Math.floor(v * frame.height));
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const i = y * width + x;
      disparities[i] = depthAt(depth, u, v);
      const p = (sy * frame.width + Math.min(frame.width - 1, Math.floor(u * frame.width))) * 4;
      grey[i] = (0.2126 * frame.pixels[p]! + 0.7152 * frame.pixels[p + 1]! + 0.0722 * frame.pixels[p + 2]!) * 0.3;
    }
  }
  return (params) => {
    const filmFormatMm = FILM_FORMAT_LONG_EDGE_MM[params.filmFormat];
    const lens = resolveLensFrame(lensSettings(params), depth, params.filmFormat, filmFormatMm, sourceEdge);
    const edge0 = acceptableCocMm(filmFormatMm, frame.width / frame.height) * (sourceEdge / filmFormatMm);
    const edge1 = edge0 * 1.5 + 0.5;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < disparities.length; i += 1) {
      const c = Math.abs(signedCocPx(disparities[i]!, lens.focusDisparity, lens.cocScalePx, lens.maxCocPx, lens.nearDisparity, lens.foreground));
      const p = i * 4;
      pixels[p] = pixels[p + 1] = pixels[p + 2] = grey[i]!;
      pixels[p + 3] = 255 * smoothstep(edge0, edge1, c);
    }
    return { width, height, pixels, colorSpace: frame.colorSpace };
  };
}

export function focusCheckFrame(frame: Frame, depth: DepthMap, params: RenderParams): Frame {
  const { width, height, pixels } = frame;
  const longEdge = Math.max(width, height);
  const filmFormatMm = FILM_FORMAT_LONG_EDGE_MM[params.filmFormat];
  const lens = resolveLensFrame(lensSettings(params), depth, params.filmFormat, filmFormatMm, longEdge);
  const acceptPx = acceptableCocMm(filmFormatMm, width / height) * (longEdge / filmFormatMm);
  const edge0 = acceptPx;
  const edge1 = acceptPx * 1.5 + 0.5;

  const out = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const c = Math.abs(
        signedCocPx(depthAt(depth, (x + 0.5) / width, v), lens.focusDisparity, lens.cocScalePx, lens.maxCocPx, lens.nearDisparity, lens.foreground),
      );
      const sharp = 1 - smoothstep(edge0, edge1, c);
      const r = pixels[i]!;
      const g = pixels[i + 1]!;
      const b = pixels[i + 2]!;
      const grey = (0.2126 * r + 0.7152 * g + 0.0722 * b) * 0.3;
      out[i] = grey + (r - grey) * sharp;
      out[i + 1] = grey + (g - grey) * sharp;
      out[i + 2] = grey + (b - grey) * sharp;
      out[i + 3] = pixels[i + 3]!;
    }
  }
  return { width, height, pixels: out, colorSpace: frame.colorSpace };
}
