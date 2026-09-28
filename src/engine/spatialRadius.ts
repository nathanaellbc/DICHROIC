/**
 * Radius apron (px) dari sigma blur yang SEBENARNYA dijalankan tahap
 * (Fase 2A.5). Dipakai dua pihak yang wajib sepakat: tahap
 * (`Stage.spatialRadiusPx`, untuk menyusutkan active rect per tahap di bawah
 * tiling) dan `buildRenderPlan` (overlap tile).
 *
 * Kenapa bukan konstanta OFX (`SPATIAL_EFFECT_RADIUS_PX = 256`): konstanta itu
 * dikalibrasi untuk blur piramida OFX. Blur kita mengikuti `fast_gaussian_filter`
 * Python: FIR terpotong di `int(3*sigma + 0.5)` (support eksak) dan IIR
 * Young-van Vliet dengan ekor tak terbatas. Di 6 um/px komponen ekor DIR
 * mencapai sigma ~89 px, dan apron 256 px (2.9 sigma) menyisakan jahitan
 * tile di atas ambang parity; di ukuran piksel fixture Fase 1 apron 256 jauh
 * berlebihan.
 *
 * IIR: `ceil(APRON_SIGMAS * sigma)`, APRON_SIGMAS = 8. Respons impuls maju-
 * mundur YvV TIDAK berekor Gaussian: all-pole, meluruh eksponensial dan
 * berosilasi (pole kompleks). Massa ekor satu sisi terukur (sigma 3..88.6):
 * 5.5 sigma ~6e-4, 7 sigma ~5e-5, 9 sigma ~1e-5, 12 sigma ~1e-7 -- jauh di
 * atas ekor Gaussian (1.9e-8 pada 5.5 sigma). Galat jahitan tile terukur
 * ~1e-2 x massa ekor (5.5 sigma: 5.7e-6 pada cmy_film, 6.25 um/px), jadi
 * 8 sigma dipilih untuk menjaga jahitan <= 1e-6 (`test/tiling.test.ts`).
 */

import { SMALL_SIGMA_MAX } from './gaussian';
import type { Vec3 } from './gaussian';

export const APRON_SIGMAS = 8;

/** Radius support satu blur `fast_gaussian_filter` bersigma `sigma` px. */
export function blurSupportPx(sigma: number): number {
  if (!(sigma > 0)) return 0;
  if (sigma < SMALL_SIGMA_MAX) return Math.trunc(3 * sigma + 0.5);
  return Math.ceil(APRON_SIGMAS * sigma);
}

/** Komponen campuran 3 Gaussian `fast_exponential_filter` (rasio sigma/lambda). */
const EXP_RATIOS = [0.536, 1.5236, 2.7684];

function exponentialSupportPx(decayPx: number): number {
  return Math.max(...EXP_RATIOS.map((r) => blurSupportPx(r * decayPx)));
}

/**
 * Halation (`apply_halation_um`): scatter core, ekor eksponensial, dan tiga
 * bounce `sigma_h * sqrt(k)`. Konstanta = `HalationParams` default Python,
 * sama dengan `stages/halation.ts`.
 */
export function halationRadiusPx(pixelSizeUm: number, firstSigmaUm: Vec3): number {
  const core = [2.2, 2.0, 1.6].map((um) => blurSupportPx(Math.max(um / pixelSizeUm, 1e-6)));
  const tail = [9.3, 9.7, 9.1].map((um) => exponentialSupportPx(um / pixelSizeUm));
  const bounce = firstSigmaUm.flatMap((um) =>
    [1, 2, 3].map((k) => blurSupportPx(Math.max((um / pixelSizeUm) * Math.sqrt(k), 1e-6))),
  );
  return Math.max(...core, ...tail, ...bounce);
}

/** DIR (`couplers.py:104`): Gaussian 20 um + ekor eksponensial 200 um. */
export function dirRadiusPx(pixelSizeUm: number): number {
  return Math.max(blurSupportPx(20 / pixelSizeUm), exponentialSupportPx(200 / pixelSizeUm));
}

/**
 * Overlap tile rantai measured produksi = jumlah radius tahap spasial yang
 * aktif. Grain (64) dan unsharp scanner (256) tetap konstanta OFX: blurnya
 * bersatuan piksel dan kecil (sigma 0.65 dan 0.7 px), tidak bergantung
 * ukuran piksel; radius tahapnya sendiri (`GRAIN_SPATIAL_RADIUS_PX`,
 * `SPATIAL_EFFECT_RADIUS_PX`) tidak diubah di sini.
 */
export function productionOverlapPx(radii: { halation: number; dir: number; grain: boolean; unsharp: boolean }): number {
  return radii.halation + radii.dir + (radii.grain ? 64 : 0) + (radii.unsharp ? 256 : 0);
}
