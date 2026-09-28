// @verifies filmExposureEv autoExposure printExposureEv -- keluarga param/exposure_* (Fase 2C Task 2)
import { beforeAll, describe, it } from 'vitest';
import { Tap } from '../../src/engine/taps';
import type { TapName } from '../../src/engine/taps';
import { prepareParamCases, runParamParity } from './planRun';

/**
 * Gerbang exposure lewat jalur produksi (`buildRenderPlan`). Ambang sama
 * dengan gerbang measured/lut Fase 1 untuk tap yang sama (1e-5).
 *
 * - `filmExposureEv` menggeser `log_e_film` DAN, karena
 *   `print_exposure_compensation=True` default Python, midgray print
 *   (`0.184 * 2**ev`, `src/host/printExposure.ts`): `log_e_print` dan
 *   `rgb_out` memeriksa cabang `_comp` itu.
 * - `autoExposure=false` mematikan metering; `printExposureEv` mengalikan raw
 *   print dengan `2**ev`.
 * - `exposure_lut_ignored`: `lut_mode` Python menimpa kedua EV, jadi kubus
 *   harus sama dengan baseline `_lut` meski patch menyetel keduanya.
 */

const TAPS: TapName[] = [Tap.LOG_E_FILM, Tap.CMY_FILM, Tap.LOG_E_PRINT, Tap.RGB_OUT];
const CASES = [
  'exposure_film_plus2',
  'exposure_film_minus1_5',
  'exposure_auto_off',
  'exposure_auto_off_film_plus1',
  'exposure_print_minus1',
  'exposure_print_plus0_7',
  'exposure_lut_ignored',
];

beforeAll(async () => {
  await prepareParamCases(CASES);
});

describe('parity exposure (param/)', () => {
  for (const name of CASES) {
    for (const tap of TAPS) {
      it(`${tap} / ${name}`, async () => {
        await runParamParity(name, tap, 1e-5);
      });
    }
  }
});
