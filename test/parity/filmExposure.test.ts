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
//
// Diukur terhadap keluarga fixture `<case>_lut` (`debug.lut_mode = True`),
// BUKAN `<case>` biasa -- lih. spec §6.3.2/§6.3.3 dan task-11-report.md.
// `FilmingStage.expose()` Python menjalankan halation (spasial, deterministik
// tapi TIDAK stokastik) SEBELUM `log10` yang menghasilkan `log_e_film`, dan
// `debug.deactivate_stochastic_effects` (yang dipakai keluarga `<case>`
// biasa) TIDAK mematikan halation -- hanya `grain.active`/`glare.active`.
// `filmExposure.wgsl` adalah port LENGKAP dan BENAR dari
// `SpektraFilmExposure.comp`, yang secara arsitektur hulu sendiri TIDAK
// memuat kode halation (itu `SpektraHalation.comp` terpisah) -- jadi
// `log_e_film` keluarga `<case>` biasa TIDAK BISA direproduksi dari tahap
// ini sendirian, terlepas seberapa benar portnya. `debug.lut_mode`
// mematikan halation (lewat promosi ke `deactivate_spatial_effects`) DAN
// auto-exposure/exposure-compensation/scanner corrections -- persis regime
// "transform per-piksel deterministik" yang ekspor LUT `.cube` DICHROIC
// kapalkan, dan persis regime yang `filmExposure.wgsl` (sendirian, tanpa
// tahap Halation yang belum diport) BISA hasilkan tepat.
describe('parity: log_e_film', () => {
  for (const name of ['gray_ramp', 'log_gray_ramp', 'color_patches']) {
    it(`cocok dengan referensi Python untuk ${name}_lut`, async () => {
      await runTapParity({
        case: `${name}_lut`,
        // input.f32 hanya ditulis sekali, di direktori kasus dasar
        // (lih. tools/gen_reference.py::_generate_case) -- `<name>_lut`
        // tidak punya salinannya sendiri.
        inputCase: name,
        family: 'lut',
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
