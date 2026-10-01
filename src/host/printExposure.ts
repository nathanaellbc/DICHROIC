/**
 * Faktor exposure print dari midgray (Fase 2C Task 2): port host dari
 * `PrintingStage._compute_exposure_factor_midgray` dan
 * `FilmingStage._compute_density_spectral_midgray_to_balance_print` hulu
 * (`runtime/stages/printing.py:100-113`, `filming.py:127-152`).
 *
 * Python menormalkan exposure print dengan midgray `[0.184]*3` yang melewati
 * SELURUH jalur film sederhana: `rgb -> raw` (Hanatos) -> `log10` ->
 * `develop_simple` (kurva H&D mentah, `density_curve_gamma`) ->
 * `compute_density_spectral`. `_rgb_to_film_raw` dipanggil TANPA argumen
 * colour space, jadi memakai default-nya: sRGB LINEAR, tanpa decode CCTF --
 * terlepas dari colour space gambar (dibuktikan dengan probe: jalur gambar
 * ProPhoto 0.184 memberi log raw 0.0054330, jalur midgray 0.0055470).
 * Dengan `print_exposure_compensation=True` (default Python, keluarga
 * measured) midgray itu dikalikan `2**exposure_compensation_ev` -- EV
 * kompensasi kamera saja, BUKAN EV auto-exposure -- sehingga print
 * "di-retime" terhadap exposure film. `lut_mode` memaksa kompensasi mati.
 *
 * Dulu (Fase 1) nilai ini di-bake per stock (`densitySpectralMidgray`) karena
 * EV, gamma, dan colour space input tidak pernah berubah. Batch parameter 1
 * membuka ketiganya, jadi faktor dihitung per render di sini dari tabel yang
 * SAMA dengan yang dibaca shader (`hanatosRawResponse`, `inputToReferenceXyz`,
 * kurva stock), dan `densitySpectralMidgray` yang di-bake menjadi pembanding
 * (`test/printExposure.test.ts`).
 *
 * PENYIMPANGAN DARI OFX (ruling 2C): `SpektraPrintScan.comp::printMidgrayExposureFactor`
 * memakai sRGB linear 0.184 yang sama, tetapi TANPA kompensasi EV. Kita
 * mengikuti Python, oracle proyek ini.
 */

export interface MidgrayTables {
  /** `hanatosRawResponse` arena dynamic: texel vec4, separuh mentah lalu separuh terkompresi. */
  hanatosRawResponse: Float32Array;
  hanatosWidth: number;
  hanatosHeight: number;
  /** `inputToReferenceXyz` arena stock: 9 f32 row-major per colour space. */
  inputToReferenceXyz: Float32Array;
  /** `curveExposure` arena stock: pasangan [logExposure, 1/dx]. */
  curveExposure: Float32Array;
  /** `densityCurves` arena stock: kurva TERNORMALISASI, K x 3. */
  densityCurves: Float32Array;
  /** Minimum per kanal kurva mentah (`densityCurveMinimum`). */
  densityCurveMinimum: Float32Array;
  channelDensity: Float32Array;
  baseDensity: Float32Array;
  printLinearSensitivity: Float32Array;
  printFilteredIlluminant: Float32Array;
}

export interface MidgrayOptions {
  /** Indeks "sRGB" di `manifest.colorSpaces.labels` (default `_rgb_to_film_raw`). */
  srgbColorSpace: number;
  /** `FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION` -- separuh tabel Hanatos yang dibaca. */
  inputCompression: boolean;
  /** `density_curve_gamma` (push/pull `Standard`). */
  gamma: number;
  /** `print_exposure_compensation` Python. */
  compensation: boolean;
  /** `camera.exposure_compensation_ev` (tanpa auto-exposure). */
  exposureCompensationEv: number;
}

const MIDGRAY = 0.184;

type ArenaName = 'stock' | 'dynamic';

/**
 * Kumpulkan tabel dari arena (dibangun atau masih builder) lewat `read`.
 * Arena dynamic harus sudah diaugmentasi `addPrintScanDynamicData`.
 */
export function midgrayTablesFrom(
  read: (arena: ArenaName, name: string) => Float32Array,
  hanatosWidth: number,
  hanatosHeight: number,
): MidgrayTables {
  return {
    hanatosRawResponse: read('dynamic', 'hanatosRawResponse'),
    hanatosWidth,
    hanatosHeight,
    inputToReferenceXyz: read('stock', 'inputToReferenceXyz'),
    curveExposure: read('stock', 'curveExposure'),
    densityCurves: read('stock', 'densityCurves'),
    densityCurveMinimum: read('stock', 'densityCurveMinimum'),
    channelDensity: read('stock', 'channelDensity'),
    baseDensity: read('stock', 'baseDensity'),
    printLinearSensitivity: read('dynamic', 'printLinearSensitivity'),
    printFilteredIlluminant: read('dynamic', 'printFilteredIlluminant'),
  };
}

function mitchell(t: number): number {
  const B = 1 / 3;
  const C = 1 / 3;
  const x = Math.abs(t);
  if (x < 1) return ((12 - 9 * B - 6 * C) * x ** 3 + (-18 + 12 * B + 6 * C) * x * x + (6 - 2 * B)) / 6;
  if (x < 2) return ((-B - 6 * C) * x ** 3 + (6 * B + 30 * C) * x * x + (-12 * B - 48 * C) * x + (8 * B + 24 * C)) / 6;
  return 0;
}

function safeIndex(index: number, size: number): number {
  if (size <= 1) return 0;
  const period = size * 2 - 2;
  let m = index % period;
  if (m < 0) m += period;
  if (m >= size) m = period - m;
  return m;
}

/** Port `hanatosRaw` `filmExposure.wgsl` (Mitchell 4x4, clamp tepi yang sama). */
export function hanatosRawHost(t: MidgrayTables, xyz: readonly [number, number, number], compressed: boolean): number[] {
  const w = t.hanatosWidth;
  const h = t.hanatosHeight;
  const b = xyz[0] + xyz[1] + xyz[2];
  const denom = Math.max(b, 1e-10);
  const x = Math.min(Math.max(xyz[0] / denom, 0), 1);
  const y = Math.min(Math.max(xyz[1] / denom, 0), 1);
  const tx = Math.min(Math.max((1 - x) * (1 - x), 0), 1);
  const ty = Math.min(Math.max(y / Math.max(1 - x, 1e-10), 0), 1);
  const xCoord = tx * (w - 1);
  const yCoord = ty * (h - 1);
  const xEdge = xCoord >= w - 1;
  const yEdge = yCoord >= h - 1;
  const xBase = xEdge ? w - 2 : Math.floor(xCoord);
  const yBase = yEdge ? h - 2 : Math.floor(yCoord);
  const xFrac = xEdge ? 1 : xCoord - xBase;
  const yFrac = yEdge ? 1 : yCoord - yBase;
  const wx = [mitchell(xFrac + 1), mitchell(xFrac), mitchell(xFrac - 1), mitchell(xFrac - 2)];
  const wy = [mitchell(yFrac + 1), mitchell(yFrac), mitchell(yFrac - 1), mitchell(yFrac - 2)];
  const offset = compressed ? w * h : 0;
  let r0 = 0;
  let r1 = 0;
  let r2 = 0;
  let weightSum = 0;
  for (let i = 0; i < 4; i += 1) {
    const xi = safeIndex(xBase - 1 + i, w);
    for (let j = 0; j < 4; j += 1) {
      const yj = safeIndex(yBase - 1 + j, h);
      const weight = wx[i]! * wy[j]!;
      weightSum += weight;
      const o = (offset + xi * h + yj) * 4;
      r0 += weight * t.hanatosRawResponse[o]!;
      r1 += weight * t.hanatosRawResponse[o + 1]!;
      r2 += weight * t.hanatosRawResponse[o + 2]!;
    }
  }
  const scale = Math.max(b, 0) / (weightSum !== 0 ? weightSum : 1);
  return [r0 * scale, r1 * scale, r2 * scale];
}

/**
 * `fast_interp` hulu (linear, di luar rentang: nilai pertama/terakhir) pada
 * sumbu `logExposure / gamma` dan kurva MENTAH (ternormalisasi + minimum).
 */
function interpDensity(t: MidgrayTables, logRaw: number, channel: number, gamma: number): number {
  const count = t.curveExposure.length / 2;
  const xAt = (i: number) => t.curveExposure[i * 2]! / gamma;
  const yAt = (i: number) => t.densityCurves[i * 3 + channel]! + t.densityCurveMinimum[channel]!;
  if (logRaw <= xAt(0)) return yAt(0);
  if (logRaw >= xAt(count - 1)) return yAt(count - 1);
  let lo = 0;
  let hi = count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xAt(mid) <= logRaw) lo = mid;
    else hi = mid;
  }
  const dx = xAt(hi) - xAt(lo);
  const f = dx !== 0 ? (logRaw - xAt(lo)) / dx : 0;
  return yAt(lo) + (yAt(hi) - yAt(lo)) * f;
}

/** Balanced negative CMY density before DIR, used to anchor a Cineon print LUT. */
export function midgrayDensityChannels(t: MidgrayTables, srgbColorSpace: number): number[] {
  const o = srgbColorSpace * 9;
  const xyz = [0, 1, 2].map(r => 0.18 * (t.inputToReferenceXyz[o + r * 3]! + t.inputToReferenceXyz[o + r * 3 + 1]! + t.inputToReferenceXyz[o + r * 3 + 2]!)) as [number, number, number];
  return hanatosRawHost(t, xyz, false).map((value, c) => interpDensity(t, Math.log10(value + 1e-10), c, 1) - t.densityCurveMinimum[c]!);
}

/** `_simple_rgb_to_density_spectral` untuk abu-abu `value` (per wavelength). */
export function midgrayDensitySpectral(t: MidgrayTables, value: number, opts: MidgrayOptions): Float64Array {
  const rgb = value;
  const m = t.inputToReferenceXyz;
  const o = opts.srgbColorSpace * 9;
  const xyz: [number, number, number] = [
    (m[o]! + m[o + 1]! + m[o + 2]!) * rgb,
    (m[o + 3]! + m[o + 4]! + m[o + 5]!) * rgb,
    (m[o + 6]! + m[o + 7]! + m[o + 8]!) * rgb,
  ];
  const raw = hanatosRawHost(t, xyz, opts.inputCompression);
  const cmy = raw.map((r, c) => interpDensity(t, Math.log10(r + 1e-10), c, opts.gamma));
  const wavelengths = t.baseDensity.length;
  const out = new Float64Array(wavelengths);
  for (let wl = 0; wl < wavelengths; wl += 1) {
    out[wl] =
      cmy[0]! * t.channelDensity[wl * 3]! +
      cmy[1]! * t.channelDensity[wl * 3 + 1]! +
      cmy[2]! * t.channelDensity[wl * 3 + 2]! +
      t.baseDensity[wl]!;
  }
  return out;
}

/** `_exposure_factor`: 1 / rata-rata geometrik raw print midgray. */
export function exposureFactor(t: MidgrayTables, densitySpectral: ArrayLike<number>): number {
  let r0 = 0;
  let r1 = 0;
  let r2 = 0;
  for (let wl = 0; wl < densitySpectral.length; wl += 1) {
    let transmitted = 10 ** -densitySpectral[wl]! * t.printFilteredIlluminant[wl]!;
    if (Number.isNaN(transmitted)) transmitted = 0;
    r0 += transmitted * t.printLinearSensitivity[wl * 3]!;
    r1 += transmitted * t.printLinearSensitivity[wl * 3 + 1]!;
    r2 += transmitted * t.printLinearSensitivity[wl * 3 + 2]!;
  }
  const logMean = [r0, r1, r2].reduce((sum, v) => sum + Math.log(Math.max(v, 1e-10)), 0) / 3;
  return 1 / Math.exp(logMean);
}

/**
 * `_compute_exposure_factor_midgray` dengan `normalize_print_exposure=True`
 * (default Python, tidak pernah diubah proyek ini): `factor_midgray_comp`
 * bila kompensasi hidup, selain itu `factor_midgray`.
 */
export function printMidgrayFactor(t: MidgrayTables, opts: MidgrayOptions): number {
  const value = opts.compensation ? MIDGRAY * 2 ** opts.exposureCompensationEv : MIDGRAY;
  return exposureFactor(t, midgrayDensitySpectral(t, value, opts));
}
