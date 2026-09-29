/**
 * Menyerahkan berkas ekspor ke pengguna (pola ekspor EMULSION, ditulis ulang).
 *
 * Dua jalur, sama-sama menerima berkas yang SUDAH ada:
 *  - Simpan ke Foto: lembar Bagikan sistem, cara browser menyerahkan gambar ke
 *    galeri di iOS/Android. `navigator.share` WAJIB dipanggil di dalam gestur
 *    pengguna di iOS -- tidak boleh ada `await` antara ketukan dan panggilan
 *    ini, jadi lembar Ekspor merender dan meng-encode lebih dulu.
 *  - Unduh: klik anchor. URL objek dilepas semenit kemudian, bukan di tick
 *    yang sama: Chromium memulai unduhan secara asinkron, dan URL yang dicabut
 *    terlalu cepat membuat berkas tersimpan sebagai "download" tanpa ekstensi.
 */

/** Bisakah browser ini menyerahkan berkas gambar ke lembar Bagikan sistem? */
export function canShareImages(): boolean {
  if (typeof navigator === 'undefined' || !navigator.canShare || !navigator.share) return false;
  try {
    return navigator.canShare({ files: [new File([new Uint8Array(0)], 'probe.png', { type: 'image/png' })] });
  } catch {
    return false;
  }
}

/**
 * Jalur Bagikan ditawarkan hanya untuk pointer sentuh: di desktop, target
 * bagikan browser bukan arti "simpan ke Foto", jadi Unduh tetap utama.
 */
export function prefersShareSheet(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true && canShareImages();
}

/**
 * Dipanggil SINKRON dari handler klik. Lembar yang ditutup pengguna berarti
 * batal, bukan galat.
 */
export async function saveViaShare(file: File): Promise<'shared' | 'cancelled'> {
  try {
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    if (error instanceof Error && /abort/i.test(error.message)) return 'cancelled';
    throw error;
  }
}

export function saveViaDownload(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Bagian nama berkas dalam ASCII polos. Chromium membuang nama `download`
 * anchor yang memuat karakter seperti em dash atau titik tengah dan menyimpan
 * berkas sebagai "download" tanpa ekstensi. Aksen dilipat (é -> e), karakter
 * lain di luar himpunan aman menjadi tanda hubung.
 */
export function asciiName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ._()+-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[\s.-]+|[\s.-]+$/g, '');
}

/** `<foto> - <film> on <kertas>.<ext>` (atau `<film> scan` tanpa kertas). */
export function exportFileName(sourceName: string | undefined, film: string, paper: string | undefined, ext: string): string {
  const stem = asciiName((sourceName ?? '').replace(/\.[^.]+$/, '')) || 'photo';
  const look = paper ? `${asciiName(film)} on ${asciiName(paper)}` : `${asciiName(film)} scan`;
  return `${stem} - ${look}.${ext}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
