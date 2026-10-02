import type { DecodedImage } from '../io/decoded';
import { srgbEncode } from '../io/display';

export const PATCH_SIZE = 512;
export interface RemovalCrop { revision: number; x: number; y: number; width: number; height: number; rgb: Float32Array; mask: Float32Array }
export interface RemovalMask { width: number; height: number; data: Uint8Array }

export function removalSample(output: Float32Array, channel: number, x: number, y: number): number {
  const fx = Math.max(0, Math.min(511, x)), fy = Math.max(0, Math.min(511, y));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(511, x0 + 1), y1 = Math.min(511, y0 + 1);
  const dx = fx - x0, dy = fy - y0, base = channel * PATCH_SIZE ** 2;
  const top = output[base + y0 * 512 + x0]! * (1 - dx) + output[base + y0 * 512 + x1]! * dx;
  const bottom = output[base + y1 * 512 + x0]! * (1 - dx) + output[base + y1 * 512 + x1]! * dx;
  return Math.max(0, Math.min(1, top * (1 - dy) + bottom * dy));
}

export function prepareRemoval(image: DecodedImage, selection: RemovalMask, revision: number): RemovalCrop {
  if (image.rgba.length !== image.width * image.height * 4) throw new Error('Invalid removal source.');
  if (!['sRGB', 'Linear Rec.709'].includes(image.suggestedColorSpace)) throw new Error('Remove currently supports sRGB photos and Linear Rec.709 RAW. Convert other color spaces first.');
  const { width: mw, height: mh, data } = selection;
  if (mw < 1 || mh < 1 || !Number.isInteger(mw) || !Number.isInteger(mh) || data.length !== mw * mh) throw new Error('Invalid removal mask.');
  let l = mw, r = -1, t = mh, b = -1;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (data[y * mw + x]! > 0) { l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y); }
  if (r < 0) throw new Error('Brush over an object first.');
  const cx = (l + r + 1) * image.width / mw / 2, cy = (t + b + 1) * image.height / mh / 2;
  const edge = Math.ceil(Math.max((r - l + 1) * image.width / mw, (b - t + 1) * image.height / mh) * 1.6);
  const width = Math.min(image.width, Math.max(32, edge)), height = Math.min(image.height, Math.max(32, edge));
  const x = Math.max(0, Math.min(image.width - width, Math.floor(cx - width / 2)));
  const y = Math.max(0, Math.min(image.height - height, Math.floor(cy - height / 2)));
  const n = PATCH_SIZE ** 2, rgb = new Float32Array(n * 3), mask = new Float32Array(n);
  for (let j = 0; j < PATCH_SIZE; j++) for (let i = 0; i < PATCH_SIZE; i++) {
    const sx = Math.min(image.width - 1, x + Math.floor((i + 0.5) * width / PATCH_SIZE));
    const sy = Math.min(image.height - 1, y + Math.floor((j + 0.5) * height / PATCH_SIZE));
    const at = j * PATCH_SIZE + i, source = (sy * image.width + sx) * 4;
    mask[at] = data[Math.min(mh - 1, Math.floor(sy * mh / image.height)) * mw + Math.min(mw - 1, Math.floor(sx * mw / image.width))]! > 0 ? 1 : 0;
    for (let c = 0; c < 3; c++) rgb[at * 3 + c] = image.encoding === 'linear' ? srgbEncode(image.rgba[source + c]!) : image.rgba[source + c]!;
  }
  return { revision, x, y, width, height, rgb, mask };
}

/** Only masked RGB pixels are backed up; unselected context and alpha never change. */
export function applyRemoval(image: DecodedImage, crop: RemovalCrop, output: Float32Array): Float32Array {
  const n = PATCH_SIZE ** 2;
  if (output.length !== n * 3 || crop.mask.length !== n || output.some(v => !Number.isFinite(v))) throw new Error('Invalid LaMa result.');
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isInteger) || crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 || crop.x + crop.width > image.width || crop.y + crop.height > image.height) throw new Error('Invalid removal bounds.');
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
    // Soften the inner edge without modifying any pixel outside the mask.
    let alpha = 1;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) if (!crop.mask[Math.max(0, Math.min(511, my + dy!)) * 512 + Math.max(0, Math.min(511, mx + dx!))]) alpha = 0.5;
    for (let c = 0; c < 3; c++) {
      backup[backupAt++] = image.rgba[source + c]!;
      const encoded = removalSample(output, c, (x + 0.5) * 512 / crop.width - 0.5, (y + 0.5) * 512 / crop.height - 0.5);
      const value = image.encoding === 'linear' ? encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4 : encoded;
      image.rgba[source + c] = image.rgba[source + c]! * (1 - alpha) + value * alpha;
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
