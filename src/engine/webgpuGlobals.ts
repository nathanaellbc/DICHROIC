/**
 * `GPUBufferUsage`/`GPUMapMode` adalah GLOBAL bawaan browser (dipasang mesin
 * browser di `globalThis`, sama seperti `navigator.gpu` yang `getNavigatorGpu()`
 * di `device.ts` tangani) -- tidak ada modul yang mengekspornya di sana. Di
 * Node/Vitest tidak ada browser yang memasangnya, dan satu-satunya sumber
 * yang tersedia untuk test (lihat `device.ts`) adalah paket `webgpu` (Dawn),
 * yang mengekspornya lewat `globals.GPUBufferUsage`/`globals.GPUMapMode`
 * alih-alih memasangnya ke `globalThis` sendiri.
 *
 * Diresolusi SEKALI di sini lewat top-level await saat modul dimuat -- nilainya
 * adalah namespace bitmask statis yang tidak pernah berubah antar panggilan
 * (pola yang sama dengan `arena.ts` sebelum modul ini ada, lihat riwayat git
 * untuk komentar aslinya di sana).
 *
 * Diekstrak ke modul terpisah ini karena blok ini SEBELUMNYA diduplikasi
 * verbatim di `arena.ts`, `graph.ts`, dan `graph.test.ts` -- tiga salinan,
 * tiga peluang menyimpang. Diekstrak SEBELUM Task 11-18 menulis delapan
 * tahap baru yang masing-masing kemungkinan akan butuh salah satu dari
 * kedua namespace ini untuk membuat buffer sendiri, bukan sesudah --
 * supaya tidak ada duplikasi kedelapan/kesembilan untuk dirapikan nanti.
 */
import { importDawn } from './dawn';

export const gpuBufferUsage: typeof GPUBufferUsage =
  typeof GPUBufferUsage !== 'undefined'
    ? GPUBufferUsage
    : (
        (await importDawn()) as {
          globals: { GPUBufferUsage: typeof GPUBufferUsage };
        }
      ).globals.GPUBufferUsage;

export const gpuMapMode: typeof GPUMapMode =
  typeof GPUMapMode !== 'undefined'
    ? GPUMapMode
    : (
        (await importDawn()) as {
          globals: { GPUMapMode: typeof GPUMapMode };
        }
      ).globals.GPUMapMode;
