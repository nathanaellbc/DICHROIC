/**
 * Alat penyuntingan: pemetaan dari kontrol UI ke field `RenderParams`,
 * rentang, dan format nilai. Rentang dibatasi ke wilayah yang digerbangi
 * parity Fase 2C (`tools/param_cases.py`, spec Fase 2 §6.1), misalnya unsharp
 * berhenti di 2,5 karena di atasnya derau f32 melewati ambang.
 */
import { F_STOPS, LENS_LIMITS, NORMAL_FOCAL_MM } from '../../host/lens';
import type { DiffusionFilterFamily, FilmFormat, RenderParams } from '../../params/renderParams';
import { isSlideFilm } from './stocks';

export type GroupId = 'camera' | 'lens' | 'film' | 'color' | 'darkroom' | 'texture';

type NumericField = {
  [K in keyof RenderParams]: RenderParams[K] extends number ? K : never;
}[keyof RenderParams];
type BooleanField = {
  [K in keyof RenderParams]: RenderParams[K] extends boolean ? K : never;
}[keyof RenderParams];

export type IconName =
  | 'exposure' | 'auto' | 'print' | 'negative' | 'pushPull' | 'format' | 'process'
  | 'dot' | 'input' | 'decode' | 'output'
  | 'couplers' | 'layers' | 'edge' | 'spread' | 'flash'
  | 'halation' | 'grain' | 'seed' | 'glare' | 'sharpen' | 'diffusion' | 'enlargerFilter'
  | 'temperature' | 'tint' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks' | 'saturation' | 'lens'
  | 'focus' | 'aperture' | 'focalLength' | 'nearSharp' | 'foreground' | 'blades' | 'curvature' | 'catEye';

interface ToolBase {
  section?: 'White Balance' | 'Light' | 'Color';
  id: string;
  label: string;
  title: string;
  icon: IconName;
  /** Warna ikon identitas (filter C/M/Y). */
  tint?: string;
  /**
   * Fase 2D: visibilitas per mode proses. `print` = hanya saat mencetak
   * (tahap print tidak ada saat scan film), `scan` = hanya saat scan.
   */
  mode?: 'print' | 'scan';
  /**
   * Alat hanya berlaku bila field ini menyala (alat lensa: `lensBlurEnabled`).
   * Beda dari `enabledBy`: alat TIDAK punya sakelar sendiri dan sakelar itu
   * tidak ikut dihitung sebagai "diubah" atau di-reset alat ini -- ia milik
   * alat lain (Lens).
   */
  requires?: BooleanField;
  /**
   * Alat punya tempat sendiri di luar deretan grupnya (Process: di pemilih
   * stok, di samping Film/Paper) -- tetap di model, tidak ikut dirender grup.
   */
  elsewhere?: true;
}

export interface SliderTool extends ToolBase {
  /** Relative -100..100 display; keeps the validated processing domain intact. */
  relativeCenter?: number;
  kind: 'slider';
  field: NumericField;
  min: number;
  max: number;
  step: number;
  digits: number;
  unit?: string;
  /** Bila ada, alat punya sakelar sendiri; slider nonaktif saat sakelar mati. */
  enabledBy?: BooleanField;
  /**
   * Slider menampilkan kebalikan field (nilai UI = -field). Beberapa parameter
   * mengikuti semantik kamar gelap yang terbalik bagi pengguna foto: print
   * exposure lebih besar = cetakan LEBIH GELAP, filter C/M/Y lebih besar =
   * warna itu BERKURANG di cetakan. Di UI, + selalu berarti "lebih" dari yang
   * tertulis di label. Engine dan rentang yang digerbangi tidak berubah
   * (rentangnya simetris).
   */
  invert?: boolean;
  /** Penjelasan singkat di bawah slider. */
  note?: string;
  /**
   * Skala posisi slider. `log10`/`log2`: jarak di slider = rasio nilai (jarak
   * fokus, panjang fokus), seperti cincin lensa. Baku linear.
   */
  scale?: 'log10' | 'log2';
  /**
   * Arti nilai 0 bagi field ini, dan di mana ia digambar:
   * `normalFocal` = lensa normal format (digambar di panjang fokus itu);
   * `max` = ujung maks (batas tajam dekat 0 = bidang fokus).
   */
  zeroAs?: 'normalFocal' | 'max';
  /** Batas maks dinamis dari field lain (batas tajam dekat <= jarak fokus). */
  maxField?: NumericField;
}

export interface ToggleTool extends ToolBase {
  kind: 'toggle';
  field: BooleanField;
  note: string;
}

export interface StepperTool extends ToolBase {
  kind: 'stepper';
  field: NumericField;
  min: number;
  max: number;
  step: number;
  /** Bila ada, stepper melangkah di daftar ini (f-stop, jumlah bilah), bukan `step`. */
  values?: readonly number[];
}

export interface ChoiceOption<V extends string = string> {
  value: V;
  label: string;
  group?: string;
}

export interface ChoiceTool extends ToolBase {
  kind: 'choice';
  field: 'filmFormat' | 'inputColorSpace' | 'outputColorSpace' | 'process';
  options: readonly ChoiceOption[];
  note?: string;
}

/**
 * Filter difusi (Fase 2D): jenis filter (4 family Python) dan kekuatannya
 * dalam stop filter komersial, dengan sakelar sendiri.
 */
export interface DiffusionTool extends ToolBase {
  kind: 'diffusion';
  enabledBy: 'cameraDiffusionEnabled' | 'printDiffusionEnabled';
  familyField: 'cameraDiffusionFamily' | 'printDiffusionFamily';
  strengthField: 'cameraDiffusionStrength' | 'printDiffusionStrength';
  note: string;
}

export interface LockedTool extends ToolBase {
  kind: 'locked';
  note: string;
}

/**
 * Lens blur (ekstensi, `host/lens.ts`): sakelar plus kartu status peta
 * kedalaman (unduh model, progres, siap, galat), pemilih titik fokus, dan
 * readout kedalaman ruang.
 */
export interface LensTool extends ToolBase {
  kind: 'lens';
  field: 'lensBlurEnabled';
  note: string;
}

export type Tool = SliderTool | ToggleTool | StepperTool | ChoiceTool | DiffusionTool | LockedTool | LensTool;

export interface ToolGroup {
  id: GroupId;
  label: string;
  icon: IconName | 'camera';
  tools: readonly Tool[];
}

export const FILM_FORMATS: readonly ChoiceOption<FilmFormat>[] = [
  { value: 'standard8', label: 'Standard 8' },
  { value: 'super8', label: 'Super 8' },
  { value: 'standard16', label: 'Standard 16' },
  { value: 'super16', label: 'Super 16' },
  { value: 'standard35', label: '35 mm' },
  { value: 'super35', label: 'Super 35' },
  { value: 'standard65', label: '65 mm' },
  { value: 'imax70', label: 'IMAX 70' },
];

/** 26 label `manifest.colorSpaces.labels`, dikelompokkan untuk daftar pilihan. */
export const INPUT_COLOR_SPACES: readonly ChoiceOption[] = [
  ...['sRGB', 'Display P3', 'Adobe RGB (1998)', 'ProPhoto RGB', 'DCI-P3', 'P3-D65 Gamma 2.2', 'P3-D65 Gamma 2.6', 'Rec.709 Gamma 2.2', 'Rec.709 Gamma 2.4']
    .map((label) => ({ value: label, label, group: 'Display' })),
  ...['Linear Rec.709', 'Linear Rec.2020', 'Linear P3-D65', 'ACES2065-1', 'ACEScg']
    .map((label) => ({ value: label, label, group: 'Linear' })),
  ...['ACEScct', 'ACEScc', 'ARRI LogC4', 'ARRI LogC3 EI800', 'BMDFilm WideGamut Gen5', 'DaVinci Intermediate WideGamut',
    'RED Log3G10 REDWideGamutRGB', 'Sony S-Log3 S-Gamut3', 'Sony S-Log3 S-Gamut3.Cine', 'Canon Log2 CinemaGamut D55',
    'Canon Log3 CinemaGamut D55', 'Panasonic V-Log V-Gamut']
    .map((label) => ({ value: label, label, group: 'Camera log' })),
];

/** 10 ruang keluaran SDR yang digerbangi (`manifest.outputColorSpaces`). */
export const OUTPUT_COLOR_SPACES: readonly ChoiceOption[] = [
  'sRGB', 'Display P3', 'Adobe RGB (1998)', 'ProPhoto RGB', 'DCI-P3', 'P3-D65 Gamma 2.6',
  'Linear Rec.2020', 'Linear P3-D65', 'ACEScg', 'ACES2065-1',
].map((label) => ({ value: label, label }));

/**
 * Label input yang decode CCTF-nya tidak punya oracle (`INPUT_DECODE_WITHOUT_ORACLE`
 * di `params/plan.ts`, dijaga sama oleh test). Untuk label ini decode dipaksa mati.
 */
export const DECODE_WITHOUT_ORACLE: readonly string[] = [
  'Canon Log2 CinemaGamut D55',
  'Canon Log3 CinemaGamut D55',
  'Linear Rec.709',
  'P3-D65 Gamma 2.2',
  'Rec.709 Gamma 2.2',
  'Rec.709 Gamma 2.4',
];

export const PROCESS_MODES: readonly ChoiceOption[] = [
  { value: 'printSimulation', label: 'Print' },
  { value: 'scanNegative', label: 'Scan' },
];

export const DIFFUSION_FAMILIES: readonly ChoiceOption<DiffusionFilterFamily>[] = [
  { value: 'glimmerglass', label: 'Glimmerglass' },
  { value: 'black_pro_mist', label: 'Black Pro-Mist' },
  { value: 'pro_mist', label: 'Pro-Mist' },
  { value: 'cinebloom', label: 'CineBloom' },
];

/**
 * "Camera Raw" (ekstensi DICHROIC, di luar spektrafilm): develop kamera
 * sebelum film. Rentang = `CAMERA_LIMITS` (`host/cameraDevelop.ts`).
 */
const LENS_NOTE = 'Beyond spektrafilm.';

export const GROUPS: readonly ToolGroup[] = [
  {
    id: 'camera',
    label: 'Camera',
    icon: 'camera',
    tools: [
      { kind: 'slider', id: 'cameraWhiteBalanceK', field: 'cameraWhiteBalanceK', section: 'White Balance', relativeCenter: 5500, label: 'Temp', title: 'Temperature', icon: 'temperature', min: 2000, max: 12000, step: 50, digits: 0, note: 'Cooler ← → warmer. Relative to the decoded white balance.' },
      { kind: 'slider', id: 'cameraTint', field: 'cameraTint', section: 'White Balance', relativeCenter: 0, label: 'Tint', title: 'Tint', icon: 'tint', min: -1, max: 1, step: 0.01, digits: 0, note: 'Green ← → magenta.' },
      { kind: 'slider', id: 'cameraExposureEv', field: 'cameraExposureEv', section: 'Light', label: 'Exposure', title: 'Exposure', icon: 'exposure', min: -5, max: 5, step: 0.05, digits: 2, unit: ' EV', note: 'Linear exposure before film. +1 EV doubles the light.' },
      { kind: 'slider', id: 'cameraContrast', field: 'cameraContrast', section: 'Light', relativeCenter: 0, label: 'Contrast', title: 'Contrast', icon: 'contrast', min: -0.75, max: 0.75, step: 0.01, digits: 0, note: 'Less ← → more contrast around the scene midtone.' },
      { kind: 'slider', id: 'cameraHighlights', field: 'cameraHighlights', section: 'Light', relativeCenter: 0, label: 'Highlights', title: 'Highlights', icon: 'highlights', min: -1.5, max: 1.5, step: 0.05, digits: 0, note: 'Darkens or lifts bright tones; cannot restore clipped sensor data.' },
      { kind: 'slider', id: 'cameraShadows', field: 'cameraShadows', section: 'Light', relativeCenter: 0, label: 'Shadows', title: 'Shadows', icon: 'shadows', min: -1.5, max: 1.5, step: 0.05, digits: 0, note: 'Deepens or opens dark tones.' },
      { kind: 'slider', id: 'cameraWhites', field: 'cameraWhites', section: 'Light', relativeCenter: 0, label: 'Whites', title: 'Whites', icon: 'whites', min: -2, max: 2, step: 0.05, digits: 0, note: 'Adjusts the brightest end of the tonal range.' },
      { kind: 'slider', id: 'cameraBlacks', field: 'cameraBlacks', section: 'Light', relativeCenter: 0, label: 'Blacks', title: 'Blacks', icon: 'blacks', min: -2, max: 2, step: 0.05, digits: 0, note: 'Adjusts the darkest end; true black stays black.' },
      { kind: 'slider', id: 'cameraSaturation', field: 'cameraSaturation', section: 'Color', relativeCenter: 1, label: 'Saturation', title: 'Saturation', icon: 'saturation', min: 0, max: 2, step: 0.01, digits: 0, note: 'Color intensity before film, preserving luminance.' },
    ],
  },
  {
    id: 'lens',
    label: 'Lens',
    icon: 'lens',
    tools: [
      { kind: 'lens', id: 'lensBlur', field: 'lensBlurEnabled', label: 'Lens', title: 'Lens Blur', icon: 'lens', note: `Defocus like a real lens, from a depth map estimated on this device. Choose “Pick Focus”, then hold and drag over the subject. ${LENS_NOTE}` },
      { kind: 'slider', id: 'lensFocusDistanceM', field: 'lensFocusDistanceM', requires: 'lensBlurEnabled', scale: 'log10', label: 'Focus', title: 'Focus Distance', icon: 'focus', min: LENS_LIMITS.focusDistanceM.min, max: LENS_LIMITS.focusDistanceM.max, step: 0.005, digits: 2, unit: ' m', note: 'How far the focused subject was from the camera. With the aperture and focal length, it sets how quickly the background falls out of focus.' },
      { kind: 'stepper', id: 'lensFNumber', field: 'lensFNumber', requires: 'lensBlurEnabled', label: 'Aperture', title: 'Aperture', icon: 'aperture', min: LENS_LIMITS.fNumber.min, max: LENS_LIMITS.fNumber.max, step: 1, values: F_STOPS },
      { kind: 'slider', id: 'lensFocalLengthMm', field: 'lensFocalLengthMm', requires: 'lensBlurEnabled', scale: 'log2', zeroAs: 'normalFocal', label: 'Focal Length', title: 'Focal Length', icon: 'focalLength', min: LENS_LIMITS.focalLengthMm.min, max: LENS_LIMITS.focalLengthMm.max, step: 0.01, digits: 0, unit: ' mm', note: 'Longer lenses blur the background more at the same aperture. Normal matches the film format.' },
      { kind: 'slider', id: 'lensNearSharpM', field: 'lensNearSharpM', requires: 'lensBlurEnabled', scale: 'log10', zeroAs: 'max', maxField: 'lensFocusDistanceM', label: 'Keep Sharp', title: 'Keep Sharp From', icon: 'nearSharp', min: LENS_LIMITS.nearSharpM.min, max: LENS_LIMITS.focusDistanceM.max, step: 0.005, digits: 2, unit: ' m', note: 'Keeps everything from this distance to the focused subject sharp, for foregrounds that should stay crisp.' },
      { kind: 'slider', id: 'lensForeground', field: 'lensForeground', requires: 'lensBlurEnabled', label: 'Foreground', title: 'Foreground Blur', icon: 'foreground', min: 0, max: 1, step: 0.05, digits: 2, note: 'How much the things in front of the subject blur. 1 is the lens itself; 0 keeps the foreground sharp.' },
      { kind: 'stepper', id: 'lensBlades', field: 'lensBlades', requires: 'lensBlurEnabled', label: 'Blades', title: 'Aperture Blades', icon: 'blades', min: 0, max: 9, step: 1, values: [0, 5, 6, 7, 8, 9] },
      { kind: 'slider', id: 'lensBladeCurvature', field: 'lensBladeCurvature', requires: 'lensBlurEnabled', label: 'Curvature', title: 'Blade Curvature', icon: 'curvature', min: 0, max: 1, step: 0.05, digits: 2, note: 'Straight blades draw polygons in out-of-focus highlights; curved blades round them off.' },
      { kind: 'slider', id: 'lensCatEye', field: 'lensCatEye', requires: 'lensBlurEnabled', label: 'Cat’s Eye', title: 'Cat’s Eye', icon: 'catEye', min: 0, max: 1, step: 0.05, digits: 2, note: 'Vignetting inside the lens clips highlights toward the corners into lemon shapes.' },
    ],
  },
  {
    id: 'film',
    label: 'Film',
    icon: 'format',
    tools: [
      { kind: 'slider', id: 'printExposureEv', field: 'printExposureEv', invert: true, mode: 'print', label: 'Exposure', title: 'Exposure', icon: 'exposure', min: -2, max: 2, step: 0.1, digits: 1, unit: ' EV', note: 'Brightness of the print, like printing lighter or darker in the darkroom.' },
      { kind: 'slider', id: 'scanExposureEv', field: 'filmExposureEv', mode: 'scan', label: 'Exposure', title: 'Exposure', icon: 'exposure', min: -3, max: 3, step: 0.1, digits: 1, unit: ' EV', note: 'Exposure of the film itself. Scanning has no print step, so this sets the brightness directly.' },
      { kind: 'toggle', id: 'autoExposure', field: 'autoExposure', label: 'Auto', title: 'Auto Exposure', icon: 'auto', note: 'Meters the scene like a camera and re-exposes the film. Best for RAW and linear files; phone photos are already exposed.' },
      { kind: 'slider', id: 'filmExposureEv', field: 'filmExposureEv', mode: 'print', label: 'Negative', title: 'Negative Exposure', icon: 'negative', min: -3, max: 3, step: 0.1, digits: 1, unit: ' EV', note: 'Over- or underexpose the negative. The print is re-timed to match, so this changes density, color and grain more than brightness.' },
      { kind: 'stepper', id: 'filmPushPullStops', field: 'filmPushPullStops', label: 'Push/Pull', title: 'Push / Pull', icon: 'pushPull', min: -2, max: 2, step: 0.5 },
      { kind: 'choice', id: 'filmFormat', field: 'filmFormat', label: 'Format', title: 'Film Format', icon: 'format', options: FILM_FORMATS, note: 'Smaller formats enlarge the grain and halation.' },
      { kind: 'choice', id: 'process', field: 'process', elsewhere: true, label: 'Process', title: 'Process', icon: 'process', options: PROCESS_MODES, note: 'Print enlarges the negative onto paper. Scan digitizes the film itself: slides come out positive, negatives as orange negatives.' },
    ],
  },
  {
    id: 'color',
    label: 'Color',
    icon: 'tint',
    tools: [
      { kind: 'slider', id: 'filterC', field: 'filterC', invert: true, mode: 'print', label: 'Cyan', title: 'Cyan', icon: 'dot', tint: '#3CD3FE', min: -50, max: 50, step: 1, digits: 0, note: 'Color balance of the print. + adds cyan, − adds red.' },
      { kind: 'slider', id: 'filterMShift', field: 'filterMShift', invert: true, mode: 'print', label: 'Magenta', title: 'Magenta', icon: 'dot', tint: '#DB34F2', min: -50, max: 50, step: 1, digits: 0, note: 'Color balance of the print. + adds magenta, − adds green.' },
      { kind: 'slider', id: 'filterYShift', field: 'filterYShift', invert: true, mode: 'print', label: 'Yellow', title: 'Yellow', icon: 'dot', tint: '#FFD600', min: -50, max: 50, step: 1, digits: 0, note: 'Color balance of the print. + adds yellow, − adds blue.' },
      { kind: 'choice', id: 'inputColorSpace', field: 'inputColorSpace', label: 'Input', title: 'Input Color Space', icon: 'input', options: INPUT_COLOR_SPACES },
      { kind: 'toggle', id: 'inputCctfDecoding', field: 'inputCctfDecoding', label: 'Decode', title: 'Decode Transfer Curve', icon: 'decode', note: 'Linearizes encoded input (like a JPEG) before exposing the film. Leave off for linear or RAW files.' },
      { kind: 'choice', id: 'outputColorSpace', field: 'outputColorSpace', label: 'Output', title: 'Output Color Space', icon: 'output', options: OUTPUT_COLOR_SPACES },
    ],
  },
  {
    id: 'darkroom',
    label: 'Develop',
    icon: 'couplers',
    tools: [
      { kind: 'slider', id: 'dirCouplersAmount', field: 'dirCouplersAmount', enabledBy: 'dirCouplersEnabled', label: 'Couplers', title: 'DIR Couplers', icon: 'couplers', min: 0, max: 1.4, step: 0.05, digits: 2, note: 'Development inhibitors built into the film. They lift color saturation and edge contrast; 1.00 is the film as designed.' },
      { kind: 'slider', id: 'dirCouplersInhibitionInterlayer', field: 'dirCouplersInhibitionInterlayer', label: 'Interlayer', title: 'Interlayer Effect', icon: 'layers', min: 0, max: 1, step: 0.05, digits: 2, note: 'How much each color layer holds back the others. Lower it for softer, less saturated color.' },
      { kind: 'slider', id: 'dirCouplersInhibitionSameLayer', field: 'dirCouplersInhibitionSameLayer', label: 'Same Layer', title: 'Same-Layer Effect', icon: 'edge', min: 0, max: 1, step: 0.05, digits: 2, note: 'How much each layer holds back itself: tonal contrast and edge sharpness.' },
      { kind: 'slider', id: 'dirCouplersDiffusionUm', field: 'dirCouplersDiffusionUm', label: 'Spread', title: 'Inhibitor Spread', icon: 'spread', min: 0, max: 60, step: 1, digits: 0, unit: ' µm', note: 'How far the inhibitors travel in the emulsion. Wider gives broader edge effects.' },
      { kind: 'slider', id: 'preflashExposure', field: 'preflashExposure', mode: 'print', label: 'Preflash', title: 'Preflash', icon: 'flash', min: 0, max: 1, step: 0.01, digits: 2, note: 'A faint, even exposure of the paper before printing. Opens up the shadows and lowers print contrast.' },
      { kind: 'slider', id: 'preflashMFilterShift', field: 'preflashMFilterShift', invert: true, mode: 'print', label: 'Flash Magenta', title: 'Preflash Magenta', icon: 'dot', tint: '#DB34F2', min: -60, max: 60, step: 1, digits: 0, note: 'Tint of the preflash light. + adds magenta to the shadows, − adds green.' },
      { kind: 'slider', id: 'preflashYFilterShift', field: 'preflashYFilterShift', invert: true, mode: 'print', label: 'Flash Yellow', title: 'Preflash Yellow', icon: 'dot', tint: '#FFD600', min: -60, max: 60, step: 1, digits: 0, note: 'Tint of the preflash light. + adds yellow to the shadows, − adds blue.' },
    ],
  },
  {
    id: 'texture',
    label: 'Texture',
    icon: 'grain',
    tools: [
      { kind: 'slider', id: 'halationAmount', field: 'halationAmount', enabledBy: 'halationEnabled', label: 'Halation', title: 'Halation', icon: 'halation', min: 0, max: 2.5, step: 0.05, digits: 2 },
      { kind: 'slider', id: 'grainAmount', field: 'grainAmount', enabledBy: 'grainEnabled', label: 'Grain', title: 'Grain', icon: 'grain', min: 0, max: 2, step: 0.05, digits: 2 },
      { kind: 'stepper', id: 'grainSeed', field: 'grainSeed', label: 'Seed', title: 'Grain Seed', icon: 'seed', min: 1, max: 9999, step: 1 },
      { kind: 'slider', id: 'glarePercent', field: 'glarePercent', enabledBy: 'glareEnabled', mode: 'print', label: 'Glare', title: 'Scanner Glare', icon: 'glare', min: 0, max: 0.2, step: 0.005, digits: 3 },
      { kind: 'slider', id: 'scannerUnsharpAmount', field: 'scannerUnsharpAmount', label: 'Sharpen', title: 'Scanner Sharpening', icon: 'sharpen', min: 0, max: 2.5, step: 0.05, digits: 2 },
      { kind: 'diffusion', id: 'cameraDiffusion', enabledBy: 'cameraDiffusionEnabled', familyField: 'cameraDiffusionFamily', strengthField: 'cameraDiffusionStrength', label: 'Lens Filter', title: 'Lens Diffusion Filter', icon: 'diffusion', note: 'A mist or bloom filter on the camera lens: highlights glow and spread before they reach the film.' },
      { kind: 'diffusion', id: 'printDiffusion', enabledBy: 'printDiffusionEnabled', familyField: 'printDiffusionFamily', strengthField: 'printDiffusionStrength', mode: 'print', label: 'Enlarger', title: 'Enlarger Diffusion Filter', icon: 'enlargerFilter', note: 'The same filter under the enlarger lens: shadows bleed softly into the print instead of highlights.' },
    ],
  },
];

/** Stop filter komersial (0, 1/8 .. 2) untuk slider strength difusi. */
export const DIFFUSION_STRENGTH = { min: 0, max: 2, step: 0.125 } as const;

export function isScanMode(params: Pick<RenderParams, 'process'>): boolean {
  return params.process === 'scanNegative';
}

/** Alat grup yang berlaku untuk mode proses saat ini (Fase 2D), tanpa alat `elsewhere`. */
export function visibleTools(group: ToolGroup, params: Pick<RenderParams, 'process'>): Tool[] {
  const mode = isScanMode(params) ? 'scan' : 'print';
  return group.tools.filter((tool) => !tool.elsewhere && (!tool.mode || tool.mode === mode));
}

/** Stop filter sebagai pecahan yang lazim di label filter: 1/8, 1/4, 1/2, 1, 2. */
export function formatStops(value: number): string {
  if (value <= 0) return '0';
  const fractions: Array<[number, string]> = [[0.125, '⅛'], [0.25, '¼'], [0.375, '⅜'], [0.5, '½'], [0.625, '⅝'], [0.75, '¾'], [0.875, '⅞']];
  const whole = Math.floor(value);
  const rest = value - whole;
  const frac = fractions.find(([f]) => Math.abs(f - rest) < 1e-6)?.[1] ?? '';
  if (whole === 0) return frac || formatNumber(value, 3, false);
  return `${whole}${frac}`;
}

export function findTool(id: string): Tool {
  for (const group of GROUPS) {
    const tool = group.tools.find((t) => t.id === id);
    if (tool) return tool;
  }
  throw new Error(`Unknown tool: ${id}`);
}

/** Minus tipografis, tanda plus untuk nilai bipolar positif. */
export function formatNumber(value: number, digits: number, signed: boolean): string {
  const rounded = Number(value.toFixed(digits));
  const text = Math.abs(rounded).toFixed(digits);
  if (rounded < 0) return `−${text}`;
  if (signed && rounded > 0) return `+${text}`;
  return text;
}

export function isBipolar(tool: SliderTool | StepperTool): boolean {
  return tool.min < 0 || (tool.kind === 'slider' && tool.relativeCenter !== undefined);
}

export function formatPushPull(stops: number): string {
  if (stops === 0) return 'Box speed';
  const verb = stops > 0 ? 'Push' : 'Pull';
  const n = Math.abs(stops);
  return `${verb} ${formatNumber(n, n % 1 === 0 ? 0 : 1, false)} ${n === 1 ? 'stop' : 'stops'}`;
}

/** Nilai slider di ruang UI (lihat `SliderTool.invert`). */
export function sliderValue(tool: SliderTool, params: RenderParams): number {
  const v = params[tool.field];
  if (tool.relativeCenter !== undefined) {
    const centre = tool.relativeCenter;
    return 100 * (v - centre) / (v < centre ? centre - tool.min : tool.max - centre);
  }
  return tool.invert ? (v === 0 ? 0 : -v) : v;
}

/** Patch field dari nilai slider di ruang UI. */
export function sliderPatch(tool: SliderTool, value: number): Partial<RenderParams> {
  if (tool.relativeCenter !== undefined) {
    const centre = tool.relativeCenter;
    const v = Math.min(100, Math.max(-100, value));
    return { [tool.field]: centre + v / 100 * (v < 0 ? centre - tool.min : tool.max - centre) };
  }
  return { [tool.field]: tool.invert ? (value === 0 ? 0 : -value) : value };
}

/** Teks nilai di readout. */
export function valueText(tool: Tool, params: RenderParams): string {
  switch (tool.kind) {
    case 'slider': {
      if (tool.enabledBy && !params[tool.enabledBy]) return 'Off';
      const v = params[tool.field];
      if (tool.zeroAs === 'normalFocal' && v === 0) return `${NORMAL_FOCAL_MM[params.filmFormat]} mm · Normal`;
      if (tool.zeroAs === 'max' && v === 0) return 'At focus';
      if (tool.scale) return `${formatScaled(v)}${tool.unit ?? ''}`;
      return formatNumber(sliderValue(tool, params), tool.digits, isBipolar(tool)) + (tool.unit ?? '');
    }
    case 'stepper':
      if (tool.values) return stepperText(tool, params);
      return tool.field === 'filmPushPullStops' ? formatPushPull(params.filmPushPullStops) : String(params[tool.field]);
    case 'toggle':
      return params[tool.field] ? 'On' : 'Off';
    case 'choice':
      return tool.options.find((o) => o.value === params[tool.field])?.label ?? String(params[tool.field]);
    case 'diffusion': {
      if (!params[tool.enabledBy] || params[tool.strengthField] <= 0) return 'Off';
      return formatStops(params[tool.strengthField]);
    }
    case 'lens':
      return params.lensBlurEnabled ? 'On' : 'Off';
    case 'locked':
      return '';
  }
}

export function isModified(tool: Tool, params: RenderParams, defaults: RenderParams): boolean {
  switch (tool.kind) {
    case 'slider':
      return params[tool.field] !== defaults[tool.field] || (tool.enabledBy !== undefined && params[tool.enabledBy] !== defaults[tool.enabledBy]);
    case 'stepper':
    case 'toggle':
    case 'choice':
    case 'lens':
      return params[tool.field] !== defaults[tool.field];
    case 'diffusion':
      return (
        params[tool.enabledBy] !== defaults[tool.enabledBy] ||
        params[tool.familyField] !== defaults[tool.familyField] ||
        params[tool.strengthField] !== defaults[tool.strengthField]
      );
    case 'locked':
      return false;
  }
}

export function resetPatch(tool: Tool, defaults: RenderParams): Partial<RenderParams> {
  switch (tool.kind) {
    case 'slider':
      return tool.enabledBy
        ? { [tool.field]: defaults[tool.field], [tool.enabledBy]: defaults[tool.enabledBy] }
        : { [tool.field]: defaults[tool.field] };
    case 'stepper':
    case 'toggle':
    case 'choice':
    case 'lens':
      return { [tool.field]: defaults[tool.field] };
    case 'diffusion':
      return {
        [tool.enabledBy]: defaults[tool.enabledBy],
        [tool.familyField]: defaults[tool.familyField],
        [tool.strengthField]: defaults[tool.strengthField],
      };
    case 'locked':
      return {};
  }
}

export function decodeAllowed(inputColorSpace: string): boolean {
  return !DECODE_WITHOUT_ORACLE.includes(inputColorSpace);
}

/** Film negatif bawaan saat kembali ke mode print dari slide film. */
export const DEFAULT_NEGATIVE = 'kodak_portra_400';

/**
 * Patch pilihan. Input tanpa oracle decode ikut mematikan decode. Kembali ke
 * mode print dengan slide film terpilih mengganti film ke negatif bawaan
 * (film reversal hanya bisa di-scan).
 */
export function choicePatch(tool: ChoiceTool, value: string, params?: Pick<RenderParams, 'film'>): Partial<RenderParams> {
  if (tool.field === 'inputColorSpace' && !decodeAllowed(value)) return { inputColorSpace: value, inputCctfDecoding: false };
  if (tool.field === 'process' && value === 'printSimulation' && params && isSlideFilm(params.film)) {
    return { process: 'printSimulation', film: DEFAULT_NEGATIVE };
  }
  return { [tool.field]: value } as Partial<RenderParams>;
}

/**
 * Patch memilih stok (Fase 2D): slide film memindah proses ke scan; kembali
 * ke negatif dari slide film memindah ke print. Negatif yang dipilih saat
 * sudah scan tetap di-scan (scan negatif disengaja lewat alat Process).
 */
export function stockPatch(kind: 'film' | 'paper', id: string, params: Pick<RenderParams, 'film' | 'process'>): Partial<RenderParams> {
  if (kind === 'paper') return { paper: id };
  if (isSlideFilm(id)) return { film: id, process: 'scanNegative' };
  if (isSlideFilm(params.film) && params.process === 'scanNegative') return { film: id, process: 'printSimulation' };
  return { film: id };
}

/** Nilai slider tanpa galat pembulatan biner (0.1 + 0.2), dijepit ke rentang. */
export function snap(value: number, tool: { min: number; max: number; step: number }): number {
  const clamped = Math.min(tool.max, Math.max(tool.min, value));
  const steps = Math.round((clamped - tool.min) / tool.step);
  const decimals = Math.max(0, Math.ceil(-Math.log10(tool.step)) + 1);
  return Number((tool.min + steps * tool.step).toFixed(decimals));
}

/**
 * Saran parameter milik berkas dari decoder (`DecodedImage`, 2B) setelah 2C
 * memverifikasi colour space input: JPEG/PNG/TIFF integer -> sRGB dengan
 * decode; TIFF float, EXR, RAW -> linear tanpa decode.
 *
 * Auto exposure hanya untuk berkas linear (RAW/EXR/float), yang eksposurnya
 * belum ditetapkan. Foto ter-encode (JPEG dari HP) sudah diekspos kamera;
 * mengukurnya ulang menggeser terang seluruh foto (terukur: bagan warna
 * rata-rata 125 -> 86 dari 255), yang terbaca sebagai "film membuat foto
 * gelap".
 */
export function suggestedInput(image: { suggestedColorSpace: string; encoding: 'encoded' | 'linear' }): Pick<RenderParams, 'inputColorSpace' | 'inputCctfDecoding' | 'autoExposure'> {
  const known = INPUT_COLOR_SPACES.some((o) => o.value === image.suggestedColorSpace);
  const inputColorSpace = known ? image.suggestedColorSpace : 'sRGB';
  return {
    inputColorSpace,
    inputCctfDecoding: image.encoding === 'encoded' && decodeAllowed(inputColorSpace),
    autoExposure: image.encoding === 'linear',
  };
}

// ---------------------------------------------------------------------------
// Posisi slider (linear atau log) dan stepper berdaftar -- grup Lens.

/** Nilai berskala log dengan pembulatan yang dibaca manusia: 0,46 / 7,3 / 24. */
function roundScaled(v: number): number {
  if (v < 1) return Number(v.toFixed(2));
  if (v < 10) return Number(v.toFixed(1));
  return Math.round(v);
}

function formatScaled(v: number): string {
  return String(roundScaled(v));
}

function toPosition(tool: SliderTool, v: number): number {
  if (tool.scale === 'log10') return Math.log10(v);
  if (tool.scale === 'log2') return Math.log2(v);
  return v;
}

function fromPosition(tool: SliderTool, p: number): number {
  if (tool.scale === 'log10') return 10 ** p;
  if (tool.scale === 'log2') return 2 ** p;
  return p;
}

function dynamicMax(tool: SliderTool, params: RenderParams): number {
  return tool.maxField ? Math.min(tool.max, params[tool.maxField]) : tool.max;
}

/** Rentang slider dalam ruang posisi (log bila `scale`). */
export function sliderRange(tool: SliderTool, params: RenderParams): { min: number; max: number; step: number } {
  if (tool.relativeCenter !== undefined) return { min: -100, max: 100, step: 1 };
  if (!tool.scale) return { min: tool.min, max: tool.max, step: tool.step };
  const min = toPosition(tool, tool.min);
  const max = toPosition(tool, Math.max(dynamicMax(tool, params), tool.min));
  return { min, max, step: tool.step };
}

/** Posisi thumb untuk nilai field saat ini. */
export function sliderPosition(tool: SliderTool, params: RenderParams): number {
  if (!tool.scale) return sliderValue(tool, params);
  const v = params[tool.field];
  if (v === 0 && tool.zeroAs === 'normalFocal') return toPosition(tool, NORMAL_FOCAL_MM[params.filmFormat]);
  if (v === 0 && tool.zeroAs === 'max') return sliderRange(tool, params).max;
  return toPosition(tool, Math.min(Math.max(v, tool.min), dynamicMax(tool, params)));
}

/** Patch field dari posisi thumb. */
export function positionPatch(tool: SliderTool, position: number, params: RenderParams): Partial<RenderParams> {
  if (!tool.scale) return sliderPatch(tool, position);
  const range = sliderRange(tool, params);
  if (tool.zeroAs === 'max' && position >= range.max - 1e-9) return { [tool.field]: 0 };
  // Ujung dipaku ke batas persis: 10^log10(x) tidak selalu kembali ke x.
  let v: number;
  if (position <= range.min + 1e-9) v = tool.min;
  else if (position >= range.max - 1e-9) v = dynamicMax(tool, params);
  else v = roundScaled(fromPosition(tool, position));
  return { [tool.field]: Math.min(Math.max(v, tool.min), dynamicMax(tool, params)) };
}

/** Langkah stepper (`dir` = -1/+1); patch kosong di ujung. */
export function stepperPatch(tool: StepperTool, params: RenderParams, dir: -1 | 1): Partial<RenderParams> {
  const v = params[tool.field];
  if (tool.values) {
    const list = tool.values;
    // Nilai di luar daftar (mis. f/1.7 lama) melangkah dari tetangga terdekatnya.
    let i = list.findIndex((x) => Math.abs(x - v) < 1e-9);
    if (i < 0) i = list.reduce((best, x, k) => (Math.abs(x - v) < Math.abs(list[best]! - v) ? k : best), 0);
    const j = i + dir;
    return j < 0 || j >= list.length ? {} : { [tool.field]: list[j]! };
  }
  const next = Math.min(tool.max, Math.max(tool.min, v + dir * tool.step));
  return next === v ? {} : { [tool.field]: next };
}

export function stepperAtEnd(tool: StepperTool, params: RenderParams, dir: -1 | 1): boolean {
  return Object.keys(stepperPatch(tool, params, dir)).length === 0;
}

/** Teks stepper berdaftar: f-stop dan bilah iris. */
export function stepperText(tool: StepperTool, params: RenderParams): string {
  const v = params[tool.field];
  if (tool.field === 'lensFNumber') return `f/${v}`;
  if (tool.field === 'lensBlades') return v === 0 ? 'Round' : `${v} blades`;
  return String(v);
}

/**
 * Patch yang dijaga tetap sah terhadap validasi `plan.ts`: batas tajam dekat
 * harus 0 atau <= jarak fokus, jadi menurunkan jarak fokus di bawahnya
 * mengembalikannya ke bidang fokus dalam patch yang sama.
 */
export function normalizePatch(params: RenderParams, patch: Partial<RenderParams>): Partial<RenderParams> {
  const focus = patch.lensFocusDistanceM;
  if (focus === undefined) return patch;
  const near = patch.lensNearSharpM ?? params.lensNearSharpM;
  return near > focus ? { ...patch, lensNearSharpM: 0 } : patch;
}
