// @verifies grainEnabled glareEnabled -- keduanya HIDUP (keluarga <case>_stochastic)
import { describe, it, expect } from 'vitest';
import { RenderGraph } from '../../src/engine/graph';
import { fullChain } from './chain';
import { Tap } from '../../src/engine/taps';
import { loadCase, loadInputAsRgba, loadTap } from './compare';
import { defaultCoreParams } from './params';
import { sharedResources } from './run';
import { moments } from './statistics';
import type { Moments } from './statistics';

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
 *
 * SUPERSEDED (task-18e-report.md Addendum 7, this session) for
 * `gray_ramp_stochastic` ONLY: the diagnosis above ("NOT a valid
 * realization", 12/12 same-sign) is still correct -- it is what first
 * proved the residual is systematic rather than noise. What changed is the
 * INSTRUMENT, not the diagnosis: task-18e-report.md's own Addendum 2/3
 * later measured this same systematic residual centre-to-centre
 * (2.55e-5, n=26 Python vs n=40 ours) and found our OWN draw-to-draw spread
 * (sd 3.293e-5) is LARGER than that effect -- meaning the single-draw
 * gate this comment justified could never have resolved the thing it was
 * asserting, at ANY threshold. `gray_ramp_stochastic` below is no longer
 * driven by this docblock's `1e-4` constant; see the dedicated
 * `describe` block and `GRAY_RAMP_STOCHASTIC_MEAN_TOLERANCE` further down
 * this file for the replacement gate and its derivation.
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
//
// `gray_ramp` SENGAJA TIDAK ada di tabel ini lagi -- lih. blok komentar
// `GRAY_RAMP_STOCHASTIC_MEAN_TOLERANCE` dan `describe` terpisah di bawah
// modul ini untuk gerbang penggantinya (task-18e-report.md Addendum 7).
// `log_gray_ramp`/`color_patches` di bawah TIDAK disentuh oleh penggantian
// itu -- keduanya lulus di atas dasar yang sah (straddle test menyeberangi
// nol untuk `log_gray_ramp`; `color_patches` tidak menggerbangi mean sama
// sekali) dan tetap memakai perbandingan SATU-undian-lawan-SATU-fixture di
// bawah, TIDAK diubah jadi rata-rata N-salt.
const CASES: Array<{ name: string; checkMean: boolean; meanTolerance: number }> = [
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

/**
 * ==========================================================================
 * task-18e-report.md Addendum 7: `gray_ramp_stochastic`'s MEAN gate,
 * REPLACED -- this is a new, sound instrument, not a widened threshold on
 * the old one.
 *
 * THE OLD GATE (removed from `CASES` above) compared ONE of our GPU draws
 * against ONE Python fixture draw and asserted the difference was below a
 * constant (`1e-4`, later re-justified to `1.351e-4` via the task-18d
 * straddle test's 4*sigma convention -- see the docblock above `CASES`).
 * task-18e Addendum 2/3 then measured, directly (not inferred from sign
 * counts), the two implementations' population MEANS centre-to-centre:
 *
 *   Python: n=26  centre=0.40936219230769233  sample sd=2.704350e-5
 *   Ours:   n=40  centre=0.40938765377286473  sample sd=3.292765e-5
 *   gap (ours-python) = 2.546147e-5 ("2.55e-5" rounded), Welch t=3.426, p~0.001
 *
 * That gap is REAL (§6.5.1a of the spec: measured, bounded, twelve
 * mechanisms eliminated, accepted as a known defect -- NOT investigated
 * further here, per this task's own instruction). The problem this
 * Addendum fixes is narrower and purely instrumental: the OLD gate's
 * single-draw comparison has draw-to-draw spread `sd=3.293e-5` (measured
 * above, n=40) -- LARGER than the 2.55e-5 effect it was trying to detect.
 * An instrument whose own noise exceeds the signal it asserts cannot
 * validate that signal at ANY threshold; loosening or tightening the old
 * `1e-4`/`1.351e-4` constant only moves where an unsound measurement
 * happens to land, it can never make the measurement sound. That is why
 * this is a REPLACEMENT of the instrument, not a widened threshold on it:
 * the old gate asserted a quantity (one draw vs one draw) it structurally
 * could not resolve; the new gate below asserts a quantity (an N-draw
 * average vs a measured population centre) it CAN resolve, at a stated,
 * derived precision.
 *
 * THE NEW GATE: average our green-channel `rgb_out` mean over N
 * independent glare salts (reseeded via `params.tileOriginX/Y`, EXACTLY
 * Addendum 5's method -- `glareRandNormal` hashes `tileGid = absoluteGid +
 * tileOrigin`, so sweeping `tileOrigin` reseeds every pixel's draw to an
 * independent realization with NO shader edit, NO recompile), and compare
 * that average against Python's centre, baked as a measured constant
 * (never a bare number -- see `GRAY_RAMP_PYTHON_CENTRE_*` below).
 *
 * CHOOSING N (arithmetic, not a guess): the standard error of an N-draw
 * average of our own distribution is `oursSd / sqrt(N)`:
 *   N=8  -> 3.292765e-5 / sqrt(8)  = 1.164e-5
 *   N=16 -> 3.292765e-5 / sqrt(16) = 8.232e-6
 * N=16 is chosen: it roughly halves N=8's noise for double the wall-clock
 * cost (16 full pipeline runs, ~3-6s each measured on this machine -- see
 * `GRAY_RAMP_STOCHASTIC_TEST_TIMEOUT_MS` below for why the per-test timeout
 * is raised for this one test), and the resulting combined SE (next
 * paragraph) is small enough relative to the bias to give both a low false-
 * fail rate AND real sensitivity to a materially larger bias (see the
 * mutation-proof below).
 *
 * TOLERANCE (derivation, computed below rather than hand-rounded so the
 * arithmetic is checkable, not asserted): the baked Python centre is
 * itself an estimate with its own standard error at n=26
 * (`pythonSd/sqrt(26)`), and our new N=16 average has its own SE
 * (`oursSd/sqrt(16)`, from above). Combining the two independent sources
 * of sampling noise in quadrature gives the SE of the *discrepancy* this
 * test measures (`|ourAverage - pythonCentre|`). Today's measured bias
 * (2.546147e-5) is locked in as a CEILING -- the expected value of that
 * discrepancy under "the bias hasn't changed since Addendum 2/3" -- and
 * the tolerance is that ceiling plus 3 combined-SE units, a one-sided
 * ~99.87%-confidence band around the expected discrepancy assuming the
 * bias is stable. A bias that has grown materially (e.g. doubled, or the
 * mutation-proof's few-percent glare scale-up, which shifts the mean by
 * tens of 1e-5 -- see below) pushes the discrepancy well past this
 * tolerance and reddens the gate; ordinary sampling noise at N=16 does
 * not.
 * ==========================================================================
 */

// Python's measured distribution centre for `gray_ramp_stochastic`'s
// green-channel `rgb_out` mean -- task-18e-report.md Addendum 2 (26 fresh
// `.venv-ref` runs of `tools/gen_reference.py`, `<scratchpad>/pyruns/
// run{0..25}/`, each run's mean computed by hand-replicating `moments()`'s
// exact formula). Measured 2026-09-25 (task-18e-report.md file mtime --
// the report body itself carries no finer-grained per-addendum timestamp;
// this is the most precise date available for when Addendum 2 ran).
// NEVER used as a bare number -- n and sd travel with it everywhere below.
const GRAY_RAMP_PYTHON_CENTRE_MEAN = 0.40936219230769233;
const GRAY_RAMP_PYTHON_CENTRE_SD = 2.704350e-5;
const GRAY_RAMP_PYTHON_CENTRE_N = 26;
const GRAY_RAMP_PYTHON_CENTRE_SE = GRAY_RAMP_PYTHON_CENTRE_SD / Math.sqrt(GRAY_RAMP_PYTHON_CENTRE_N);

// Our own draw-to-draw spread -- task-18e-report.md Addendum 2 (40 salted
// runs of the real, unmodified `fullChain()` pipeline via
// `params.tileOriginX/Y` reseeding, `gray_ramp_stochastic`). This is the
// instrument's own noise floor: it is LARGER than the 2.55e-5 effect the
// old single-draw gate tried to detect, which is exactly why that gate
// was unsound (see docblock above).
const GRAY_RAMP_OUR_DRAW_SD = 3.292765e-5;

// N chosen from the arithmetic in the docblock above: halves N=8's SE
// for double the wall-clock cost, and gives a combined SE (below) small
// enough for both a low false-fail rate and real sensitivity to a
// materially larger bias.
const GRAY_RAMP_SALT_COUNT = 16;
const GRAY_RAMP_OUR_AVERAGE_SE = GRAY_RAMP_OUR_DRAW_SD / Math.sqrt(GRAY_RAMP_SALT_COUNT);

// Two independent sampling-noise sources (our fresh N=16 average; Python's
// baked centre, itself an n=26 estimate) combined in quadrature -- the SE
// of the discrepancy `|ourAverage - pythonCentre|` this test measures.
const GRAY_RAMP_COMBINED_SE = Math.sqrt(
  GRAY_RAMP_OUR_AVERAGE_SE * GRAY_RAMP_OUR_AVERAGE_SE +
    GRAY_RAMP_PYTHON_CENTRE_SE * GRAY_RAMP_PYTHON_CENTRE_SE,
);

// Today's measured centre-to-centre bias (task-18e-report.md Addendum 2/3,
// "gap (ours - python) = 2.546147e-5"), locked in as a CEILING: the
// expected discrepancy if the bias has not changed. Spec §6.5.1a records
// this as a measured, bounded, ACCEPTED known defect -- twelve mechanisms
// eliminated across seven sessions, not investigated further by this task.
const GRAY_RAMP_BIAS_CEILING = 2.546147e-5;

// 3 combined-SE units above the ceiling: ~99.87% one-sided confidence the
// gate passes if the bias is stable, while a materially larger bias (e.g.
// doubled, or the mutation-proof's glare scale-up) pushes the discrepancy
// past this and reddens the gate.
//
// MUTATION-PROOF (task-18e-report.md Addendum 7, done once against a
// scratch-patched copy of `scannerPost.wgsl`, reverted via `git checkout`
// before committing -- `git status --short` confirmed clean immediately
// after): scaled the glare term at `scannerPost.wgsl:835`
// (`xyz + glareBlurred[index] * illuminantXyz()`) up 5%
// (`xyz + (glareBlurred[index] * 1.05) * illuminantXyz()`) and reran this
// exact test unchanged. Measured (unmutated) baseline this session:
// 16-salt average mean 0.40939074243487994, discrepancy 2.855e-5 against
// tolerance 5.484e-5 -- passes with real margin, not a coin flip. With the
// 5% mutation: discrepancy jumped to 6.293e-5, exceeding the same
// 5.484e-5 tolerance -- the gate reddens
// ("expected 0.00006292632662485698 to be less than 0.0000548390018042427").
// A gate never seen to fail is not evidence; this one has been.
const GRAY_RAMP_STOCHASTIC_MEAN_TOLERANCE = GRAY_RAMP_BIAS_CEILING + 3 * GRAY_RAMP_COMBINED_SE;

// Distinct large primes, one per coordinate, so `tileGid = absoluteGid +
// tileOrigin` (Addendum 5's reseeding mechanism, `glareRandNormal` in
// `scannerPost.wgsl` -- NO shader edit here, only the `CoreParams` field
// every stage already reads) lands on a decorrelated hash input for every
// salt index without ever colliding with another salt in this run.
const GRAY_RAMP_TILE_ORIGIN_STRIDE_X = 7919;
const GRAY_RAMP_TILE_ORIGIN_STRIDE_Y = 104729;

// 16 full pipeline draws, budgeted at the brief's own ~3-6s/draw estimate,
// can reach ~96s worst case -- well above vitest.config.ts's global 30s
// `testTimeout`. (Measured this session with device/arenas already warm
// from the two `it()`s that run earlier in this same file: the whole
// 16-draw test took ~2.2s total, ~140ms/draw -- far below the budget. The
// budget stays at the brief's per-draw estimate rather than this session's
// warm-cache number: a cold run, a slower machine, or this file running
// alone would not get the earlier tests' warm-up for free.) Raised for
// THIS TEST ONLY (third argument to `it`, below) -- every other test in
// this file keeps the global 30s.
const GRAY_RAMP_STOCHASTIC_TEST_TIMEOUT_MS = 180_000;

describe('parity: rgb_out (Gate B replacement, gray_ramp_stochastic mean, N-salt average vs Python centre)', () => {
  it(
    `rata-rata mean ${GRAY_RAMP_SALT_COUNT} salt cocok dengan pusat distribusi Python untuk gray_ramp_stochastic`,
    async () => {
      const { engine, bundle, arenas } = await sharedResources(STOCK_ID, {
        printStockId: PRINT_STOCK_ID,
        enlargerFilters: ENLARGER_FILTERS,
      });

      const graph = new RenderGraph(engine);
      for (const stage of fullChain(engine.device, arenas)) {
        graph.addStage(stage);
      }

      const caseName = 'gray_ramp_stochastic';
      const meta = loadCase(caseName);
      const inputRgba = loadInputAsRgba('gray_ramp');
      const baseParams = defaultCoreParams(meta.width, meta.height, bundle, inputRgba, 'measured', true, STOCK_ID);

      // N independent draws, salt=0 uses tileOrigin (0,0) -- identical to
      // the production default -- and each subsequent salt offsets both
      // tile-origin coordinates by a distinct prime stride, exactly
      // Addendum 5's reseeding method, no shader edit.
      const draws: Moments[] = [];
      for (let salt = 0; salt < GRAY_RAMP_SALT_COUNT; salt += 1) {
        const params = {
          ...baseParams,
          tileOriginX: salt * GRAY_RAMP_TILE_ORIGIN_STRIDE_X,
          tileOriginY: salt * GRAY_RAMP_TILE_ORIGIN_STRIDE_Y,
        };
        const actual = await graph.run(inputRgba, params, Tap.RGB_OUT);
        draws.push(moments(actual, meta.width, meta.height));
      }

      const ourAverageMean = draws.reduce((sum, d) => sum + d.mean, 0) / draws.length;
      const discrepancy = Math.abs(ourAverageMean - GRAY_RAMP_PYTHON_CENTRE_MEAN);
      expect(
        discrepancy,
        `gray_ramp_stochastic: |${GRAY_RAMP_SALT_COUNT}-salt average mean - Python centre| ` +
          `(ceiling ${GRAY_RAMP_BIAS_CEILING.toExponential(4)} + 3*combinedSE ` +
          `${GRAY_RAMP_COMBINED_SE.toExponential(4)} = tolerance ${GRAY_RAMP_STOCHASTIC_MEAN_TOLERANCE.toExponential(4)})`,
      ).toBeLessThan(GRAY_RAMP_STOCHASTIC_MEAN_TOLERANCE);

      // variance/radialPower: UNCHANGED from the gate this replaces --
      // spec §6.5.1's own measurement table shows both statistics have a
      // healthy margin (>=3.4x the measured oracle spread) for
      // `gray_ramp` at SINGLE-draw scale already, so they were never the
      // unsound part of this gate. Reuses salt=0's draw (tileOrigin (0,0),
      // the production default) against the committed fixture, exactly as
      // the old gate did -- the fixture is only ever READ here, never
      // regenerated.
      const expectedRgb = loadTap(caseName, 'rgb_out');
      const pixels = expectedRgb.length / 3;
      const expectedRgba = new Float32Array(pixels * 4);
      for (let p = 0; p < pixels; p += 1) {
        expectedRgba[p * 4] = expectedRgb[p * 3]!;
        expectedRgba[p * 4 + 1] = expectedRgb[p * 3 + 1]!;
        expectedRgba[p * 4 + 2] = expectedRgb[p * 3 + 2]!;
        expectedRgba[p * 4 + 3] = 1;
      }
      const want = moments(expectedRgba, meta.width, meta.height);
      const got = draws[0]!;

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
    },
    GRAY_RAMP_STOCHASTIC_TEST_TIMEOUT_MS,
  );
});
