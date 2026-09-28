// @verifies grainAmount grainSeed filmFormat -- param/grain_*, format_* (Fase 2C Task 7)
import { beforeAll, describe, expect, it } from 'vitest';
import { Tap } from '../../src/engine/taps';
import type { TapName } from '../../src/engine/taps';
import { prepareParamCases, renderParamCase, runParamParity, runParamStatParity } from './planRun';

/**
 * - `grainAmount`: OFX `applyGrainControls` (`base + (grained - base) *
 *   amount`, setelah blur densitas akhir). Python tidak punya field ini;
 *   oracle-nya campuran `cmy_film` grain-mati/grain-hidup Python, dan tap
 *   hilir diinjeksi dari campuran itu (`tools/gen_reference.py::_run_param_tap`,
 *   jalur injeksi dibuktikan identik bit-per-bit dengan run normal). Varians
 *   `cmy_film` Python persis mengikuti amount^2 (0.5 -> 1.70e-8, 1 -> 6.81e-8,
 *   1.8 -> 2.21e-7).
 * - `grainSeed`: Python memakai seed grain tetap, jadi tidak ada padanan
 *   langsung. Gerbangnya: seed 42 memberi realisasi engine BERBEDA dari seed 1
 *   dengan statistik yang sama-sama lulus terhadap Python (seperti Gate B).
 * - `filmFormat`: `camera.film_format_mm` = sisi panjang OFX. Deterministik
 *   lewat halation/DIR (ukuran piksel 90..1100 um), plus satu kasus grain.
 */

const STAT_CASES = [
  'grain_amount0_5_flat',
  'grain_amount1_8_flat',
  'grain_amount0_flat',
  'grain_seed42_flat',
  'format_super16_grain_flat',
];
const FORMAT_CASES = ['format_super8', 'format_standard16', 'format_imax70'];
const FORMAT_TAPS: TapName[] = [Tap.LOG_E_FILM, Tap.CMY_FILM, Tap.RGB_OUT];

beforeAll(async () => {
  await prepareParamCases([...STAT_CASES, ...FORMAT_CASES, 'grain_only_flat']);
});

describe('parity grain statistik (param/)', () => {
  for (const name of STAT_CASES) {
    for (const tap of [Tap.CMY_FILM, Tap.RGB_OUT] as TapName[]) {
      it(`${tap} / ${name}`, async () => {
        await runParamStatParity(name, tap);
      });
    }
  }
});

describe('grainSeed: realisasi berbeda, statistik sama', () => {
  it('seed 42 berbeda dari seed 1 (grain_only_flat) di cmy_film', async () => {
    const a = (await renderParamCase('grain_only_flat', Tap.CMY_FILM)).rgba;
    const b = (await renderParamCase('grain_seed42_flat', Tap.CMY_FILM)).rgba;
    let differing = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i + 1] !== b[i + 1]) differing += 1;
    expect(differing / (a.length / 4)).toBeGreaterThan(0.9);
  });
});

describe('parity format film (param/)', () => {
  for (const name of FORMAT_CASES) {
    for (const tap of FORMAT_TAPS) {
      it(`${tap} / ${name}`, async () => {
        await runParamParity(name, tap, 1e-5);
      });
    }
  }
});
