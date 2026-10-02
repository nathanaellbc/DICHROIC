import { rgbToRgba8 } from '../io/canvasEncode';
import { rgbToCanvas } from '../io/display';
import type { OutputColorSpaceSpec } from '../profiles/types';

/** Quantize while the tile is alive, then discard its float pixels. */
export class ExportPixels {
  readonly rgb8: Uint8Array;
  readonly rgb16: Uint16Array;
  readonly canvasPixels?: Uint8ClampedArray;

  constructor(readonly width: number, readonly height: number, readonly outputColorSpace: string,
    private readonly spaces: Record<string, OutputColorSpaceSpec>) {
    this.rgb8 = new Uint8Array(width * height * 3);
    this.rgb16 = new Uint16Array(width * height * 3);
    if (outputColorSpace !== 'sRGB' && outputColorSpace !== 'Display P3') this.canvasPixels = new Uint8ClampedArray(width * height * 4);
  }

  draw(rgb: Float32Array, x: number, y: number, width: number, height: number): void {
    const canvas = this.canvasPixels && rgbToCanvas(rgb, width, height, this.outputColorSpace, 'srgb', this.spaces);
    for (let row = 0; row < height; row++) {
      const dest = ((y + row) * this.width + x) * 3;
      for (let i = 0; i < width * 3; i++) {
        const v = rgb[row * width * 3 + i]!;
        this.rgb8[dest + i] = v > 0 ? v >= 1 ? 255 : Math.round(v * 255) : 0;
        this.rgb16[dest + i] = v > 0 ? v >= 1 ? 65535 : Math.round(v * 65535) : 0;
      }
      if (canvas) this.canvasPixels!.set(canvas.subarray(row * width * 4, (row + 1) * width * 4), ((y + row) * this.width + x) * 4);
    }
  }

  canvas(): Uint8ClampedArray {
    return this.canvasPixels ?? rgbToRgba8(this.rgb8, this.width, this.height);
  }
}
