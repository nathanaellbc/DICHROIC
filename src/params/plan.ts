/**
 * `buildRenderPlan` -- SATU-SATUNYA tempat `RenderParams` diterjemahkan ke
 * bahasa engine (spec Fase 2 §4.2). Menggantikan `defaultCoreParams` di
 * `test/parity/params.ts` (Fase 1), yang isinya dipindah ke sini apa adanya
 * dan dibuktikan setara field per field oleh `test/plan.test.ts` sebelum yang
 * lama dihapus.
 *
 * Dua mode:
 *
 * - `'image'` -- keluarga fixture `measured`. Auto-exposure diukur dari isi
 *   gambar (`measureAutoExposureEv`, dihitung host sebelum dispatch, persis
 *   `SpektraVulkanRenderer.cpp::measureAutoExposureEv`). `slot0 = 1`: film
 *   exposure menyimpan cabang LINEAR, halation yang menutup `log10`.
 * - `'cube'` -- keluarga fixture `_lut` (`debug.lut_mode=True`): auto-exposure,
 *   efek spasial, dan efek stokastik mati. Kubus tidak boleh bergantung pada
 *   isi gambar dan secara prinsip tidak bisa membawa efek spasial (spec induk
 *   §7.2), dan itu PERSIS semantik `lut_mode` -- jadi `.cube` memakai jalur
 *   yang sudah digerbangi sampai `rgb_out` di Fase 1, bukan jalur kedua.
 *   `slot0 = 0`: film/print exposure menutup `log10` sendiri.
 */

import { FLAG_GLARE_ACTIVE, FLAG_INPUT_CCTF_DECODING, FLAG_UNSHARP_ACTIVE } from '../engine/params';
import type { CoreParams } from '../engine/params';
import { EXPORT_APRON_SIGMAS, dirRadiusPx, exportOverlapPx, halationRadiusPx, productionOverlapPx } from '../engine/spatialRadius';
import type { FrameParams } from '../engine/graph';
import { measureAutoExposureEv } from '../host/autoExposure';
import { CAMERA_LIMITS, cameraFrameValues, isNeutralCamera, invert3, lumaWeights, measureScenePivot } from '../host/cameraDevelop';
import type { CameraSettings } from '../host/cameraDevelop';
import { softenKernel } from '../host/softenDetail';
import { LENS_LIMITS, lensSettings, resolveLensFrame } from '../host/lens';
import type { DepthMap } from '../host/lens';
import { decodeWithLut } from '../host/colorDecode';
import type { EnlargerFilterState } from '../host/enlarger';
import type { PrintScanArenaOptions, ScanFilmArenaOptions } from '../host/spectral';
import type { AssetBundle } from '../profiles/load';
import { FILM_FORMAT_LONG_EDGE_MM } from './filmFormat';
import { UnverifiedParameterError, validateRenderParams } from './registry';
import { BASELINE_RENDER_PARAMS } from './renderParams';
import { isPrintLut, type PrintLutId } from '../profiles/printLuts';
import type { ProcessMode, RenderParams } from './renderParams';

export type RenderMode = 'image' | 'cube';

export interface ChainSpec {
  printLut?: PrintLutId;
  filmOff?: boolean;
  softenDetail?: boolean;
  family: 'measured' | 'lut';
  /** Tahap grain disertakan. Selalu `false` untuk `lut`. */
  grain: boolean;
  /** Fase 2D Task 3: `io.scan_film` -- tanpa tahap print. Baku `false`. */
  scan?: boolean;
  /** Fase 2D Task 4: difusi FFT kamera / enlarger aktif. Baku `false`. */
  cameraDiffusion?: boolean;
  printDiffusion?: boolean;
  /** Ekstensi lens blur aktif (butuh peta kedalaman). Baku `false`. */
  lensBlur?: boolean;
}

/** Data per gambar di luar `RenderParams` (bukan parameter, tapi milik foto). */
export interface PlanExtras {
  /** Peta kedalaman foto ini (lens blur); tanpa ini lens blur tidak berjalan. */
  depth?: DepthMap;
}

export interface ArenaInputs {
  stockId: string;
  /** Data print+scan (mode print) atau scanner film (mode scan, Fase 2D). */
  printScan: PrintScanArenaOptions | ScanFilmArenaOptions;
}

export interface RenderPlan {
  core: CoreParams;
  /** Kunci cache arena: semua masukan `precomputeArenaData` yang bisa berubah. */
  arenaKey: string;
  arenaInputs: ArenaInputs;
  chain: ChainSpec;
  /** Apron tiling (px) dari `estimateTileOverlap`; 0 untuk `cube`. */
  overlap: number;
  /**
   * Apron tile EKSPOR (px): halation + DIR pada 5 sigma + FIR kecil
   * (`exportOverlapPx`), jahitan terukur <= 3,7e-6 di rgb_out. 0 untuk `cube`.
   */
  exportOverlap: number;
  /** Efek yang dimatikan mode ini -- ditulis ke header `.cube` (spec induk §7.2). */
  disabledEffects: string[];
  /** Nilai host per render (format film -> ukuran piksel). */
  frame: FrameParams;
}

// Tabel format film dan `lensSettings` tinggal di modul ringan supaya UI bisa
// memakainya tanpa menarik modul GPU yang diimpor plan ini.
export { FILM_FORMAT_LONG_EDGE_MM } from './filmFormat';

/**
 * Push/pull mode `Standard`: pengali gamma kurva film dari waktu develop ECN-2
 * (`SpektraVulkanRenderer.cpp::filmPushPullGamma`, 180 s normal, pull-1 150 s,
 * push-1 220 s, push-2 280 s). Padanan Python: `film_render.density_curve_gamma`,
 * yang dipakai `develop_simple`, koreksi DIR, dan midgray print.
 */
export function filmPushPullGamma(stops: number): number {
  const s = Math.min(Math.max(stops, -2), 2);
  const normal = 180;
  const pull1 = 150;
  const push1 = 220;
  const push2 = 280;
  if (s < 0) return (pull1 / normal) ** -s;
  if (s <= 1) return Math.exp(Math.log(push1 / normal) * s);
  return Math.exp(Math.log(push1 / normal) + Math.log(push2 / push1) * (s - 1));
}

export interface PlanImage {
  width: number;
  height: number;
  rgba: Float32Array;
}

const CUBE_DISABLED_EFFECTS = [
  'camera raw',
  'soften detail',
  'lens blur',
  'halation',
  'grain',
  'camera diffusion',
  'print diffusion',
  'DIR diffusion',
  'glare',
  'unsharp mask',
  'auto exposure',
  'film exposure compensation',
  'print exposure',
];

/**
 * Filter netral enlarger (Kodak CC) per pasangan (print, film) untuk
 * illuminant TH-KG3 -- `manifest.neutralPrintFilters`, database Python yang
 * `apply_database_neutral_print_filters()` baca (Fase 2C Task 8). Pasangan
 * di luar database ditolak keras: Python akan diam-diam memakai default
 * dataclass, konfigurasi yang tidak pernah kita gerbangi.
 */
export class MissingNeutralFiltersError extends Error {
  constructor(film: string, paper: string) {
    super(
      `Filter netral enlarger untuk pasangan film "${film}" / paper "${paper}" tidak ada ` +
        'di database Python (manifest.neutralPrintFilters).',
    );
    this.name = 'MissingNeutralFiltersError';
  }
}

/**
 * Stock yang sah per mode proses.
 *
 * - `printSimulation`: `film` harus film NEGATIF di database filter netral
 *   kertas `paper` (Python diam-diam memakai default dataclass untuk pasangan
 *   di luar database -- konfigurasi yang tidak pernah kita gerbangi).
 * - `scanNegative` (Fase 2D Task 3, `io.scan_film`): `film` boleh negatif
 *   maupun reversal, asal stock FILM (bukan kertas); `paper` tetap harus
 *   kertas yang sah (tidak dipakai, tapi dibawa ke mode print berikutnya).
 *
 * Dipanggil `buildRenderPlan` dan `Session.setParams`.
 */
export function validateStocks(bundle: AssetBundle, film: string, paper: string, process: ProcessMode = 'printSimulation'): void {
  if (isPrintLut(paper)) {
    validateStocks(bundle, film, BASELINE_RENDER_PARAMS.paper, 'scanNegative');
    return;
  }
  const { table } = bundle.manifest.neutralPrintFilters;
  const papers = Object.keys(table);
  if (!papers.includes(paper)) {
    throw new UnverifiedParameterError('paper', paper, BASELINE_RENDER_PARAMS.paper, `bukan stock kertas (${papers.join(', ')})`);
  }
  if (process === 'scanNegative') {
    const isStock = bundle.manifest.stocks.some((s) => s.id === film);
    if (!isStock || papers.includes(film)) {
      throw new UnverifiedParameterError('film', film, BASELINE_RENDER_PARAMS.film, 'bukan stock film');
    }
    return;
  }
  const films = Object.keys(table[paper]!);
  if (!films.includes(film)) {
    const reason = isStockOfType(bundle, film, 'positive')
      ? 'film reversal hanya bisa di-scan langsung (process scanNegative)'
      : 'bukan stock film di database netral';
    throw new UnverifiedParameterError('film', film, BASELINE_RENDER_PARAMS.film, reason);
  }
  if (bundle.stockEntry(film).type !== 'negative') {
    throw new UnverifiedParameterError('film', film, BASELINE_RENDER_PARAMS.film, 'film reversal hanya bisa di-scan langsung (process scanNegative)');
  }
}

function isStockOfType(bundle: AssetBundle, id: string, type: string): boolean {
  return bundle.manifest.stocks.some((s) => s.id === id && s.type === type);
}

/**
 * `filterC` OFX ditambahkan ke C netral (`filteredEnlargerIlluminantCpu`:
 * `neutral[c] + cFilter`); padanan Python-nya `enlarger.c_filter_neutral`
 * setelah `digest_params` (Python tidak punya shift C). M/Y memakai
 * `*_filter_shift`. Ruling 2C: OFX meng-clamp `netral + shift` di 0, Python
 * tidak (cc negatif -> transmitansi > 1); kita mengikuti Python, digerbangi
 * `param/enlarger_m_minus58_lut`.
 */
export function resolveEnlargerFilters(
  bundle: AssetBundle,
  film: string,
  paper: string,
  cFilter: number,
  mShift: number,
  yShift: number,
): EnlargerFilterState {
  const neutral = bundle.manifest.neutralPrintFilters.table[paper]?.[film];
  if (!neutral) throw new MissingNeutralFiltersError(film, paper);
  return {
    cFilterNeutral: neutral[0] + cFilter,
    mFilterNeutral: neutral[1],
    mFilterShift: mShift,
    yFilterNeutral: neutral[2],
    yFilterShift: yShift,
  };
}

/**
 * Batas atas `amount * max(inhibition_samelayer, inhibition_interlayer)`
 * yang digerbangi (Fase 2D Task 1). Di atas ~1.45 kurva sebelum DIR
 * terlipat (`log_exposure_0` tidak monoton; Portra 800 Push 2 paling awal,
 * Vision3 500T paling akhir di 2.15): `np.interp` Python tidak bermakna di
 * sana dan derau f32 GPU melewati ambang parity (2e-5 pada amount 2).
 */
export const DIR_MAX_EFFECTIVE = 1.4;

/** Rentang DIR yang digerbangi `param/dir_*`. */
export function validateDirCouplers(params: RenderParams): void {
  const { dirCouplersAmount: amount, dirCouplersInhibitionSameLayer: same, dirCouplersInhibitionInterlayer: inter } = params;
  const baseline = BASELINE_RENDER_PARAMS;
  if (!(amount >= 0) || !(same >= 0) || !(inter >= 0)) {
    throw new UnverifiedParameterError('dirCouplersAmount', amount, baseline.dirCouplersAmount, 'amount dan inhibisi DIR tidak boleh negatif');
  }
  if (amount * Math.max(same, inter) > DIR_MAX_EFFECTIVE + 1e-9) {
    throw new UnverifiedParameterError(
      'dirCouplersAmount',
      amount,
      baseline.dirCouplersAmount,
      `amount x inhibisi maksimum ${DIR_MAX_EFFECTIVE} (kurva sebelum DIR terlipat di atasnya)`,
    );
  }
  if (!(params.preflashExposure >= 0) || params.preflashExposure > 1) {
    throw new UnverifiedParameterError('preflashExposure', params.preflashExposure, baseline.preflashExposure, 'preflash digerbangi 0..1');
  }
  for (const field of ['preflashMFilterShift', 'preflashYFilterShift'] as const) {
    if (!(Math.abs(params[field]) <= 60)) {
      throw new UnverifiedParameterError(field, params[field], baseline[field], 'shift filter preflash digerbangi -60..60 CC');
    }
  }
  for (const field of ['cameraDiffusionStrength', 'printDiffusionStrength'] as const) {
    if (!(params[field] >= 0) || params[field] > 2) {
      throw new UnverifiedParameterError(field, params[field], baseline[field], 'strength difusi digerbangi 0..2 (stop filter komersial)');
    }
  }
  for (const field of ['cameraDiffusionFamily', 'printDiffusionFamily'] as const) {
    if (!['glimmerglass', 'black_pro_mist', 'pro_mist', 'cinebloom'].includes(params[field])) {
      throw new UnverifiedParameterError(field, params[field], baseline[field], 'family difusi tidak dikenal');
    }
  }
  if (!(params.dirCouplersDiffusionUm >= 0) || params.dirCouplersDiffusionUm > 60) {
    throw new UnverifiedParameterError(
      'dirCouplersDiffusionUm',
      params.dirCouplersDiffusionUm,
      baseline.dirCouplersDiffusionUm,
      'difusi DIR digerbangi 0..60 um',
    );
  }
}

/** Rentang kontrol "Camera Raw" (ekstensi DICHROIC, `host/cameraDevelop.ts`). */
const CAMERA_FIELD_LIMITS: ReadonlyArray<[keyof RenderParams, { min: number; max: number }]> = [
  ['cameraWhiteBalanceK', CAMERA_LIMITS.whiteBalanceK],
  ['cameraExposureEv', CAMERA_LIMITS.exposureEv],
  ['cameraTint', CAMERA_LIMITS.tint],
  ['cameraContrast', CAMERA_LIMITS.contrast],
  ['cameraHighlights', CAMERA_LIMITS.highlights],
  ['cameraShadows', CAMERA_LIMITS.shadows],
  ['cameraWhites', CAMERA_LIMITS.whites],
  ['cameraBlacks', CAMERA_LIMITS.blacks],
  ['cameraSaturation', CAMERA_LIMITS.saturation],
  ['cameraHsvSaturation', CAMERA_LIMITS.hsvSaturation],
  ['cameraSoftenDetail', { min: 0, max: 1 }],
];

export function validateCamera(params: RenderParams): void {
  for (const [field, { min, max }] of CAMERA_FIELD_LIMITS) {
    const value = params[field] as number;
    if (!(value >= min && value <= max)) {
      throw new RangeError(`Parameter "${field}" = ${String(value)} di luar rentang ${min}..${max}.`);
    }
  }
}

export function cameraSettings(params: RenderParams): CameraSettings {
  return {
    whiteBalanceK: params.cameraWhiteBalanceK,
    exposureEv: params.cameraExposureEv,
    tint: params.cameraTint,
    contrast: params.cameraContrast,
    highlights: params.cameraHighlights,
    shadows: params.cameraShadows,
    whites: params.cameraWhites,
    blacks: params.cameraBlacks,
    saturation: params.cameraSaturation,
    hsvSaturation: params.cameraHsvSaturation,
  };
}

/**
 * Uniform "Camera Raw" untuk render ini, atau `undefined` bila netral (tahap
 * dilewati persis). Pivot tone diukur dari gambar ini sendiri, ter-decode
 * persis seperti yang dilihat shader (termasuk pengali auto-exposure di ruang
 * ter-encode bila decode aktif).
 */
function cameraFrame(
  params: RenderParams,
  bundle: AssetBundle,
  image: PlanImage,
  inputColorSpace: number,
  inputDecodeScale: number,
): Float32Array | undefined {
  const settings = cameraSettings(params);
  if (isNeutralCamera(settings)) return undefined;
  const all = bundle.staticTable('inputMeterXyzMatrices');
  const rgbToXyz = Array.from({ length: 9 }, (_, i) => all[inputColorSpace * 9 + i]!);
  const decode = params.inputCctfDecoding ? inputDecoder(bundle, inputColorSpace) : undefined;
  const scaled = decode && inputDecodeScale !== 1 ? (v: number) => decode(v * inputDecodeScale) : decode;
  const pivot = measureScenePivot(image.rgba, image.width, image.height, lumaWeights(rgbToXyz), scaled);
  return cameraFrameValues(settings, rgbToXyz, pivot);
}

/** Rentang lens blur (`host/lens.ts`). */
export function validateLens(params: RenderParams): void {
  const check = (field: keyof RenderParams, ok: boolean, range: string) => {
    if (!ok) throw new RangeError(`Parameter "${field}" = ${String(params[field])} di luar rentang ${range}.`);
  };
  const inRange = (v: number, min: number, max: number) => v >= min && v <= max;
  check('lensFocusX', inRange(params.lensFocusX, 0, 1), '0..1');
  check('lensFocusY', inRange(params.lensFocusY, 0, 1), '0..1');
  check('lensFocusDistanceM', inRange(params.lensFocusDistanceM, LENS_LIMITS.focusDistanceM.min, LENS_LIMITS.focusDistanceM.max), '0.3..100 m');
  check(
    'lensFocalLengthMm',
    params.lensFocalLengthMm === 0 || inRange(params.lensFocalLengthMm, LENS_LIMITS.focalLengthMm.min, LENS_LIMITS.focalLengthMm.max),
    '0 (normal) atau 8..600 mm',
  );
  check('lensFNumber', inRange(params.lensFNumber, LENS_LIMITS.fNumber.min, LENS_LIMITS.fNumber.max), 'f/1.2..f/22');
  check('lensBlades', [0, 5, 6, 7, 8, 9].includes(params.lensBlades), '0 (bulat) atau 5..9');
  check('lensBladeCurvature', inRange(params.lensBladeCurvature, 0, 1), '0..1');
  check('lensCatEye', inRange(params.lensCatEye, 0, 1), '0..1');
  check(
    'lensNearSharpM',
    params.lensNearSharpM === 0 || inRange(params.lensNearSharpM, LENS_LIMITS.nearSharpM.min, params.lensFocusDistanceM),
    '0 (bidang fokus) atau 0.2..jarak fokus',
  );
  check('lensForeground', inRange(params.lensForeground, 0, 1), '0..1');
}

export { lensSettings } from '../host/lens';

export function buildRenderPlan(
  params: RenderParams,
  bundle: AssetBundle,
  image: PlanImage,
  mode: RenderMode,
  extras: PlanExtras = {},
): RenderPlan {
  validateRenderParams(params);
  validateStocks(bundle, params.film, params.paper, params.process);
  validateOutputColorSpace(bundle, params.outputColorSpace);
  validateDirCouplers(params);
  validateCamera(params);
  validateLens(params);

  const family = mode === 'cube' ? 'lut' : 'measured';
  const printLut = isPrintLut(params.paper) ? params.paper : undefined;
  const scan = params.process === 'scanNegative' && !printLut;
  const backingParams = printLut ? { ...params, paper: BASELINE_RENDER_PARAMS.paper } : params;
  // Grain dan glare independen sejak Fase 2C (`film_render.grain.active`,
  // `print_render.glare.active`); keduanya mati di lut_mode. Scan film
  // (Fase 2D) tidak punya glare: `scanning.py` memberi `glare = None`.
  const grainActive = family === 'measured' && params.grainEnabled;
  // Fase 2D Task 4: difusi spasial -- `lut_mode` (deactivate_spatial_effects)
  // mematikan keduanya; situs enlarger tidak ada di mode scan film.
  const cameraDiffusion = family === 'measured' && params.cameraDiffusionEnabled && params.cameraDiffusionStrength > 0;
  const printDiffusion = family === 'measured' && !scan && params.printDiffusionEnabled && params.printDiffusionStrength > 0;
  const glareActive = family === 'measured' && !scan && params.glareEnabled && params.glarePercent > 0;
  // Ekstensi lens blur: efek spasial (mati di `lut_mode`) dan butuh peta kedalaman.
  const lensBlur = family === 'measured' && params.lensBlurEnabled && extras.depth !== undefined;

  const printScan: PrintScanArenaOptions | ScanFilmArenaOptions = scan
    ? { scanFilm: true, outputColorSpace: params.outputColorSpace }
    : {
        printStockId: backingParams.paper,
        enlargerFilters: resolveEnlargerFilters(
          bundle,
          printLut ? BASELINE_RENDER_PARAMS.film : params.film,
          backingParams.paper,
          params.filterC,
          params.filterMShift,
          params.filterYShift,
        ),
        outputColorSpace: params.outputColorSpace,
      };

  const filmFormatMm = FILM_FORMAT_LONG_EDGE_MM[params.filmFormat];
  const softenDetail = family === 'measured' && params.cameraSoftenDetail > 0;
  const softenApron = softenDetail ? 2 * softenKernel(Math.max(image.width, image.height)).radius : 0;
  const overlap = family === 'lut' ? 0 : measuredOverlapPx(params, bundle, image, filmFormatMm) + softenApron;
  const exportOverlap = family === 'lut' ? 0 : exportApronPx(params, bundle, image, filmFormatMm) + softenApron;

  const inputColorSpace = validateInputColorSpace(bundle, params.inputColorSpace, params.inputCctfDecoding);
  // Auto-exposure diukur dari gambar ter-decode (bila decode), tapi Python
  // MENERAPKANNYA pada gambar ter-encode (`image * 2**ev`, sebelum
  // `rgb_to_raw`). Tanpa decode keduanya linear dan EV cukup dijumlah ke
  // `filmExposureEv`; dengan decode EV itu dibawa `frame.inputDecodeScale`.
  const autoEv =
    family === 'measured' && params.autoExposure
      ? measureAutoExposureEv(
          image.rgba,
          image.width,
          image.height,
          bundle.staticTable('inputMeterXyzMatrices'),
          inputColorSpace,
          params.inputCctfDecoding ? inputDecoder(bundle, inputColorSpace) : undefined,
        )
      : 0;

  // Ekstensi "Camera Raw": warna per piksel, tapi pivot tone diukur dari
  // gambar -- kisi `.cube` bukan gambar, jadi `lut_mode` melewatinya.
  const camera = family === 'measured' ? cameraFrame(params, bundle, image, inputColorSpace, params.inputCctfDecoding ? 2 ** autoEv : 1) : undefined;

  return {
    core: buildCoreParams(backingParams, bundle, image, family, glareActive, inputColorSpace, autoEv),
    arenaKey: scan
      ? `${params.film}::scan::out=${params.outputColorSpace}`
      : `${params.film}::print=${params.paper}::out=${params.outputColorSpace}::c=${params.filterC}::m=${params.filterMShift}::y=${params.filterYShift}`,
    arenaInputs: { stockId: params.film, printScan },
    chain: {
      family,
      ...(printLut ? { printLut } : {}),
      ...(!params.filmEnabled ? { filmOff: true } : {}),
      grain: grainActive,
      ...(scan ? { scan } : {}),
      ...(cameraDiffusion ? { cameraDiffusion: true } : {}),
      ...(printDiffusion ? { printDiffusion: true } : {}),
      ...(lensBlur ? { lensBlur: true } : {}),
      ...(softenDetail ? { softenDetail: true } : {}),
    },
    overlap,
    exportOverlap,
    disabledEffects: family === 'lut' ? [...CUBE_DISABLED_EFFECTS] : [],
    frame: {
      ...(!params.filmEnabled || printLut ? {
        cameraOutput: linearOutputFrame(params, bundle),
        neutralFilm: neutralFilmFrame(params, bundle, family, autoEv),
      } : {}),
      ...exposureFrame(params, family, filmFormatMm),
      ...(cameraDiffusion ? { cameraDiffusion: { family: params.cameraDiffusionFamily, strength: params.cameraDiffusionStrength } } : {}),
      ...(printDiffusion ? { printDiffusion: { family: params.printDiffusionFamily, strength: params.printDiffusionStrength } } : {}),
      inputDecodeScale: params.inputCctfDecoding ? 2 ** autoEv : 1,
      ...(camera ? { camera } : {}),
      ...(softenDetail ? { softenDetail: {
        amount: params.cameraSoftenDetail,
        luma: lumaWeights(Array.from({ length: 9 }, (_, i) => bundle.staticTable('inputMeterXyzMatrices')[inputColorSpace * 9 + i]!)),
      } } : {}),
      ...(lensBlur
        ? {
            lens: resolveLensFrame(
              lensSettings(params),
              extras.depth!,
              params.filmFormat,
              filmFormatMm,
              Math.max(image.width, image.height),
            ),
          }
        : {}),
    },
  };
}

/**
 * Label colour space input yang decode OFX-nya TIDAK sama dengan
 * `cctf_decoding` colour pada kunci Python-nya (diukur Fase 2C Task 9:
 * selisih relatif 1..74; 20 label lain identik persis). Tanpa decode, ke-26
 * label sah (primaries identik).
 */
export const INPUT_DECODE_WITHOUT_ORACLE: readonly string[] = Object.freeze([
  'Canon Log2 CinemaGamut D55',
  'Canon Log3 CinemaGamut D55',
  'Linear Rec.709',
  'P3-D65 Gamma 2.2',
  'Rec.709 Gamma 2.2',
  'Rec.709 Gamma 2.4',
]);

/** Indeks label di manifest; menolak label tak dikenal dan decode tanpa oracle. */
export function validateInputColorSpace(bundle: AssetBundle, label: string, decode: boolean): number {
  const index = bundle.manifest.colorSpaces.labels.indexOf(label);
  if (index < 0) {
    throw new UnverifiedParameterError('inputColorSpace', label, BASELINE_RENDER_PARAMS.inputColorSpace, 'bukan label colour space');
  }
  if (decode && INPUT_DECODE_WITHOUT_ORACLE.includes(label)) {
    throw new UnverifiedParameterError(
      'inputCctfDecoding',
      decode,
      false,
      `decode "${label}" tidak punya padanan cctf_decoding di colour-science`,
    );
  }
  return index;
}

/**
 * Colour space keluaran harus ada di `manifest.outputColorSpaces`: label SDR
 * yang encode OFX-nya identik dengan `cctf_encoding` colour (10 dari 26;
 * mis. "Rec.709 Gamma 2.4", default OFX, TIDAK -- colour BT.709 memakai OETF).
 */
export function validateOutputColorSpace(bundle: AssetBundle, label: string): void {
  const supported = Object.keys(bundle.manifest.outputColorSpaces);
  if (!supported.includes(label)) {
    throw new UnverifiedParameterError(
      'outputColorSpace',
      label,
      BASELINE_RENDER_PARAMS.outputColorSpace,
      `hanya ${supported.join(', ')} yang punya padanan colour-science`,
    );
  }
}

function inputDecoder(bundle: AssetBundle, colorSpace: number): (value: number) => number {
  const { colorSpaces } = bundle.manifest;
  const table = {
    luts: bundle.staticTable('colorDecodeLuts'),
    size: colorSpaces.transferLutSize,
    min: colorSpaces.decodeLutMin,
    max: colorSpaces.decodeLutMax,
  };
  return (value) => decodeWithLut(table, colorSpace, value);
}

/**
 * Exposure print (Fase 2C Task 2), mengikuti `digest_params` Python:
 *
 * - `measured`: `print_exposure_compensation=True` (default) -- midgray print
 *   dihitung pada `0.184 * 2**filmExposureEv`, jadi print di-retime terhadap
 *   EV kompensasi film (BUKAN EV auto-exposure). `print_exposure =
 *   2**printExposureEv`.
 * - `lut` (`lut_mode`): kompensasi mati, `exposure_compensation_ev = 0`,
 *   `print_exposure = 1` -- kubus mengabaikan kedua EV, dicatat di
 *   `CUBE_DISABLED_EFFECTS`.
 */
function exposureFrame(params: RenderParams, family: 'measured' | 'lut', filmFormatMm: number): FrameParams {
  // Fase 2D Task 1: kimia DIR (matriks) berlaku di kedua keluarga; difusinya
  // spasial, jadi `lut_mode` (`deactivate_spatial_effects`) menolkannya.
  // `active=False` Python melewati koreksi sepenuhnya -- setara amount 0
  // (matriks nol: kurva sebelum DIR = kurva asli, koreksi nol), digerbangi
  // `param/dir_off`.
  const dir = {
    dirCouplersAmount: params.dirCouplersEnabled ? params.dirCouplersAmount : 0,
    dirInhibitionSameLayer: params.dirCouplersInhibitionSameLayer,
    dirInhibitionInterlayer: params.dirCouplersInhibitionInterlayer,
    dirDiffusionUm: family === 'lut' || !params.dirCouplersEnabled ? 0 : params.dirCouplersDiffusionUm,
    // Fase 2D Task 2: preflash tidak spasial dan tidak stokastik -- berlaku
    // juga di `lut_mode`.
    preflashExposure: params.preflashExposure,
    preflashMFilterShift: params.preflashMFilterShift,
    preflashYFilterShift: params.preflashYFilterShift,
  };
  if (family === 'lut') {
    return { filmFormatMm, exposureCompensationEv: 0, printExposureCompensation: false, printExposure: 1, ...dir };
  }
  return {
    ...dir,
    filmFormatMm,
    exposureCompensationEv: params.filmExposureEv,
    printExposureCompensation: true,
    printExposure: 2 ** params.printExposureEv,
    // Fase 2C Task 5: `film_render.halation.active`/`halation_amount`.
    halationEnabled: params.halationEnabled,
    halationAmount: params.halationAmount,
    // Fase 2C Task 6: `scanner.unsharp_mask[1]`, `print_render.glare.percent`.
    scannerUnsharpAmount: params.scannerUnsharpAmount,
    glarePercent: params.glarePercent,
    // Fase 2C Task 7: RNG dan blend grain OFX.
    grainSeed: params.grainSeed,
    grainAmount: params.grainAmount,
  };
}

/**
 * Overlap tile keluarga measured (Fase 2A.5): jumlah radius tahap spasial
 * yang aktif, dihitung dengan fungsi yang SAMA dengan `Stage.spatialRadiusPx`
 * halation/DIR (`src/engine/spatialRadius.ts`), sehingga apron tile dan
 * penyusutan active rect per tahap tidak bisa berselisih. Kedua situs
 * diffusion berjalan sebagai identitas (`bypassConvolution`) selama
 * `*DiffusionEnabled` locked ke false, jadi radiusnya 0.
 */
/** Apron tile ekspor (5 sigma, `EXPORT_APRON_SIGMAS`); 0 untuk `lut`. */
function exportApronPx(params: RenderParams, bundle: AssetBundle, image: PlanImage, filmFormatMm: number): number {
  const pixelSizeUm = (filmFormatMm * 1000) / Math.max(image.width, image.height, 1);
  const firstSigma = bundle.stockField(params.film, 'halationFirstSigmaUm');
  if (!firstSigma) throw new Error(`Stock '${params.film}' tidak punya halationFirstSigmaUm`);
  return exportOverlapPx({
    halation: params.halationEnabled
      ? halationRadiusPx(pixelSizeUm, [firstSigma[0]!, firstSigma[1]!, firstSigma[2]!], EXPORT_APRON_SIGMAS)
      : 0,
    dir: dirRadiusPx(pixelSizeUm, params.dirCouplersEnabled ? params.dirCouplersDiffusionUm : 0, EXPORT_APRON_SIGMAS),
  });
}

function measuredOverlapPx(params: RenderParams, bundle: AssetBundle, image: PlanImage, filmFormatMm: number): number {
  const pixelSizeUm = (filmFormatMm * 1000) / Math.max(image.width, image.height, 1);
  const firstSigma = bundle.stockField(params.film, 'halationFirstSigmaUm');
  if (!firstSigma) throw new Error(`Stock '${params.film}' tidak punya halationFirstSigmaUm`);
  return productionOverlapPx({
    halation: params.halationEnabled
      ? halationRadiusPx(pixelSizeUm, [firstSigma[0]!, firstSigma[1]!, firstSigma[2]!])
      : 0,
    // DIR spasial aktif di keluarga measured kecuali difusi dinolkan (Fase 2D).
    dir: dirRadiusPx(pixelSizeUm, params.dirCouplersEnabled ? params.dirCouplersDiffusionUm : 0),
    grain: params.grainEnabled,
    unsharp: params.scannerUnsharpAmount > 0,
  });
}

/**
 * Isi `defaultCoreParams` Fase 1 (Task 11-18c). Sejarah tiap keputusan ada di
 * laporan task yang dirujuk; ringkasnya:
 *
 * - `filmExposureEv` MENCAKUP hasil auto-exposure yang bergantung isi gambar
 *   (`camera.auto_exposure` default `True`), dibuktikan lewat rasio
 *   `rgb_pre/input` yang konstan per gambar tapi berbeda antar gambar
 *   (task-11-report.md). `lut_mode` mematikannya.
 * - Glare hanya menyala saat `measured` DAN efek stokastik hidup
 *   (`deactivate_stochastic_effects` mematikan `print_render.glare.active`);
 *   unsharp menyala untuk `measured` terlepas dari efek stokastik (hanya
 *   `deactivate_spatial_effects`/`lut_mode` yang menolkannya) -- Task 18c,
 *   dibuktikan `measuredChain.test.ts`.
 * - `slot0`: `lut` menyimpan cabang LOG langsung (film exposure menutup
 *   `log10` sendiri); `measured` menyimpan LINEAR (halation yang menutupnya).
 */
/**
 * Sumber tiap field (dipindah dari `test/parity/params.ts`, Fase 1 Task 11;
 * keterangan `slot0` di bawah mendahului Task 14 -- keluarga `measured`
 * sekarang memakai cabang LINEAR, lih. ringkasan di atas):
 * `CoreParams` yang mencerminkan `digest_params(init_params())` Python
 * untuk stock `kodak_portra_400` (default `gen_reference.py`/`init_params`)
 * pada tahap FilmExposure. Field yang TIDAK dibaca `filmExposure.wgsl`
 * (`filmGamma`, `filmPushPullMode/Stops`, tiling) diberi nilai netral
 * (tidak berpengaruh, dicatat sebagai demikian) -- bukan ditebak dari nama.
 *
 * Field demi field, dengan sumber:
 *   - `width`/`height`/`fullWidth`/`fullHeight` — dimensi kasus uji (tidak
 *     di-tile, jadi keduanya sama; lih. `params.ts::CoreParams` untuk tiga
 *     ruang koordinat).
 *   - `filmExposureEv` — `camera.exposure_compensation_ev` (0.0, default
 *     `CameraParams`) + `measureAutoExposureEv(...)` (lih. di atas) --
 *     KEDUANYA linear dalam skala raw (`hanatosRaw`/`mallettRaw` linear
 *     terhadap magnitudo input, lih. task-11-report.md), jadi menjumlahkan
 *     keduanya di ruang EV/log2 SETARA dengan menerapkan auto-exposure
 *     sebagai perkalian rgb SEBELUM konversi (yang dilakukan Python) --
 *     dibuktikan, bukan diasumsikan.
 *   - `inputColorSpace` — indeks "ProPhoto RGB" pada
 *     `manifest.colorSpaces.labels` (`io.input_color_space` default).
 *   - `rgbToRawMethod` — 0 (hanatos2025, `settings.rgb_to_raw_method`
 *     default) -- shader memilih mallett hanya bila `== 1`.
 *   - `colorSpaceCount`/`transferLutSize`/`colorDecodeMin`/`colorDecodeMax`
 *     — dari `manifest.colorSpaces` (Task 4), bukan dihardcode ulang.
 *   - `hanatosWidth`/`hanatosHeight` — dari `manifest.hanatos` (Task 4).
 *   - `slot0` — 0: pilih cabang LOG (`_pad0==1u` adalah cabang linear;
 *     tap `log_e_film` butuh log).
 *   - `slot1` — `FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION` (bit 0): Python
 *     `InputGamutCompressSpec.active` default `True`
 *     (`gamut_compression.py:69`), TIDAK dimatikan `digest_params` untuk
 *     konfigurasi ini -- shader harus membaca separuh TERKOMPRESI
 *     `HanatosRawResponse`. Task 18 Gate B menambahkan bit 2
 *     (`FLAG_GLARE_ACTIVE`, `scannerPost.wgsl`-only): menyala untuk
 *     `family: 'measured'`, padam untuk `'lut'` -- lih. `FLAG_GLARE_ACTIVE`
 *     (`src/engine/params.ts`) untuk alasan lengkap.
 *   - `slot2` — 0. `filmExposure.wgsl` tidak lagi membaca field ini
 *     (review seluruh-branch agenda #5 -- cabang "buffer tetangga
 *     resolusi-penuh" yang dulu di sini dihapus sebagai kode mati
 *     berbahaya, bukan diaktifkan oleh tiling Task 19).
 *   - `activeOrigin*`/`tileOrigin*` — 0; `activeWidth/Height` — 0 (berarti
 *     "seluruh buffer", lih. `params.ts`).
 */
function buildCoreParams(
  params: RenderParams,
  bundle: AssetBundle,
  image: PlanImage,
  family: 'measured' | 'lut',
  glareActive: boolean,
  inputColorSpace: number,
  autoEv: number,
): CoreParams {
  const { width, height } = image;
  const { colorSpaces } = bundle.manifest;

  // `lut_mode` memaksa `camera.exposure_compensation_ev = 0` dan
  // `auto_exposure = False` (`params_builder.py`); `autoEv` sudah 0 di sana.
  // Dengan decode CCTF, auto-EV diterapkan di ruang ter-encode lewat
  // `frame.inputDecodeScale`, jadi tidak dijumlah di sini.
  const filmExposureEv = (family === 'lut' ? 0 : params.filmExposureEv) + (params.inputCctfDecoding ? 0 : autoEv);

  const FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION = 1 << 0;
  const inputDecodingFlag = params.inputCctfDecoding ? FLAG_INPUT_CCTF_DECODING : 0;
  // Guard Python: `add_glare` hanya bila `active and percent > 0` (sudah di
  // `glareActive`); `_apply_blur_and_unsharp` hanya bila `sigma > 0 and
  // amount > 0` (sigma tetap 0.7).
  const glareActiveFlag = glareActive ? FLAG_GLARE_ACTIVE : 0;
  const unsharpActiveFlag = family === 'measured' && params.scannerUnsharpAmount > 0 ? FLAG_UNSHARP_ACTIVE : 0;

  return {
    width,
    height,
    filmExposureEv,
    // `density_curve_gamma` Python; push/pull `Standard` (Fase 2C Task 4).
    filmGamma: filmPushPullGamma(params.filmPushPullStops),
    // curveDevelop.wgsl membaca ini sebagai batas pencarian biner kurva H&D.
    exposureCount: bundle.stock(params.film).entry.exposureCount,
    inputColorSpace,
    rgbToRawMethod: 0, // hanatos2025
    colorSpaceCount: colorSpaces.count,
    transferLutSize: colorSpaces.transferLutSize,
    colorDecodeMin: colorSpaces.decodeLutMin,
    colorDecodeMax: colorSpaces.decodeLutMax,
    hanatosWidth: bundle.manifest.hanatos.width,
    hanatosHeight: bundle.manifest.hanatos.height,
    slot0: family === 'lut' ? 0 : 1,
    slot1: FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION | glareActiveFlag | unsharpActiveFlag | inputDecodingFlag,
    // Tidak lagi dibaca filmExposure.wgsl (review seluruh-branch Fase 1, agenda #5).
    slot2: 0,
    // Mode `Standard` (0): efeknya hanya lewat `filmGamma` di atas, persis OFX.
    // Mode `Experimental` (1) tidak punya oracle Python dan tidak dibuka.
    filmPushPullMode: 0,
    filmPushPullStops: params.filmPushPullStops,
    fullWidth: width,
    fullHeight: height,
    tileOriginX: 0,
    tileOriginY: 0,
    activeOriginX: 0,
    activeOriginY: 0,
    activeWidth: 0, // 0 = seluruh buffer
    activeHeight: 0,
  };
}

/** Convert between input/output RGB primaries via their common adapted sRGB basis. */
function cameraOutputFrame(params: RenderParams, bundle: AssetBundle): Float32Array {
  const matrices = bundle.stockField(params.film, 'inputToSrgb')!;
  const labels = bundle.manifest.colorSpaces.labels;
  const inIndex = labels.indexOf(params.inputColorSpace);
  const input = matrices.slice(inIndex * 9, inIndex * 9 + 9);
  const outIndex = labels.indexOf(params.outputColorSpace);
  const inverse = invert3(matrices.slice(outIndex * 9, outIndex * 9 + 9));
  const values = new Float32Array(16);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    for (let k = 0; k < 3; k++) values[r * 4 + c]! += inverse[r * 3 + k]! * input[k * 3 + c]!;
  }
  const output = bundle.manifest.outputColorSpaces[params.outputColorSpace]!;
  values[12] = { linear: 0, srgb: 1, romm: 2, gamma: 3 }[output.encoding];
  values[13] = output.gamma ?? 1;
  return values;
}

function linearOutputFrame(params: RenderParams, bundle: AssetBundle): Float32Array {
  const frame = cameraOutputFrame({ ...params, inputColorSpace: 'sRGB' }, bundle);
  frame[12] = 0;
  return frame;
}

function neutralFilmFrame(params: RenderParams, bundle: AssetBundle, family: 'measured' | 'lut', autoEv: number): Float32Array {
  const matrix = cameraOutputFrame({ ...params, outputColorSpace: 'sRGB' }, bundle);
  const values = new Float32Array(28);
  values.set(matrix.subarray(0, 12));
  values[12] = 2 ** ((family === 'lut' ? 0 : params.filmExposureEv) + (params.inputCctfDecoding ? 0 : autoEv));
  values[13] = filmPushPullGamma(params.filmPushPullStops);
  values[14] = bundle.stockEntry(params.film).type === 'positive' ? -1 : 1;
  values[15] = params.filmEnabled ? 1 : 0;
  values[19] = family === 'lut' ? 1 : 2 ** params.printExposureEv;
  values[20] = 10 ** (-params.filterC / 100);
  values[21] = 10 ** (-(params.filterC + params.filterMShift) / 100);
  values[22] = 10 ** (-(params.filterC + params.filterYShift) / 100);
  values[23] = params.preflashExposure;
  values[24] = params.preflashMFilterShift;
  values[25] = params.preflashYFilterShift;
  return values;
}
