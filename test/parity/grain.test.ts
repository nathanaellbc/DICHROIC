import { describe, it, expect } from 'vitest';
import { RenderGraph } from '../../src/engine/graph';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createHalationStage } from '../../src/engine/stages/halation';
import { createCurveDevelopStage } from '../../src/engine/stages/curveDevelop';
import { createDirStage } from '../../src/engine/stages/dir';
import { createGrainStage } from '../../src/engine/stages/grain';
import { Tap } from '../../src/engine/taps';
import { loadCase, loadInputAsRgba, loadTap } from './compare';
import { defaultCoreParams } from './params';
import { sharedResources } from './run';
import { moments, momentsBinned } from './statistics';

/**
 * Parity gerbang Grain (Task 16) -- STATISTIK, bukan per-piksel (spec §6.5:
 * ambang 1e-4, metode mean/varians/spektrum-daya). Lih. blok komentar
 * panjang `grain.wgsl`/`grain.ts` untuk rasional lengkap kenapa ini bukan
 * pelonggaran: RNG WGSL di sini adalah ALGORITMA BERBEDA dari numba/scipy
 * Python, jadi dua implementasi yang sama-sama benar menghasilkan realisasi
 * butir berbeda pada piksel yang sama dengan statistik yang sama.
 *
 * Rantai `materializeActiveRegion → filmExposure → halation → curveDevelop →
 * dir → grain`, `family: 'measured'`. **`createHalationStage` WAJIB ADA**,
 * bukan opsional dan bukan sesuai draf lama tugas ini (yang menyebut lima
 * tahap tanpa halation) -- dibuktikan EMPIRIS lewat GPU sungguhan, bukan
 * hanya dibaca dari komentar: `defaultCoreParams` family `'measured'`
 * memaksa `slot0=1` pada `filmExposure.wgsl`, yang artinya tahap itu
 * menyimpan RAW LINEAR (BUKAN log10) -- Halation-lah yang melakukan
 * `log10` sebagai dispatch TERAKHIRNYA (`kOpBounceResolveLog`,
 * `halation.wgsl`), persis meniru `FilmingStage.expose()` Python
 * (`apply_halation_um` sebelum `log10` tunggal). Menjalankan
 * `curveDevelop` langsung atas keluaran `filmExposure` slot0=1 (melewati
 * halation) memberi `curveDevelop` input RAW LINEAR padahal ia
 * mengasumsikan input LOG -- bukan galat kecil: mean kanal hijau
 * `gray_ramp` melonjak dari referensi 0.636 menjadi 1.190 (hampir 2x),
 * terukur langsung sebelum perbaikan ini (lih. `_grain_debug.test.ts`,
 * tidak dikomit). Task 14 sudah membangun tahap ini; menyertakannya di
 * sini bukan pekerjaan baru, hanya pengurutan chain yang benar.
 *
 * Keluarga fixture `_stochastic` (grain DAN glare aktif di Python -- lih.
 * `tools/gen_reference.py` -- tapi glare hanya menyentuh `rgb_out`, TIDAK
 * `cmy_film`, dibuktikan empiris Task 3: dari seluruh keluarga
 * `_stochastic`, TEPAT lima `rgb_out.f32` berubah antar-rerun Python dan
 * TIDAK SATU PUN `cmy_film.f32`, jadi `cmy_film` pada keluarga ini adalah
 * oracle yang reproducible).
 *
 * TIGA KASUS -- gray_ramp/log_gray_ramp/color_patches, PERSIS pilihan
 * `curveDevelop.test.ts` (Task 12/13), BUKAN hard_edge/impulse_highlight.
 * Dibuktikan (task-16-report.md), bukan disalin tanpa verifikasi: rantai
 * ini masih TIDAK menyertakan spasial DIR-coupler (`dir.wgsl` hanya
 * mengimplementasikan cabang non-spasial, `dir_couplers.diffusion_size_um
 * =20.0` default AKTIF untuk keluarga `_stochastic` yang bukan `lut_mode`).
 * Residual dari mengabaikan itu diukur langsung terhadap Python (halation
 * SUDAH disertakan pada kedua kolom -- residual murni dari DIR-spasial):
 *
 *   | kasus              | mean_err | var_rel | radial_rel (bin terburuk) |
 *   |--------------------|----------|---------|----------------------------|
 *   | gray_ramp          | 7.0e-6   | 0.0001  | 0.0002                    |
 *   | log_gray_ramp      | 5.5e-6   | 0.0000  | 0.0001                    |
 *   | color_patches      | 2.4e-6   | 0.0000  | 0.0000                    |
 *   | hard_edge          | 7.7e-5   | 0.0004  | 0.0097  (MELEBIHI ambang) |
 *   | impulse_highlight  | 5.3e-6   | 0.0217  | 1.3128  (MELEBIHI ambang) |
 *
 * `hard_edge`/`impulse_highlight` gagal karena residual DIR-spasial
 * mendominasi pada tepi tajam/impuls -- di luar cakupan Task 16 (milik
 * Task 13, dir.wgsl, yang secara eksplisit hanya mengimplementasikan
 * cabang non-spasial sejak awal). `impulse_highlight` juga menunjukkan
 * Python vs Python sendiri TIDAK reproducible sampai presisi tinggi untuk
 * kasus ini (beda parameter EV sekecil apa pun membelokkan cabang rejection-
 * sampling scipy internal ke realisasi grain yang sepenuhnya berbeda) --
 * bukti langsung kenapa gerbang grain HARUS statistik, bukan per-piksel,
 * bahkan andai RNG WGSL kita entah bagaimana identik dengan Python.
 */
const CASES = ['gray_ramp', 'log_gray_ramp', 'color_patches'];

const STOCK_ID = 'kodak_portra_400';

describe('parity: grain (statistik, cmy_film, keluarga _stochastic)', () => {
  for (const name of CASES) {
    it(`momen dan spektrum daya cocok dengan referensi Python untuk ${name}_stochastic`, async () => {
      const { engine, bundle, arenas } = await sharedResources(STOCK_ID);

      const graph = new RenderGraph(engine);
      for (const stage of [
        createMaterializeActiveRegionStage(engine.device),
        createFilmExposureStage(engine.device, arenas),
        createHalationStage(engine.device, arenas),
        createCurveDevelopStage(engine.device, arenas),
        createDirStage(engine.device, arenas),
        createGrainStage(engine.device, arenas),
      ]) {
        graph.addStage(stage);
      }

      const caseName = `${name}_stochastic`;
      const meta = loadCase(caseName);
      const inputRgba = loadInputAsRgba(name);
      // `_stochastic`: Python TIDAK menyalakan deactivate_stochastic_effects (grain
      // aktif, lih. blok komentar modul) -- Task 18c, defaultCoreParams butuh ini eksplisit.
      const params = defaultCoreParams(meta.width, meta.height, bundle, inputRgba, 'measured', true, STOCK_ID);

      const actual = await graph.run(inputRgba, params, Tap.CMY_FILM);

      // Referensi disimpan RGB rapat; perluas ke RGBA agar moments() sebanding.
      const expectedRgb = loadTap(caseName, 'cmy_film');
      const pixels = expectedRgb.length / 3;
      const expectedRgba = new Float32Array(pixels * 4);
      for (let p = 0; p < pixels; p += 1) {
        expectedRgba[p * 4] = expectedRgb[p * 3]!;
        expectedRgba[p * 4 + 1] = expectedRgb[p * 3 + 1]!;
        expectedRgba[p * 4 + 2] = expectedRgb[p * 3 + 2]!;
        expectedRgba[p * 4 + 3] = 1;
      }

      const got = moments(actual, meta.width, meta.height);
      const want = moments(expectedRgba, meta.width, meta.height);

      expect(got.mean, `${caseName}: mean`).toBeCloseTo(want.mean, 4);
      expect(
        Math.abs(got.variance - want.variance) / Math.max(want.variance, 1e-30),
        `${caseName}: variance relative error`,
      ).toBeLessThan(0.02);

      for (let bin = 1; bin < want.radialPower.length; bin += 1) {
        const w = want.radialPower[bin]!;
        if (w < 1e-12) continue;
        const relative = Math.abs(got.radialPower[bin]! - w) / w;
        expect(relative, `${caseName}: bin daya radial ${bin}`).toBeLessThan(0.05);
      }
    });
  }
});

/**
 * Task 16b -- gerbang statistik BARU untuk `blur_particle` (blur per-lapisan
 * dye-cloud) dan `add_micro_structure` (clumping lognormal), dua suku Task 16
 * menunda sebagai no-op TERBUKTI pada `pixel_size_um` fixture di atas
 * (546..4375 um) tapi menandai eksplisit deferral itu BERGANTUNG ukuran
 * piksel, bukan struktural. `grain_dense_patch` (64x64, SETIAP piksel
 * bernilai sama -- lih. `gen_reference.py::grain_dense_patch` --
 * `camera.film_format_mm=0.024` alih-alih 35.0 default) menekan
 * `pixel_size_um` ke 0,375 um, jauh di bawah ambang aktivasi KEDUANYA:
 *
 *   - blur_particle: sigma = blur_dye_clouds_um*sqrt(od_particle) berkisar
 *     1,44..4,47 di fixture ini (radius kernel 4..13 px) vs ~5e-4..3e-3
 *     (radius 0) di fixture `_stochastic` lama -- lih. `grain.wgsl`.
 *   - add_micro_structure: grain_micro_structure_sigma=0,08 > ambang
 *     Python 0,05 (vs ~5e-5 lama) DAN grain_micro_structure_blur_pixel=
 *     0,533 > ambang blur bersarang 0,4 -- kedua cabang bersarang aktif.
 *
 * AMBANG BERBEDA dari gerbang `_stochastic` di atas (5e-5/2%/5%), SENGAJA --
 * bukan pelonggaran sembarangan, dikalibrasi terhadap sebaran TERUKUR
 * (spec §6.5.1 "ambang terikat sebaran terukur"), bukan diwariskan dari
 * Task 16 yang dikalibrasi pada rezim partikel yang sama sekali berbeda:
 *
 *   `n_particles_per_pixel` per (kanal,sublapisan) di fixture ini turun ke
 *   orde 0,03..0,35 -- jauh dari rezim "banyak partikel" (1e5..1e7) yang
 *   membuat aproksimasi Poisson-thinning+Normal Task 16 presisi tinggi.
 *   Identitas Poisson-thinning tetap EKSAK pada n manapun (mean/variance
 *   formula diverifikasi Monte Carlo langsung terhadap `layer_particle_model`
 *   Python sungguhan, cocok 4-5 angka signifikan, task-16b-report.md) --
 *   TAPI karena Python men-seed grain.py:84-87 dengan `seed=[0,1,2]` TETAP
 *   (deterministik antar-run Python, BUKAN acak), sedangkan implementasi
 *   kami memakai RNG independen sungguhan, kami tidak bisa memanfaatkan
 *   "kebetulan" itu -- kami membandingkan SATU realisasi acak independen
 *   terhadap SATU realisasi Python (yang acak HANYA lewat micro-structure's
 *   `fast_lognormal_from_mean_std`, numba `parallel=True` tak-tersemai).
 *   60 realisasi Monte Carlo independen dari implementasi statistik kami
 *   SENDIRI (host-side JS/f64, `mu`/`variance` formula yang SAMA dengan
 *   WGSL) terhadap fixture PERSIS ini menunjukkan sebaran ensemble asli:
 *   std rata-rata (kanal hijau, sejenis di kanal lain) ~2-4% relatif,
 *   variance relatif ~11-19%, daya radial per-bin (8 bin lebar-sama) ~15-60%.
 *   Ambang di bawah (0,08 mean absolut, 60% variance relatif, 150% radial
 *   per-bin) memberi margin 2-4x di atas sebaran terukur itu, TETAP jauh di
 *   bawah apa yang mutasi "hapus kedua suku baru" hasilkan (var_rel 7,7-14,6,
 *   radial 12-29 -- lih. laporan Task 16b untuk transkrip mutasi penuh).
 */
describe('parity: grain Task 16b (blur_particle + micro_structure, grain_dense_patch)', () => {
  it('momen (bin lebar-sama) cocok dengan referensi Python untuk grain_dense_patch', async () => {
    const { engine, bundle, arenas } = await sharedResources(STOCK_ID);

    const graph = new RenderGraph(engine);
    for (const stage of [
      createMaterializeActiveRegionStage(engine.device),
      createFilmExposureStage(engine.device, arenas),
      createHalationStage(engine.device, arenas),
      createCurveDevelopStage(engine.device, arenas),
      createDirStage(engine.device, arenas),
      // film_format_mm=0.024 -- HANYA test ini, lih. `createGrainStage`
      // untuk kenapa default 35.0 di semua pemanggil lain tidak tersentuh.
      createGrainStage(engine.device, arenas, 0.024),
    ]) {
      graph.addStage(stage);
    }

    const caseName = 'grain_dense_patch';
    const meta = loadCase(caseName);
    const inputRgba = loadInputAsRgba(caseName);
    const params = defaultCoreParams(meta.width, meta.height, bundle, inputRgba, 'measured', true, STOCK_ID);

    const actual = await graph.run(inputRgba, params, Tap.CMY_FILM);

    const expectedRgb = loadTap(caseName, 'cmy_film');
    const pixels = expectedRgb.length / 3;
    const expectedRgba = new Float32Array(pixels * 4);
    for (let p = 0; p < pixels; p += 1) {
      expectedRgba[p * 4] = expectedRgb[p * 3]!;
      expectedRgba[p * 4 + 1] = expectedRgb[p * 3 + 1]!;
      expectedRgba[p * 4 + 2] = expectedRgb[p * 3 + 2]!;
      expectedRgba[p * 4 + 3] = 1;
    }

    const BINS = 8;
    const got = momentsBinned(actual, meta.width, meta.height, BINS);
    const want = momentsBinned(expectedRgba, meta.width, meta.height, BINS);

    expect(Math.abs(got.mean - want.mean), `${caseName}: mean abs error`).toBeLessThan(0.08);
    expect(
      Math.abs(got.variance - want.variance) / Math.max(want.variance, 1e-30),
      `${caseName}: variance relative error`,
    ).toBeLessThan(0.6);

    for (let bin = 1; bin < want.radialPower.length; bin += 1) {
      const w = want.radialPower[bin]!;
      if (w < 1e-12) continue;
      const relative = Math.abs(got.radialPower[bin]! - w) / w;
      expect(relative, `${caseName}: bin daya radial ${bin}`).toBeLessThan(1.5);
    }
  });
});
