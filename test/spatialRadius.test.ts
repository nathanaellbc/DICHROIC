import { describe, it, expect } from 'vitest';
import {
  APRON_SIGMAS,
  blurSupportPx,
  dirRadiusPx,
  halationRadiusPx,
  productionOverlapPx,
} from '../src/engine/spatialRadius';

/**
 * Radius apron dari sigma blur SEBENARNYA (Fase 2A.5 Task 6). Angka acuan:
 * `tools/README.md` (tabel rezim produksi) -- sigma halation bounce
 * 65 um * sqrt(k), ekor DIR 200 um * 2.7684 (komponen terbesar campuran
 * eksponensial), dll.
 */

const FIRST_SIGMA: [number, number, number] = [65, 65, 65];

describe('blurSupportPx', () => {
  it('FIR: radius truncasi hulu int(3*sigma + 0.5); IIR: ceil(10*sigma)', () => {
    expect(APRON_SIGMAS).toBe(10);
    expect(blurSupportPx(0)).toBe(0);
    expect(blurSupportPx(1e-6)).toBe(0);
    expect(blurSupportPx(0.2)).toBe(1);
    expect(blurSupportPx(2.9)).toBe(9);
    expect(blurSupportPx(3)).toBe(30);
    expect(blurSupportPx(88.6)).toBe(886);
  });
});

describe('radius tahap', () => {
  it('ukuran piksel fixture Fase 1 (546.875 um): halation 1, DIR 3', () => {
    expect(halationRadiusPx(546.875, FIRST_SIGMA)).toBe(1);
    expect(dirRadiusPx(546.875)).toBe(3);
  });

  it('31.25 um: halation 37 (bounce IIR 3.6 px), DIR 178 (ekor 17.7 px)', () => {
    expect(halationRadiusPx(31.25, FIRST_SIGMA)).toBe(37);
    expect(dirRadiusPx(31.25)).toBe(178);
  });

  it('6.25 um (foto sungguhan): halation 181, DIR 886', () => {
    expect(halationRadiusPx(6.25, FIRST_SIGMA)).toBe(181);
    expect(dirRadiusPx(6.25)).toBe(886);
  });
});

describe('productionOverlapPx', () => {
  it('menjumlahkan halation, DIR, grain (64), dan unsharp scanner (256)', () => {
    expect(productionOverlapPx({ halation: 99, dir: 488, grain: true, unsharp: true })).toBe(99 + 488 + 64 + 256);
    expect(productionOverlapPx({ halation: 1, dir: 3, grain: false, unsharp: true })).toBe(260);
  });
});
