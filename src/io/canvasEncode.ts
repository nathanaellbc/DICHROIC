/**
 * Encoder format lossy (JPEG, WebP, AVIF) lewat `OffscreenCanvas.convertToBlob`
 * milik browser -- dipanggil di worker `Session`, tanpa DOM halaman.
 *
 * Browser diam-diam jatuh ke PNG untuk tipe yang tidak bisa ia encode (Safari
 * lama untuk WebP dan AVIF), jadi format ditawarkan lewat PROBING: encode
 * kanvas 4x4 lalu baca MIME blob hasilnya -- satu-satunya bukti yang tidak
 * bisa bohong. Encode sungguhan juga menolak blob yang tipenya lain dari
 * yang diminta alih-alih menyerahkan PNG berlabel `.jpg`.
 *
 * PNG 8/16 dan TIFF 16 TIDAK lewat sini: encoder kita sendiri (`encode.ts`)
 * menulis nilai render persis, termasuk 16-bit yang tidak dimiliki kanvas.
 */

import { quantize } from './encode';
import type { RgbPixels } from './encode';

export type CanvasFormat = 'jpeg' | 'webp' | 'avif';

export const CANVAS_FORMATS: readonly CanvasFormat[] = ['jpeg', 'webp', 'avif'];

export const CANVAS_MIME: Readonly<Record<CanvasFormat, string>> = {
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** Ruang warna kanvas yang ditandai pada berkas hasil encode. */
export type CanvasColorSpace = 'srgb' | 'display-p3';

/**
 * Encoder piksel RGBA 8-bit -> berkas. Disuntikkan ke `Session` (Node test
 * memakai tiruan); bawaan di browser: `offscreenCanvasEncoder`.
 */
export interface CanvasEncoder {
  encode(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    format: CanvasFormat,
    quality: number,
    colorSpace: CanvasColorSpace,
  ): Promise<Uint8Array>;
  /** Format lossy yang benar-benar dihasilkan encoder ini. */
  probe(): Promise<CanvasFormat[]>;
}

/**
 * RGB f32 rapat (sudah ter-encode, [0,1]) -> RGBA 8-bit dengan kuantisasi
 * yang SAMA dengan PNG 8-bit (`quantize`), jadi JPEG/WebP/AVIF berangkat dari
 * piksel yang identik dengan ekspor lossless.
 */
export function rgbToRgba8(rgb: RgbPixels, width: number, height: number): Uint8ClampedArray {
  const n = width * height;
  const q = quantize(rgb.subarray(0, n * 3), 8);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i += 1, j += 3) {
    const o = i * 4;
    out[o] = q[j]!;
    out[o + 1] = q[j + 1]!;
    out[o + 2] = q[j + 2]!;
    out[o + 3] = 255;
  }
  return out;
}

/** `quality` kanvas dibatasi ke (0, 1]; 0 membuat sebagian browser memakai bawaannya. */
export function clampQuality(quality: number): number {
  return Math.min(Math.max(Number.isFinite(quality) ? quality : 1, 0.01), 1);
}

function hasOffscreenCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

async function convert(canvas: OffscreenCanvas, mime: string, quality: number): Promise<Blob> {
  return canvas.convertToBlob({ type: mime, quality });
}

let probed: Promise<CanvasFormat[]> | undefined;

export const offscreenCanvasEncoder: CanvasEncoder = {
  async encode(pixels, width, height, format, quality, colorSpace) {
    if (!hasOffscreenCanvas()) throw new Error('OffscreenCanvas tidak tersedia untuk encode lossy.');
    const mime = CANVAS_MIME[format];
    const canvas = new OffscreenCanvas(width, height);
    const ctx = (canvas.getContext('2d', { colorSpace }) ?? canvas.getContext('2d')) as OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('Browser tidak memberi kanvas 2D untuk encode.');
    const data = new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height, { colorSpace });
    ctx.putImageData(data, 0, 0);
    const blob = await convert(canvas, mime, clampQuality(quality));
    if (blob.type !== mime) throw new Error(`Browser ini tidak meng-encode ${format.toUpperCase()} (memberi ${blob.type || 'tipe kosong'}).`);
    return new Uint8Array(await blob.arrayBuffer());
  },

  probe() {
    probed ??= (async () => {
      if (!hasOffscreenCanvas()) return [];
      const found: CanvasFormat[] = [];
      for (const format of CANVAS_FORMATS) {
        try {
          const canvas = new OffscreenCanvas(4, 4);
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          ctx.fillStyle = '#804020';
          ctx.fillRect(0, 0, 4, 4);
          const blob = await convert(canvas, CANVAS_MIME[format], 0.5);
          if (blob.type === CANVAS_MIME[format]) found.push(format);
        } catch {
          // Tipe yang membuat encoder melempar sama dengan tidak didukung.
        }
      }
      return found;
    })();
    return probed;
  },
};
