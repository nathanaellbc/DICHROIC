import type { DecodedImage } from '../io/decoded';
import { TO_REC709, sourceToDisplay, srgbEncode } from '../io/display';

export const PATCH_SIZE = 512;

/**
 * Bagaimana nilai sumber dipetakan ke masukan LaMa (sRGB ter-encode 0..1) dan
 * kembali. Berlaku untuk semua colour space:
 *
 * - `encoded` (sRGB, Display P3, Adobe RGB, ProPhoto, ...): nilai yang sudah
 *   membawa kurva transfer diberikan apa adanya; hasil model kembali di ruang
 *   dan kurva yang sama. Tanpa konversi bolak-balik dan tanpa gamut terpotong.
 * - `linear` (RAW ACES2065-1, ACEScg, Rec.2020/P3/Rec.709 linear, EXR):
 *   matriks ke Rec.709 linear, dibagi `gain` (putih robust konteks, >= 1,
 *   supaya sorotan HDR tidak terpotong), lalu kurva sRGB. Hasil dibalik
 *   persis: sRGB -> linear, x `gain`, matriks invers ke primer sumber.
 */
export interface RemovalTransform {
  space: string;
  encoding: DecodedImage['encoding'];
  /** Primer sumber -> Rec.709 linear (baris-mayor), hanya untuk `linear`. */
  toModel?: number[];
  /** Invers `toModel`. */
  fromModel?: number[];
  gain: number;
}
export interface RemovalCrop { revision: number; x: number; y: number; width: number; height: number; rgb: Float32Array; mask: Float32Array; transform: RemovalTransform }
export interface RemovalMask { width: number; height: number; data: Uint8Array }
export interface RemovalBounds { x: number; y: number; width: number; height: number }

/** Geometry shared by full-memory web and bounded native source readers. */
export function removalBounds(image: { width: number; height: number }, selection: RemovalMask): RemovalBounds {
  const { width: mw, height: mh, data } = selection;
  if (mw < 1 || mh < 1 || !Number.isInteger(mw) || !Number.isInteger(mh) || data.length !== mw * mh) throw new Error('Invalid removal mask.');
  let l = mw, r = -1, t = mh, b = -1;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (data[y * mw + x]! > 0) { l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y); }
  if (r < 0) throw new Error('Brush over an object first.');
  const cx = (l + r + 1) * image.width / mw / 2, cy = (t + b + 1) * image.height / mh / 2;
  const edge = Math.ceil(Math.max((r - l + 1) * image.width / mw, (b - t + 1) * image.height / mh) * 1.6);
  const width = Math.min(image.width, Math.max(32, edge)), height = Math.min(image.height, Math.max(32, edge));
  return { x: Math.max(0, Math.min(image.width - width, Math.floor(cx - width / 2))),
    y: Math.max(0, Math.min(image.height - height, Math.floor(cy - height / 2))), width, height };
}

/** Original-image coordinate of one model sample; no resampling substitute. */
export function removalSource(bounds: RemovalBounds, width: number, height: number, i: number, j: number): [number, number] {
  return [Math.min(width - 1, bounds.x + Math.floor((i + 0.5) * bounds.width / PATCH_SIZE)),
    Math.min(height - 1, bounds.y + Math.floor((j + 0.5) * bounds.height / PATCH_SIZE))];
}

/** Sampled source retains exact encoded/linear color and robust HDR mapping. */
export function prepareSampledRemoval(image: Pick<DecodedImage, 'width' | 'height' | 'suggestedColorSpace' | 'encoding'>,
  selection: RemovalMask, revision: number, bounds: RemovalBounds, rgba: Float32Array): RemovalCrop {
  const n = PATCH_SIZE ** 2;
  if (rgba.length !== n * 4) throw new Error('Invalid removal samples.');
  const mask = new Float32Array(n), sources = Uint32Array.from({ length: n }, (_, i) => i * 4);
  for (let j = 0; j < PATCH_SIZE; j++) for (let i = 0; i < PATCH_SIZE; i++) {
    const [sx, sy] = removalSource(bounds, image.width, image.height, i, j);
    mask[j * PATCH_SIZE + i] = selection.data[Math.min(selection.height - 1, Math.floor(sy * selection.height / image.height)) * selection.width
      + Math.min(selection.width - 1, Math.floor(sx * selection.width / image.width))]! > 0 ? 1 : 0;
  }
  const sampled = { ...image, rgba }, transform = removalTransform(sampled, sources, mask), rgb = new Float32Array(n * 3);
  for (let at = 0; at < n; at++) {
    const value = toModel(transform, rgba[at * 4]!, rgba[at * 4 + 1]!, rgba[at * 4 + 2]!);
    rgb.set(value, at * 3);
  }
  return { revision, ...bounds, rgb, mask, transform };
}

export function removalModelInput(crop: Pick<RemovalCrop, 'rgb' | 'mask'>): Float32Array {
  const n = PATCH_SIZE ** 2, input = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) input[c * n + i] = crop.rgb[i * 3 + c]! * (1 - crop.mask[i]!);
    input[3 * n + i] = crop.mask[i]!;
  }
  return input;
}

/** One masked source pixel, shared with native tile/preview reads. */
export function removalPixel(crop: RemovalCrop, output: Float32Array, x: number, y: number,
  r: number, g: number, b: number): [number, number, number] | undefined {
  x -= crop.x; y -= crop.y;
  if (x < 0 || y < 0 || x >= crop.width || y >= crop.height) return;
  const mx = Math.min(511, Math.floor(x * 512 / crop.width)), my = Math.min(511, Math.floor(y * 512 / crop.height));
  if (!crop.mask[my * 512 + mx]) return;
  let alpha = 1;
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) if (!crop.mask[Math.max(0, Math.min(511, my + dy!)) * 512 + Math.max(0, Math.min(511, mx + dx!))]) alpha = 0.5;
  const u = (x + 0.5) * 512 / crop.width - 0.5, v = (y + 0.5) * 512 / crop.height - 0.5;
  const value = fromModel(crop.transform, removalSample(output, 0, u, v), removalSample(output, 1, u, v), removalSample(output, 2, u, v));
  return [r * (1 - alpha) + value[0] * alpha, g * (1 - alpha) + value[1] * alpha, b * (1 - alpha) + value[2] * alpha];
}

export function removalSample(output: Float32Array, channel: number, x: number, y: number): number {
  const fx = Math.max(0, Math.min(511, x)), fy = Math.max(0, Math.min(511, y));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(511, x0 + 1), y1 = Math.min(511, y0 + 1);
  const dx = fx - x0, dy = fy - y0, base = channel * PATCH_SIZE ** 2;
  const top = output[base + y0 * 512 + x0]! * (1 - dx) + output[base + y0 * 512 + x1]! * dx;
  const bottom = output[base + y1 * 512 + x0]! * (1 - dx) + output[base + y1 * 512 + x1]! * dx;
  return Math.max(0, Math.min(1, top * (1 - dy) + bottom * dy));
}

const srgbDecode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function invert3(m: readonly number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error('Invalid removal color matrix.');
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

function mul3(m: readonly number[], r: number, g: number, b: number): [number, number, number] {
  return [m[0]! * r + m[1]! * g + m[2]! * b, m[3]! * r + m[4]! * g + m[5]! * b, m[6]! * r + m[7]! * g + m[8]! * b];
}

/** Nilai sumber -> masukan model (sRGB ter-encode, 0..1). */
function toModel(t: RemovalTransform, r: number, g: number, b: number): [number, number, number] {
  if (t.encoding === 'encoded') return [Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b))];
  const [lr, lg, lb] = mul3(t.toModel!, r, g, b);
  return [srgbEncode(lr / t.gain), srgbEncode(lg / t.gain), srgbEncode(lb / t.gain)];
}

/** Keluaran model (sRGB ter-encode) -> nilai sumber. */
function fromModel(t: RemovalTransform, r: number, g: number, b: number): [number, number, number] {
  if (t.encoding === 'encoded') return [r, g, b];
  return mul3(t.fromModel!, srgbDecode(r) * t.gain, srgbDecode(g) * t.gain, srgbDecode(b) * t.gain);
}

export function prepareRemoval(image: DecodedImage, selection: RemovalMask, revision: number): RemovalCrop {
  if (image.rgba.length !== image.width * image.height * 4) throw new Error('Invalid removal source.');
  const bounds = removalBounds(image, selection), samples = new Float32Array(PATCH_SIZE ** 2 * 4);
  for (let j = 0; j < PATCH_SIZE; j++) for (let i = 0; i < PATCH_SIZE; i++) {
    const [x, y] = removalSource(bounds, image.width, image.height, i, j);
    samples.set(image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4), (j * PATCH_SIZE + i) * 4);
  }
  return prepareSampledRemoval(image, selection, revision, bounds, samples);
}

/**
 * Transformasi untuk crop ini. `gain` = persentil 99,5 dari kanal terbesar
 * (Rec.709 linear) di piksel konteks yang tidak disapu, minimal 1: gambar LDR
 * tidak berubah, sorotan HDR diskalakan masuk 0..1 dan dikembalikan sesudahnya.
 */
function removalTransform(image: Pick<DecodedImage, 'rgba' | 'encoding' | 'suggestedColorSpace'>, sources: Uint32Array, mask: Float32Array): RemovalTransform {
  if (image.encoding === 'encoded') return { space: image.suggestedColorSpace, encoding: 'encoded', gain: 1 };
  // Primer tak dikenal: identitas (diperlakukan seperti Rec.709); tetap bolak-balik persis.
  const toModelMatrix = [...(TO_REC709[image.suggestedColorSpace] ?? TO_REC709['Linear Rec.709']!)];
  const peaks: number[] = [];
  for (let at = 0; at < sources.length; at += 3) {
    if (mask[at]) continue;
    const s = sources[at]!;
    const [lr, lg, lb] = mul3(toModelMatrix, image.rgba[s]!, image.rgba[s + 1]!, image.rgba[s + 2]!);
    const peak = Math.max(lr, lg, lb);
    if (Number.isFinite(peak)) peaks.push(peak);
  }
  peaks.sort((p, q) => p - q);
  const white = peaks.length ? peaks[Math.min(peaks.length - 1, Math.floor(peaks.length * 0.995))]! : 1;
  return { space: image.suggestedColorSpace, encoding: 'linear', toModel: toModelMatrix, fromModel: invert3(toModelMatrix), gain: Math.max(1, white) };
}

/** Only masked RGB pixels are backed up; unselected context and alpha never change. */
export function applyRemoval(image: DecodedImage, crop: RemovalCrop, output: Float32Array): Float32Array {
  const n = PATCH_SIZE ** 2;
  if (output.length !== n * 3 || crop.mask.length !== n || output.some(v => !Number.isFinite(v))) throw new Error('Invalid LaMa result.');
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isInteger) || crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 || crop.x + crop.width > image.width || crop.y + crop.height > image.height) throw new Error('Invalid removal bounds.');
  if (crop.transform.space !== image.suggestedColorSpace || crop.transform.encoding !== image.encoding) throw new Error('Removal color space changed.');
  let selectedPixels = 0;
  for (let my = 0; my < PATCH_SIZE; my++) for (let mx = 0; mx < PATCH_SIZE; mx++) {
    if (!crop.mask[my * PATCH_SIZE + mx]) continue;
    const width = Math.ceil((mx + 1) * crop.width / PATCH_SIZE) - Math.ceil(mx * crop.width / PATCH_SIZE);
    const height = Math.ceil((my + 1) * crop.height / PATCH_SIZE) - Math.ceil(my * crop.height / PATCH_SIZE);
    selectedPixels += width * height;
  }
  const backup = new Float32Array(selectedPixels * 3);
  let backupAt = 0;
  for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) {
    const source = ((crop.y + y) * image.width + crop.x + x) * 4;
    const mx = Math.min(511, Math.floor(x * 512 / crop.width)), my = Math.min(511, Math.floor(y * 512 / crop.height));
    if (!crop.mask[my * 512 + mx]) continue;
    const value = removalPixel(crop, output, crop.x + x, crop.y + y,
      image.rgba[source]!, image.rgba[source + 1]!, image.rgba[source + 2]!)!;
    for (let c = 0; c < 3; c++) {
      backup[backupAt++] = image.rgba[source + c]!;
      image.rgba[source + c] = value[c]!;
    }
  }
  return backup;
}

export function restoreRemoval(image: DecodedImage, crop: RemovalCrop, backup: Float32Array): void {
  let backupAt = 0;
  for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) {
    const mx = Math.min(511, Math.floor(x * PATCH_SIZE / crop.width)), my = Math.min(511, Math.floor(y * PATCH_SIZE / crop.height));
    if (!crop.mask[my * PATCH_SIZE + mx]) continue;
    const source = ((crop.y + y) * image.width + crop.x + x) * 4;
    for (let c = 0; c < 3; c++) image.rgba[source + c] = backup[backupAt++]!;
  }
}

/**
 * Keluaran model sebagai piksel layar (planar 0..1, 3 x 512 x 512), lewat
 * konversi yang sama dengan pratinjau asli (`sourceToDisplay`), supaya
 * pratinjau hapus objek cocok dengan foto di sekitarnya di semua colour space.
 */
export function removalDisplayPatch(crop: RemovalCrop, output: Float32Array): Float32Array {
  const n = PATCH_SIZE ** 2;
  const source = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = fromModel(crop.transform, output[i]!, output[n + i]!, output[2 * n + i]!);
    source[i * 3] = v[0]; source[i * 3 + 1] = v[1]; source[i * 3 + 2] = v[2];
  }
  const { pixels } = sourceToDisplay(source, 3, n, { suggestedColorSpace: crop.transform.space, encoding: crop.transform.encoding });
  const planar = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) planar[c * n + i] = pixels[i * 4 + c]! / 255;
  return planar;
}
