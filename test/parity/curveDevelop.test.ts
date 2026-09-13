import { describe, it } from 'vitest';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createCurveDevelopStage } from '../../src/engine/stages/curveDevelop';
import { Tap } from '../../src/engine/taps';
import { runTapParity } from './run';

// Gerbang Task 12: keluaran tahap CurveDevelop dibandingkan terhadap
// `cmy_film.f32` yang dibangkitkan Python (Task 3), diukur terhadap keluarga
// fixture `<case>_lut` (`debug.lut_mode = True`) -- sama seperti gerbang
// log_e_film (Task 11), lih. spec §6.3.2/§6.3.3 dan task-11-report.md.
//
// `createFormatConvertStage` di teks rencana adalah nama LAMA -- Task 9
// menggantinya menjadi `createMaterializeActiveRegionStage`.
//
// PERINGATAN STRUKTURAL (dibuktikan, bukan diasumsikan -- lih.
// task-12-report.md): `Tap.CMY_FILM` Python adalah keluaran SATU fungsi
// `FilmingStage.develop()` -> `model.develop.develop()`, yang menjalankan
// TIGA hal berurutan: interpolasi kurva densitas (`develop_simple`, cakupan
// `curveDevelop.wgsl`/shader `SpektraCurveDevelop.comp`), lalu koreksi
// coupler DIR (`apply_density_correction_dir_couplers`, cakupan Task 13 /
// `dir.wgsl` / `SpektraDir.comp`), lalu grain (no-op di sini,
// `grain.active=False` di bawah `deactivate_stochastic_effects`, yang
// `lut_mode` mempromosikan). `dir_couplers.active` default `True`
// (`params_schema.py:131`) dan TIDAK dimatikan oleh `lut_mode` --
// `lut_mode` hanya menominalkan `dir_couplers.diffusion_size_um = 0`
// (menghilangkan blur SPASIAL-nya, lewat `deactivate_spatial_effects`),
// bukan mematikan chemistry coupler itu sendiri. Dibuktikan empiris
// (skrip sekali-pakai, dibuang setelah dipakai): toggle
// `dir_couplers.active` True/False pada params `lut_mode` mengubah
// `cmy_film` sebesar 0.0203 (gray_ramp) dan 0.390 (color_patches) -- 2000x
// dan 39000x di atas ambang 1e-5 -- dan hanya `active=True` yang cocok
// dengan fixture (`ON vs fixture` ~5e-8, `OFF vs fixture` ~0.02-0.39).
// Chain TIGA tahap ini (tanpa Dir) karena itu TIDAK BISA menutup gerbang
// `cmy_film` ke 1e-5 untuk gambar mana pun -- ini bukan bug transliterasi
// `curveDevelop.wgsl`, melainkan potongan pipeline yang secara SENGAJA
// dialokasikan ke Task 13. Test ini tetap ditulis PERSIS seperti diminta
// (chain tiga tahap, gerbang di cmy_film, keluarga 'lut') karena itu adalah
// definisi resmi tugas ini -- angka nyatanya (BUKAN pass/fail) dilaporkan
// di task-12-report.md, bersama bukti independen bahwa `curveDevelop.wgsl`
// sendiri cocok dengan `develop_simple` (pra-DIR) Python sampai ~1e-7.
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
        ],
      });
    });
  }
});
