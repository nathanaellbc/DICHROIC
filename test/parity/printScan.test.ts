import { describe, it } from 'vitest';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createCurveDevelopStage } from '../../src/engine/stages/curveDevelop';
import { createDirStage } from '../../src/engine/stages/dir';
import { createPrintExposureStage, createPrintDevelopStage } from '../../src/engine/stages/printScan';
import { Tap } from '../../src/engine/taps';
import { runTapParity } from './run';

/**
 * Parity gerbang PrintScan (Task 17) -- KEDUA tap `log_e_print`/`cmy_print`,
 * keluarga `_lut` (`gray_ramp_lut`/`log_gray_ramp_lut`/`color_patches_lut`),
 * PERSIS pola `curveDevelop.test.ts` (Task 12/13) untuk `cmy_film`.
 *
 * Rantai `materializeActiveRegion -> filmExposure -> curveDevelop -> dir ->
 * printExpose -> printDevelop`, `family: 'lut'` -- SAMA prefiks empat-tahap
 * yang `curveDevelop.test.ts` sudah buktikan menutup `cmy_film` untuk
 * keluarga ini (tanpa halation: `slot0=0` di bawah `lut_mode` membuat
 * `filmExposure.wgsl` menuliskan `log_e_film` sendirian). `printExpose`
 * membaca keluaran `dir` (density `cmy_film` akhir) sebagai `src`,
 * PERSIS `PrintingStage.expose()` Python yang menerima `cmy_film` sebagai
 * argumennya.
 *
 * `printScan: { printStockId, enlargerFilters }` memakai nilai neutral
 * C/M/Y yang SUDAH DIRESOLVE Python untuk triple (film, print, illuminant)
 * fixture ini (`bundle.manifest.printScan`, dibakukan Task 17 sebelumnya,
 * commit `26708ad`), BUKAN default skema `EnlargerParams` mentah -- lih.
 * docstring `PrintScanDefaults` (`src/profiles/types.ts`).
 *
 * `Tap.LOG_E_PRINT` berhenti pada `printExpose` (chain di bawah tetap
 * menyertakan `printDevelop` setelahnya -- `RenderGraph.run()` mencari
 * tahap TERAKHIR yang menulis tap, jadi kehadiran `printDevelop` di array
 * tidak memengaruhi hasil `LOG_E_PRINT`, hanya `CMY_PRINT` yang butuh
 * keduanya berjalan).
 */
describe('parity: printScan (log_e_print / cmy_print, keluarga _lut)', () => {
  for (const name of ['gray_ramp', 'log_gray_ramp', 'color_patches']) {
    const caseName = `${name}_lut`;

    it(`log_e_print cocok dengan referensi Python untuk ${caseName}`, async () => {
      await runTapParity({
        case: caseName,
        inputCase: name,
        family: 'lut',
        tap: Tap.LOG_E_PRINT,
        tolerance: 1e-5,
        printScan: {
          printStockId: 'kodak_portra_endura',
          enlargerFilters: {
            cFilterNeutral: 0,
            mFilterNeutral: 51.56801468495496,
            mFilterShift: 0,
            yFilterNeutral: 52.53400422349596,
            yFilterShift: 0,
          },
        },
        stages: (device, arenas) => [
          createMaterializeActiveRegionStage(device),
          createFilmExposureStage(device, arenas),
          createCurveDevelopStage(device, arenas),
          createDirStage(device, arenas),
          createPrintExposureStage(device, arenas),
          createPrintDevelopStage(device, arenas),
        ],
      });
    });

    it(`cmy_print cocok dengan referensi Python untuk ${caseName}`, async () => {
      await runTapParity({
        case: caseName,
        inputCase: name,
        family: 'lut',
        tap: Tap.CMY_PRINT,
        tolerance: 1e-5,
        printScan: {
          printStockId: 'kodak_portra_endura',
          enlargerFilters: {
            cFilterNeutral: 0,
            mFilterNeutral: 51.56801468495496,
            mFilterShift: 0,
            yFilterNeutral: 52.53400422349596,
            yFilterShift: 0,
          },
        },
        stages: (device, arenas) => [
          createMaterializeActiveRegionStage(device),
          createFilmExposureStage(device, arenas),
          createCurveDevelopStage(device, arenas),
          createDirStage(device, arenas),
          createPrintExposureStage(device, arenas),
          createPrintDevelopStage(device, arenas),
        ],
      });
    });
  }
});
