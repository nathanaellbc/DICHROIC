// @verifies filterMShift filterYShift filterC -- keluarga param/enlarger_* (Fase 2C Task 3)
import { beforeAll, describe, it } from 'vitest';
import { Tap } from '../../src/engine/taps';
import type { TapName } from '../../src/engine/taps';
import { prepareParamCases, runParamParity } from './planRun';

/**
 * Filter enlarger lewat jalur produksi. `filterC` OFX = tambahan pada C
 * netral (Python `c_filter_neutral` setelah digest); M/Y = `*_filter_shift`.
 * `enlarger_m_minus58_lut` menguji cc negatif (netral M ~51.6), yang Python
 * biarkan tanpa clamp -- beda dari OFX, ruling 2C di `resolveEnlargerFilters`.
 * Filter hanya memengaruhi print: tap `log_e_print` dan `rgb_out`, ambang 1e-5.
 */

const TAPS: TapName[] = [Tap.LOG_E_PRINT, Tap.CMY_PRINT, Tap.RGB_OUT];
const CASES = ['enlarger_m_plus20_y_minus10', 'enlarger_c15', 'enlarger_m_minus58_lut', 'enlarger_y_plus40_c30_lut'];

beforeAll(async () => {
  await prepareParamCases(CASES);
});

describe('parity filter enlarger (param/)', () => {
  for (const name of CASES) {
    for (const tap of TAPS) {
      it(`${tap} / ${name}`, async () => {
        await runParamParity(name, tap, 1e-5);
      });
    }
  }
});
