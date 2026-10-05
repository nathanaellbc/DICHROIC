/**
 * Vectorscope gaya DaVinci Resolve -- bagian numerik (bebas DOM, diuji di Node).
 *
 * Konvensi yang sama dengan Resolve (dan vectorscope siaran ITU-R BT.709):
 *  - Sinyal: R'G'B' ter-encode yang ditampilkan (frame pratinjau, sRGB atau
 *    Display P3), diubah ke Y'CbCr dengan koefisien Rec.709 -- yang dipakai
 *    Resolve untuk timeline Rec.709/sRGB/P3:
 *      Y' = 0.2126 R' + 0.7152 G' + 0.0722 B'
 *      Cb = (B' - Y') / 1.8556,   Cr = (R' - Y') / 1.5748   (masing-masing +-0.5)
 *  - Sumbu: Cb ke kanan, Cr ke atas. Lingkaran graticule = |C| 0.5 (batas satu
 *    kanal); target 100 % Rec.709: R/Cy 0.513, B/Yl 0.502, Mg/G 0.596 -- Mg dan
 *    G memang di luar lingkaran, jadi kanvas menyisakan ruang sampai |C| 0.6.
 *    Target 75 % di 3/4 jarak itu. Zoom 2x menggandakan skala.
 *  - Sudut target Rec.709 (dari +Cb, berlawanan jarum jam): R 102.9, Mg 49.7,
 *    B 354.8, Cy 282.9, G 229.7, Yl 174.8 derajat (BT.601 lama: 103/61/347/
 *    283/241/167 -- bukan yang dipakai Resolve untuk Rec.709).
 *  - Skin tone indicator: garis dari pusat pada 123 derajat (sumbu "I" NTSC),
 *    di antara merah dan kuning -- kulit manusia dari semua etnis jatuh di
 *    dekat garis ini karena hue-nya ditentukan hemoglobin + melanin; yang
 *    berbeda hanya saturasi (jarak dari pusat).
 */

export const REC709_LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 } as const;
/** 2 (1 - Kb), 2 (1 - Kr). */
export const CB_SCALE = 2 * (1 - REC709_LUMA.b);
export const CR_SCALE = 2 * (1 - REC709_LUMA.r);

/** Sudut garis skin tone (derajat dari +Cb, berlawanan jarum jam). */
export const SKIN_TONE_ANGLE_DEG = 123;

export function toCbCr(r: number, g: number, b: number): [number, number] {
  const y = REC709_LUMA.r * r + REC709_LUMA.g * g + REC709_LUMA.b * b;
  return [(b - y) / CB_SCALE, (r - y) / CR_SCALE];
}

export interface ScopeTarget {
  label: 'R' | 'Mg' | 'B' | 'Cy' | 'G' | 'Yl';
  /** Warna penanda (sRGB CSS). */
  color: string;
  cb: number;
  cr: number;
}

const PRIMARIES: ReadonlyArray<[ScopeTarget['label'], [number, number, number], string]> = [
  ['R', [1, 0, 0], '#ff453a'],
  ['Mg', [1, 0, 1], '#ff4fd8'],
  ['B', [0, 0, 1], '#4d7dff'],
  ['Cy', [0, 1, 1], '#3ee0ff'],
  ['G', [0, 1, 0], '#3ddc63'],
  ['Yl', [1, 1, 0], '#ffd23a'],
];

/** Target bar warna pada level `level` (0.75 atau 1). */
export function scopeTargets(level: 0.75 | 1): ScopeTarget[] {
  return PRIMARIES.map(([label, [r, g, b], color]) => {
    const [cb, cr] = toCbCr(r * level, g * level, b * level);
    return { label, color, cb, cr };
  });
}

export function angleDeg(cb: number, cr: number): number {
  const a = (Math.atan2(cr, cb) * 180) / Math.PI;
  return a < 0 ? a + 360 : a;
}

export interface ScopeTrace {
  size: number;
  /** Jumlah piksel per bin (size x size, baris atas = Cr positif). */
  density: Float32Array;
  /** Jumlah R', G', B' per bin (untuk mode colorize). */
  color: Float32Array;
  samples: number;
}

/**
 * Akumulasi Cb/Cr piksel RGBA8 ke kisi `size` x `size`. Skala: lingkaran
 * graticule (|C| = 0.5 / zoom) menyentuh `radiusPx` dari pusat. Piksel di luar
 * kisi dibuang (seperti scope yang terpotong saat zoom). Gambar besar
 * dicuplik merata sampai `maxSamples`. Jitter deterministik +-0.5 LSB
 * menghapus pola kisi kuantisasi 8-bit (Resolve membaca 10/12-bit).
 */
/** Rentang tonal vectorscope Resolve: semua, atau hanya Low/Mid/High (Y' sepertiga). */
export type ScopeRange = 'all' | 'low' | 'mid' | 'high';

export function inRange(y: number, range: ScopeRange): boolean {
  if (range === 'all') return true;
  if (range === 'low') return y < 1 / 3;
  if (range === 'mid') return y >= 1 / 3 && y < 2 / 3;
  return y >= 2 / 3;
}

export function accumulateScope(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  size: number,
  radiusPx: number,
  zoom: 1 | 2,
  maxSamples = 600_000,
  range: ScopeRange = 'all',
): ScopeTrace {
  const density = new Float32Array(size * size);
  const color = new Float32Array(size * size * 3);
  const n = width * height;
  const stride = Math.max(1, Math.round(Math.sqrt(n / maxSamples)));
  const scale = (radiusPx * zoom) / 0.5;
  const centre = size / 2;
  let samples = 0;
  let seed = 0x9e3779b9;
  const jitter = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296 - 0.5) / 255;
  };
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      const r = pixels[i]! / 255 + jitter();
      const g = pixels[i + 1]! / 255 + jitter();
      const b = pixels[i + 2]! / 255 + jitter();
      samples += 1;
      if (range !== 'all' && !inRange(REC709_LUMA.r * r + REC709_LUMA.g * g + REC709_LUMA.b * b, range)) continue;
      const [cb, cr] = toCbCr(r, g, b);
      const px = Math.floor(centre + cb * scale);
      const py = Math.floor(centre - cr * scale);
      if (px < 0 || py < 0 || px >= size || py >= size) continue;
      const k = py * size + px;
      density[k]! += 1;
      color[k * 3]! += r;
      color[k * 3 + 1]! += g;
      color[k * 3 + 2]! += b;
    }
  }
  return { size, density, color, samples };
}

/**
 * Warna palsu Colorize Resolve untuk satu posisi Cb/Cr: hue arah posisi itu
 * pada saturasi penuh, memudar ke putih di dekat pusat (saturasi rendah).
 * Jadi warna trace menunjukkan WARNA APA yang ada di posisi itu, seperti
 * vectorscope Resolve dengan Colorize.
 */
export function falseColor(cb: number, cr: number): [number, number, number] {
  const c = Math.hypot(cb, cr);
  if (c < 1e-6) return [1, 1, 1];
  const y = 0.5;
  const r = y + CR_SCALE * cr;
  const b = y + CB_SCALE * cb;
  const g = (y - REC709_LUMA.r * r - REC709_LUMA.b * b) / REC709_LUMA.g;
  const lo = Math.min(r, g, b);
  const hi = Math.max(r, g, b) - lo || 1;
  const hue = [(r - lo) / hi, (g - lo) / hi, (b - lo) / hi];
  const s = Math.min(1, c / 0.14);
  const mix = hue.map((h) => 1 - s * (1 - h));
  const m = Math.max(...mix);
  return [mix[0]! / m, mix[1]! / m, mix[2]! / m];
}

/**
 * Trace -> RGBA. Kecerahan logaritmik terhadap kepadatan (fosfor scope):
 * satu piksel terisolasi tetap terlihat, area datar luas tidak membakar
 * putih. `gain` = kecerahan scope. Colorize memakai warna palsu posisi
 * (`falseColor`), tanpa Colorize trace putih -- dua mode Resolve.
 * `scale` = px kanvas per satuan Cb/Cr (untuk memetakan bin ke posisi).
 */
export function shadeScope(trace: ScopeTrace, colorize: boolean, gain = 1, scale = trace.size): Uint8ClampedArray {
  const { size, density, samples } = trace;
  const out = new Uint8ClampedArray(size * size * 4);
  // Referensi: kepadatan bin bila semua sampel jatuh di ~1/400 luas kisi.
  const ref = Math.max(1, (samples / (size * size)) * 400);
  const norm = 1 / Math.log1p(ref);
  const centre = size / 2;
  for (let k = 0; k < size * size; k += 1) {
    const d = density[k]!;
    if (d <= 0) continue;
    const v = Math.min(1, Math.log1p(d * 6 * gain) * norm * 0.9 + 0.12);
    let r = 0.93;
    let g = 0.95;
    let b = 0.97;
    if (colorize) {
      const cb = ((k % size) + 0.5 - centre) / scale;
      const cr = (centre - Math.floor(k / size) - 0.5) / scale;
      [r, g, b] = falseColor(cb, cr);
    }
    out[k * 4] = r * 255;
    out[k * 4 + 1] = g * 255;
    out[k * 4 + 2] = b * 255;
    out[k * 4 + 3] = v * 255;
  }
  return out;
}

export type ScopeKind = 'vectorscope' | 'waveform' | 'parade';

export const SCOPE_KINDS: ReadonlyArray<{ value: ScopeKind; label: string; short: string }> = [
  { value: 'waveform', label: 'Waveform', short: 'Wave' },
  { value: 'parade', label: 'Parade', short: 'Parade' },
  { value: 'vectorscope', label: 'Vectorscope', short: 'Vector' },
];

/** Gaya graticule vectorscope Resolve ("Vectorscope Scale Style"). */
export type VectorStyle = 'standard' | 'simplified' | 'hueVectors' | 'off';
export type WaveMode = 'y' | 'rgb' | 'cbcr';
export type ParadeMode = 'rgb' | 'yrgb' | 'ycbcr';

export interface ScopePrefs {
  /** Mobile: overlay tampil; desktop: panel inspector terbuka. */
  open: boolean;
  kind: ScopeKind;
  // Vectorscope
  zoom: 1 | 2;
  skinTone: boolean;
  colorize: boolean;
  targets: 75 | 100;
  range: ScopeRange;
  style: VectorStyle;
  // Waveform / parade
  waveMode: WaveMode;
  /** Kanal R, G, B yang tampil di waveform mode RGB. */
  waveChannels: [boolean, boolean, boolean];
  paradeMode: ParadeMode;
  waveColorize: boolean;
  lowPass: boolean;
  extents: boolean;
}

/**
 * Bawaan seperti Resolve: Colorize menyala (vectorscope berwarna palsu,
 * waveform/parade berwarna kanal), graticule Standard dengan target 75 %.
 */
export const DEFAULT_SCOPE_PREFS: ScopePrefs = {
  open: false,
  kind: 'vectorscope',
  zoom: 1,
  skinTone: true,
  colorize: true,
  targets: 75,
  range: 'all',
  style: 'standard',
  waveMode: 'rgb',
  waveChannels: [true, true, true],
  paradeMode: 'rgb',
  waveColorize: true,
  lowPass: false,
  extents: false,
};
