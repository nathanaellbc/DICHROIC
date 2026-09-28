import { describe, it, expect } from 'vitest';
import { PREVIEW_MAX_LONG_EDGE, boxDownscale } from '../src/session/downscale';

function rgbaOf(values: number[][]): Float32Array {
  return Float32Array.from(values.flatMap((v) => [v[0]!, v[1]!, v[2]!, 1]));
}

describe('boxDownscale', () => {
  it('batas pratinjau adalah 1024 px sisi terpanjang', () => {
    expect(PREVIEW_MAX_LONG_EDGE).toBe(1024);
  });

  it('merata-ratakan blok 2x2 untuk 4x2 -> 2x1', () => {
    // baris 0: a b c d; baris 1: e f g h
    const src = rgbaOf([
      [0, 0, 0], [4, 8, 12], [1, 1, 1], [3, 3, 3],
      [0, 0, 0], [4, 8, 12], [1, 1, 1], [3, 3, 3],
    ]);
    const out = boxDownscale(src, 4, 2, 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(1);
    expect(Array.from(out.rgba)).toEqual([2, 4, 6, 1, 2, 2, 2, 1]);
  });

  it('membulatkan sisi pendek dan tidak pernah di bawah 1 px', () => {
    const out = boxDownscale(new Float32Array(3000 * 10 * 4), 3000, 10, 1024);
    expect(out.width).toBe(1024);
    expect(out.height).toBe(3);
    const thin = boxDownscale(new Float32Array(5000 * 1 * 4), 5000, 1, 1024);
    expect(thin.height).toBe(1);
  });

  it('mempertahankan rata-rata gambar seragam', () => {
    const src = new Float32Array(1500 * 700 * 4).fill(0.37);
    const out = boxDownscale(src, 1500, 700, 1024);
    for (const v of out.rgba) expect(v).toBeCloseTo(0.37, 6);
  });

  it('mengembalikan masukan apa adanya bila sudah dalam batas', () => {
    const src = new Float32Array(16 * 8 * 4);
    const out = boxDownscale(src, 16, 8, 1024);
    expect(out.rgba).toBe(src);
    expect(out.width).toBe(16);
  });
});
