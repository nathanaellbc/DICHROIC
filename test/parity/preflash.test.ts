// @verifies preflashExposure preflashMFilterShift preflashYFilterShift -- keluarga param/preflash_* (Fase 2D Task 2)
import { beforeAll, describe, it } from 'vitest';
import { Tap } from '../../src/engine/taps';
import type { TapName } from '../../src/engine/taps';
import { prepareParamCases, runParamParity } from './planRun';

/**
 * Preflash kertas lewat jalur produksi (Fase 2D Task 2): vektor
 * `_compute_raw_preflash` dihitung host per render (`src/host/preflash.ts`)
 * dan ditambahkan ke raw print setelah faktor midgray. Hanya memengaruhi
 * print: tap `log_e_print` dan hilirnya. Termasuk `lut_mode` dan kombinasi
 * dengan filter C enlarger (C netral yang sama dipakai preflash).
 */

const TAPS: TapName[] = [Tap.LOG_E_PRINT, Tap.CMY_PRINT, Tap.RGB_OUT];
const CASES = [
  'preflash_0_2',
  'preflash_1',
  'preflash_0_5_m30_y_minus40',
  'preflash_0_3_m_minus60_y60_lut',
  'preflash_0_4_with_filter_c15',
];

beforeAll(async () => {
  await prepareParamCases(CASES);
});

describe('parity preflash (param/)', () => {
  for (const name of CASES) {
    for (const tap of TAPS) {
      it(`${tap} / ${name}`, async () => {
        await runParamParity(name, tap, 1e-5);
      });
    }
  }
});
