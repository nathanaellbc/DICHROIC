import { beforeAll, describe, it } from 'vitest';
import { Tap } from '../../src/engine/taps';
import type { TapName } from '../../src/engine/taps';
import { prepareParamCases, runParamParity } from './planRun';

/**
 * Kendali harness `param/` (Fase 2C Task 1). Patch kosong: fixture ini
 * dibangkitkan bit-identik dengan `gray_ramp`, `gray_ramp_lut`, dan
 * `hard_edge_px6um` (diperiksa saat membangkitkan, tools/README.md), jadi
 * setiap gerbang di bawah membuktikan bahwa jalur `buildRenderPlan` ->
 * `buildChain` di `planRun.ts` sama dengan rakitan lama yang sudah hijau.
 * Ambang sama dengan gerbang lama tap yang sama.
 */

const CASES: Array<[string, TapName[]]> = [
  ['baseline_gray_ramp', [Tap.LOG_E_FILM, Tap.CMY_FILM, Tap.LOG_E_PRINT, Tap.RGB_OUT]],
  ['baseline_gray_ramp_lut', [Tap.LOG_E_FILM, Tap.CMY_FILM, Tap.LOG_E_PRINT, Tap.RGB_OUT]],
  ['baseline_hard_edge_px6um', [Tap.CMY_FILM, Tap.RGB_OUT]],
];

beforeAll(async () => {
  await prepareParamCases(CASES.map(([name]) => name));
});

describe('harness param/: kasus kendali lewat jalur produksi', () => {
  for (const [name, taps] of CASES) {
    for (const tap of taps) {
      it(`${tap} / ${name}`, async () => {
        await runParamParity(name, tap, 1e-5);
      });
    }
  }
});
