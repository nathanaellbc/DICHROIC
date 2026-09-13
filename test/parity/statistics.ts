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
