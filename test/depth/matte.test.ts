import { describe, expect, it } from 'vitest';
import { GuideImage, boxMean, guidedFilterGray } from '../../src/depth/matte';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('matte: filter dasar', () => {
  it('boxMean = brute force (jendela dijepit di tepi)', () => {
    const w = 13, h = 9, r = 3, rand = rng(7);
    const src = Float32Array.from({ length: w * h }, rand);
    const mean = boxMean(src, w, h, r, new Float32Array(w * h), new Float32Array(w * h));
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      let s = 0, c = 0;
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j += 1) for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i += 1) {
        s += src[j * w + i]!; c += 1;
      }
      expect(mean[y * w + x]).toBeCloseTo(s / c, 5);
    }
  });

  it('guided filter membersihkan derau kedalaman tanpa melunakkan tepi yang sejajar foto', () => {
    const w = 64, h = 32, rand = rng(11);
    const guide = new Uint8ClampedArray(w * h * 4);
    const depth = new Float32Array(w * h);
    const ideal = (x: number) => (x < 32 ? 0.2 : 0.9);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      // Foto: tepi tajam di x = 32. Kedalaman: tepi sama + derau jaringan ±0,1.
      guide.set(x < 32 ? [40, 30, 90, 255] : [220, 150, 60, 255], i * 4);
      depth[i] = ideal(x) + (rand() - 0.5) * 0.2;
    }
    const error = (q: Float32Array) => {
      let e = 0;
      for (let i = 0; i < w * h; i += 1) e += Math.abs(q[i]! - ideal(i % w));
      return e / (w * h);
    };
    const q = guidedFilterGray(new GuideImage(guide, w, h), depth, 4, 1e-3);
    expect(error(q) / error(depth)).toBeLessThan(0.35);
    // Tepi tetap tegas: satu piksel di tiap sisi masih dekat nilainya sendiri.
    expect(Math.abs(q[16 * w + 31]! - 0.2)).toBeLessThan(0.08);
    expect(Math.abs(q[16 * w + 32]! - 0.9)).toBeLessThan(0.08);
  });
});
