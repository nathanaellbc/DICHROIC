import { describe, it } from 'vitest';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createCurveDevelopStage } from '../../src/engine/stages/curveDevelop';
import { createDirStage } from '../../src/engine/stages/dir';
import { Tap } from '../../src/engine/taps';
import { runTapParity } from './run';

// Gerbang Task 12+13: keluaran chain CurveDevelop -> Dir dibandingkan
// terhadap `cmy_film.f32` yang dibangkitkan Python (Task 3), diukur
// terhadap keluarga fixture `<case>_lut` (`debug.lut_mode = True`) -- sama
// seperti gerbang log_e_film (Task 11), lih. spec §6.3.2/§6.3.3 dan
// task-11-report.md/task-12-report.md.
//
// `createFormatConvertStage` di teks rencana adalah nama LAMA -- Task 9
// menggantinya menjadi `createMaterializeActiveRegionStage`.
//
// KENAPA CHAIN EMPAT TAHAP (bukan tiga seperti draf awal Task 12, DIBUKTIKAN
// di task-12-report.md dan task-13-report.md, bukan diasumsikan): `Tap.
// CMY_FILM` Python adalah keluaran SATU fungsi `FilmingStage.develop()` ->
// `model.develop.develop()`, yang menjalankan TIGA hal berurutan:
// interpolasi kurva densitas (`develop_simple`, cakupan `curveDevelop.wgsl`
// /shader `SpektraCurveDevelop.comp`), lalu koreksi coupler DIR
// (`apply_density_correction_dir_couplers`, cakupan Task 13 / `dir.wgsl` /
// `SpektraDir.comp`), lalu grain (no-op di sini, `grain.active=False` di
// bawah `deactivate_stochastic_effects`, yang `lut_mode` mempromosikan).
// `dir_couplers.active` default `True` (`params_schema.py:131`) dan TIDAK
// dimatikan oleh `lut_mode` -- `lut_mode` hanya menominalkan
// `dir_couplers.diffusion_size_um = 0` (menghilangkan blur SPASIAL-nya,
// lewat `deactivate_spatial_effects`), bukan mematikan chemistry coupler
// itu sendiri. Task 12 membuktikan empiris (toggle `dir_couplers.active`
// True/False pada params `lut_mode` mengubah `cmy_film` sebesar 0.0203
// (gray_ramp) dan 0.390 (color_patches) -- 2000x-39000x di atas ambang
// 1e-5, dan hanya `active=True` cocok dengan fixture) bahwa chain TIGA
// tahap (tanpa Dir) TIDAK BISA menutup gerbang ini untuk gambar mana pun.
// Task 13 menambahkan `createDirStage` -- non-spasial di keluarga ini
// (`diffusion_size_um=0`), lih. `dir.wgsl` untuk cakupan penuh dan
// task-13-report.md untuk angka per kasus SETELAH tahap ini ditambahkan.
describe('parity: cmy_film', () => {
  for (const name of ['gray_ramp', 'log_gray_ramp', 'color_patches']) {
    it(`cocok dengan referensi Python untuk ${name}_lut`, async () => {
      await runTapParity({
        case: `${name}_lut`,
        inputCase: name,
        family: 'lut',
        tap: Tap.CMY_FILM,
        tolerance: 1e-5,
        stages: (device, arenas) => [
          createMaterializeActiveRegionStage(device),
          createFilmExposureStage(device, arenas),
          createCurveDevelopStage(device, arenas),
          createDirStage(device, arenas),
        ],
      });
    });
  }
});
