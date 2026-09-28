// @verifies filmPushPullStops -- keluarga param/pushpull_* (Fase 2C Task 4, mode Standard)
import { beforeAll, describe, expect, it } from 'vitest';
import { Tap } from '../../src/engine/taps';
import type { TapName } from '../../src/engine/taps';
import { filmPushPullGamma } from '../../src/params/plan';
import { prepareParamCases, runParamParity } from './planRun';

/**
 * Push/pull `Standard` = pengali gamma kurva film (`filmPushPullGamma`, OFX),
 * padanan Python `density_curve_gamma`. Gamma memengaruhi `develop_simple`,
 * interpolasi akhir koreksi DIR, dan midgray print (`_comp` pada kasus
 * `pushpull_minus2_film_plus1`), jadi `cmy_film` dan tap print ikut diperiksa.
 */

const TAPS: TapName[] = [Tap.CMY_FILM, Tap.LOG_E_PRINT, Tap.RGB_OUT];
const CASES = [
  'pushpull_minus1',
  'pushpull_plus0_5',
  'pushpull_plus2',
  'pushpull_plus1_5_lut',
  'pushpull_minus2_film_plus1',
];

beforeAll(async () => {
  await prepareParamCases(CASES);
});

describe('filmPushPullGamma (OFX)', () => {
  it('titik rujukan waktu develop ECN-2 dan clamp +-2', () => {
    expect(filmPushPullGamma(0)).toBe(1);
    expect(filmPushPullGamma(-1)).toBeCloseTo(150 / 180, 12);
    expect(filmPushPullGamma(1)).toBeCloseTo(220 / 180, 12);
    expect(filmPushPullGamma(2)).toBeCloseTo(280 / 180, 12);
    expect(filmPushPullGamma(5)).toBe(filmPushPullGamma(2));
    expect(filmPushPullGamma(-5)).toBe(filmPushPullGamma(-2));
  });
});

describe('parity push/pull (param/)', () => {
  for (const name of CASES) {
    for (const tap of TAPS) {
      it(`${tap} / ${name}`, async () => {
        await runParamParity(name, tap, 1e-5);
      });
    }
  }
});
