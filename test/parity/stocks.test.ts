// @verifies film paper -- keluarga param/stock_* (Fase 2C Task 8)
import { beforeAll, describe, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Tap } from '../../src/engine/taps';
import type { TapName } from '../../src/engine/taps';
import { prepareParamCases, runParamParity } from './planRun';

/**
 * Setiap film NEGATIF dengan `kodak_portra_endura`, dan `kodak_portra_400`
 * dengan setiap stock kertas -- keluarga `lut` (kubus, tanpa efek spasial) dan
 * measured deterministik (halation/DIR per stock, preset `(use,
 * antihalation)` Python). Filter netral enlarger dari database Python per
 * pasangan (`manifest.neutralPrintFilters`). Ambang sama dengan gerbang
 * lut/measured Fase 1 (1e-5).
 */

const CASES = readdirSync(join('test', 'fixtures', 'param'))
  .filter((n) => n.startsWith('stock_'))
  .sort();
const LUT_TAPS: TapName[] = [Tap.LOG_E_FILM, Tap.CMY_FILM, Tap.LOG_E_PRINT, Tap.RGB_OUT];
const MEASURED_TAPS: TapName[] = [Tap.CMY_FILM, Tap.RGB_OUT];

beforeAll(async () => {
  await prepareParamCases(CASES);
}, 120_000);

describe('parity stock film x paper (param/)', () => {
  for (const name of CASES) {
    for (const tap of name.endsWith('_lut') ? LUT_TAPS : MEASURED_TAPS) {
      it(`${tap} / ${name}`, async () => {
        await runParamParity(name, tap, 1e-5);
      });
    }
  }
});
