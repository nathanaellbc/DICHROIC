import { describe, expect, it } from 'vitest';
import { applyCrop, boxToImage, cropFits, fitCrop, identityCrop, imageToBox, isIdentityCrop, rotateQuarter, withAspect } from '../src/io/geometry';

const A = 2 / 3; // foto lanskap 3:2

describe('geometry (crop & rotate)', () => {
  it('identity maps box to image 1:1', () => {
    const c = identityCrop(A);
    expect(isIdentityCrop(c, A)).toBe(true);
    expect(boxToImage(c, A, 0.25, 0.75)).toEqual({ u: 0.25, v: 0.75 });
  });

  it('boxToImage and imageToBox are inverse under rotation and flip', () => {
    const c = fitCrop({ ...identityCrop(A), angle: 12, quarter: 1, flip: true, w: 0.3, h: 0.4, cx: 0.45, cy: 0.3 }, A);
    for (const [x, y] of [[0, 0], [1, 1], [0.3, 0.8]] as const) {
      const p = boxToImage(c, A, x, y);
      const b = imageToBox(c, A, p.u, p.v);
      expect(b.x).toBeCloseTo(x, 9);
      expect(b.y).toBeCloseTo(y, 9);
    }
  });

  it('straightening shrinks the crop so no empty corners show', () => {
    const c = fitCrop({ ...identityCrop(A), angle: 20 }, A);
    expect(cropFits(c, A)).toBe(true);
    expect(c.w).toBeLessThan(1);
    expect(c.w / c.h).toBeCloseTo(1 / A, 9);
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const p = boxToImage(c, A, x, y);
      expect(p.u).toBeGreaterThanOrEqual(-1e-9);
      expect(p.u).toBeLessThanOrEqual(1 + 1e-9);
      expect(p.v).toBeGreaterThanOrEqual(-1e-9);
      expect(p.v).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('aspect lock picks the largest rect of that ratio', () => {
    const sq = withAspect(identityCrop(A), '1:1', A);
    expect(sq.w).toBeCloseTo(A, 9);
    expect(sq.h).toBeCloseTo(A, 9);
    expect(cropFits(sq, A)).toBe(true);
  });

  it('rotating a quarter swaps the display box', () => {
    const r = rotateQuarter(identityCrop(A), A);
    expect(r.quarter).toBe(1);
    expect(r.w).toBeCloseTo(A, 9);
    expect(r.h).toBeCloseTo(1, 9);
  });

  it('applyCrop copies a straight crop and rotates a quarter exactly', () => {
    // 3 x 2 RGB, nilai = indeks piksel.
    const src = new Uint8Array(3 * 2 * 3).map((_, i) => Math.floor(i / 3));
    const a = 2 / 3;
    const half = { ...identityCrop(a), w: 2 / 3, h: 2 / 3, cx: 1 / 3, cy: 1 / 3 };
    const straight = applyCrop(src, 3, 2, 3, half);
    expect([straight.width, straight.height]).toEqual([2, 2]);
    expect(Array.from(straight.data.filter((_, i) => i % 3 === 0))).toEqual([0, 1, 3, 4]);
    const turned = applyCrop(src, 3, 2, 3, rotateQuarter(identityCrop(a), a));
    expect([turned.width, turned.height]).toEqual([2, 3]);
    // Searah jarum jam: baris atas hasil = kolom kiri sumber dari bawah ke atas.
    expect(Array.from(turned.data.filter((_, i) => i % 3 === 0))).toEqual([3, 0, 4, 1, 5, 2]);
  });
});
