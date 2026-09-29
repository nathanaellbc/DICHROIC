import { describe, it, expect } from 'vitest';
import { originalFrame, rgbToPixels } from '../../src/ui/engine/display';

describe('konversi tampilan', () => {
  it('rgb_out f32 -> RGBA 8-bit, dijepit dan dibulatkan', () => {
    const px = rgbToPixels(new Float32Array([0, 0.5, 1, -0.2, 1.4, 0.002]), 2, 1);
    expect(Array.from(px)).toEqual([0, 128, 255, 255, 0, 255, 1, 255]);
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
