import { boxDownscaleSize } from '../session/downscale';
import { PATCH_SIZE, removalBounds, removalPixel, removalSource, prepareSampledRemoval, removalModelInput } from '../retouch/patch';
import type { RemovalCrop, RemovalMask } from '../retouch/patch';
import type { DecodedImage } from '../io/decoded';

export interface NativeSourceHost {
  sourceRegion(x: number, y: number, width: number, height: number): Float32Array;
  sourceSamples(bounds: { x: number; y: number; width: number; height: number }): Float32Array;
}

/** Sparse float edits retain model precision without a full-photo float copy.
 * Each decoded read applies the same canonical masked-pixel operation as web.
 * Disk-backed native source bytes remain immutable, including for Before. */
export class NativeSource {
  private edits: { crop: RemovalCrop; output: Float32Array }[] = [];
  private cursor = 0;
  private pending?: { crop: RemovalCrop; output?: Float32Array };
  private revision = 0;
  constructor(readonly host: NativeSourceHost,
    readonly meta: Pick<DecodedImage, 'width' | 'height' | 'encoding' | 'suggestedColorSpace'>) {}

  private apply(pixels: Float32Array, x: number, y: number, width: number, height: number, candidate = false): void {
    const edits = this.edits.slice(0, this.cursor);
    if (candidate && this.pending?.output) edits.push({ crop: this.pending.crop, output: this.pending.output });
    for (const edit of edits) {
      const { crop, output } = edit;
      const top = Math.max(y, crop.y), bottom = Math.min(y + height, crop.y + crop.height);
      const left = Math.max(x, crop.x), right = Math.min(x + width, crop.x + crop.width);
      for (let yy = top; yy < bottom; yy++) for (let xx = left; xx < right; xx++) {
        const at = ((yy - y) * width + xx - x) * 4;
        const value = removalPixel(crop, output, xx, yy, pixels[at]!, pixels[at + 1]!, pixels[at + 2]!);
        if (value) pixels.set(value, at);
      }
    }
  }

  region(outW: number, outH: number, x: number, y: number, w: number, h: number, into?: Float32Array, candidate = false): Float32Array {
    const out = into?.subarray(0, w * h * 4) ?? new Float32Array(w * h * 4);
    const { width, height } = this.meta;
    const same = width === outW && height === outH;
    // Each strip stays below 4 MiB, including very wide sources. The box
    // bounds and double-precision summation order match boxDownscaleRegion.
    for (let row = 0; row < h; row++) {
      const oy = y + row, y0 = Math.floor(oy * height / outH), y1 = Math.max(y0 + 1, Math.floor((oy + 1) * height / outH));
      const x0 = Math.floor(x * width / outW), x1 = Math.max(x0 + 1, Math.floor((x + w) * width / outW));
      const sw = x1 - x0, sh = y1 - y0;
      if (sw * sh * 16 > 4 * 1024 * 1024) throw new Error('Source strip exceeds native read budget.');
      const pixels = this.host.sourceRegion(x0, y0, sw, sh);
      if (pixels.length !== sw * sh * 4) throw new Error('Invalid native source strip.');
      this.apply(pixels, x0, y0, sw, sh, candidate);
      if (same) { out.set(pixels, row * w * 4); continue; }
      for (let col = 0; col < w; col++) {
        const ax = Math.floor((x + col) * width / outW), bx = Math.max(ax + 1, Math.floor((x + col + 1) * width / outW));
        const sums = [0, 0, 0, 0];
        for (let yy = 0; yy < sh; yy++) for (let xx = ax; xx < bx; xx++) {
          const at = (yy * sw + xx - x0) * 4;
          for (let c = 0; c < 4; c++) sums[c]! += pixels[at + c]!;
        }
        const n = sh * (bx - ax), dest = (row * w + col) * 4;
        for (let c = 0; c < 4; c++) out[dest + c] = sums[c]! / n;
      }
    }
    return out;
  }

  preview(edge: number, candidate = false) {
    const size = boxDownscaleSize(this.meta.width, this.meta.height, edge);
    return { ...size, rgba: this.region(size.width, size.height, 0, 0, size.width, size.height, undefined, candidate) };
  }

  prepare(mask: RemovalMask): Float32Array {
    const bounds = removalBounds(this.meta, mask), samples = this.host.sourceSamples(bounds);
    if (samples.length !== PATCH_SIZE ** 2 * 4) throw new Error('Invalid native removal samples.');
    for (let j = 0; j < PATCH_SIZE; j++) for (let i = 0; i < PATCH_SIZE; i++) {
      const [x, y] = removalSource(bounds, this.meta.width, this.meta.height, i, j), at = (j * PATCH_SIZE + i) * 4;
      for (const edit of this.edits.slice(0, this.cursor)) {
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
    this.edits.length = this.cursor;
    this.edits.push({ crop: this.pending.crop, output: this.pending.output });
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
