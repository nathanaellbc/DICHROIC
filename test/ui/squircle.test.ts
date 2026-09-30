import { describe, expect, it } from 'vitest';
import { fitRadii, squirclePath } from '../../src/ui/squircle';

describe('quartic squircle geometry', () => {
  it('uses an n=4 superellipse rather than a circular corner', () => {
    const path = squirclePath(100, 60, [20, 20, 20, 20]);
    const points = Array.from(path.matchAll(/C (?:[\d.-]+ ){4}([\d.-]+) ([\d.-]+)/g), m => [Number(m[1]), Number(m[2])]);
    for (const [x, y] of points.slice(0, 16)) {
      expect(((x! - 80) / 20) ** 4 + ((y! - 20) / 20) ** 4).toBeCloseTo(1, 3);
    }
    const midpoint = points[7]!;
    expect(midpoint[0]).toBeCloseTo(80 + 20 * 2 ** -0.25, 2);
    expect(midpoint[1]).toBeCloseTo(20 - 20 * 2 ** -0.25, 2);
  });
  it('joins straight edges with tangent-aligned controls and zero curvature', () => {
    const curves = Array.from(squirclePath(100, 60, [20, 20, 20, 20]).matchAll(/C ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/g));
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
});
