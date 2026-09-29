/**
 * Alat penyuntingan: pemetaan dari kontrol UI ke field `RenderParams`,
 * rentang, dan format nilai. Rentang dibatasi ke wilayah yang digerbangi
 * parity Fase 2C (`tools/param_cases.py`, spec Fase 2 §6.1), misalnya unsharp
 * berhenti di 2,5 karena di atasnya derau f32 melewati ambang.
 */
import type { FilmFormat, RenderParams } from '../../params/renderParams';

export type GroupId = 'film' | 'color' | 'texture';

type NumericField = {
  [K in keyof RenderParams]: RenderParams[K] extends number ? K : never;
}[keyof RenderParams];
type BooleanField = {
  [K in keyof RenderParams]: RenderParams[K] extends boolean ? K : never;
}[keyof RenderParams];

export type IconName =
  | 'exposure' | 'auto' | 'print' | 'negative' | 'pushPull' | 'format'
  | 'dot' | 'input' | 'decode' | 'output'
  | 'halation' | 'grain' | 'seed' | 'glare' | 'sharpen' | 'diffusion';

interface ToolBase {
  id: string;
  label: string;
  title: string;
  icon: IconName;
  /** Warna ikon identitas (filter C/M/Y). */
  tint?: string;
}

export interface SliderTool extends ToolBase {
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
}

export interface ChoiceOption<V extends string = string> {
  value: V;
  label: string;
  group?: string;
}

export interface ChoiceTool extends ToolBase {
  kind: 'choice';
  field: 'filmFormat' | 'inputColorSpace' | 'outputColorSpace';
  options: readonly ChoiceOption[];
  note?: string;
}

export interface LockedTool extends ToolBase {
  kind: 'locked';
  note: string;
}

export type Tool = SliderTool | ToggleTool | StepperTool | ChoiceTool | LockedTool;

export interface ToolGroup {
  id: GroupId;
  label: string;
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

export const GROUPS: readonly ToolGroup[] = [
  {
    id: 'film',
    label: 'Film',
    tools: [
      { kind: 'slider', id: 'printExposureEv', field: 'printExposureEv', invert: true, label: 'Exposure', title: 'Exposure', icon: 'exposure', min: -2, max: 2, step: 0.1, digits: 1, unit: ' EV', note: 'Brightness of the print, like printing lighter or darker in the darkroom.' },
      { kind: 'toggle', id: 'autoExposure', field: 'autoExposure', label: 'Auto', title: 'Auto Exposure', icon: 'auto', note: 'Meters the scene like a camera and re-exposes the negative. Best for RAW and linear files; phone photos are already exposed.' },
      { kind: 'slider', id: 'filmExposureEv', field: 'filmExposureEv', label: 'Negative', title: 'Negative Exposure', icon: 'negative', min: -3, max: 3, step: 0.1, digits: 1, unit: ' EV', note: 'Over- or underexpose the negative. The print is re-timed to match, so this changes density, colour and grain more than brightness.' },
      { kind: 'stepper', id: 'filmPushPullStops', field: 'filmPushPullStops', label: 'Push/Pull', title: 'Push / Pull', icon: 'pushPull', min: -2, max: 2, step: 0.5 },
      { kind: 'choice', id: 'filmFormat', field: 'filmFormat', label: 'Format', title: 'Film Format', icon: 'format', options: FILM_FORMATS, note: 'Smaller formats enlarge the grain and halation.' },
    ],
  },
  {
    id: 'color',
    label: 'Color',
    tools: [
      { kind: 'slider', id: 'filterC', field: 'filterC', invert: true, label: 'Cyan', title: 'Cyan', icon: 'dot', tint: '#3CD3FE', min: -50, max: 50, step: 1, digits: 0, note: 'Color balance of the print. + adds cyan, − adds red.' },
      { kind: 'slider', id: 'filterMShift', field: 'filterMShift', invert: true, label: 'Magenta', title: 'Magenta', icon: 'dot', tint: '#DB34F2', min: -50, max: 50, step: 1, digits: 0, note: 'Color balance of the print. + adds magenta, − adds green.' },
      { kind: 'slider', id: 'filterYShift', field: 'filterYShift', invert: true, label: 'Yellow', title: 'Yellow', icon: 'dot', tint: '#FFD600', min: -50, max: 50, step: 1, digits: 0, note: 'Color balance of the print. + adds yellow, − adds blue.' },
      { kind: 'choice', id: 'inputColorSpace', field: 'inputColorSpace', label: 'Input', title: 'Input Color Space', icon: 'input', options: INPUT_COLOR_SPACES },
      { kind: 'toggle', id: 'inputCctfDecoding', field: 'inputCctfDecoding', label: 'Decode', title: 'Decode Transfer Curve', icon: 'decode', note: 'Linearizes encoded input (like a JPEG) before exposing the film. Leave off for linear or RAW files.' },
      { kind: 'choice', id: 'outputColorSpace', field: 'outputColorSpace', label: 'Output', title: 'Output Color Space', icon: 'output', options: OUTPUT_COLOR_SPACES },
    ],
  },
  {
    id: 'texture',
    label: 'Texture',
    tools: [
      { kind: 'slider', id: 'halationAmount', field: 'halationAmount', enabledBy: 'halationEnabled', label: 'Halation', title: 'Halation', icon: 'halation', min: 0, max: 2.5, step: 0.05, digits: 2 },
      { kind: 'slider', id: 'grainAmount', field: 'grainAmount', enabledBy: 'grainEnabled', label: 'Grain', title: 'Grain', icon: 'grain', min: 0, max: 2, step: 0.05, digits: 2 },
      { kind: 'stepper', id: 'grainSeed', field: 'grainSeed', label: 'Seed', title: 'Grain Seed', icon: 'seed', min: 1, max: 9999, step: 1 },
      { kind: 'slider', id: 'glarePercent', field: 'glarePercent', enabledBy: 'glareEnabled', label: 'Glare', title: 'Scanner Glare', icon: 'glare', min: 0, max: 0.2, step: 0.005, digits: 3 },
      { kind: 'slider', id: 'scannerUnsharpAmount', field: 'scannerUnsharpAmount', label: 'Sharpen', title: 'Scanner Sharpening', icon: 'sharpen', min: 0, max: 2.5, step: 0.05, digits: 2 },
      { kind: 'locked', id: 'diffusion', label: 'Diffusion', title: 'Diffusion Filter', icon: 'diffusion', note: 'Coming soon. Camera and enlarger diffusion need a GPU feature that isn’t ready yet.' },
    ],
  },
];

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
  return tool.min < 0;
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
  return tool.invert ? (v === 0 ? 0 : -v) : v;
}

/** Patch field dari nilai slider di ruang UI. */
export function sliderPatch(tool: SliderTool, value: number): Partial<RenderParams> {
  return { [tool.field]: tool.invert ? (value === 0 ? 0 : -value) : value };
}

/** Teks nilai di readout. */
export function valueText(tool: Tool, params: RenderParams): string {
  switch (tool.kind) {
    case 'slider':
      if (tool.enabledBy && !params[tool.enabledBy]) return 'Off';
      return formatNumber(sliderValue(tool, params), tool.digits, isBipolar(tool)) + (tool.unit ?? '');
    case 'stepper':
      return tool.field === 'filmPushPullStops' ? formatPushPull(params.filmPushPullStops) : String(params[tool.field]);
    case 'toggle':
      return params[tool.field] ? 'On' : 'Off';
    case 'choice':
      return tool.options.find((o) => o.value === params[tool.field])?.label ?? String(params[tool.field]);
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
      return params[tool.field] !== defaults[tool.field];
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
      return { [tool.field]: defaults[tool.field] };
    case 'locked':
      return {};
  }
}

export function decodeAllowed(inputColorSpace: string): boolean {
  return !DECODE_WITHOUT_ORACLE.includes(inputColorSpace);
}

/** Patch pilihan; input tanpa oracle decode ikut mematikan decode. */
export function choicePatch(tool: ChoiceTool, value: string): Partial<RenderParams> {
  if (tool.field === 'inputColorSpace' && !decodeAllowed(value)) return { inputColorSpace: value, inputCctfDecoding: false };
  return { [tool.field]: value } as Partial<RenderParams>;
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
