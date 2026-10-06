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
 * IIR: `ceil(APRON_SIGMAS * sigma)`, APRON_SIGMAS = 10. Respons impuls
 * maju-mundur YvV TIDAK berekor Gaussian: all-pole, meluruh eksponensial dan
 * berosilasi (pole kompleks). Massa |ekor| satu sisi terukur (sigma 3..88.6):
 * 5.5 sigma ~6e-4, 8 sigma ~2e-5, 10 sigma ~3e-6, 12 sigma ~1e-7 -- jauh di
 * atas ekor Gaussian (1.9e-8 pada 5.5 sigma). Jahitan tile terukur ~1e-2 x
 * massa ekor pada cmy_film (5.5 sigma: 5.7e-6; 8 sigma: 2.4e-7), dan
 * kontras print/scan memperkuatnya ~6x di rgb_out (8 sigma: 1.37e-6 --
 * melewati 1e-6). 10 sigma menjaga jahitan rgb_out rantai penuh <= 1e-6
 * (`test/tiling.test.ts`, `test/session.test.ts`).
 */

import { SMALL_SIGMA_MAX } from './gaussian';
import type { Vec3 } from './gaussian';

export const APRON_SIGMAS = 10;

/**
 * Apron tile EKSPOR: 5 sigma, bukan 10. Diukur (rantai penuh, pitch 8,5 um =
 * ekspor 4096 px format 35 mm, highlight 20x): jahitan rgb_out terbesar
 * 3,7e-6 pada apron 384 px (~4,9 sigma) -- setara derau f32 tile-vs-full
 * (2e-6) dan di bawah ambang parity rgb_out 1e-5; 0,2 level 16-bit, 0,001
 * level 8-bit. Apron 10 sigma (1100 px pada 4096 px) membuat tiap tile ekspor
 * HP butuh ~6,5 MP x 192 B GPU (~1,26 GB) dan 66x kerja ulang: penyebab tab
 * Safari iPhone dimatikan. Pratinjau dan gerbang parity tetap 10 sigma.
 */
export const EXPORT_APRON_SIGMAS = 5;

/** Radius support satu blur `fast_gaussian_filter` bersigma `sigma` px. */
export function blurSupportPx(sigma: number, sigmas = APRON_SIGMAS): number {
  if (!(sigma > 0)) return 0;
  if (sigma < SMALL_SIGMA_MAX) return Math.trunc(3 * sigma + 0.5);
  return Math.ceil(sigmas * sigma);
}

/** Komponen campuran 3 Gaussian `fast_exponential_filter` (rasio sigma/lambda). */
const EXP_RATIOS = [0.536, 1.5236, 2.7684];

function exponentialSupportPx(decayPx: number, sigmas = APRON_SIGMAS): number {
  return Math.max(...EXP_RATIOS.map((r) => blurSupportPx(r * decayPx, sigmas)));
}

/**
 * Halation (`apply_halation_um`): scatter core, ekor eksponensial, dan tiga
 * bounce `sigma_h * sqrt(k)`. Konstanta = `HalationParams` default Python,
 * sama dengan `stages/halation.ts`.
 */
export function halationRadiusPx(pixelSizeUm: number, firstSigmaUm: Vec3, sigmas = APRON_SIGMAS): number {
  const core = [2.2, 2.0, 1.6].map((um) => blurSupportPx(Math.max(um / pixelSizeUm, 1e-6), sigmas));
  const tail = [9.3, 9.7, 9.1].map((um) => exponentialSupportPx(um / pixelSizeUm, sigmas));
  const bounce = firstSigmaUm.flatMap((um) =>
    [1, 2, 3].map((k) => blurSupportPx(Math.max((um / pixelSizeUm) * Math.sqrt(k), 1e-6), sigmas)),
  );
  return Math.max(...core, ...tail, ...bounce);
}

/**
 * DIR (`couplers.py:104`): Gaussian `diffusion_size_um` (baku 20) + ekor
 * eksponensial 200 um. `diffusion_size_um <= 0` mematikan keduanya (Python
 * menolkan ukuran ekor bersamaan).
 */
export function dirRadiusPx(pixelSizeUm: number, diffusionUm = 20, sigmas = APRON_SIGMAS): number {
  if (!(diffusionUm > 0)) return 0;
  return Math.max(blurSupportPx(diffusionUm / pixelSizeUm, sigmas), exponentialSupportPx(200 / pixelSizeUm, sigmas));
}

/**
 * Support FIR sungguhan tahap kecil di hilir (blur grain sigma 0,65 px,
 * unsharp scanner 0,7 px, blur glare 0,5 px: masing-masing `int(3 sigma +
 * 0.5)` = 2 px), dijumlah dengan cadangan. Konstanta OFX 64/256 px di
 * `productionOverlapPx` jauh di atas ini.
 */
export const EXPORT_FIR_MARGIN_PX = 8;

/** Apron tile ekspor: halation + DIR pada `EXPORT_APRON_SIGMAS`, plus FIR kecil. */
export function exportOverlapPx(radii: { halation: number; dir: number }): number {
  return radii.halation + radii.dir + EXPORT_FIR_MARGIN_PX;
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
