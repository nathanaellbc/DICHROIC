import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createHalationStage } from '../../src/engine/stages/halation';
import { createCurveDevelopStage } from '../../src/engine/stages/curveDevelop';
import { createDirStage } from '../../src/engine/stages/dir';
import { createGrainStage } from '../../src/engine/stages/grain';
import { createDiffusionStage } from '../../src/engine/stages/diffusion';
import { createPrintExposureStage, createPrintDevelopStage } from '../../src/engine/stages/printScan';
import { createScannerPostStage } from '../../src/engine/stages/scannerPost';
import type { Arenas } from '../../src/engine/arena';
import type { Stage } from '../../src/engine/graph';

/**
 * Rantai LENGKAP (Task 18) -- SATU-satunya tempat urutan penuh dirakit,
 * per plan Task 18. TIDAK disalin dari sketsa lama plan itu (yang
 * mengurutkan halation/grain SEBELUM diffusion(camera) dan diffusion(print)
 * SETELAH printDevelop -- keduanya salah, dibuktikan lewat gerbang yang
 * sudah lulus di Task 15-17): urutan di bawah dibangun dari apa yang
 * `diffusion.test.ts` (Task 15/17) dan `grain.test.ts` (Task 16) SUDAH
 * buktikan benar terhadap Python, digabung.
 *
 * Urutan mengikuti `FilmingStage.expose()` -> `develop()` ->
 * `PrintingStage.expose()` -> `.develop()` -> `ScanningStage.scan()` Python
 * persis:
 *   1. materializeActiveRegion
 *   2. filmExposure        -- raw linear (slot0=1 untuk family bukan 'lut')
 *   3. diffusion(camera)   -- `apply_diffusion_filter_um` kamera, SEBELUM
 *                             halation (`filming.py:64` sebelum `:68`).
 *                             __DIFFUSION_FINAL_LOG__=false di site ini --
 *                             halation-lah yang menutup log10.
 *   4. halation             -- `apply_halation_um` + log10 TUNGGAL
 *                             (`kOpBounceResolveLog`), PERSIS grain.test.ts.
 *   5. curveDevelop         -- density cmy_film (develop_simple + normalisasi)
 *   6. dir                  -- DIR couplers non-spasial (grain.test.ts, Task 13)
 *   7. grain                -- stokastik, `cmy_film` (Task 16)
 *   8. printExposure        -- `PrintingStage.expose()`, raw linear print
 *                             (slot0=1 untuk family bukan 'lut', sama seperti
 *                             filmExposure -- diffusion(print) menutup log10)
 *   9. diffusion(print)     -- `apply_diffusion_filter_um` enlarger,
 *                             __DIFFUSION_FINAL_LOG__=true di site ini --
 *                             menutup log10 `log_e_print` SENDIRI (tidak ada
 *                             tahap lain setelahnya yang melakukannya, beda
 *                             dari site kamera -- lih. task-17-report.md).
 *  10. printDevelop         -- `PrintingStage.develop()`, density cmy_print
 *  11. scannerPost          -- `ScanningStage.scan()`, tap rgb_out (Task 18)
 *
 * Untuk keluarga `family: 'lut'` (`debug.lut_mode=True`), `slot0` global
 * (satu field `CoreParams`, dibaca SEKALI oleh `filmExposure`/`printScan`
 * expose saat dispatch masing-masing -- lih. `test/parity/params.ts:263`)
 * adalah 0, bukan 1: `filmExposure`/`printExposure` MENUTUP log10 SENDIRI
 * pada dispatch itu. Menjalankan `diffusion`/`halation` SESUDAHNYA pada
 * value yang SUDAH log akan meng-log10-kan dua kali -- itu sebabnya gerbang
 * `_lut` (Task 11-13, 17, dan Gate A Task 18 di `scannerPost.test.ts`) TIDAK
 * memakai `fullChain` ini, melainkan daftar tahap eksplisit yang lebih
 * pendek (persis pola `printScan.test.ts`). `fullChain` ini dipakai untuk
 * keluarga di mana `slot0` global adalah 1 -- `measured`/`_stochastic` --
 * di mana diffusion/halation/diffusion(print) betul-betul dibutuhkan untuk
 * menutup log10, dan di mana diffusion yang TIDAK aktif (baked PSF delta,
 * `DiffusionFilterParams.active=False` default Python) berlaku sebagai
 * no-op spasial murni (tidak menyentuh log10 -- itu urusan
 * `__DIFFUSION_FINAL_LOG__`, independen dari aktif/tidaknya PSF).
 */
export function fullChain(device: GPUDevice, arenas: Arenas): Stage[] {
  return [
    createMaterializeActiveRegionStage(device),
    createFilmExposureStage(device, arenas),
    createDiffusionStage(device, arenas, 'camera'),
    createHalationStage(device, arenas),
    createCurveDevelopStage(device, arenas),
    createDirStage(device, arenas),
    createGrainStage(device, arenas),
    createPrintExposureStage(device, arenas),
    createDiffusionStage(device, arenas, 'print'),
    createPrintDevelopStage(device, arenas),
    createScannerPostStage(device, arenas),
  ];
}
