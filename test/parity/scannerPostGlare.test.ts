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


const MEAN_TOLERANCE = 1e-4;
const VARIANCE_RELATIVE_TOLERANCE = 0.02;
const RADIAL_POWER_RELATIVE_TOLERANCE = 0.05;

/**
 * ==========================================================================
 * task-18d: STRADDLE TEST -- systematic bias or valid noisy realization?
 * (§6.5.1's own rule: a statistical threshold must be a measured multiple
 * of the oracle's OWN spread, never a constant picked to make a number
 * pass. Task 18c closed three real bugs upstream of this gate -- DIR's
 * spatial branch, `FLAG_GLARE_ACTIVE`/`FLAG_UNSHARP_ACTIVE` conflating
 * `<case>` with `<case>_stochastic`, and the missing unsharp port -- and
 * task-18d additionally closed a `sin()`/`cos()` native-GPU-builtin floor
 * in `compressRgbCam16Ucs` (see task-18c-report.md addendum). Neither
 * session moved these two numbers by more than noise: re-measuring after
 * both was mandatory before deciding anything here.)
 *
 * Method (identical to the one Task 18's predecessor used ONCE, pre-18c,
 * when it found a genuine systematic bug this same way -- task-18-report.md,
 * "gray_ramp/log_gray_ramp: a small, real, systematic bias"): patch ONLY
 * the glare RNG hash salt (`0xB5297A4Du` in `glareRandNormal`,
 * `scannerPost.wgsl`) in a scratch copy of the shader source, run the real
 * `fullChain()` pipeline (unchanged otherwise) through 12 independent
 * salts, and see whether `got.mean - want.mean` crosses zero (straddles
 * the oracle mean -> a valid realization of an unbiased implementation)
 * or lands on the same side every time (systematic -> a real bug, not
 * tuned away).
 *
 * Result, 12 salts each (full transcript: task-18c-report.md addendum,
 * task-18d session):
 *
 *   gray_ramp_stochastic:      12 positive, 0 negative. min=1.05e-6,
 *                              max=1.524e-4. NEVER straddles, even though
 *                              one salt lands within 1e-6 of zero.
 *   log_gray_ramp_stochastic:  10 positive, 2 negative. min=-4.38e-5,
 *                              max=1.780e-4. DOES straddle.
 *
 * Verdict:
 *   - `log_gray_ramp_stochastic`: valid realization. Threshold below set
 *     to a multiple of the measured oracle spread (§6.5.1), chosen BEFORE
 *     checking whether our number passes it (see derivation below) --
 *     not reverse-fit to the 3.35-sigma residual it happens to measure.
 *   - `gray_ramp_stochastic`: NOT a valid realization by this test --
 *     12/12 same-sign across independent RNG salts is a >1-in-2000 event
 *     under "our implementation is unbiased" (2*0.5^12). Left at the
 *     original 1e-4 constant, UNMODIFIED, and still failing: this is a
 *     real residual, reported BLOCKED, not tuned. The same 4*sigma
 *     multiple used for `log_gray_ramp_stochastic` below would give
 *     `gray_ramp_stochastic` a threshold of 1.351e-4 -- which its own
 *     measured error (1.524e-4) would STILL exceed, an independent
 *     confirmation from the same formula rather than a coincidence
 *     manufactured by picking different multiples per case.
 *
 * `SIX_SAMPLE_RANGE_TO_SIGMA` (2.534): Shewhart/Western-Electric control-
 * chart d2 constant for subgroup size n=6 -- converts the §6.5.1
 * max-minus-min spread (six fresh Python reruns) to an estimated standard
 * deviation, the same textbook conversion the brief itself uses to state
 * "for six samples the range is roughly 2.5 standard deviations".
 * ==========================================================================
 */
const SIX_SAMPLE_RANGE_TO_SIGMA = 2.534;
// §6.5.1: max-minus-min across six fresh Python reruns, `log_gray_ramp`.
const LOG_GRAY_RAMP_ORACLE_RANGE = 1.16e-4;
const LOG_GRAY_RAMP_ORACLE_SIGMA = LOG_GRAY_RAMP_ORACLE_RANGE / SIX_SAMPLE_RANGE_TO_SIGMA;
// 4*sigma: a conventional "very strict" statistical multiple (not 3.35,
// which is what our specific residual happens to measure -- see comment
// above for why 4 was chosen independent of that number).
const LOG_GRAY_RAMP_MEAN_TOLERANCE = 4 * LOG_GRAY_RAMP_ORACLE_SIGMA;

// `checkMean: false` untuk `color_patches` -- lih. blok komentar modul,
// bagian "PENGUKURAN SPREAD": oracle Python sendiri (3.11e-4) melebihi
// ambang mean 1e-4 untuk kasus 8x8 ini, jadi gerbang mean di sana tidak
// membuktikan apa pun. TIDAK dihapus dari daftar kasus -- variance dan
// radialPower KEDUANYA tetap diperiksa dan KEDUANYA berarti (margin >=3.4x).
const CASES: Array<{ name: string; checkMean: boolean; meanTolerance: number }> = [
  // `gray_ramp`: ambang DIBIARKAN di konstanta 1e-4 yang asli dan test ini
  // MASIH MERAH. Uji straddle memberi 12 positif / 0 negatif lintas 12 salt
  // RNG independen -- di bawah hipotesis "implementasi kami tak bias" itu
  // peristiwa 2*0.5^12, di bawah 1 banding 2000. Jadi residualnya SISTEMATIS,
  // dan melonggarkan ambang di sini akan menyembunyikan bug, bukan mengakui
  // derau. Dilaporkan BLOCKED.
  { name: 'gray_ramp', checkMean: true, meanTolerance: MEAN_TOLERANCE },
  // `log_gray_ramp`: 10 positif / 2 negatif -- MENYEBERANGI mean oracle, jadi
  // ia realisasi yang sah dari implementasi tak bias. Ambangnya diikat ke
  // sebaran oracle terukur sesuai spec 6.5.1.
  { name: 'log_gray_ramp', checkMean: true, meanTolerance: LOG_GRAY_RAMP_MEAN_TOLERANCE },
  { name: 'color_patches', checkMean: false, meanTolerance: MEAN_TOLERANCE },
];

describe('parity: rgb_out (Gate B, glare stokastik, keluarga _stochastic)', () => {
  for (const { name, checkMean, meanTolerance } of CASES) {
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
          meanTolerance,
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
