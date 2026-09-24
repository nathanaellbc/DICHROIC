import { describe, it } from 'vitest';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createCurveDevelopStage } from '../../src/engine/stages/curveDevelop';
import { createDirStage } from '../../src/engine/stages/dir';
import { createPrintExposureStage, createPrintDevelopStage } from '../../src/engine/stages/printScan';
import { createScannerPostStage } from '../../src/engine/stages/scannerPost';
import { Tap } from '../../src/engine/taps';
import { runTapParity } from './run';

/**
 * Gate A (Task 18) -- deterministik, keluarga `_lut`, tap `rgb_out`.
 *
 * Rantai PERSIS `printScan.test.ts` (Task 17) + `scannerPost` di akhir --
 * BUKAN `fullChain` (`chain.ts`): di bawah `lut_mode` (family `'lut'`)
 * `params.slot0` global (satu field `CoreParams`, dibaca `filmExposure`/
 * `printExpose` sekali saat dispatch masing-masing) adalah 0, artinya
 * KEDUANYA menutup `log10` SENDIRI pada dispatch itu -- menyertakan
 * `halation`/`diffusion` di chain ini akan meng-`log10`-kan hasil yang
 * SUDAH log SEKALI LAGI (data rusak), persis kenapa `printScan.test.ts`
 * tidak menyertakannya. Peta tap->tahap (Global Constraints, plan Task 18)
 * mengonfirmasi ini: `rgb_out` di bawah `lut_mode` hanya butuh
 * `ScannerPost` di atas `cmy_print`, dan `cmy_print` sendiri hanya butuh
 * paruh `printDevelop` (bukan diffusion print) -- SATU tahap masing-masing
 * cukup, sama seperti `log_e_film`/`log_e_print` di baris tap yang sama.
 *
 * `printScan: {...}` memakai nilai neutral C/M/Y yang SUDAH DIRESOLVE
 * Python untuk triple (film, print, illuminant) fixture ini, PERSIS
 * `printScan.test.ts` (`bundle.manifest.printScan`, dibakukan Task 17
 * commit `26708ad`).
 *
 * Toleransi 1e-5 (spec §6.5); diukur ~1e-7 lewat validasi host (JS/f64
 * terhadap manifest+fixture SUNGGUHAN, `src/host/cam16.ts`) SEBELUM WGSL
 * ditulis -- lih. task-18-report.md untuk angka per kasus dan tiga bug
 * yang ditemukan (whitepoint CAM16, signed-power, matriks XYZ<->RGB
 * terbit vs invers numerik).
 */
describe('parity: rgb_out (Gate A, deterministik, keluarga _lut)', () => {
  for (const name of ['gray_ramp', 'log_gray_ramp', 'color_patches']) {
    const caseName = `${name}_lut`;

    it(`cocok dengan referensi Python untuk ${caseName}`, async () => {
      await runTapParity({
        case: caseName,
        inputCase: name,
        family: 'lut',
        stochasticEffectsActive: false, // lut_mode selalu mematikan grain/glare.
        tap: Tap.RGB_OUT,
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
          // lut_mode menolkan dir_couplers.diffusion_size_um (deactivate_spatial_effects)
          // -- lih. DirStageOptions.
          createDirStage(device, arenas, { spatialDiffusionActive: false }),
          createPrintExposureStage(device, arenas),
          createPrintDevelopStage(device, arenas),
          createScannerPostStage(device, arenas),
        ],
      });
    });
  }
});
