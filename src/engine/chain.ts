import { createMaterializeActiveRegionStage } from './stages/materializeActiveRegion';
import { createFilmExposureStage } from './stages/filmExposure';
import { createHalationStage } from './stages/halation';
import { createCurveDevelopStage } from './stages/curveDevelop';
import { createDirStage } from './stages/dir';
import { createGrainStage } from './stages/grain';
import { createDiffusionStage } from './stages/diffusion';
import { createDiffusionFftStage } from './stages/diffusionFft';
import { createPrintExposureStage, createPrintDevelopStage } from './stages/printScan';
import { createScannerPostStage } from './stages/scannerPost';
import type { Arenas } from './arena';
import type { Stage } from './graph';
import type { ChainSpec } from '../params/plan';

/**
 * Rantai produksi (dipindah dari `test/parity/chain.ts`, Fase 2A Task 4).
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
 * keluarga di mana `slot0` global adalah 1 -- `measured`/`_stochastic`.
 *
 * KOREKSI (follow-on session, Gate B): draf SEBELUMNYA paragraf ini
 * mengklaim diffusion yang tidak aktif "berlaku sebagai no-op spasial
 * murni" karena PSF-nya baked delta -- SALAH, dibuktikan langsung dari
 * `src/host/spectral.ts` (`precomputeDiffusionFilter({family:
 * 'black_pro_mist', strength: 0.5}, ...)` dipanggil TANPA SYARAT untuk
 * KEDUA situs, radius=14/scatterFraction~0.2625, BUKAN delta) dan dari
 * Python (`DiffusionFilterParams.active` default `False` UNTUK KEDUA
 * situs, `params_builder.py` tidak pernah menyalakannya untuk keluarga
 * `measured`/`_stochastic` -- hanya `hard_edge_diffusion_{camera,print}`/
 * `impulse_highlight_diffusion_{camera,print}`, `diffusion.test.ts`'s
 * fixture sendiri yang MEMAKAI PSF nonzero itu, lewat daftar tahap
 * eksplisitnya sendiri di luar `fullChain`). Baked PSF di sini dipakai
 * BERSAMA oleh kedua jenis render (tidak dibedakan per-fixture), jadi
 * `radius<=0||scatterFraction<=0`-nya `diffusion.wgsl` TIDAK PERNAH
 * menyala untuk stock apa pun -- membiarkan `fullChain` menjalankan
 * konvolusi PSF asli (bukan identitas) pada keluarga di mana Python
 * TIDAK PERNAH melakukannya. `color_patches_stochastic`'s gate variance
 * (73.7% relative error terukur SEBELUM perbaikan ini) membuktikan
 * dampaknya konkret: PSF 29x29 men-smear tepi tajam antar-patch 8x8
 * yang Python sendiri tidak pernah sentuh.
 *
 * PERBAIKAN: kedua dispatch diffusion di bawah memakai
 * `{ bypassConvolution: true }` (lih. `createDiffusionStage`,
 * `diffusion.wgsl`'s `kBypassConvolution`) -- identitas spasial murni,
 * TIDAK menyentuh `kApplyFinalLog`/`__DIFFUSION_FINAL_LOG__` (independen,
 * situs print MASIH menutup `log10` `PrintingStage.expose()` sebagai
 * dispatch terakhirnya, SATU-SATUNYA tugas yang tidak bisa dilewati
 * bahkan saat PSF-nya identitas). Task 16's `grain.test.ts` sudah
 * membuktikan EMPIRIS sisi kamera: cmy_film mean/var error TIDAK berubah
 * (~1e-6/~1e-3, dalam ambang) baik tahap ini disertakan sebagai identitas
 * ATAU dihilangkan total dari rantai -- `fullChain` menyertakannya
 * (bukan menghilangkannya) supaya urutan 11-tahap yang didokumentasikan
 * di atas tetap utuh secara harfiah, bukan demi hasil numerik yang
 * berbeda (keduanya identik).
 *
 * Fase 2A: `buildChain` menyatukan dua varian yang dulu tersebar di test.
 * `family: 'lut'` adalah daftar pendek `scannerPost.test.ts` Gate A
 * (tanpa halation/diffusion/grain, DIR non-spasial) -- lih. paragraf
 * `lut_mode` di atas untuk kenapa rantai penuh SALAH di keluarga itu.
 * `family: 'measured'` adalah rantai 11 tahap; `grain: false` menghapus
 * tahap grain (keluarga `<case>` deterministik, `measuredChain.test.ts`).
 */
/**
 * Fase 2D Task 3 (`io.scan_film`): film di-scan langsung. Topologi Python
 * `CMY_FILM -> RGB_OUT` lewat `scanning.scan_film` -- ketiga tahap print
 * (exposure enlarger, difusi enlarger, develop kertas) TIDAK dibangun sama
 * sekali (modul WGSL-nya butuh entri arena print yang tidak ada di mode ini);
 * tahap scanner yang SAMA membaca `cmy_film` dengan data scanner FILM di
 * arena dynamic (`precomputeArenaData(..., { scanFilm: true })`).
 */
/**
 * Fase 2D Task 4: situs difusi memakai konvolusi FFT df64 bila aktif; bila
 * mati tetap tahap identitas (`bypassConvolution`) yang menjaga semantik
 * linear/log antar-tahap persis seperti sebelumnya.
 */
function cameraDiffusionStage(device: GPUDevice, arenas: Arenas, spec: ChainSpec): Stage {
  return spec.cameraDiffusion
    ? createDiffusionFftStage(device, 'camera')
    : createDiffusionStage(device, arenas, 'camera', { bypassConvolution: true });
}

function printDiffusionStage(device: GPUDevice, arenas: Arenas, spec: ChainSpec): Stage {
  return spec.printDiffusion
    ? createDiffusionFftStage(device, 'print')
    : createDiffusionStage(device, arenas, 'print', { bypassConvolution: true });
}

export function buildChain(device: GPUDevice, arenas: Arenas, spec: ChainSpec): Stage[] {
  if (!spec.scan) return buildPrintChain(device, arenas, spec);
  if (spec.family === 'lut') {
    if (spec.grain) throw new Error('buildChain: grain tidak sah di keluarga lut (lut_mode mematikan efek stokastik).');
    return [
      createMaterializeActiveRegionStage(device),
      createFilmExposureStage(device, arenas),
      createCurveDevelopStage(device, arenas),
      createDirStage(device, arenas, { spatialDiffusionActive: false }),
      createScannerPostStage(device, arenas),
    ];
  }
  return [
    createMaterializeActiveRegionStage(device),
    createFilmExposureStage(device, arenas),
    cameraDiffusionStage(device, arenas, spec),
    createHalationStage(device, arenas),
    createCurveDevelopStage(device, arenas),
    createDirStage(device, arenas),
    ...(spec.grain ? [createGrainStage(device, arenas)] : []),
    createScannerPostStage(device, arenas),
  ];
}

function buildPrintChain(device: GPUDevice, arenas: Arenas, spec: ChainSpec): Stage[] {
  if (spec.family === 'lut') {
    if (spec.grain) {
      throw new Error('buildChain: grain tidak sah di keluarga lut (lut_mode mematikan efek stokastik).');
    }
    return [
      createMaterializeActiveRegionStage(device),
      createFilmExposureStage(device, arenas),
      createCurveDevelopStage(device, arenas),
      createDirStage(device, arenas, { spatialDiffusionActive: false }),
      createPrintExposureStage(device, arenas),
      createPrintDevelopStage(device, arenas),
      createScannerPostStage(device, arenas),
    ];
  }
  return [
    createMaterializeActiveRegionStage(device),
    createFilmExposureStage(device, arenas),
    cameraDiffusionStage(device, arenas, spec),
    createHalationStage(device, arenas),
    createCurveDevelopStage(device, arenas),
    createDirStage(device, arenas),
    ...(spec.grain ? [createGrainStage(device, arenas)] : []),
    createPrintExposureStage(device, arenas),
    printDiffusionStage(device, arenas, spec),
    createPrintDevelopStage(device, arenas),
    createScannerPostStage(device, arenas),
  ];
}
