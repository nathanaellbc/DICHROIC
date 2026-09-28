/**
 * Titik masuk `io/` (spec Fase 2 §5): `decodeImage` memilih decoder dari
 * magic bytes dan membungkus setiap galat pustaka menjadi `DecodeError`.
 */
import type { DecodedImage } from './decoded';
import { detectFormat, type ImageFormat } from './detect';
import { DecodeError } from './errors';

export type { DecodedImage } from './decoded';
export { detectFormat, type ImageFormat } from './detect';
export { DecodeError } from './errors';

type Decoder = (bytes: Uint8Array, name?: string) => Promise<DecodedImage> | DecodedImage;

/** Decoder per format; diisi bertahap oleh Task 2-5 rencana 2B. */
const DECODERS: Partial<Record<ImageFormat, () => Promise<Decoder>>> = {
  jpeg: async () => (await import('./jpeg')).decodeJpeg,
  png: async () => (await import('./png')).decodePng,
  tiff: async () => (await import('./tiff')).decodeTiff,
  exr: async () => (await import('./exr')).decodeExr,
};

async function runDecoder(format: ImageFormat, bytes: Uint8Array, name?: string): Promise<DecodedImage> {
  const load = DECODERS[format];
  if (!load) throw new DecodeError(format, 'decoder untuk format ini belum tersedia');
  try {
    return await (await load())(bytes, name);
  } catch (error) {
    if (error instanceof DecodeError) throw error;
    throw new DecodeError(format, error instanceof Error ? error.message : String(error));
  }
}

export async function decodeImage(bytes: Uint8Array, name?: string): Promise<DecodedImage> {
  const format = detectFormat(bytes);
  if (format !== 'unknown') return runDecoder(format, bytes, name);
  throw new DecodeError('unknown', 'magic bytes tidak dikenali');
}
