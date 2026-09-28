// @verifies glarePercent grainEnabled glareEnabled -- param/glare_*, grain_* (Fase 2C Task 6; keempat kombinasi grain x glare)
import { beforeAll, describe, it } from 'vitest';
import { Tap } from '../../src/engine/taps';
import { prepareParamCases, runParamParity, runParamStatParity } from './planRun';

/**
 * `glarePercent` = `print_render.glare.percent` (mean lognormal glare);
 * percent 0 dilewati `add_glare`. Glare dan grain kini independen
 * (`buildRenderPlan`), dan keempat kombinasinya digerbangi di sini, di citra
 * datar 64x64 dengan momen 16 realisasi Python (`runParamStatParity`):
 *
 *   glare saja      glare_only_flat (0.03), glare_only_p0_15_flat (0.15)
 *   grain + glare   grain_glare_default_flat (0.03), grain_glare_p0_1_flat (0.1)
 *   grain saja      grain_only_flat (percent 0)
 *   tanpa keduanya  glare_p0_no_grain (glareEnabled, percent 0) -- deterministik, per piksel
 *
 * Diskriminasi: percent 0.03 vs 0.15 menggeser mean `rgb_out` 1.4e-3, dua
 * orde di atas ambang; tanpa glare, lag-1 turun dari ~0.136 ke 0.
 */

const STAT_CASES = [
  'glare_only_flat',
  'glare_only_p0_15_flat',
  'grain_glare_default_flat',
  'grain_glare_p0_1_flat',
  'grain_only_flat',
];

beforeAll(async () => {
  await prepareParamCases([...STAT_CASES, 'glare_p0_no_grain']);
});

describe('parity glare statistik (param/)', () => {
  for (const name of STAT_CASES) {
    it(`rgb_out / ${name}`, async () => {
      await runParamStatParity(name, Tap.RGB_OUT);
    });
  }
});

describe('parity glare percent 0 tanpa grain (deterministik)', () => {
  it('rgb_out / glare_p0_no_grain', async () => {
    await runParamParity('glare_p0_no_grain', Tap.RGB_OUT, 1e-5);
  });
});
