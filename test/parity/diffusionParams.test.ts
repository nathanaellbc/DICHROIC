// @verifies cameraDiffusionEnabled cameraDiffusionFamily cameraDiffusionStrength printDiffusionEnabled printDiffusionFamily printDiffusionStrength -- keluarga param/diffusion_* (Fase 2D Task 4)
import { beforeAll, describe, it } from 'vitest';
import { Tap } from '../../src/engine/taps';
import type { TapName } from '../../src/engine/taps';
import { prepareParamCases, runParamParity } from './planRun';

/**
 * Filter difusi kamera dan enlarger lewat jalur produksi (Fase 2D Task 4):
 * konvolusi FFT df64 (`stages/diffusionFft.ts`) untuk keempat family dan
 * rentang strength 0.125..2. `lamp_scene` 128x96 membawa radius ke klem
 * `min(h, w) // 2 - 1` dengan kontras 4e4:1 -- rezim tempat FFT f32 gagal
 * (terukur 5e-5..3e-4 pada log10) -- jadi gerbang ini membuktikan presisi
 * df64. `_px6um` di ukuran piksel produksi, `_lut` membuktikan lut_mode
 * mematikan difusi.
 */

const TAPS: TapName[] = [Tap.LOG_E_FILM, Tap.CMY_FILM, Tap.LOG_E_PRINT, Tap.RGB_OUT];
const CASES = [
  'diffusion_camera_glimmerglass_0_125',
  'diffusion_camera_black_pro_mist_1',
  'diffusion_camera_pro_mist_0_5',
  'diffusion_camera_cinebloom_2',
  'diffusion_print_cinebloom_1',
  'diffusion_print_glimmerglass_2',
  'diffusion_both_pro_mist_bpm',
  'diffusion_camera_cinebloom_1_px6um',
  'diffusion_camera_black_pro_mist_1_lut',
];

beforeAll(async () => {
  await prepareParamCases(CASES);
});

describe('parity filter difusi (param/)', () => {
  for (const name of CASES) {
    for (const tap of TAPS) {
      it(`${tap} / ${name}`, async () => {
        await runParamParity(name, tap, 1e-5);
      });
    }
  }
});
