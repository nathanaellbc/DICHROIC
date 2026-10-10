/**
 * Lens blur: defocus sintetis dari peta kedalaman (ekstensi DICHROIC, di
 * luar spektrafilm). Separuh thin-lens-nya -- matematika defocus EMULSION,
 * ditulis ulang (batas lisensi, `test/boundary.test.ts`).
 *
 * Circle of confusion thin-lens
 *
 *     c(z) = f^2 / (N (z_f - f)) . |z - z_f| / z
 *
 * linear terhadap kebalikan jarak. Depth Anything V2 memberi disparitas
 * RELATIF (d ~ 1/z sampai skala dan geser yang tidak diketahui), dan blur yang
 * linear di 1/z cukup butuh dua jangkar untuk menjadi metrik: ujung jauh peta
 * dianggap tak hingga (d = 0 setelah normalisasi) dan fotografer memberi
 * jarak fokus dalam meter. Maka 1/z = (d / d_f) / z_f, dan
 *
 *     c(d) = f^2 / (N (z_f - f)) . (1 - d / d_f)
 *
 * -- bertanda: + di belakang bidang fokus, - di depannya. f, N, dan format
 * film lalu berlaku persis seperti di kamera sungguhan.
 *
 * Posisi di rantai: raw linear film SETELAH `filmExposure` dan SEBELUM filter
 * difusi kamera, halation, dan develop -- urutan yang sama dengan
 * `camera.lens_blur_um` Python (`filming.py`). Lensa membentuk citra sebelum
 * film melihatnya: highlight yang tak fokus sampai di negatif sebagai cakram
 * terang, lalu bahu kurva dan halation bekerja padanya.
 */

import type { FilmFormat, RenderParams } from '../params/renderParams';

/** Lensa "normal" per format: kira-kira diagonal bingkai, dibulatkan ke lensa yang ada. */
export const NORMAL_FOCAL_MM: Readonly<Record<FilmFormat, number>> = Object.freeze({
  standard8: 12.5,
  super8: 12.5,
  standard16: 16,
  super16: 16,
  standard35: 50,
  super35: 35,
  standard65: 75,
  imax70: 100,
});

/** Skala f-number dalam sepertiga stop, f/1.2 .. f/22. */
export const F_STOPS = [
  1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22,
] as const;
export const FULL_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22] as const;

export function nearestStop(n: number): number {
  let best: number = F_STOPS[0];
  for (const s of F_STOPS) if (Math.abs(Math.log(s / n)) < Math.abs(Math.log(best / n))) best = s;
  return best;
}

/**
 * Cakram blur terbesar yang digambar gather, sebagai pecahan sisi panjang
 * (diameter). Di atas itu cakram hanya sapuan dan sampel gather terlalu
 * jarang untuk menahan bentuknya.
 */
export const MAX_COC_FRACTION = 0.1;
/**
 * Disparitas di bawah ini dianggap "di jangkar jauh": pembagian dengan d_f
 * membuat peta relatif menjadi metrik, dan titik fokus di langit akan membuat
 * semua piksel lain dekat tak hingga.
 */
export const MIN_FOCUS_DISPARITY = 0.02;

export const LENS_LIMITS = {
  focusDistanceM: { min: 0.3, max: 100 },
  focalLengthMm: { min: 8, max: 600 },
  fNumber: { min: 1.2, max: 22 },
  nearSharpM: { min: 0.2 },
} as const;

/** CoC yang masih tajam: diagonal bingkai / 1442 (0,030 mm untuk 35 mm). */
export function acceptableCocMm(longEdgeMm: number, aspect: number): number {
  const a = Math.max(aspect, 1 / aspect, 1);
  return (longEdgeMm * Math.hypot(1, 1 / a)) / 1442;
}

/** Diameter CoC (mm, di film) subjek di tak hingga. */
export function cocAtInfinityMm(focalMm: number, fNumber: number, focusMm: number): number {
  const zf = Math.max(focusMm, focalMm * 1.25);
  return (focalMm * focalMm) / (fNumber * (zf - focalMm));
}

/** Diameter CoC thin-lens (mm) subjek di `zMm`, fokus di `focusMm`. */
export function cocMm(focalMm: number, fNumber: number, focusMm: number, zMm: number): number {
  const zf = Math.max(focusMm, focalMm * 1.25);
  return (focalMm * focalMm * Math.abs(zMm - zf)) / (fNumber * zMm * (zf - focalMm));
}

export interface DepthOfField {
  hyperfocalMm: number;
  nearMm: number;
  /** `Infinity` bila fokus melewati hiperfokal. */
  farMm: number;
}

export function depthOfField(focalMm: number, fNumber: number, focusMm: number, cMm: number): DepthOfField {
  const f = focalMm;
  const z = Math.max(focusMm, f * 1.25);
  const H = (f * f) / (fNumber * cMm) + f;
  const nearMm = (z * (H - f)) / (H + z - 2 * f);
  const farMm = z < H ? (z * (H - f)) / (H - z) : Infinity;
  return { hyperfocalMm: H, nearMm, farMm };
}

/**
 * Diameter CoC bertanda (px render) untuk disparitas `d` -- cermin host
 * `signedCoc` di `lensBlur.wgsl`.
 */
export function signedCocPx(
  d: number,
  focusDisparity: number,
  scalePx: number,
  maxPx: number,
  nearDisparity = focusDisparity,
  foreground = 1,
): number {
  const df = Math.max(focusDisparity, MIN_FOCUS_DISPARITY);
  let c = scalePx * (1 - d / df);
  if (c < 0) {
    // Di depan bidang fokus: tajam sampai batas dekat dn (>= df), lalu tumbuh
    // dengan laju lensa dari sana, diskalakan porsi foreground.
    const dn = Math.max(nearDisparity, df);
    c = (-scalePx * Math.max(d - dn, 0) * foreground) / df;
  }
  return Math.max(-maxPx, Math.min(maxPx, c));
}

/** Disparitas batas dekat zona tajam: d_f . z_f / z_n (d_f bila tidak diset). */
export function nearSharpDisparity(focusDisparity: number, focusMm: number, nearSharpMm: number | null): number {
  const df = Math.max(focusDisparity, MIN_FOCUS_DISPARITY);
  if (nearSharpMm === null || nearSharpMm >= focusMm) return df;
  return (df * focusMm) / Math.max(nearSharpMm, 1);
}

/** Peta kedalaman: disparitas ternormalisasi (0 = tak hingga, 1 = jangkar dekat), baris atas-bawah. */
export interface DepthMap {
  width: number;
  height: number;
  data: Float32Array;
  /**
   * Dua lapis di tepi subjek (`depth/matte.ts`), seukuran `data`: kedalaman
   * lapis depan dan latar di belakangnya, plus bagian lapis depan (0..1).
   * Lens blur memakainya untuk detail halus seperti rambut; tanpa ini
   * (atau di luar zona tepi) hasilnya sama dengan satu lapis.
   */
  layers?: { foreground: Float32Array; background: Float32Array; alpha: Float32Array };
}

/**
 * Disparitas di bawah titik (u, v) 0..1 sebagai MEDIAN jendela kecil: ketukan
 * fokus yang jatuh di tepi mengambil sisi mayoritas, bukan rata-rata subjek
 * dan latar yang bukan milik keduanya.
 */
export function sampleDisparity(map: DepthMap, u: number, v: number, radius = 3): number {
  const { width, height, data } = map;
  const cx = Math.min(Math.max(Math.round(u * (width - 1)), 0), width - 1);
  const cy = Math.min(Math.max(Math.round(v * (height - 1)), 0), height - 1);
  const values: number[] = [];
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    if (y < 0 || y >= height) continue;
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      if (x < 0 || x >= width) continue;
      values.push(data[y * width + x]!);
    }
  }
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 0;
}

export interface LensSettings {
  focusX: number;
  focusY: number;
  focusDistanceM: number;
  /** 0 = lensa normal format. */
  focalLengthMm: number;
  fNumber: number;
  /** 0 = iris bulat; 5..9 bilah. */
  blades: number;
  bladeCurvature: number;
  catEye: number;
  /** 0 = bidang fokus (perilaku lensa sendiri). */
  nearSharpM: number;
  foreground: number;
}

/** Field `lens*` `RenderParams` -> `LensSettings` (plan dan readout UI). */
export function lensSettings(params: RenderParams): LensSettings {
  return {
    focusX: params.lensFocusX,
    focusY: params.lensFocusY,
    focusDistanceM: params.lensFocusDistanceM,
    focalLengthMm: params.lensFocalLengthMm,
    fNumber: params.lensFNumber,
    blades: params.lensBlades,
    bladeCurvature: params.lensBladeCurvature,
    catEye: params.lensCatEye,
    nearSharpM: params.lensNearSharpM,
    foreground: params.lensForeground,
  };
}

/** Setelan per render yang dibaca tahap `lensBlur` (`FrameParams.lens`). */
export interface LensFrame {
  depth: DepthMap;
  focusDisparity: number;
  nearDisparity: number;
  /** Diameter CoC subjek di tak hingga, px render. */
  cocScalePx: number;
  /** Diameter terbesar yang digambar, px render. */
  maxCocPx: number;
  foreground: number;
  blades: number;
  bladeCurvature: number;
  catEye: number;
}

export interface LensReadout {
  focalLengthMm: number;
  acceptableCocMm: number;
  /** Batas tajam dekat SETELAH kontrol editorial (0 = foreground dipotong tajam). */
  nearLimitM: number;
  farLimitM: number;
  hyperfocalM: number;
}

function focalOf(settings: LensSettings, filmFormat: FilmFormat): number {
  return settings.focalLengthMm > 0 ? settings.focalLengthMm : NORMAL_FOCAL_MM[filmFormat];
}

/**
 * Semua yang fisik diputuskan di sini -- panjang fokus, skala CoC, kedalaman
 * ruang -- supaya shader hanya mengalikan disparitas dengan satu angka.
 * `longEdgePx` = sisi panjang render ini (pratinjau atau penuh): skala CoC
 * dalam px mengikuti pitch pikselnya.
 */
export function resolveLensFrame(
  settings: LensSettings,
  depth: DepthMap,
  filmFormat: FilmFormat,
  filmFormatMm: number,
  longEdgePx: number,
): LensFrame {
  const f = focalOf(settings, filmFormat);
  const zfMm = Math.max(settings.focusDistanceM * 1000, f * 1.25);
  const mmToPx = longEdgePx / filmFormatMm;
  const focusDisparity = Math.max(sampleDisparity(depth, settings.focusX, settings.focusY), MIN_FOCUS_DISPARITY);
  const nearSharpMm = settings.nearSharpM > 0 ? settings.nearSharpM * 1000 : null;
  return {
    depth,
    focusDisparity,
    nearDisparity: nearSharpDisparity(focusDisparity, zfMm, nearSharpMm),
    cocScalePx: cocAtInfinityMm(f, settings.fNumber, zfMm) * mmToPx,
    maxCocPx: MAX_COC_FRACTION * longEdgePx,
    foreground: settings.foreground,
    blades: settings.blades,
    bladeCurvature: settings.bladeCurvature,
    catEye: settings.catEye,
  };
}

/** Angka kedalaman ruang untuk UI (tidak butuh peta kedalaman). */
export function lensReadout(settings: LensSettings, filmFormat: FilmFormat, filmFormatMm: number, aspect: number): LensReadout {
  const f = focalOf(settings, filmFormat);
  const zfMm = Math.max(settings.focusDistanceM * 1000, f * 1.25);
  const cAcc = acceptableCocMm(filmFormatMm, aspect);
  const dof = depthOfField(f, settings.fNumber, zfMm, cAcc);
  let nearLimitMm = dof.nearMm;
  const nearSharpMm = settings.nearSharpM > 0 ? settings.nearSharpM * 1000 : null;
  if (settings.foreground <= 1e-4) {
    nearLimitMm = 0;
  } else if (nearSharpMm !== null || settings.foreground < 1) {
    // Pada skala disparitas relatif terhadap d_f = 1: di mana cakram depan
    // yang dibentuk ulang mencapai CoC yang masih tajam.
    const scaleMm = cocAtInfinityMm(f, settings.fNumber, zfMm);
    const dn = nearSharpDisparity(1, zfMm, nearSharpMm);
    const dLimit = dn + cAcc / (scaleMm * settings.foreground);
    nearLimitMm = Math.min(zfMm / dLimit, zfMm);
  }
  return {
    focalLengthMm: f,
    acceptableCocMm: cAcc,
    nearLimitM: nearLimitMm / 1000,
    farLimitM: dof.farMm / 1000,
    hyperfocalM: dof.hyperfocalMm / 1000,
  };
}
