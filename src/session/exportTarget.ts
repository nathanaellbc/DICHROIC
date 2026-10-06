import type { ExportFormat } from './session';

/**
 * Piksel yang dipegang render ekspor (`ExportPixels`): hanya yang dibutuhkan
 * format terpilih. Foto 24 MP: RGB 8-bit 73 MB, 16-bit 147 MB, RGBA kanvas
 * 98 MB -- memegang semuanya sekaligus ikut membuat tab iPhone dimatikan.
 *  - `rgb8`: JPEG, PNG 8-bit, dan WebP/AVIF bila ruang keluaran sRGB/P3
 *    (kanvas dibuat dari RGB 8-bit).
 *  - `rgb16`: PNG/TIFF 16-bit.
 *  - `canvas`: WebP/AVIF dari ruang keluaran lain (dikonversi saat render).
 */
export type ExportTarget = 'rgb8' | 'rgb16' | 'canvas';

export function isDisplaySpace(outputColorSpace: string): boolean {
  return outputColorSpace === 'sRGB' || outputColorSpace === 'Display P3';
}

export function exportTarget(format: ExportFormat, outputColorSpace: string): ExportTarget {
  if (format === 'png16' || format === 'tiff16') return 'rgb16';
  if ((format === 'webp' || format === 'avif') && !isDisplaySpace(outputColorSpace)) return 'canvas';
  return 'rgb8';
}
