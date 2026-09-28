import { describe, it } from 'vitest';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createDiffusionStage } from '../../src/engine/stages/diffusion';
import { createHalationStage } from '../../src/engine/stages/halation';
import { Tap } from '../../src/engine/taps';
import { buildChain } from '../../src/engine/chain';
import { loadCase } from './compare';
import { runTapParity } from './run';

/**
 * Gerbang rezim resolusi produksi (Fase 2A.5). Fixture 64 px dengan
 * `camera.film_format_mm` 0.4/2.0 (6.25/31.25 um per piksel, lih.
 * `tools/README.md`) menempatkan sigma halation dan DIR di rezim IIR
 * `fast_gaussian_filter` -- rezim yang tidak pernah disentuh fixture Fase 1
 * (~550 um/px). Ambang SAMA dengan gerbang measured Fase 1 untuk tap yang
 * sama (1e-5).
 */

const CASES = ['hard_edge_px6um', 'impulse_highlight_px6um', 'hard_edge_px31um', 'impulse_highlight_px31um'];
const PRINT = {
  printStockId: 'kodak_portra_endura',
  enlargerFilters: {
    cFilterNeutral: 0,
    mFilterNeutral: 51.56801468495496,
    mFilterShift: 0,
    yFilterNeutral: 52.53400422349596,
    yFilterShift: 0,
  },
};

function frameOf(name: string) {
  return { filmFormatMm: (loadCase(name) as unknown as { filmFormatMm: number }).filmFormatMm };
}

describe('parity rezim produksi: log_e_film (halation)', () => {
  for (const name of CASES) {
    it(name, async () => {
      await runTapParity({
        case: name,
        family: 'measured',
        stochasticEffectsActive: false,
        tap: Tap.LOG_E_FILM,
        tolerance: 1e-5,
        printScan: PRINT,
        frame: frameOf(name),
        stages: (device, arenas) => [
          createMaterializeActiveRegionStage(device),
          createFilmExposureStage(device, arenas),
          createDiffusionStage(device, arenas, 'camera', { bypassConvolution: true }),
          createHalationStage(device, arenas),
        ],
      });
    });
  }
});

describe('parity rezim produksi: cmy_film (DIR) dan rgb_out (rantai penuh)', () => {
  for (const tap of [Tap.CMY_FILM, Tap.RGB_OUT]) {
    for (const name of CASES) {
      it(`${tap} / ${name}`, async () => {
        await runTapParity({
          case: name,
          family: 'measured',
          stochasticEffectsActive: false,
          tap,
          tolerance: 1e-5,
          printScan: PRINT,
          frame: frameOf(name),
          // Rantai produksi apa adanya (keluarga <case> deterministik): runTapParity
          // berhenti di tahap TERAKHIR yang menulis tap (DIR untuk cmy_film).
          stages: (device, arenas) => buildChain(device, arenas, { family: 'measured', grain: false }),
        });
      });
    }
  }
});
