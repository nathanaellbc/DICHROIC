import { describe, it } from 'vitest';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { Tap } from '../../src/engine/taps';
import { runTapParity } from './run';

// Gerbang parity SUNGGUHAN pertama (Task 11): keluaran tahap FilmExposure
// dibandingkan terhadap `log_e_film.f32` yang dibangkitkan Python
// (Task 3). `createFormatConvertStage` di brief adalah nama LAMA --
// Task 9 mengganti namanya menjadi `createMaterializeActiveRegionStage`
// (lih. task-9-report.md, "Ruling penamaan").
describe('parity: log_e_film', () => {
  for (const name of ['gray_ramp', 'log_gray_ramp', 'color_patches']) {
    it(`cocok dengan referensi Python untuk ${name}`, async () => {
      await runTapParity({
        case: name,
        tap: Tap.LOG_E_FILM,
        tolerance: 1e-5,
        stages: (device, arenas) => [
          createMaterializeActiveRegionStage(device),
          createFilmExposureStage(device, arenas),
        ],
      });
    });
  }
});
