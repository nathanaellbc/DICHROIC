import { describe, it, expect } from 'vitest';
import { RenderGraph } from '../../src/engine/graph';
import { fullChain } from './chain';
import { Tap } from '../../src/engine/taps';
import { loadCase, loadInputAsRgba, loadTap } from './compare';
import { defaultCoreParams } from './params';
import { sharedResources } from './run';
import { moments } from './statistics';

/**
 * Gate B (Task 18) -- STATISTIK (`moments()`, Task 16's fungsi dipakai ulang
 * PERSIS seperti didesain, lih. blok komentar `statistics.ts`), tap
 * `rgb_out`, keluarga fixture `_stochastic`. Menutup `add_glare`
 * (`model/glare.py`), efek stokastik KEDUA proyek ini setelah grain, dan
 * gerbang STATISTIK KEDUA setelah `grain.test.ts` -- alasan gerbang
 * statistik IDENTIK: kernel numba `@njit(parallel=True)` Python memanggil
 * `np.random.randn()` di dalam `prange`, RNG paralel yang state-nya TIDAK
 * bisa di-seed lewat field params manapun (`task-3-brief.md`), jadi RNG
 * WGSL di sini SELALU algoritma berbeda dari Python -- dua implementasi
 * sama-sama benar menghasilkan realisasi derau berbeda pada piksel yang
 * sama dengan statistik yang sama. JANGAN naikkan ini jadi gerbang
 * per-piksel dan JANGAN longgarkan toleransi statistik.
 *
 * RANTAI: `fullChain()` (`test/parity/chain.ts`) PENUH, family `'measured'`
 * -- BUKAN daftar tahap eksplisit pendek seperti Gate A (`scannerPost.
 * test.ts`), karena `_stochastic` BUKAN `lut_mode`: `slot0` global 1 berarti
 * `filmExposure`/`printExposure` menyimpan RAW LINEAR, dan
 * `diffusion(camera)`/`halation`/`grain`/`diffusion(print)` SEMUA
 * dibutuhkan untuk menutup log10 dan derau di titik yang Python lakukan
 * (lih. blok komentar `chain.ts` untuk urutan lengkap dan pembuktiannya).
 * `printScan: { printStockId, enlargerFilters }` memakai nilai neutral
 * C/M/Y SAMA yang `scannerPost.test.ts` (Gate A)/`printScan.test.ts`
 * (Task 17) pakai -- diresolve Python untuk triple (film, print,
 * illuminant) YANG SAMA (`kodak_portra_400`/`kodak_portra_endura`),
 * independen dari family lut/stochastic (nilai neutral filter bukan
 * fungsi dari `lut_mode`/`deactivate_stochastic_effects`).
 *
 * ==========================================================================
 * PENGUKURAN SPREAD REALISASI-KE-REALISASI (WAJIB sebelum menetapkan
 * toleransi -- lih. brief Task 18 Gate B), DILAKUKAN DULU SEBELUM ANGKA DI
 * BAWAH DITULIS, bukan ditebak:
 *
 * `tools/gen_reference.py --out <scratch> --case gray_ramp --case
 * log_gray_ramp --case color_patches` dijalankan ENAM KALI (real Python,
 * `.venv-ref`), `rgb_out.f32` `_stochastic` tiap kasus di-`moments()`-kan
 * per run, lalu dibandingkan run-ke-run (bukan run-vs-fixture-terkomit --
 * fixture terkomit HANYA SATU realisasi lagi, "bukan jawaban kanonis" per
 * brief). Hasil (lih. task-18-report.md untuk transkrip penuh):
 *
 *   | kasus         | spread mean (max-min) | spread var (relatif) | spread radial (bin terburuk, relatif) |
 *   |---------------|------------------------|-----------------------|----------------------------------------|
 *   | gray_ramp     | 4.95e-5                | 7.71e-4               | 1.26e-2                                |
 *   | log_gray_ramp | 6.60e-5                | 3.67e-4               | 1.58e-2                                |
 *   | color_patches | 3.11e-4                | 4.49e-3               | 1.47e-2                                |
 *
 * Interpretasi -- oracle-nya sendiri (satu realisasi Python) SUDAH bising
 * pada skala ini, TERLEPAS dari implementasi WGSL apa pun:
 *   - `variance` (ambang relatif dipilih 0.02) dan `radialPower` (ambang
 *     relatif dipilih 0.05, KEDUANYA identik grain.test.ts) punya margin
 *     SEHAT di ketiga kasus (>=3.4x di atas spread terukur) -- gerbang ini
 *     BERARTI untuk kedua statistik itu, di ketiga kasus.
 *   - `mean` (ambang absolut 1e-4, PERSIS instruksi brief, TIDAK
 *     dilonggarkan): `gray_ramp` (4.95e-5, margin ~2x) dan `log_gray_ramp`
 *     (6.60e-5, margin ~1.5x) MASIH di bawah ambang dengan margin tipis
 *     tapi nyata. `color_patches` (3.11e-4) MELEBIHI ambang 1e-4 itu
 *     SENDIRI, sebelum WGSL menyentuh apa pun -- gambar 8x8=64 piksel
 *     terlalu kecil untuk hukum bilangan besar meredam derau lognormal
 *     per-piksel `add_glare` ke bawah 1e-4 pada statistik mean. Ini TEMUAN
 *     NYATA (brief eksplisit meminta ini dilaporkan, bukan ditutupi lewat
 *     tuning): mengecek `mean` `color_patches` pada ambang 1e-4 TIDAK
 *     membuktikan apa pun -- gerbang itu akan gagal/lulus tergantung
 *     realisasi RNG mana pun yang kebetulan dijalankan, implementasi benar
 *     atau salah. Karena itu `color_patches` di bawah TIDAK menyertakan
 *     assersi `mean` (variance/radialPower TETAP diperiksa -- keduanya
 *     berarti untuk kasus ini). `gray_ramp`/`log_gray_ramp` MENYERTAKAN
 *     assersi mean, margin tipis tapi terukur nyata di atas nol.
 * ==========================================================================
 */
const STOCK_ID = 'kodak_portra_400';
const PRINT_STOCK_ID = 'kodak_portra_endura';
const ENLARGER_FILTERS = {
  cFilterNeutral: 0,
  mFilterNeutral: 51.56801468495496,
  mFilterShift: 0,
  yFilterNeutral: 52.53400422349596,
  yFilterShift: 0,
};

// `checkMean: false` untuk `color_patches` -- lih. blok komentar modul,
// bagian "PENGUKURAN SPREAD": oracle Python sendiri (3.11e-4) melebihi
// ambang mean 1e-4 untuk kasus 8x8 ini, jadi gerbang mean di sana tidak
// membuktikan apa pun. TIDAK dihapus dari daftar kasus -- variance dan
// radialPower KEDUANYA tetap diperiksa dan KEDUANYA berarti (margin >=3.4x).
const CASES: Array<{ name: string; checkMean: boolean }> = [
  { name: 'gray_ramp', checkMean: true },
  { name: 'log_gray_ramp', checkMean: true },
  { name: 'color_patches', checkMean: false },
];

const MEAN_TOLERANCE = 1e-4;
const VARIANCE_RELATIVE_TOLERANCE = 0.02;
const RADIAL_POWER_RELATIVE_TOLERANCE = 0.05;

describe('parity: rgb_out (Gate B, glare stokastik, keluarga _stochastic)', () => {
  for (const { name, checkMean } of CASES) {
    const caseName = `${name}_stochastic`;

    it(`momen cocok dengan referensi Python untuk ${caseName}`, async () => {
      const { engine, bundle, arenas } = await sharedResources(STOCK_ID, {
        printStockId: PRINT_STOCK_ID,
        enlargerFilters: ENLARGER_FILTERS,
      });

      const graph = new RenderGraph(engine);
      for (const stage of fullChain(engine.device, arenas)) {
        graph.addStage(stage);
      }

      const meta = loadCase(caseName);
      const inputRgba = loadInputAsRgba(name);
      // `_stochastic`: Python TIDAK menyalakan deactivate_stochastic_effects (glare
      // aktif, lih. blok komentar modul) -- Task 18c, defaultCoreParams butuh ini eksplisit.
      const params = defaultCoreParams(meta.width, meta.height, bundle, inputRgba, 'measured', true, STOCK_ID);

      const actual = await graph.run(inputRgba, params, Tap.RGB_OUT);

      // Referensi disimpan RGB rapat; perluas ke RGBA agar moments() sebanding.
      const expectedRgb = loadTap(caseName, 'rgb_out');
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

      if (checkMean) {
        expect(Math.abs(got.mean - want.mean), `${caseName}: mean abs error`).toBeLessThan(
          MEAN_TOLERANCE,
        );
      }

      expect(
        Math.abs(got.variance - want.variance) / Math.max(want.variance, 1e-30),
        `${caseName}: variance relative error`,
      ).toBeLessThan(VARIANCE_RELATIVE_TOLERANCE);

      for (let bin = 1; bin < want.radialPower.length; bin += 1) {
        const w = want.radialPower[bin]!;
        if (w < 1e-12) continue;
        const relative = Math.abs(got.radialPower[bin]! - w) / w;
        expect(relative, `${caseName}: bin daya radial ${bin}`).toBeLessThan(
          RADIAL_POWER_RELATIVE_TOLERANCE,
        );
      }
    });
  }
});
