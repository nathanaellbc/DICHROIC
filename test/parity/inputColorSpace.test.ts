// @verifies inputColorSpace inputCctfDecoding -- keluarga param/cs_* (Fase 2C Task 9)
import { beforeAll, describe, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Tap } from '../../src/engine/taps';
import type { TapName } from '../../src/engine/taps';
import { prepareParamCases, runParamParity } from './planRun';

/**
 * Colour space input lewat jalur produksi:
 *
 * - `cs_<label>_lut`: ke-26 label tanpa decode (`io.input_cctf_decoding =
 *   False`), primaries kunci colour identik dengan `matrix_space` OFX.
 * - `cs_<label>_decode_lut`: 20 label yang decode OFX-nya identik dengan
 *   `cctf_decoding` colour, pada nilai ter-encode [0, 1] (`encoded_patches`).
 *   Enam sisanya ditolak `validateInputColorSpace`.
 * - `cs_*_decode_auto`: decode + auto-exposure measured. Metering men-decode,
 *   EV diterapkan di ruang TER-ENCODE (`image * 2**ev`, Python
 *   `FilmingStage.auto_exposure`), EV kompensasi di ruang raw.
 * - `cs_acescg_auto`: metering di colour space non-baseline tanpa decode.
 *
 * Ambang sama dengan gerbang lut/measured Fase 1 (1e-5).
 */

const CASES = readdirSync(join('test', 'fixtures', 'param'))
  .filter((n) => n.startsWith('cs_'))
  .sort();
const TAPS: TapName[] = [Tap.LOG_E_FILM, Tap.CMY_FILM, Tap.RGB_OUT];

beforeAll(async () => {
  await prepareParamCases(CASES);
}, 120_000);

describe('parity colour space input (param/)', () => {
  for (const name of CASES) {
    for (const tap of TAPS) {
      it(`${tap} / ${name}`, async () => {
        await runParamParity(name, tap, 1e-5);
      });
    }
  }
});
