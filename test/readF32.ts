import { readFileSync } from 'node:fs';

/**
 * Baca berkas biner little-endian f32 mentah menjadi `Float32Array`.
 *
 * Review seluruh-branch, agenda #4 (`docs/superpowers/plans/2026-09-11-
 * dichroic-phase1-engine.md`, "Agenda review seluruh-branch"): Task 10
 * menunda ekstraksi ini dengan aturan "ekstrak kalau muncul salinan
 * ketiga" -- saat itu HANYA `test/parity/compare.ts::readF32` (SALIN,
 * `.slice()`) dan `test/fixtures.test.ts` (ALIAS, tanpa `.slice()`) yang
 * ada. Menghitung ulang sekarang: `test/assets.test.ts` (DUA situs
 * panggil, `stocksBlob()`/`staticBlob()`) dan `test/profiles.test.ts`
 * (`readRawBlob()`) SUDAH masing-masing menulis implementasi ALIAS-nya
 * SENDIRI sejak sebelum review ini -- salinan ketiga (dan keempat) sudah
 * ada, aturan penundaan sudah terpenuhi. Kesembilan berkas
 * `test/parity/*.test.ts` TIDAK ikut dihitung -- semuanya SUDAH memakai
 * ulang `compare.ts::loadTap`/`loadInputAsRgba` (satu implementasi, nol
 * salinan baru), itulah kenapa hitungan salinan tetap kecil meski jumlah
 * berkas test bertambah banyak.
 *
 * SELALU menyalin (`buf.buffer.slice(...)`), TIDAK meng-alias `Buffer`
 * Node yang dikembalikan `readFileSync` seperti ketiga implementasi ALIAS
 * yang diekstrak ini dulu lakukan -- bukan cuma gaya. `Buffer.byteOffset`
 * yang `readFileSync` kembalikan TIDAK dijamin kelipatan 4: alokasi kecil
 * bisa dipotong dari kolam bersama Node (`Buffer.poolSize`), yang mengepak
 * alokasi berurutan tanpa alignment. `new Float32Array(buf.buffer,
 * buf.byteOffset, n)` melempar `RangeError` ("start offset ... is not a
 * multiple of BYTES_PER_ELEMENT") bila `byteOffset` itu bukan kelipatan 4
 * -- kegagalan yang sepenuhnya di luar kendali pemanggil (bergantung
 * riwayat alokasi Buffer proses Node, bukan isi berkas), dan yang HANYA
 * implementasi SALIN `compare.ts` kebal terhadapnya (`.slice()` selalu
 * memulai array hasil dari offset 0 yang selaras). Mengekstrak varian ALIAS
 * yang lebih murah TANPA memilih basis SALIN yang sudah kebal akan
 * mengekstrak kerapuhannya juga -- bukan tujuan ekstraksi ini.
 */
export function readF32(path: string): Float32Array {
  const buf = readFileSync(path);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
