/**
 * Momen statistik dan spektrum daya radial dari kanal hijau suatu gambar
 * RGBA. Dipakai Task 16 (Grain) untuk menggerbangi `cmy_film` pada keluarga
 * `_stochastic` (RNG WGSL adalah algoritma BERBEDA dari numba/scipy Python,
 * jadi perbandingan piksel-demi-piksel tidak punya arti -- lih.
 * `grain.wgsl`/`grain.test.ts`), dan dirancang BERDIRI SENDIRI terhadap
 * kasus uji mana pun -- Task 18 memakai ulang fungsi yang sama untuk
 * menggerbangi glare (`rgb_out`), yang stokastik dengan alasan identik
 * (kernel numba `@njit(parallel=True)` yang RNG paralelnya tidak bisa
 * di-seed lewat field params manapun, lih. spec/plan Task 3).
 *
 * Tiga komponen, masing-masing menutup kelas kesalahan yang berbeda
 * (task-16-report.md mendemonstrasikan ini dengan mutasi nyata, bukan
 * hanya menyatakannya):
 *   - `mean`      -- offset konstan. Implementasi grain yang salah tapi
 *                    tak-bias (mis. lupa mengurangi `density_min` di akhir,
 *                    atau salah tanda pada satu suku) akan lolos test
 *                    varians/spektrum-daya (bentuk noise-nya tetap benar)
 *                    tapi GAGAL di sini karena seluruh gambar bergeser.
 *   - `variance`  -- skala noise. Implementasi yang memakai jumlah
 *                    partikel/uniformitas yang salah (mis. `n_particles_
 *                    per_pixel` disamakan lintas kanal, lih. task-16-
 *                    report.md) mengubah magnitudo noise tanpa mengubah
 *                    rata-ratanya -- GAGAL di sini, lolos di `mean`.
 *   - `radialPower` -- struktur SPASIAL. Sebuah implementasi yang
 *                    menghasilkan noise PUTIH spasial (mis. lupa blur akhir
 *                    `fast_gaussian_filter(..., grain_blur)`) bisa saja
 *                    punya `mean`/`variance` GLOBAL yang benar (varians
 *                    total tidak berubah oleh blur yang menormalisasi bobot
 *                    kernelnya ke 1) tapi salah menyebar daya itu lintas
 *                    frekuensi spasial -- GAGAL di sini meski dua komponen
 *                    lain lolos. Dibuktikan bukan cuma diklaim:
 *                    task-16-report.md menghapus blur akhir dari model
 *                    grain sendiri dan mengukur `worst_radial_rel` melonjak
 *                    ke >600% (dari <1%) untuk kasus `color_patches`.
 */

export interface Moments {
  mean: number;
  variance: number;
  radialPower: Float32Array;
}

/** Momen dan spektrum daya radial dari kanal hijau. */
export function moments(rgba: Float32Array, width: number, height: number): Moments {
  const pixels = width * height;
  let sum = 0;
  for (let p = 0; p < pixels; p += 1) sum += rgba[p * 4 + 1]!;
  const mean = sum / pixels;

  let sq = 0;
  for (let p = 0; p < pixels; p += 1) {
    const d = rgba[p * 4 + 1]! - mean;
    sq += d * d;
  }

  const bins = Math.max(1, Math.min(width, height) >> 1);
  const power = new Float32Array(bins);
  const counts = new Uint32Array(bins);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - width / 2;
      const dy = y - height / 2;
      const r = Math.min(bins - 1, Math.round(Math.hypot(dx, dy)));
      const d = rgba[(y * width + x) * 4 + 1]! - mean;
      power[r] = power[r]! + d * d;
      counts[r] = counts[r]! + 1;
    }
  }
  for (let i = 0; i < bins; i += 1) {
    if (counts[i]! > 0) power[i] = power[i]! / counts[i]!;
  }

  return { mean, variance: sq / pixels, radialPower: power };
}

/**
 * Task 16b: varian `moments()` untuk `grain_dense_patch` (64x64,
 * `pixel_size_um=0.375`) -- fixture yang membuat `blur_particle`/
 * `add_micro_structure` aktif JUGA mendorong `n_particles_per_pixel` per
 * (kanal,sublapisan) ke orde 0,03..0,35 (jauh dari rezim "banyak partikel"
 * 1e5..1e7 yang membuat gerbang `_stochastic` biasa presisi 1e-4/2%/5%,
 * lih. `grain.wgsl`/task-16b-report.md). Dua perbedaan dari `moments()`:
 *
 *   1. Bin radial LEBAR-SAMA (`floor(r/(size/2)*bins)`), BUKAN
 *      `round(hypot(dx,dy))` -- pada gambar 64x64 dengan bin sempit dekat
 *      r=0 (sedikit piksel), binning lama membuat bin rendah nyaris tak
 *      bermakna secara statistik (diverifikasi: 60 realisasi Monte Carlo
 *      independen dari implementasi KAMI SENDIRI menunjukkan std relatif
 *      antar-bin 15-60%, task-16b-report.md) -- binning lebar-sama menekan
 *      itu ke kisaran yang sama tapi dengan jumlah bin yang predictable
 *      dan reusable oleh test lain.
 *   2. `bins` adalah parameter eksplisit (bukan diturunkan dari
 *      `min(width,height)>>1`) -- `grain.test.ts` memakai 8 (dikalibrasi
 *      terhadap sebaran Monte Carlo yang sama di atas), BUKAN 32
 *      (`min(64,64)>>1`) yang akan mewarisi noise per-bin yang sama.
 *
 * `moments()` di atas TIDAK disentuh -- ketiga kasus `_stochastic` Task 16
 * (gray_ramp/log_gray_ramp/color_patches, fixture kecil di mana binning
 * lama SUDAH lulus di ambang 5%) tetap memakainya apa adanya.
 */
/**
 * Fase 2C: autokorelasi lag-1 kanal hijau (rata-rata arah x dan y), port
 * `tools/gen_reference.py::_moments_binned`. Peka terhadap blur derau (glare
 * `blur`, grain) -- struktur spasial yang tidak terlihat dari mean/varians.
 */
export function lag1Correlation(rgba: Float32Array, width: number, height: number): number {
  const pixels = width * height;
  let sum = 0;
  for (let p = 0; p < pixels; p += 1) sum += rgba[p * 4 + 1]!;
  const mean = sum / pixels;
  const dev = (x: number, y: number) => rgba[(y * width + x) * 4 + 1]! - mean;
  let variance = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) variance += dev(x, y) ** 2;
  variance /= pixels;
  if (variance <= 0) return 0;
  let lx = 0;
  for (let y = 0; y < height; y += 1) for (let x = 1; x < width; x += 1) lx += dev(x, y) * dev(x - 1, y);
  let ly = 0;
  for (let y = 1; y < height; y += 1) for (let x = 0; x < width; x += 1) ly += dev(x, y) * dev(x, y - 1);
  return (lx / (height * (width - 1)) / variance + ly / ((height - 1) * width) / variance) / 2;
}

export function momentsBinned(rgba: Float32Array, width: number, height: number, bins: number): Moments {
  const pixels = width * height;
  let sum = 0;
  for (let p = 0; p < pixels; p += 1) sum += rgba[p * 4 + 1]!;
  const mean = sum / pixels;

  let sq = 0;
  for (let p = 0; p < pixels; p += 1) {
    const d = rgba[p * 4 + 1]! - mean;
    sq += d * d;
  }

  const power = new Float32Array(bins);
  const counts = new Uint32Array(bins);
  const halfSize = Math.min(width, height) / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - width / 2;
      const dy = y - height / 2;
      const rRaw = Math.hypot(dx, dy);
      const r = Math.min(bins - 1, Math.floor((rRaw / Math.max(halfSize, 1e-9)) * bins));
      const d = rgba[(y * width + x) * 4 + 1]! - mean;
      power[r] = power[r]! + d * d;
      counts[r] = counts[r]! + 1;
    }
  }
  for (let i = 0; i < bins; i += 1) {
    if (counts[i]! > 0) power[i] = power[i]! / counts[i]!;
  }

  return { mean, variance: sq / pixels, radialPower: power };
}
