/**
 * Jalur cadangan: format yang tidak punya decoder di `io/` tapi bisa dibaca
 * browser sendiri -- terutama HEIC (format kamera iPhone), juga AVIF, WebP,
 * GIF, BMP. Hasilnya 8-bit ter-encode. Bila kanvas mendukung Display P3,
 * piksel dibaca di ruang itu supaya gamut foto HP tidak terpotong ke sRGB.
 *
 * Tidak bit-identik dengan oracle mana pun (decoder milik browser), jadi
 * hanya dipakai untuk format yang memang tidak bisa dibuka lewat `io/`.
 */
import type { DecodedImage } from '../../io/decoded';

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif', 'avis']);

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** Magic bytes format yang diserahkan ke decoder browser. */
export function isBrowserImage(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (HEIF_BRANDS.has(ascii(bytes, 8, 4))) return true;
    for (let o = 16; o + 4 <= Math.min(size, bytes.length); o += 4) {
      if (HEIF_BRANDS.has(ascii(bytes, o, 4))) return true;
    }
    return false;
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return true;
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return true;
  return ascii(bytes, 0, 2) === 'BM';
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function context(width: number, height: number, colorSpace: PredefinedColorSpace): Context2D | null {
  const settings: CanvasRenderingContext2DSettings = { colorSpace, willReadFrequently: true };
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height).getContext('2d', settings);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext('2d', settings);
}

export async function decodeWithBrowser(blob: Blob, name?: string): Promise<DecodedImage> {
  // `from-image`: orientasi EXIF/HEIF diterapkan browser.
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image', colorSpaceConversion: 'default' });
  try {
    const { width, height } = bitmap;
    const ctx = context(width, height, 'display-p3') ?? context(width, height, 'srgb');
    if (!ctx) throw new Error('kanvas 2D tidak tersedia');
    ctx.drawImage(bitmap, 0, 0);
    // Browser tanpa dukungan P3 mengabaikan permintaan ini dan memberi sRGB.
    const pixels = ctx.getImageData(0, 0, width, height, { colorSpace: 'display-p3' });
    const p3 = pixels.colorSpace === 'display-p3';
    const data = pixels.data;
    const rgba = new Float32Array(width * height * 4);
    for (let i = 0; i < rgba.length; i += 1) rgba[i] = data[i]! / 255;
    return {
      width,
      height,
      rgba,
      suggestedColorSpace: p3 ? 'Display P3' : 'sRGB',
      encoding: 'encoded',
      source: { format: 'browser', bitDepth: 8, ...(name === undefined ? {} : { name }) },
    };
  } finally {
    bitmap.close();
  }
}
