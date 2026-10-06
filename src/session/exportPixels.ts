import { rgbToRgba8 } from '../io/canvasEncode';
import { rgbToCanvas } from '../io/display';
import type { OutputColorSpaceSpec } from '../profiles/types';
import { isDisplaySpace } from './exportTarget';
import type { ExportTarget } from './exportTarget';

/**
 * Quantize while the tile is alive, then discard its float pixels. Hanya
 * larik untuk `target` yang dialokasikan (`'all'` = semuanya, untuk alat dan
 * tes); meminta larik lain melempar galat, bukan diam-diam memberi nol.
 */
export class ExportPixels {
  readonly #rgb8?: Uint8Array;
  readonly #rgb16?: Uint16Array;
  readonly canvasPixels?: Uint8ClampedArray;

  constructor(readonly width: number, readonly height: number, readonly outputColorSpace: string,
    private readonly spaces: Record<string, OutputColorSpaceSpec>, readonly target: ExportTarget | 'all' = 'all') {
    const display = isDisplaySpace(outputColorSpace);
    if (target === 'all' || target === 'rgb8' || (target === 'canvas' && display)) this.#rgb8 = new Uint8Array(width * height * 3);
    if (target === 'all' || target === 'rgb16') this.#rgb16 = new Uint16Array(width * height * 3);
    if ((target === 'all' || target === 'canvas') && !display) this.canvasPixels = new Uint8ClampedArray(width * height * 4);
  }

  get rgb8(): Uint8Array {
    if (!this.#rgb8) throw new Error(`Render ekspor ini hanya memegang piksel ${this.target}, bukan RGB 8-bit.`);
    return this.#rgb8;
  }

  get rgb16(): Uint16Array {
    if (!this.#rgb16) throw new Error(`Render ekspor ini hanya memegang piksel ${this.target}, bukan RGB 16-bit.`);
    return this.#rgb16;
  }

  /** Byte piksel yang dipegang (diagnosis memori). */
  get bytes(): number {
    return (this.#rgb8?.byteLength ?? 0) + (this.#rgb16?.byteLength ?? 0) + (this.canvasPixels?.byteLength ?? 0);
  }

  draw(rgb: Float32Array, x: number, y: number, width: number, height: number): void {
    const canvas = this.canvasPixels && rgbToCanvas(rgb, width, height, this.outputColorSpace, 'srgb', this.spaces);
    const rgb8 = this.#rgb8;
    const rgb16 = this.#rgb16;
    for (let row = 0; row < height; row++) {
      const dest = ((y + row) * this.width + x) * 3;
      for (let i = 0; i < width * 3; i++) {
        const v = rgb[row * width * 3 + i]!;
        if (rgb8) rgb8[dest + i] = v > 0 ? v >= 1 ? 255 : Math.round(v * 255) : 0;
        if (rgb16) rgb16[dest + i] = v > 0 ? v >= 1 ? 65535 : Math.round(v * 65535) : 0;
      }
      if (canvas) this.canvasPixels!.set(canvas.subarray(row * width * 4, (row + 1) * width * 4), ((y + row) * this.width + x) * 4);
    }
  }

  canvas(): Uint8ClampedArray {
    return this.canvasPixels ?? rgbToRgba8(this.rgb8, this.width, this.height);
  }
}
