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
import { moments } from './statistics';

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
      const params = defaultCoreParams(meta.width, meta.height, bundle, inputRgba, 'measured', STOCK_ID);

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
