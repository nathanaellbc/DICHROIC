import { expect, it } from 'vitest';
import { NativeSource } from '../src/native/source';
import { boxDownscaleRegion, measurementImage } from '../src/session/downscale';
import { applyRemoval, prepareRemoval, removalSource, removalModelInput } from '../src/retouch/patch';
import type { DecodedImage } from '../src/io/decoded';

it.each([false, true])('bounded native reads match web edits with disk history=%s', disk => {
  const width = 64, height = 48;
  const rgba = Float32Array.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? 1 : ((i * 13) % 257) / 256);
  const image: DecodedImage = { width, height, rgba, encoding: 'encoded', suggestedColorSpace: 'sRGB', source: { format: 'png', bitDepth: 8 } };
  const stored = new Map<number, Float32Array>();
  const strip = new Float32Array(width * height * 4);
  const native = new NativeSource({
    ...(disk ? {
      saveRemoval(pixels: Float32Array) { const id = stored.size; stored.set(id, pixels.slice()); return id; },
      loadRemoval(id: number) { return stored.get(id)!.slice(); },
    } : {}),
    sourceRegion(x, y, w, h) {
      const out = strip.subarray(0, w * h * 4);
      for (let row = 0; row < h; row++) out.set(rgba.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4), row * w * 4);
      return out;
    },
    sourceSamples(bounds) {
      const out = new Float32Array(512 ** 2 * 4);
      for (let j = 0; j < 512; j++) for (let i = 0; i < 512; i++) {
        const [x, y] = removalSource(bounds, width, height, i, j), at = (y * width + x) * 4;
        out.set(rgba.subarray(at, at + 4), (j * 512 + i) * 4);
      }
      return out;
    },
  }, image);
  const mask = { width: 16, height: 12, data: Uint8Array.from({ length: 192 }, (_, i) => i % 16 > 4 && i % 16 < 10 && Math.floor(i / 16) > 2 && Math.floor(i / 16) < 8 ? 255 : 0) };
  const crop = prepareRemoval(image, mask, 0), input = native.prepare(mask);
  expect(input).toEqual(removalModelInput(crop));
  const result = Float32Array.from({ length: 512 ** 2 * 3 }, (_, i) => (i % 511) / 511);
  const expected = { ...image, rgba: rgba.slice() };
  applyRemoval(expected, crop, result); native.finish(result);
  expect(native.preview(32, true).rgba).toEqual(boxDownscaleRegion(expected.rgba, width, height, 32, 24, 0, 0, 32, 24));
  expect(native.commit()).toBe(1);
  native.purgeCache();
  expect(native.region(width, height, 0, 0, width, height)).toEqual(expected.rgba);
  expect(native.region(width, height, 0, 0, width, height, undefined, false, true)).toEqual(rgba);
  expect(native.measurement(31, 23)).toEqual(measurementImage(expected.rgba, width, height, 31, 23));
  native.restore(0);
  expect(native.region(width, height, 0, 0, width, height)).toEqual(rgba);
  native.restore(1);
  expect(native.region(width, height, 8, 7, 30, 25)).toEqual(boxDownscaleRegion(expected.rgba, width, height, width, height, 8, 7, 30, 25));
});
