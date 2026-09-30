import { describe, it, expect } from 'vitest';
import { originalFrame, rgbToPixels, rgbToCanvas } from '../../src/ui/engine/display';

describe('konversi tampilan', () => {
  it('preserves Display P3 originals for the comparison canvas', () => {
    const frame = originalFrame({ width: 1, height: 1, rgba: Float32Array.of(0.2, 0.8, 0.1, 1),
      suggestedColorSpace: 'Display P3', encoding: 'encoded', source: { format: 'png', bitDepth: 8 } }, 1024);
    expect(frame.colorSpace).toBe('display-p3');
    expect(Array.from(frame.pixels)).toEqual([51, 204, 26, 255]);
  });

  it.each(['Linear Rec.709', 'Linear Rec.2020', 'Linear P3-D65', 'ACES2065-1', 'ACEScg'])('converts neutral %s values to display sRGB', (space) => {
    const pixels = rgbToPixels(Float32Array.of(0.18, 0.18, 0.18), 1, 1, space);
    expect(Array.from(pixels)).toEqual([118, 118, 118, 255]);
  });

  it('decodes ProPhoto transfer and adapts its D50 white', () => {
    const value = 0.18 ** (1 / 1.8);
    expect(Array.from(rgbToPixels(Float32Array.of(value, value, value), 1, 1, 'ProPhoto RGB'))).toEqual([118, 118, 118, 255]);
  });

  it('converts P3 to sRGB for consumers that require sRGB', () => {
    expect(Array.from(rgbToCanvas(Float32Array.of(0.2, 0.8, 0.1), 1, 1, 'Display P3'))).toEqual([0, 208, 0, 255]);
  });
  it('rgb_out f32 -> RGBA 8-bit, dijepit dan dibulatkan', () => {
    const px = rgbToPixels(new Float32Array([0, 0.5, 1, -0.2, 1.4, 0.002]), 2, 1);
    expect(Array.from(px)).toEqual([0, 128, 255, 255, 0, 255, 1, 255]);
    // Sama dengan kuantisasi PNG 8-bit: 0.2 -> 51, bukan 52.
    expect(rgbToPixels(Float32Array.of(0.2, 0.2, 0.2), 1, 1)[0]).toBe(51);
  });

  it('pratinjau asli: ter-encode apa adanya, linear -> sRGB', () => {
    const rgba = new Float32Array([0.5, 0.5, 0.5, 1]);
    const encoded = originalFrame({ width: 1, height: 1, rgba, suggestedColorSpace: 'sRGB', encoding: 'encoded', source: { format: 'png', bitDepth: 8 } }, 1024);
    expect(Array.from(encoded.pixels)).toEqual([128, 128, 128, 255]);
    const linear = originalFrame({ width: 1, height: 1, rgba, suggestedColorSpace: 'Linear Rec.709', encoding: 'linear', source: { format: 'exr', bitDepth: 16 } }, 1024);
    expect(linear.pixels[0]).toBe(188); // sRGB OETF(0.5) = 0.7354
  });

  it('pratinjau asli diperkecil sama seperti pratinjau Session', () => {
    const w = 2000, h = 1000;
    const frame = originalFrame({ width: w, height: h, rgba: new Float32Array(w * h * 4), suggestedColorSpace: 'sRGB', encoding: 'encoded', source: { format: 'png', bitDepth: 8 } }, 1024);
    expect([frame.width, frame.height]).toEqual([1024, 512]);
  });
});
