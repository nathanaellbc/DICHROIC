// @verifies dirCouplersEnabled dirCouplersAmount dirCouplersInhibitionSameLayer dirCouplersInhibitionInterlayer dirCouplersDiffusionUm -- keluarga param/dir_* (Fase 2D Task 1)
import { beforeAll, describe, it } from 'vitest';
import { Tap } from '../../src/engine/taps';
import type { TapName } from '../../src/engine/taps';
import { prepareParamCases, runParamParity } from './planRun';

/**
 * Coupler DIR lewat jalur produksi (Fase 2D Task 1). Matriks dan kurva
 * sebelum DIR kini dihitung per render dari `amount`/`inhibition_*`
 * (`src/host/dirCouplers.ts`), difusi dari `diffusion_size_um`. DIR bekerja
 * di `cmy_film`; tap hilir membuktikan efeknya sampai keluaran. Kasus
 * `_px6um` berjalan di rezim ukuran piksel produksi (difusi DIR benar-benar
 * spasial), kasus `_lut` membuktikan kimia non-spasial pada `.cube`.
 * `dir_off` membuktikan pemetaan `active=False` -> amount 0.
 */

const TAPS: TapName[] = [Tap.CMY_FILM, Tap.CMY_PRINT, Tap.RGB_OUT];
const CASES = [
  'dir_off',
  'dir_off_px6um',
  'dir_amount0_5',
  'dir_amount1_4',
  'dir_amount1_4_px6um',
  'dir_amount1_4_lut',
  'dir_amount1_4_portra800_push2',
  'dir_inhibition_same0_5_inter0',
  'dir_inhibition_same0_inter1_amount1_4_lut',
  'dir_diffusion0_px6um',
  'dir_diffusion5_px6um',
  'dir_diffusion60_px6um',
];

beforeAll(async () => {
  await prepareParamCases(CASES);
});

describe('parity DIR couplers (param/)', () => {
  for (const name of CASES) {
    for (const tap of TAPS) {
      it(`${tap} / ${name}`, async () => {
        await runParamParity(name, tap, 1e-5);
      });
    }
  }
});
