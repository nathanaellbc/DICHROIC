import { describe, it, expect } from 'vitest';
import { SourcePixels } from '../src/session/sourcePixels';
import { boxDownscale, boxDownscaleRegion, measurementImage } from '../src/session/downscale';

function codes(w: number, h: number, max: number): Float32Array {
  const out = new Float32Array(w * h * 4);
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out[i] = (i % 4 === 3 ? max : seed % (max + 1)) / max;
  }
  return out;
}

describe('SourcePixels: sumber diringkas tanpa mengubah nilai', () => {
  it('8-bit -> Uint8 (4 B/px), 16-bit -> Uint16, float tetap float; toFloat identik', () => {
    const eight = codes(37, 23, 255);
    const sixteen = codes(37, 23, 65535);
    const float = codes(37, 23, 255).map((v) => v * 1.5);
    const a = SourcePixels.from(eight);
    const b = SourcePixels.from(sixteen);
    const c = SourcePixels.from(float);
    expect(a.data).toBeInstanceOf(Uint8Array);
    expect(a.byteLength).toBe(eight.byteLength / 4);
    expect(b.data).toBeInstanceOf(Uint16Array);
    expect(c.data).toBe(float);
    expect(a.toFloat()).toEqual(eight);
    expect(b.toFloat()).toEqual(sixteen);
    expect(c.float).toBe(float);
    // Satu nilai di luar kisi 8-bit -> 16-bit atau float, bukan dibulatkan.
    const almost = eight.slice();
    almost[5] = 0.5;
    expect(SourcePixels.from(almost).toFloat()).toEqual(almost);
    expect(SourcePixels.from(Float32Array.of(NaN, 0, 0, 1)).float).toBeDefined();
  });

  it('downscale, wilayah tile, dan kisi pengukuran dari sumber ringkas == dari f32', () => {
    const [W, H] = [301, 199];
    for (const max of [255, 65535]) {
      const rgba = codes(W, H, max);
      const compact = SourcePixels.from(rgba);
      expect(compact.float).toBeUndefined();
      for (const edge of [301, 160, 97]) {
        expect(boxDownscale(compact, W, H, edge)).toEqual(boxDownscale(rgba, W, H, edge));
        const { width, height } = boxDownscale(rgba, W, H, edge);
        expect(boxDownscaleRegion(compact, W, H, width, height, 3, 5, 40, 30)).toEqual(boxDownscaleRegion(rgba, W, H, width, height, 3, 5, 40, 30));
        expect(measurementImage(compact, W, H, width, height)).toEqual(measurementImage(rgba, W, H, width, height));
      }
    }
  });
});
