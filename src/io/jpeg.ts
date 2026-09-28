/**
 * Decoder JPEG. Keluaran 8-bit ter-encode, disarankan `sRGB` (spec Fase 2
 * §5); profil ICC dan orientasi EXIF belum dibaca. Decodenya sendiri ada di
 * `jpegDecoder.ts` (meniru libjpeg-turbo, lihat alasannya di sana).
 */
import type { DecodedImage } from './decoded';
import { decodeJpegPixels } from './jpegDecoder';
import { interleavedToRgba } from './pixels';

export function decodeJpeg(bytes: Uint8Array, name?: string): DecodedImage {
  const { width, height, channels, data } = decodeJpegPixels(bytes);
  return {
    width,
    height,
    rgba: interleavedToRgba(data, width, height, channels, 255),
    suggestedColorSpace: 'sRGB',
    encoding: 'encoded',
    source: { format: 'jpeg', bitDepth: 8, ...(name === undefined ? {} : { name }) },
  };
}
