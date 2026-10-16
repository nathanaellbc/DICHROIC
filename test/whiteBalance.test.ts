// Pemilih putih dan Auto WB: kebalikan operator white balance "Camera Raw".
import { describe, it, expect } from 'vitest';
import { invert3, shadesOfGray, solveWhiteBalance, whiteBalanceRgb } from '../src/host/cameraDevelop';

/** sRGB (D65) -> XYZ, baris-mayor. */
const SRGB_TO_XYZ = [0.4124, 0.3576, 0.1805, 0.2126, 0.7152, 0.0722, 0.0193, 0.1192, 0.9505];

const apply = (m: ArrayLike<number>, v: readonly number[]) =>
  [0, 1, 2].map((r) => m[r * 3]! * v[0]! + m[r * 3 + 1]! * v[1]! + m[r * 3 + 2]! * v[2]!) as [number, number, number];

describe('solveWhiteBalance', () => {
  it('abu-abu netral (R = G = B) tetap: 5500 K, tint 0', () => {
    expect(solveWhiteBalance(SRGB_TO_XYZ, [0.4, 0.4, 0.4])).toEqual({ whiteBalanceK: 5500, tint: 0 });
  });

  it.each([
    [3200, 0],
    [4300, 0.35],
    [7500, -0.4],
    [10000, 0.2],
  ])('putih di bawah cahaya %d K / tint %d dipulihkan, dan hasilnya benar-benar netral', (k, tint) => {
    // Warna kertas putih yang terekam di bawah iluminan itu: kebalikan WB-nya.
    const neutral = apply(invert3(whiteBalanceRgb(SRGB_TO_XYZ, k, tint)), [0.5, 0.5, 0.5]);
    const solved = solveWhiteBalance(SRGB_TO_XYZ, neutral)!;
    expect(Math.abs(solved.whiteBalanceK - k)).toBeLessThanOrEqual(2);
    expect(Math.abs(solved.tint - tint)).toBeLessThanOrEqual(0.002);
    const out = apply(whiteBalanceRgb(SRGB_TO_XYZ, solved.whiteBalanceK, solved.tint), neutral);
    expect(Math.abs(Math.log(out[0] / out[1]))).toBeLessThan(2e-3);
    expect(Math.abs(Math.log(out[2] / out[1]))).toBeLessThan(2e-3);
  });

  it('warna di luar jangkauan slider dijepit ke tepi, bukan gagal', () => {
    const solved = solveWhiteBalance(SRGB_TO_XYZ, [1, 0.3, 0.02])!;
    expect(solved.whiteBalanceK).toBeGreaterThanOrEqual(2000);
    expect(solved.whiteBalanceK).toBeLessThan(3000);
  });

  it('hitam atau tak hingga: tidak ada hasil', () => {
    expect(solveWhiteBalance(SRGB_TO_XYZ, [0, 0, 0])).toBeUndefined();
    expect(solveWhiteBalance(SRGB_TO_XYZ, [Number.NaN, 1, 1])).toBeUndefined();
  });
});

describe('shadesOfGray', () => {
  it('p = 1 adalah Grey-World (rata-rata kanal)', () => {
    const rgb = new Float32Array(300);
    for (let i = 0; i < 100; i += 1) rgb.set([0.2 + (i % 5) * 0.1, 0.3, 0.1 + (i % 3) * 0.05], i * 3);
    const e = shadesOfGray(rgb, 1)!;
    expect(e[1]).toBeCloseTo(0.3, 5);
  });

  it('adegan abu-abu bercahaya jingga: iluminan jingga, lalu solver menetralkannya ke arah hangat', () => {
    const cast = [1, 0.75, 0.45];
    const rgb = new Float32Array(3 * 400);
    for (let i = 0; i < 400; i += 1) {
      const albedo = 0.05 + 0.6 * ((i * 37) % 100) / 100;
      rgb.set(cast.map((c) => c * albedo), i * 3);
    }
    const e = shadesOfGray(rgb)!;
    expect(e[0] / e[1]).toBeCloseTo(cast[0]! / cast[1]!, 2);
    expect(e[2] / e[1]).toBeCloseTo(cast[2]! / cast[1]!, 2);
    expect(solveWhiteBalance(SRGB_TO_XYZ, e)!.whiteBalanceK).toBeLessThan(4000);
  });

  it('piksel terpotong tidak ikut', () => {
    const rgb = new Float32Array(3 * 200);
    for (let i = 0; i < 200; i += 1) rgb.set(i < 20 ? [1, 1, 0.2] : [0.3, 0.3, 0.3], i * 3);
    const e = shadesOfGray(rgb)!;
    expect(e[2] / e[1]).toBeCloseTo(1, 5);
  });
});
