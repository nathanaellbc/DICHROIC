import { describe, it } from 'vitest';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createHalationStage } from '../../src/engine/stages/halation';
import { createCurveDevelopStage } from '../../src/engine/stages/curveDevelop';
import { createDirStage } from '../../src/engine/stages/dir';
import { createDiffusionFftStage } from '../../src/engine/stages/diffusionFft';
import { createPrintExposureStage } from '../../src/engine/stages/printScan';
import { Tap } from '../../src/engine/taps';
import { runTapParity } from './run';

/**
 * Fase 2D Task 4: tahap difusi FFT df64 terhadap fixture Python yang SAMA
 * dengan gerbang konvolusi langsung (`diffusion.test.ts`, Fase 1 Task 15/17):
 * `black_pro_mist` strength 0.5 pada 64 px / 35 mm. Membuktikan pemetaan
 * reflect-pad + konvolusi sirkular + pemisahan kanal berpasangan identik
 * dengan `fftconvolve(mode='same')` Python.
 */

const DEFAULT_FILTER = { family: 'black_pro_mist', strength: 0.5 } as const;

describe('parity FFT: diffusion kamera (log_e_film)', () => {
  for (const name of ['hard_edge_diffusion_camera', 'impulse_highlight_diffusion_camera']) {
    it(`cocok dengan referensi Python untuk ${name}`, async () => {
      await runTapParity({
        case: name,
        family: 'measured',
        stochasticEffectsActive: false,
        tap: Tap.LOG_E_FILM,
        tolerance: 1e-5,
        frame: { filmFormatMm: 35, cameraDiffusion: DEFAULT_FILTER },
        stages: (device, arenas) => [
          createMaterializeActiveRegionStage(device),
          createFilmExposureStage(device, arenas),
          createDiffusionFftStage(device, 'camera'),
          createHalationStage(device, arenas),
        ],
      });
    });
  }
});

describe('parity FFT: diffusion enlarger (log_e_print)', () => {
  for (const name of ['hard_edge_diffusion_print', 'impulse_highlight_diffusion_print']) {
    it(`cocok dengan referensi Python untuk ${name}`, async () => {
      await runTapParity({
        case: name,
        family: 'measured',
        stochasticEffectsActive: false,
        tap: Tap.LOG_E_PRINT,
        tolerance: 1e-5,
        frame: { filmFormatMm: 35, printDiffusion: DEFAULT_FILTER },
        printScan: {
          printStockId: 'kodak_portra_endura',
          enlargerFilters: {
            cFilterNeutral: 0,
            mFilterNeutral: 51.56801468495496,
            mFilterShift: 0,
            yFilterNeutral: 52.53400422349596,
            yFilterShift: 0,
          },
        },
        stages: (device, arenas) => [
          createMaterializeActiveRegionStage(device),
          createFilmExposureStage(device, arenas),
          createHalationStage(device, arenas),
          createCurveDevelopStage(device, arenas),
          createDirStage(device, arenas, { spatialDiffusionActive: false }),
          createPrintExposureStage(device, arenas),
          createDiffusionFftStage(device, 'print'),
        ],
      });
    });
  }
});
