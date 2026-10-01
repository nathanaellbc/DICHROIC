import { describe, expect, it } from 'vitest';
import { CONTINUOUS_CSS_K, CONTINUOUS_EXPONENT, CONTINUOUS_EXTENT, continuousExtents, fitRadii, squirclePath } from '../../src/ui/squircle';

describe('quartic squircle geometry', () => {
  it('uses an n=4 superellipse rather than a circular corner', () => {
    const path = squirclePath(100, 60, [20, 20, 20, 20], 4);
    const points = Array.from(path.matchAll(/C (?:[\d.-]+ ){4}([\d.-]+) ([\d.-]+)/g), m => [Number(m[1]), Number(m[2])]);
    for (const [x, y] of points.slice(0, 16)) {
      expect(((x! - 80) / 20) ** 4 + ((y! - 20) / 20) ** 4).toBeCloseTo(1, 3);
    }
    const midpoint = points[7]!;
    expect(midpoint[0]).toBeCloseTo(80 + 20 * 2 ** -0.25, 2);
    expect(midpoint[1]).toBeCloseTo(20 - 20 * 2 ** -0.25, 2);
  });
  it('joins straight edges with tangent-aligned controls and zero curvature', () => {
    const curves = Array.from(squirclePath(100, 60, [20, 20, 20, 20], 4).matchAll(/C ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/g));
    expect(Number(curves[0]![2])).toBe(0); expect(Number(curves[0]![4])).toBe(0);
    expect(Number(curves[15]![1])).toBe(100); expect(Number(curves[15]![3])).toBe(100);
  });
  it('normalizes overlapping radii proportionally and preserves square corners', () => {
    expect(fitRadii(80, 30, [40, 40, 0, 0])).toEqual([30, 30, 0, 0]);
    expect(fitRadii(100, 40, [30, 30, 30, 30])).toEqual([20, 20, 20, 20]);
    expect(squirclePath(0, 40, [20, 20, 20, 20])).toBe('');
    expect(squirclePath(100, 40, [0, 0, 0, 0])).not.toMatch(/NaN|Infinity/);
  });
  it('keeps all sampled corners inside the rectangular bounds at phone and control sizes', () => {
    for (const [w, h, r] of [[390, 349, 47], [44, 44, 12], [520, 630, 27], [56, 50, 28]]) {
      const path = squirclePath(w!, h!, [r!, r!, r!, r!]);
      for (const m of path.matchAll(/([\d.-]+) ([\d.-]+)/g)) {
        expect(Number(m[1])).toBeGreaterThanOrEqual(0); expect(Number(m[1])).toBeLessThanOrEqual(w!);
        expect(Number(m[2])).toBeGreaterThanOrEqual(0); expect(Number(m[2])).toBeLessThanOrEqual(h!);
      }
    }
  });

  it('sudut kontinu: diagonal = lingkaran beradius nominal, kurva sepanjang 1,528 r', () => {
    expect(CONTINUOUS_EXPONENT).toBeCloseTo(3.2588, 3);
    expect(CONTINUOUS_CSS_K).toBeCloseTo(1.7043, 3);
    // Titik diagonal superellipse sepanjang E = lingkaran r: E(1 - 2^(-1/n)) = r(1 - 1/sqrt2).
    const r = 12, e = r * CONTINUOUS_EXTENT;
    expect(e * (1 - 2 ** (-1 / CONTINUOUS_EXPONENT))).toBeCloseTo(r * (1 - Math.SQRT1_2), 6);
    // Path: titik tengah sudut kanan atas tepat di diagonal itu.
    const path = squirclePath(100, 60, [e, e, e, e]);
    const points = Array.from(path.matchAll(/C (?:[\d.-]+ ){4}([\d.-]+) ([\d.-]+)/g), m => [Number(m[1]), Number(m[2])]);
    const mid = points[7]!;
    const offset = r * (1 - Math.SQRT1_2);
    expect(100 - mid[0]!).toBeCloseTo(offset, 1);
    expect(mid[1]!).toBeCloseTo(offset, 1);
    for (const [x, y] of points.slice(0, 16)) {
      expect(Math.abs((x! - (100 - e)) / e) ** CONTINUOUS_EXPONENT + Math.abs((e - y!) / e) ** CONTINUOUS_EXPONENT).toBeCloseTo(1, 3);
    }
  });
  it('continuousExtents menskalakan radius nominal lalu menjepit ke kotak (kapsul)', () => {
    expect(continuousExtents(200, 100, [12, 12, 12, 12])[0]).toBeCloseTo(12 * CONTINUOUS_EXTENT, 6);
    // Tombol 44 px dengan radius konsentris 31: dijepit ke setengah tinggi.
    expect(continuousExtents(136, 44, [31, 31, 31, 31])).toEqual([22, 22, 22, 22]);
    expect(continuousExtents(80, 40, [0, 0, 0, 0])).toEqual([0, 0, 0, 0]);
  });

  it('kontur kontinu di dalam lingkaran beradius nominal (box fallback boleh memakai radius itu)', () => {
    const r = 10, e = r * CONTINUOUS_EXTENT, n = CONTINUOUS_EXPONENT;
    for (let i = 1; i < 400; i++) {
      const t = (Math.PI / 2) * (i / 400);
      const x = e - e * Math.cos(t) ** (2 / n), y = e - e * Math.sin(t) ** (2 / n);
      if (x < r && y < r) expect(Math.hypot(x - r, y - r)).toBeLessThanOrEqual(r + 1e-9);
    }
  });
});
