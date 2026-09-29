/**
 * Gambar ter-decode, bentuk bersama semua decoder `io/` (spec Fase 2 §5).
 *
 * `rgba` selalu 4 kanal f32 (alpha diabaikan engine). `suggestedColorSpace`
 * adalah label `manifest.colorSpaces.labels` yang disarankan decoder --
 * HANYA saran: colour space input tetap parameter pilihan pengguna
 * (`RenderParams.inputColorSpace`), karena profil ICC belum dibaca.
 * `encoding` menyatakan apakah nilainya masih membawa kurva transfer
 * (`'encoded'`, mis. JPEG sRGB) atau sudah linear (`'linear'`, mis. EXR/RAW).
 */
export interface DecodedImage {
  width: number;
  height: number;
  rgba: Float32Array;
  suggestedColorSpace: string;
  encoding: 'encoded' | 'linear';
  /**
   * EXIF berkas asli, bersih dan ringkas (`io/exif.ts` `captureExif`):
   * dibawa ke berkas ekspor. Tidak ada untuk format tanpa EXIF.
   */
  exif?: Uint8Array;
  source: {
    /** `browser`: decoder gambar bawaan browser (HEIC, AVIF, WebP; lihat `ui/engine/browserDecode.ts`). */
    format: 'jpeg' | 'png' | 'tiff' | 'exr' | 'raw' | 'browser' | 'fixture';
    bitDepth: number;
    name?: string;
  };
}
