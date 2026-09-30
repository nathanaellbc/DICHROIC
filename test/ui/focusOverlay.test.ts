import { describe, expect, it } from 'vitest';
import { focusCheckFrame, prepareFocusOverlay } from '../../src/ui/engine/focusCheck';
import { BASELINE_RENDER_PARAMS } from '../../src/params/renderParams';
import type { Frame } from '../../src/ui/engine/display';

const depth = { width: 8, height: 8, data: Float32Array.from({ length: 64 }, (_, i) => 0.1 + i / 64) };
function image(width: number, height: number): Frame {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([180, 100, 50, 255], i);
  return { width, height, pixels, colorSpace: 'srgb' };
}

describe('focus overlay', () => {
  it('composites to the existing focus check and updates with the selected depth', () => {
    const source = image(80, 50);
    const prepare = prepareFocusOverlay(source, depth);
    const masks = [];
    for (const lensFocusX of [0.1, 0.9]) {
      const params = { ...BASELINE_RENDER_PARAMS, lensBlurEnabled: true, lensFNumber: 1.4, lensFocusX };
      const mask = prepare(params);
      masks.push(mask);
      const reference = focusCheckFrame(source, depth, params);
      for (let i = 0; i < mask.pixels.length; i += 4) {
        const opacity = mask.pixels[i + 3]! / 255;
        for (let c = 0; c < 3; c += 1) {
          const composite = mask.pixels[i + c]! * opacity + source.pixels[i + c]! * (1 - opacity);
          expect(Math.abs(composite - reference.pixels[i + c]!)).toBeLessThanOrEqual(2);
        }
      }
    }
    expect(masks[0]!.pixels).not.toEqual(masks[1]!.pixels);
  });

  it('bounds only the mask, preserving the high resolution source and previous frames', () => {
    const source = image(4096, 2048);
    const prepare = prepareFocusOverlay(source, depth);
    const first = prepare(BASELINE_RENDER_PARAMS);
    const saved = first.pixels.slice();
    const next = prepare({ ...BASELINE_RENDER_PARAMS, lensFocusY: 0.9 });
    expect([next.width, next.height]).toEqual([768, 384]);
    expect([source.width, source.height]).toEqual([4096, 2048]);
    expect(first.pixels).toEqual(saved);
    expect(next.pixels).not.toBe(first.pixels);
    expect(source.pixels.slice(0, 4)).toEqual(new Uint8ClampedArray([180, 100, 50, 255]));
  });
});
