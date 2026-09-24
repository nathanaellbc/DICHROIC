import { describe, it } from 'vitest';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createHalationStage } from '../../src/engine/stages/halation';
import { createCurveDevelopStage } from '../../src/engine/stages/curveDevelop';
import { createDirStage } from '../../src/engine/stages/dir';
import { createDiffusionStage } from '../../src/engine/stages/diffusion';
import { createPrintExposureStage, createPrintDevelopStage } from '../../src/engine/stages/printScan';
import { createScannerPostStage } from '../../src/engine/stages/scannerPost';
import type { Arenas } from '../../src/engine/arena';
import type { Stage } from '../../src/engine/graph';
import { Tap } from '../../src/engine/taps';
import type { TapName } from '../../src/engine/taps';
import { runTapParity } from './run';

/**
 * Task 18c -- menutup lubang cakupan §6.5.2: TIDAK ADA gerbang deterministik
 * antara `cmy_film` dan `rgb_out` pada keluarga `measured` (fixture `<case>`
 * BIASA, tanpa akhiran) sebelum berkas ini. Gate B (`scannerPostGlare.
 * test.ts`) adalah hal PERTAMA yang pernah menjalankan rentang itu ujung ke
 * ujung, dan gagalnya (5,6x-168x di atas sebaran oracle sendiri, §6.5.1)
 * kemungkinan besar GEJALA dari divergensi di rentang tak tergerbangi itu --
 * dibuktikan tak berubah dengan glare dimatikan (task-18-report.md, addendum
 * ketiga). Fixture `<case>` (BUKAN `_stochastic`, BUKAN `_lut`) punya
 * `case.json.stochastic === false` -- `deactivate_stochastic_effects` mematikan
 * HANYA `grain.active`/`glare.active` (spec baris 429), bukan halation/DIR/
 * diffusion -- jadi rantainya di bawah adalah `fullChain()` (`chain.ts`)
 * DIKURANGI `createGrainStage` saja, family `'measured'` (slot0=1, sama
 * seperti `_stochastic`), tanpa fixture baru: Python untuk keluarga ini
 * sepenuhnya deterministik, dan fixture per-tap sudah ada di
 * `test/fixtures/<case>/*.f32` sejak Task 11-18 (lih. `case.json` di atas,
 * enam tap termasuk `cmy_film`/`log_e_print`/`cmy_print`/`rgb_out`).
 *
 * Toleransi 1e-5 per piksel (spec §6.5), SAMA seperti Gate A -- `log_e_film`
 * sudah terbukti lulus di orde ~3e-7 di sini sejak Task 14 (`halation.
 * test.ts`), jadi titik mula jalan keluar dimulai di `cmy_film`, bukan
 * `rgb_pre`/`log_e_film` (tidak diulang di sini).
 *
 * `printScan: {...}` memakai nilai neutral C/M/Y yang SAMA yang dipakai
 * `scannerPost.test.ts` (Gate A)/`scannerPostGlare.test.ts` (Gate B) --
 * diresolve Python untuk triple (film, print, illuminant) yang sama,
 * independen dari family.
 */
const STOCK_ID = 'kodak_portra_400';
const PRINT_STOCK_ID = 'kodak_portra_endura';
const ENLARGER_FILTERS = {
  cFilterNeutral: 0,
  mFilterNeutral: 51.56801468495496,
  mFilterShift: 0,
  yFilterNeutral: 52.53400422349596,
  yFilterShift: 0,
};

const CASES = ['gray_ramp', 'log_gray_ramp', 'color_patches'];
const TOLERANCE = 1e-5;

/**
 * Tahap sampai (termasuk) `cmy_film` -- `materializeActiveRegion ->
 * filmExposure -> diffusion(camera, bypass) -> halation -> curveDevelop ->
 * dir`. PERSIS `fullChain()` sampai baris `createDirStage`, TANPA
 * `createGrainStage`: `case.json` keluarga ini punya `"stochastic": false`
 * (`deactivate_stochastic_effects`, yang HANYA mematikan `grain.active`/
 * `glare.active` -- spec baris 429), jadi Python tidak menjalankan grain
 * sama sekali untuk fixture ini; menyertakan `createGrainStage` di sini
 * akan menambahkan derau stokastik yang tidak ada di sisi referensi.
 */
function stagesToCmyFilm(device: GPUDevice, arenas: Arenas): Stage[] {
  return [
    createMaterializeActiveRegionStage(device),
    createFilmExposureStage(device, arenas),
    createDiffusionStage(device, arenas, 'camera', { bypassConvolution: true }),
    createHalationStage(device, arenas),
    createCurveDevelopStage(device, arenas),
    createDirStage(device, arenas),
  ];
}

/** Tahap sampai (termasuk) `log_e_print` -- `stagesToCmyFilm` + printExposure + diffusion(print, bypass). */
function stagesToLogEPrint(device: GPUDevice, arenas: Arenas): Stage[] {
  return [
    ...stagesToCmyFilm(device, arenas),
    createPrintExposureStage(device, arenas),
    createDiffusionStage(device, arenas, 'print', { bypassConvolution: true }),
  ];
}

/** Tahap sampai (termasuk) `cmy_print` -- `stagesToLogEPrint` + printDevelop. */
function stagesToCmyPrint(device: GPUDevice, arenas: Arenas): Stage[] {
  return [...stagesToLogEPrint(device, arenas), createPrintDevelopStage(device, arenas)];
}

/** Tahap sampai (termasuk) `rgb_out` -- `stagesToCmyPrint` + scannerPost. Identik `fullChain()` minus grain. */
function stagesToRgbOut(device: GPUDevice, arenas: Arenas): Stage[] {
  return [...stagesToCmyPrint(device, arenas), createScannerPostStage(device, arenas)];
}

const GATES: Array<{ tap: TapName; stages: (device: GPUDevice, arenas: Arenas) => Stage[] }> = [
  { tap: Tap.CMY_FILM, stages: stagesToCmyFilm },
  { tap: Tap.LOG_E_PRINT, stages: stagesToLogEPrint },
  { tap: Tap.CMY_PRINT, stages: stagesToCmyPrint },
  { tap: Tap.RGB_OUT, stages: stagesToRgbOut },
];

describe('parity: lubang cakupan cmy_film..rgb_out (Task 18c, deterministik, keluarga measured biasa)', () => {
  for (const { tap, stages } of GATES) {
    describe(`tap ${tap}`, () => {
      for (const name of CASES) {
        it(`cocok dengan referensi Python untuk ${name}`, async () => {
          await runTapParity({
            case: name,
            family: 'measured',
            // `case.json`nya "stochastic": false -- deactivate_stochastic_effects
            // mematikan grain/glare Python untuk keluarga fixture ini (lih.
            // blok komentar modul).
            stochasticEffectsActive: false,
            tap,
            tolerance: TOLERANCE,
            stockId: STOCK_ID,
            printScan: {
              printStockId: PRINT_STOCK_ID,
              enlargerFilters: ENLARGER_FILTERS,
            },
            stages,
          });
        });
      }
    });
  }
});
