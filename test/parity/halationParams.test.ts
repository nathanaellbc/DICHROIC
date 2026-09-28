// @verifies halationEnabled halationAmount -- keluarga param/halation_* (Fase 2C Task 5)
import { beforeAll, describe, it } from 'vitest';
import { Tap } from '../../src/engine/taps';
import type { TapName } from '../../src/engine/taps';
import { prepareParamCases, runParamParity } from './planRun';

/**
 * Halation lewat jalur produksi. `halationAmount` mengalikan `a_tot`
 * (`apply_halation_um` langkah 2); amount 0 tetap menjalankan scatter.
 * `halationEnabled=false` melewati scatter DAN bounce (`if not
 * halation.active: return raw`), jadi tahap halation hanya menutup `log10`.
 * Rezim FIR (35 mm) dan IIR (`_px6um`, 6.25 um/px) sama-sama diuji. Ambang
 * sama dengan gerbang measured/rezim produksi (1e-5).
 */

const TAPS: TapName[] = [Tap.LOG_E_FILM, Tap.CMY_FILM, Tap.RGB_OUT];
const CASES = [
  'halation_amount2_5',
  'halation_amount0_4_px6um',
  'halation_amount0_px6um',
  'halation_off',
  'halation_off_px6um',
];

beforeAll(async () => {
  await prepareParamCases(CASES);
});

describe('parity halation (param/)', () => {
  for (const name of CASES) {
    for (const tap of TAPS) {
      it(`${tap} / ${name}`, async () => {
        await runParamParity(name, tap, 1e-5);
      });
    }
  }
});
