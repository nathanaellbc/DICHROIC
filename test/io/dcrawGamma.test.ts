import { describe, it, expect } from 'vitest';
import { dcrawGammaCurve, invertDcrawCurve } from '../../src/io/dcrawGamma';

const curve = dcrawGammaCurve(0.45, 4.5, 2, 0x10000);
const inverse = invertDcrawCurve(curve);

describe('kurva gamma dcraw (0,45; 4,5)', () => {
  it('curve[0] = 0 dan tidak menurun', () => {
    expect(curve[0]).toBe(0);
    for (let i = 1; i < curve.length; i += 1) expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
  });

  it('wilayah linear: kemiringan 4,5 (BT.709)', () => {
    expect(curve[1000]).toBe(Math.trunc(0x10000 * (1000 / 0x10000) * 4.5));
  });

  it('putih penuh mendekati 0xffff', () => {
    expect(curve[0xffff]).toBeGreaterThan(0xfff0);
  });

  it('invers eksak di wilayah gelap (kurva injektif)', () => {
    for (let l = 0; l < 1000; l += 1) expect(inverse[curve[l]!]).toBe(l);
  });

  it('invers ke tengah rentang di wilayah terang', () => {
    for (let l = 20000; l < 0x10000; l += 97) {
      const e = curve[l]!;
      let a = l;
      let b = l;
      while (a > 0 && curve[a - 1] === e) a -= 1;
      while (b < 0xffff && curve[b + 1] === e) b += 1;
      expect(inverse[e]).toBe((a + b) / 2);
    }
  });

  it('invers tidak menurun dan total (tanpa NaN)', () => {
    for (let e = 1; e < inverse.length; e += 1) {
      expect(Number.isNaN(inverse[e])).toBe(false);
      expect(inverse[e]!).toBeGreaterThanOrEqual(inverse[e - 1]!);
    }
  });
});
