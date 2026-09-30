/**
 * "Camera Raw": develop kamera SEBELUM film -- white balance, tone
 * (contrast/highlights/shadows/whites/blacks), saturasi. Matematikanya
 * mengikuti develop kamera EMULSION (ditulis ulang, bukan diimpor: batas
 * lisensi, `test/boundary.test.ts`).
 *
 * BUKAN bagian spektrafilm: Python tidak punya padanannya, jadi field-nya
 * berstatus `extension` (registry.ts), digerbangi terhadap implementasi
 * referensi JS di berkas ini (`cameraDevelopPixel`), bukan terhadap Python.
 * Pada nilai netral tahap ini DILEWATI persis (flag mati di uniform), jadi
 * seluruh gerbang parity Python tetap berlaku bit-per-bit.
 *
 * Posisi di rantai: di `filmExposure`, setelah decode input (linear, primer
 * input) dan SEBELUM rgb -> raw. Film -- dan setiap tahap spasial sesudahnya
 * -- melihat adegan yang sudah di-develop: develop kamera adalah seperti apa
 * cahaya itu saat mencapai emulsi.
 *
 *  - White balance: adaptasi von Kries di ruang kerucut CAT02 dari
 *    iluminan adegan (suhu K + tint tegak lurus lokus Planckian, Duv 0.02
 *    per satuan) ke 5500 K. 5500 K / tint 0 = identitas. Seluruh operator
 *    runtuh menjadi satu 3x3 di primer input: `M^-1 . W_xyz . M`.
 *  - Tone: pemetaan luminans per piksel (satu gain skalar, kromatisitas
 *    terjaga) dalam stop di sekitar PIVOT = rata-rata log luminans gambar
 *    (tengah gambar itu sendiri), jadi tidak ada kontrol tone yang
 *    menggeser kecerahan tengah. Tone invarian skala, jadi urutannya
 *    terhadap eksposur film (dikalikan sesudah raw) tidak berpengaruh.
 *  - Saturasi: campuran yang menjaga luminans, `y + s * (c - y)`.
 *  - Exposure: RGB linear dikali 2^EV sesudah tone/WB, sebelum film.
 *    Tidak menjepit nilai HDR ke 1 dan tidak mengubah pengukuran pivot.
 */

export const REFERENCE_TEMP_K = 5500;
export const TINT_DUV = 0.02;
export const LUMA_FLOOR = 1e-7;
export const SCENE_GREY = 0.18;

export const CAMERA_LIMITS = {
  exposureEv: { min: -5, max: 5 },
  whiteBalanceK: { min: 2000, max: 12000 },
  tint: { min: -1, max: 1 },
  contrast: { min: -0.75, max: 0.75 },
  highlights: { min: -1.5, max: 1.5 },
  shadows: { min: -1.5, max: 1.5 },
  whites: { min: -2, max: 2 },
  blacks: { min: -2, max: 2 },
  saturation: { min: 0, max: 2 },
} as const;

/** Pusat dan lebar masker logistik, dalam stop dari pivot. */
export const MASKS = {
  highlight: { centre: 1.5, width: 1 },
  shadow: { centre: -1.5, width: 1 },
  white: { centre: 4, width: 1 },
  black: { centre: -4, width: 1 },
} as const;

export interface CameraSettings {
  exposureEv: number;
  whiteBalanceK: number;
  tint: number;
  /** Kemiringan log2: pengali = 2^contrast. */
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  saturation: number;
}

export const NEUTRAL_CAMERA: Readonly<CameraSettings> = Object.freeze({
  exposureEv: 0,
  whiteBalanceK: REFERENCE_TEMP_K,
  tint: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  saturation: 1,
});

export function isNeutralCamera(s: CameraSettings): boolean {
  return (Object.keys(NEUTRAL_CAMERA) as Array<keyof CameraSettings>).every((k) => s[k] === NEUTRAL_CAMERA[k]);
}

type Mat3 = [number, number, number, number, number, number, number, number, number];

function mul(a: ArrayLike<number>, b: ArrayLike<number>): Mat3 {
  const out = new Array<number>(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      let acc = 0;
      for (let k = 0; k < 3; k += 1) acc += a[i * 3 + k]! * b[k * 3 + j]!;
      out[i * 3 + j] = acc;
    }
  }
  return out;
}

export function invert3(m: ArrayLike<number>): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]!, m[7]!, m[8]!];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 0)) throw new RangeError('Matriks 3x3 singular.');
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

/** CAT02: XYZ -> respons kerucut yang dipertajam. */
const XYZ_TO_LMS: Mat3 = [0.7328, 0.4296, -0.1624, -0.7036, 1.6975, 0.0061, 0.003, 0.0136, 0.9834];
const LMS_TO_XYZ = invert3(XYZ_TO_LMS);

/** CCT -> xy CIE 1931 (kubik Kim et al., 1667..25000 K). */
export function cctToXy(tempK: number): { x: number; y: number } {
  const T = Math.min(Math.max(tempK, 1667), 25000);
  const t = 1000 / T;
  const x =
    T <= 4000
      ? -0.2661239 * t ** 3 - 0.2343589 * t ** 2 + 0.8776956 * t + 0.17991
      : -3.0258469 * t ** 3 + 2.1070379 * t ** 2 + 0.2226347 * t + 0.24039;
  const y =
    T <= 2222
      ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
      : T <= 4000
        ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  return { x, y };
}

function planckianUv(tempK: number): [number, number] {
  const { x, y } = cctToXy(tempK);
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (6 * y) / d];
}

/**
 * Putih iluminan sebagai XYZ (Y = 1). Tint menggesernya TEGAK LURUS lokus
 * Planckian di UCS CIE 1960 (arti fisik Duv / hijau-magenta); positif =
 * cahaya hijau. Normal diambil dari lokus itu sendiri, 5 mired ke tiap sisi.
 */
export function illuminantXyz(tempK: number, tint: number): [number, number, number] {
  let [u, v] = planckianUv(tempK);
  if (tint !== 0) {
    const mired = 1e6 / tempK;
    const [u1, v1] = planckianUv(1e6 / (mired + 5));
    const [u0, v0] = planckianUv(1e6 / (mired - 5));
    let nu = -(v1 - v0);
    let nv = u1 - u0;
    const len = Math.hypot(nu, nv) || 1;
    nu /= len;
    nv /= len;
    if (nv < 0) {
      nu = -nu;
      nv = -nv;
    }
    u += tint * TINT_DUV * nu;
    v += tint * TINT_DUV * nv;
  }
  const d = 2 * u - 8 * v + 4;
  const xp = (3 * u) / d;
  const yp = (2 * v) / d;
  if (yp <= 1e-6) return [1, 1, 1];
  return [xp / yp, 1, (1 - xp - yp) / yp];
}

/** Von Kries CAT02 dari iluminan (temp, tint) ke 5500 K, di domain XYZ. */
export function whiteBalanceXyz(tempK: number, tint: number): Mat3 {
  const cone = (xyz: [number, number, number]) => [0, 1, 2].map((r) => XYZ_TO_LMS[r * 3]! * xyz[0] + XYZ_TO_LMS[r * 3 + 1]! * xyz[1] + XYZ_TO_LMS[r * 3 + 2]! * xyz[2]);
  const s = cone(illuminantXyz(tempK, tint));
  const d = cone(illuminantXyz(REFERENCE_TEMP_K, 0));
  const gain: Mat3 = [d[0]! / s[0]!, 0, 0, 0, d[1]! / s[1]!, 0, 0, 0, d[2]! / s[2]!];
  return mul(LMS_TO_XYZ, mul(gain, XYZ_TO_LMS));
}

/** White balance di primer input: `M^-1 . W_xyz . M` (M = RGB input -> XYZ, row-major). */
export function whiteBalanceRgb(rgbToXyz: ArrayLike<number>, tempK: number, tint: number): Mat3 {
  return mul(invert3(rgbToXyz), mul(whiteBalanceXyz(tempK, tint), rgbToXyz));
}

/** Bobot luminans ternormalisasi (baris Y matriks RGB -> XYZ, jumlah 1). */
export function lumaWeights(rgbToXyz: ArrayLike<number>): [number, number, number] {
  const sum = rgbToXyz[3]! + rgbToXyz[4]! + rgbToXyz[5]!;
  return [rgbToXyz[3]! / sum, rgbToXyz[4]! / sum, rgbToXyz[5]! / sum];
}

const logistic = (x: number) => 1 / (1 + Math.exp(-x));

export interface ToneParams {
  pivot: number;
  /** Pengali kemiringan (2^contrast). */
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
}

/**
 * Satu luminans lewat kontrol tone (f64). Masker sisi terang naik ke atas
 * skala; masker sisi gelap memakai bentuk cermin `σ((c - t)/w)` sehingga
 * maksimal di ujung bawah.
 */
export function developLuma(y: number, p: ToneParams): number {
  const l = Math.log2(Math.max(y, LUMA_FLOOR) / p.pivot);
  let t = l * p.contrast;
  t += p.highlights * logistic((t - MASKS.highlight.centre) / MASKS.highlight.width);
  t += p.shadows * logistic((MASKS.shadow.centre - t) / MASKS.shadow.width);
  t += p.whites * logistic((t - MASKS.white.centre) / MASKS.white.width);
  t += p.blacks * logistic((MASKS.black.centre - t) / MASKS.black.width);
  return p.pivot * 2 ** t;
}

/**
 * Rata-rata log luminans (pivot tone) dari gambar input ter-decode, pada
 * pratinjau <= 256 px (sampling tetangga terdekat seperti auto-exposure).
 * `decode` = decode CCTF input (dengan pengali `inputDecodeScale` di
 * dalamnya) bila aktif. Gambar tanpa piksel terang yang terukur memakai
 * abu-abu adegan 0.18.
 */
export function measureScenePivot(
  rgba: Float32Array,
  width: number,
  height: number,
  weights: readonly [number, number, number],
  decode?: (value: number) => number,
): number {
  const d = decode ?? ((v: number) => v);
  const longEdge = Math.max(width, height);
  const scale = Math.min(1, 256 / longEdge);
  const pw = Math.max(1, Math.round(width * scale));
  const ph = Math.max(1, Math.round(height * scale));
  let logSum = 0;
  let count = 0;
  for (let y = 0; y < ph; y += 1) {
    const sy = Math.min(height - 1, Math.floor((y * height) / ph));
    for (let x = 0; x < pw; x += 1) {
      const sx = Math.min(width - 1, Math.floor((x * width) / pw));
      const p = (sy * width + sx) * 4;
      const lum = weights[0] * d(rgba[p]!) + weights[1] * d(rgba[p + 1]!) + weights[2] * d(rgba[p + 2]!);
      if (lum > 1e-5) {
        logSum += Math.log(lum);
        count += 1;
      }
    }
  }
  return count > 0 ? Math.exp(logSum / count) : SCENE_GREY;
}

/** Ukuran uniform `CameraFrame` di `filmExposure.wgsl` (6 x vec4). */
export const CAMERA_FRAME_FLOATS = 24;

/**
 * Isi uniform `CameraFrame`: tiga baris matriks WB (primer input), bobot
 * luminans + pivot, tone, lalu (blacks, saturasi, aktif, exposure gain). Netral -> semua
 * nol termasuk flag aktif, dan shader melewati tahap ini persis.
 */
export function cameraFrameValues(
  settings: CameraSettings | undefined,
  rgbToXyz: ArrayLike<number>,
  pivot: number,
): Float32Array {
  const out = new Float32Array(CAMERA_FRAME_FLOATS);
  if (!settings || isNeutralCamera(settings)) return out;
  const wb = whiteBalanceRgb(rgbToXyz, settings.whiteBalanceK, settings.tint);
  const w = lumaWeights(rgbToXyz);
  out.set([wb[0], wb[1], wb[2], 0, wb[3], wb[4], wb[5], 0, wb[6], wb[7], wb[8], 0], 0);
  out.set([w[0], w[1], w[2], pivot], 12);
  out.set([2 ** settings.contrast, settings.highlights, settings.shadows, settings.whites], 16);
  out.set([settings.blacks, settings.saturation, 1, 2 ** settings.exposureEv], 20);
  return out;
}

/**
 * Referensi CPU (f64) untuk satu piksel linear di primer input -- gerbang
 * tahap GPU (`test/cameraDevelop.test.ts`). Membaca uniform yang sama.
 */
export function cameraDevelopPixel(rgb: readonly [number, number, number], frame: ArrayLike<number>): [number, number, number] {
  if (frame[22] === 0) return [rgb[0], rgb[1], rgb[2]];
  const c = [0, 1, 2].map((r) => frame[r * 4]! * rgb[0] + frame[r * 4 + 1]! * rgb[1] + frame[r * 4 + 2]! * rgb[2]);
  const y = frame[12]! * c[0]! + frame[13]! * c[1]! + frame[14]! * c[2]!;
  const tone: ToneParams = {
    pivot: frame[15]!,
    contrast: frame[16]!,
    highlights: frame[17]!,
    shadows: frame[18]!,
    whites: frame[19]!,
    blacks: frame[20]!,
  };
  const yOut = developLuma(y, tone);
  const gain = yOut / Math.max(y, LUMA_FLOOR);
  const s = frame[21]!;
  return [0, 1, 2].map((k) => Math.max(yOut + s * (c[k]! * gain - yOut), 0) * frame[23]!) as [number, number, number];
}
