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

/**
 * Wilayah `[x, x + w) x [y, y + h)` dari `boxDownscale(rgba, width, height,
 * ...)` berukuran `outW x outH`, tanpa membuat frame terskala utuh. Nilainya
 * identik bit demi bit dengan frame utuh (kotak dan urutan penjumlahan sama),
 * jadi ekspor ber-tile bisa membaca tile langsung dari sumber: ekspor 4096 px
 * dari foto 24 MP tidak lagi menahan salinan float 200 MB.
 */
export function boxDownscaleRegion(
  rgba: Float32Array, width: number, height: number, outW: number, outH: number,
  x: number, y: number, w: number, h: number, into?: Float32Array,
): Float32Array {
  const out = into ? into.subarray(0, w * h * 4) : new Float32Array(w * h * 4);
  const same = outW === width && outH === height;
  for (let row = 0; row < h; row += 1) {
    const oy = y + row;
    if (same) {
      const start = (oy * width + x) * 4;
      out.set(rgba.subarray(start, start + w * 4), row * w * 4);
      continue;
    }
    const y0 = Math.floor((oy * height) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / outH));
    for (let col = 0; col < w; col += 1) {
      const ox = x + col;
      const x0 = Math.floor((ox * width) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / outW));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        let i = (yy * width + x0) * 4;
        for (let xx = x0; xx < x1; xx += 1, i += 4) {
          r += rgba[i]!;
          g += rgba[i + 1]!;
          b += rgba[i + 2]!;
          a += rgba[i + 3]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (row * w + col) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return out;
}

/** Ukuran keluaran `boxDownscale` untuk sisi panjang `maxLongEdge` (tanpa menghitung piksel). */
export function boxDownscaleSize(width: number, height: number, maxLongEdge: number): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return { width, height };
  const scale = maxLongEdge / longEdge;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Sisi panjang kisi pengukuran auto-exposure dan pivot (`measureAutoExposureEv`, `measureScenePivot`). */
const MEASURE_LONG_EDGE = 256;

/**
 * Kisi pengukuran <= 256 px dari frame `boxDownscale` berukuran `outW x outH`,
 * dicuplik tetangga terdekat persis seperti pengukurannya
 * (`min(W - 1, floor(x * W / pw))`): pengukuran pada gambar kecil ini sama
 * dengan pengukuran pada frame utuh, tanpa membuat frame itu.
 */
export function measurementImage(rgba: Float32Array, width: number, height: number, outW: number, outH: number): ScaledImage {
  const scale = Math.min(1, MEASURE_LONG_EDGE / Math.max(outW, outH));
  const pw = Math.max(1, Math.round(outW * scale));
  const ph = Math.max(1, Math.round(outH * scale));
  const out = new Float32Array(pw * ph * 4);
  for (let y = 0; y < ph; y += 1) {
    const sy = Math.min(outH - 1, Math.floor((y * outH) / ph));
    for (let x = 0; x < pw; x += 1) {
      const sx = Math.min(outW - 1, Math.floor((x * outW) / pw));
      boxDownscaleRegion(rgba, width, height, outW, outH, sx, sy, 1, 1, out.subarray((y * pw + x) * 4));
    }
  }
  return { rgba: out, width: pw, height: ph };
}
