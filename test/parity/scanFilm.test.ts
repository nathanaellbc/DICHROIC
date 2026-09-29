// @verifies process -- keluarga param/scan_* (Fase 2D Task 3)
import { beforeAll, describe, it } from 'vitest';
import { Tap } from '../../src/engine/taps';
import type { TapName } from '../../src/engine/taps';
import { prepareParamCases, runParamParity, runParamStatParity } from './planRun';

/**
 * Scan film langsung (`io.scan_film=True`, Fase 2D Task 3) lewat jalur
 * produksi: rantai tanpa tahap print, scanner memakai data FILM, tanpa glare.
 * Membuka empat film reversal (profil `positive`: develop, DIR, grain), dan
 * scan film negatif (negatif oranye). Tap `log_e_film`/`cmy_film` membuktikan
 * sisi film untuk profil positif, `rgb_out` scanner-nya.
 */

const TAPS: TapName[] = [Tap.LOG_E_FILM, Tap.CMY_FILM, Tap.RGB_OUT];
const CASES = [
  'scan_velvia100',
  'scan_provia100f_log',
  'scan_ektachrome100_lut',
  'scan_kodachrome64_px6um',
  'scan_portra400_negative',
  'scan_velvia100_film_plus1',
  'scan_velvia100_dir_amount0_5_p3',
];
const STOCHASTIC = ['scan_velvia100_grain_flat'];

beforeAll(async () => {
  await prepareParamCases([...CASES, ...STOCHASTIC]);
});

describe('parity scan film (param/)', () => {
  for (const name of CASES) {
    for (const tap of TAPS) {
      it(`${tap} / ${name}`, async () => {
        await runParamParity(name, tap, 1e-5);
      });
    }
  }
});

describe('parity scan film stokastik: grain film reversal (param/)', () => {
  for (const name of STOCHASTIC) {
    it(`rgb_out / ${name}`, async () => {
      await runParamStatParity(name, Tap.RGB_OUT);
    });
  }
});
