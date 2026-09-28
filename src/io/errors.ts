import type { ImageFormat } from './detect';

/**
 * Galat decode dari `io/` (spec Fase 2 §5). Selalu menyebut format yang
 * dicoba dan alasannya, sehingga UI bisa menulis pesan yang berguna ("TIFF
 * rusak: ...") alih-alih meneruskan exception mentah pustaka pihak ketiga.
 * `format` bernilai `'unknown'` bila magic bytes tidak dikenali dan LibRaw
 * juga menolaknya.
 */
export class DecodeError extends Error {
  constructor(readonly format: ImageFormat | 'unknown', readonly reason: string) {
    super(`Gagal mendecode ${format === 'unknown' ? 'berkas (format tidak dikenali)' : format.toUpperCase()}: ${reason}`);
    this.name = 'DecodeError';
  }
}
