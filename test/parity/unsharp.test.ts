// @verifies scannerUnsharpAmount -- keluarga param/unsharp_* (Fase 2C Task 6)
import { beforeAll, describe, it } from 'vitest';
import { Tap } from '../../src/engine/taps';
import { prepareParamCases, runParamParity } from './planRun';

/**
 * `scannerUnsharpAmount` = `scanner.unsharp_mask[1]` (sigma tetap 0.7 px).
 * Amount 0 dilewati Python (`sigma > 0 and amount > 0`), jadi plan
 * memadamkan `FLAG_UNSHARP_ACTIVE` dan apron unsharp. Hanya `rgb_out` yang
 * tersentuh; ambang sama dengan gerbang measured (1e-5). Amount besar
 * memperkuat derau f32 secara linear (lih. `tools/param_cases.py`): 3.5
 * meleset 1.14e-5 di color_patches, jadi gerbang berhenti di 2.5.
 */

const CASES = ['unsharp_amount0', 'unsharp_amount1_5', 'unsharp_amount2_5'];

beforeAll(async () => {
  await prepareParamCases(CASES);
});

describe('parity unsharp scanner (param/)', () => {
  for (const name of CASES) {
    it(`rgb_out / ${name}`, async () => {
      await runParamParity(name, Tap.RGB_OUT, 1e-5);
    });
  }
});
