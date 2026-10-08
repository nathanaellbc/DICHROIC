import { boxDownscaleSize } from '../session/downscale';
import { PATCH_SIZE, removalBounds, removalPixel, removalSource, prepareSampledRemoval, removalModelInput } from '../retouch/patch';
import type { RemovalCrop, RemovalMask } from '../retouch/patch';
import type { DecodedImage } from '../io/decoded';

export interface NativeSourceHost {
  /** Borrowed strip storage, consumed before the next read. Native reuses 4 MiB. */
  sourceRegion(x: number, y: number, width: number, height: number): Float32Array;
  sourceSamples(bounds: { x: number; y: number; width: number; height: number }): Float32Array;
  saveRemoval?(pixels: Float32Array): number;
  loadRemoval?(id: number): Float32Array;
}
type SavedRemoval = { crop: RemovalCrop; output: Float32Array; id?: number };

/** Sparse float edits retain model precision without a full-photo float copy.
 * Each decoded read applies the same canonical masked-pixel operation as web.
 * Disk-backed native source bytes remain immutable, including for Before. */
export class NativeSource {
  private edits: SavedRemoval[] = [];
  private cache = new Map<number, { crop: RemovalCrop; output: Float32Array }>();
  private cursor = 0;
  private pending?: { crop: RemovalCrop; output?: Float32Array };
  private revision = 0;
  constructor(readonly host: NativeSourceHost,
    readonly meta: Pick<DecodedImage, 'width' | 'height' | 'encoding' | 'suggestedColorSpace'>) {}

  private loaded(edit: SavedRemoval): { crop: RemovalCrop; output: Float32Array } {
    if (edit.id === undefined) return edit;
    let value = this.cache.get(edit.id);
    if (!value) {
      const packed = this.host.loadRemoval!(edit.id);
      if (packed.length !== PATCH_SIZE ** 2 * 4) throw new Error('Removal history is truncated.');
      value = { crop: { ...edit.crop, mask: packed.subarray(0, PATCH_SIZE ** 2) }, output: packed.subarray(PATCH_SIZE ** 2) };
    }
    this.cache.delete(edit.id); this.cache.set(edit.id, value);
    if (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  private intersecting(x: number, y: number, width: number, height: number): SavedRemoval[] {
    return this.edits.slice(0, this.cursor).filter(({ crop }) =>
      crop.x < x + width && crop.y < y + height && crop.x + crop.width > x && crop.y + crop.height > y);
  }
  purgeCache(): void { this.cache.clear(); }

  private apply(pixels: Float32Array, x: number, y: number, width: number, height: number, candidate = false): void {
    const edits: SavedRemoval[] = this.intersecting(x, y, width, height);
    if (candidate && this.pending?.output) edits.push({ crop: this.pending.crop, output: this.pending.output });
    for (const edit of edits) {
      const { crop, output } = this.loaded(edit);
      const top = Math.max(y, crop.y), bottom = Math.min(y + height, crop.y + crop.height);
      const left = Math.max(x, crop.x), right = Math.min(x + width, crop.x + crop.width);
      for (let yy = top; yy < bottom; yy++) for (let xx = left; xx < right; xx++) {
        const at = ((yy - y) * width + xx - x) * 4;
        const value = removalPixel(crop, output, xx, yy, pixels[at]!, pixels[at + 1]!, pixels[at + 2]!);
        if (value) pixels.set(value, at);
      }
    }
  }

  region(outW: number, outH: number, x: number, y: number, w: number, h: number, into?: Float32Array, candidate = false, untouched = false): Float32Array {
    const out = into?.subarray(0, w * h * 4) ?? new Float32Array(w * h * 4);
    const { width, height } = this.meta;
    const same = width === outW && height === outH;
    if (same) {
      const stripRows = Math.max(1, Math.floor(4 * 1024 * 1024 / (w * 16)));
      for (let row = 0; row < h; row += stripRows) {
        const rows = Math.min(stripRows, h - row), pixels = this.host.sourceRegion(x, y + row, w, rows);
        if (pixels.length !== w * rows * 4) throw new Error('Invalid native source strip.');
        out.set(pixels, row * w * 4);
      }
      if (!untouched) this.apply(out, x, y, w, h, candidate);
      return out;
    }
    // Each strip stays below 4 MiB, including very wide sources. The box
    // bounds and double-precision summation order match boxDownscaleRegion.
    for (let row = 0; row < h; row++) {
      const oy = y + row, y0 = Math.floor(oy * height / outH), y1 = Math.max(y0 + 1, Math.floor((oy + 1) * height / outH));
      const x0 = Math.floor(x * width / outW), x1 = Math.max(x0 + 1, Math.floor((x + w) * width / outW));
      const sw = x1 - x0, sh = y1 - y0, stripRows = Math.max(1, Math.floor(4 * 1024 * 1024 / (sw * 16)));
      const sums = new Float64Array(w * 4);
      for (let top = y0; top < y1; top += stripRows) {
        const rows = Math.min(stripRows, y1 - top), pixels = this.host.sourceRegion(x0, top, sw, rows);
        if (pixels.length !== sw * rows * 4) throw new Error('Invalid native source strip.');
        if (!untouched) this.apply(pixels, x0, top, sw, rows, candidate);
        for (let col = 0; col < w; col++) {
          const ax = Math.floor((x + col) * width / outW), bx = Math.max(ax + 1, Math.floor((x + col + 1) * width / outW)), dest = col * 4;
          let r = sums![dest]!, g = sums![dest + 1]!, b = sums![dest + 2]!, a = sums![dest + 3]!;
          for (let yy = 0; yy < rows; yy++) for (let xx = ax; xx < bx; xx++) {
            const at = (yy * sw + xx - x0) * 4;
            r += pixels[at]!; g += pixels[at + 1]!; b += pixels[at + 2]!; a += pixels[at + 3]!;
          }
          sums![dest] = r; sums![dest + 1] = g; sums![dest + 2] = b; sums![dest + 3] = a;
        }
      }
      for (let col = 0; col < w; col++) {
        const ax = Math.floor((x + col) * width / outW), bx = Math.max(ax + 1, Math.floor((x + col + 1) * width / outW));
        const n = sh * (bx - ax), dest = (row * w + col) * 4;
        for (let c = 0; c < 4; c++) out[dest + c] = sums![col * 4 + c]! / n;
      }
    }
    return out;
  }

  preview(edge: number, candidate = false) {
    const size = boxDownscaleSize(this.meta.width, this.meta.height, edge);
    return { ...size, rgba: this.region(size.width, size.height, 0, 0, size.width, size.height, undefined, candidate) };
  }

  /** Identical full-output measurement sampling as web, without a full frame. */
  measurement(outW: number, outH: number) {
    const scale = Math.min(1, 256 / Math.max(outW, outH)), width = Math.max(1, Math.round(outW * scale)), height = Math.max(1, Math.round(outH * scale));
    const rgba = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const sy = Math.min(outH - 1, Math.floor(y * outH / height)), row = this.region(outW, outH, 0, sy, outW, 1);
      for (let x = 0; x < width; x++) {
        const sx = Math.min(outW - 1, Math.floor(x * outW / width));
        rgba.set(row.subarray(sx * 4, sx * 4 + 4), (y * width + x) * 4);
      }
    }
    return { rgba, width, height };
  }

  prepare(mask: RemovalMask): Float32Array {
    const bounds = removalBounds(this.meta, mask), samples = this.host.sourceSamples(bounds);
    if (samples.length !== PATCH_SIZE ** 2 * 4) throw new Error('Invalid native removal samples.');
    for (const saved of this.intersecting(bounds.x, bounds.y, bounds.width, bounds.height)) {
      const edit = this.loaded(saved);
      for (let j = 0; j < PATCH_SIZE; j++) for (let i = 0; i < PATCH_SIZE; i++) {
      const [x, y] = removalSource(bounds, this.meta.width, this.meta.height, i, j), at = (j * PATCH_SIZE + i) * 4;
        const value = removalPixel(edit.crop, edit.output, x, y, samples[at]!, samples[at + 1]!, samples[at + 2]!);
        if (value) samples.set(value, at);
      }
    }
    const crop = prepareSampledRemoval(this.meta, mask, this.revision, bounds, samples);
    this.pending = { crop };
    return removalModelInput(crop);
  }

  finish(output: Float32Array): void {
    if (!this.pending || output.length !== PATCH_SIZE ** 2 * 3 || output.some(v => !Number.isFinite(v))) throw new Error('Invalid LaMa output.');
    this.pending.output = output;
  }
  commit(): number {
    if (!this.pending?.output) throw new Error('Remove an object before applying.');
    const edit: SavedRemoval = { crop: this.pending.crop, output: this.pending.output };
    if (this.host.saveRemoval && this.host.loadRemoval) {
      const packed = new Float32Array(PATCH_SIZE ** 2 * 4);
      packed.set(edit.crop.mask); packed.set(edit.output, PATCH_SIZE ** 2);
      edit.id = this.host.saveRemoval(packed);
      // Keep only geometry in JS history. Two recent float patches are cached.
      edit.crop = { ...edit.crop, mask: new Float32Array(), rgb: new Float32Array() };
      edit.output = new Float32Array();
    }
    this.edits.length = this.cursor;
    this.edits.push(edit);
    // The model input is no longer needed after inference (3 MiB per edit).
    this.pending.crop.rgb = new Float32Array();
    this.cursor++; this.revision++; this.pending = undefined;
    return this.cursor;
  }
  cancel(): void { this.pending = undefined; }
  restore(cursor: number): void {
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > this.edits.length) throw new Error('Invalid removal history.');
    this.cursor = cursor; this.revision++; this.pending = undefined;
  }
}
