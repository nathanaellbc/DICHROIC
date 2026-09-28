/**
 * Titik masuk `io/` (spec Fase 2 §5): `decodeImage` memilih decoder dari
 * magic bytes dan membungkus setiap galat pustaka menjadi `DecodeError`.
 */
import type { DecodedImage } from './decoded';
import { detectFormat, type ImageFormat } from './detect';
import { DecodeError } from './errors';
import type { RawDecodeOptions } from './raw';

export type { DecodedImage } from './decoded';
export { detectFormat, type ImageFormat } from './detect';
export { DecodeError } from './errors';

export interface DecodeOptions {
  /** Diteruskan ke decoder RAW (`libraw-wasm`); di Node `wasmBinary` wajib. */
  raw?: RawDecodeOptions;
}

type Decoder = (bytes: Uint8Array, name: string | undefined, options: DecodeOptions) => Promise<DecodedImage> | DecodedImage;

/** Decoder per format; diisi bertahap oleh Task 2-5 rencana 2B. */
const DECODERS: Partial<Record<ImageFormat, () => Promise<Decoder>>> = {
  jpeg: async () => (await import('./jpeg')).decodeJpeg,
  png: async () => (await import('./png')).decodePng,
  tiff: async () => (await import('./tiff')).decodeTiff,
  exr: async () => (await import('./exr')).decodeExr,
  // Lazy: modul WASM LibRaw (~1,4 MB) hanya dimuat saat RAW pertama dibuka.
  raw: async () => {
    const { decodeRaw } = await import('./raw');
    return (bytes, name, options) => decodeRaw(bytes, name, options.raw);
  },
};

async function runDecoder(format: ImageFormat, bytes: Uint8Array, name: string | undefined, options: DecodeOptions): Promise<DecodedImage> {
  const load = DECODERS[format];
  if (!load) throw new DecodeError(format, 'decoder untuk format ini belum tersedia');
  try {
    return await (await load())(bytes, name, options);
  } catch (error) {
    if (error instanceof DecodeError) throw error;
    throw new DecodeError(format, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Decode berkas gambar apa pun yang didukung. Format dikenali dari magic
 * bytes; yang tidak dikenali tetap dicoba lewat LibRaw (ia mengenal jauh
 * lebih banyak format RAW daripada `detectFormat`), dan baru ditolak sebagai
 * `DecodeError('unknown')` bila LibRaw juga menolaknya.
 */
export async function decodeImage(bytes: Uint8Array, name?: string, options: DecodeOptions = {}): Promise<DecodedImage> {
  const format = detectFormat(bytes);
  if (format !== 'unknown') return runDecoder(format, bytes, name, options);
  try {
    return await runDecoder('raw', bytes, name, options);
  } catch (error) {
    const reason = error instanceof DecodeError ? error.reason : String(error);
    throw new DecodeError('unknown', `magic bytes tidak dikenali, dan LibRaw juga menolaknya (${reason})`);
  }
}
