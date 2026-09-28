/**
 * Salinan terskala untuk pratinjau interaktif (spec induk §7.1): dirender
 * saat slider digeser, digantikan render penuh saat dilepas. Efek yang
 * bergantung ukuran piksel (halation, DIR, grain) menghitung
 * `pixel_size_um = film_format_mm * 1000 / max(fullWidth, fullHeight)` per
 * render, jadi skala fisiknya tetap benar pada resolusi pratinjau.
 */

export const PREVIEW_MAX_LONG_EDGE = 1024;

export interface ScaledImage {
  rgba: Float32Array;
  width: number;
  height: number;
}

/**
 * Box filter: tiap piksel keluaran = rata-rata kotak sumber
 * `[floor(x*w/W), floor((x+1)*w/W))` di kedua sumbu. Masukan yang sudah
 * dalam batas dikembalikan apa adanya (tanpa salinan).
 */
export function boxDownscale(rgba: Float32Array, width: number, height: number, maxLongEdge: number): ScaledImage {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return { rgba, width, height };

  const scale = maxLongEdge / longEdge;
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const out = new Float32Array(outW * outH * 4);

  for (let oy = 0; oy < outH; oy += 1) {
    const y0 = Math.floor((oy * height) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / outH));
    for (let ox = 0; ox < outW; ox += 1) {
      const x0 = Math.floor((ox * width) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / outW));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = y0; y < y1; y += 1) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x < x1; x += 1, i += 4) {
          r += rgba[i]!;
          g += rgba[i + 1]!;
          b += rgba[i + 2]!;
          a += rgba[i + 3]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      out.set([r / n, g / n, b / n, a / n], (oy * outW + ox) * 4);
    }
  }
  return { rgba: out, width: outW, height: outH };
}
