import { describe, it, expect } from 'vitest';
import {
  compareRgb,
  expectWithinTolerance,
  loadCase,
  loadInputAsRgba,
  loadTap,
} from './compare';

describe('harness perbandingan', () => {
  it('melaporkan nol galat untuk data yang identik', () => {
    const expected = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const actual = new Float32Array([0.1, 0.2, 0.3, 1, 0.4, 0.5, 0.6, 1]);
    const result = compareRgb(actual, expected);
    expect(result.maxAbsError).toBe(0);
    expect(result.meanAbsError).toBe(0);
  });

  it('menemukan indeks terburuk', () => {
    const expected = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const actual = new Float32Array([0.1, 0.2, 0.3, 1, 0.4, 0.5, 0.9, 1]);
    const result = compareRgb(actual, expected);
    expect(result.maxAbsError).toBeCloseTo(0.3, 6);
    expect(result.worstIndex).toBe(5);
  });

  // Regresi yang ditargetkan: kalau komparator hanya memeriksa piksel
  // pertama (bug yang mudah lolos, mis. loop yang salah break atau range
  // yang salah), galat besar di piksel KETIGA di sini akan hilang tanpa
  // terdeteksi. Piksel 0 dan 1 dibuat identik dengan sengaja supaya
  // "berhenti setelah piksel pertama yang cocok" juga gagal.
  it('mendeteksi galat pada piksel ketiga, bukan cuma piksel pertama', () => {
    const expected = new Float32Array([
      0.1, 0.1, 0.1, // piksel 0: cocok
      0.2, 0.2, 0.2, // piksel 1: cocok
      0.3, 0.3, 0.3, // piksel 2: MELESET di kanal G
    ]);
    const actual = new Float32Array([
      0.1, 0.1, 0.1, 1,
      0.2, 0.2, 0.2, 1,
      0.3, 0.9, 0.3, 1,
    ]);
    const result = compareRgb(actual, expected);
    expect(result.maxAbsError).toBeCloseTo(0.6, 6);
    expect(result.worstIndex).toBe(7); // piksel 2, kanal G -> 2*3 + 1
  });

  // Panjang yang tidak cocok harus gagal keras, bukan diam-diam
  // melaporkan nol galat (mis. karena loop berhenti di panjang array
  // yang lebih pendek tanpa pemberitahuan).
  it('melempar galat ketika keluaran aktual lebih pendek dari yang diharapkan', () => {
    const expected = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const actual = new Float32Array([0.1, 0.2, 0.3, 1]); // hanya 1 piksel, bukan 2
    expect(() => compareRgb(actual, expected)).toThrow();
  });

  it('gagal keras ketika di luar ambang', () => {
    const comparison = { maxAbsError: 1e-3, meanAbsError: 1e-4, worstIndex: 7 };
    expect(() => expectWithinTolerance(comparison, 1e-5, 'cmy_film')).toThrow(
      /cmy_film/,
    );
  });

  it('pesan galat menyertakan ambang, magnitudo, dan lokasi terburuk', () => {
    const comparison = { maxAbsError: 1.234e-3, meanAbsError: 5.6e-4, worstIndex: 7 };
    expect(() => expectWithinTolerance(comparison, 1e-5, 'gray_ramp/cmy_film')).toThrow(
      /1\.234e-3.*1\.000e-5.*piksel 2, kanal G/s,
    );
  });

  it('lulus diam-diam ketika di dalam ambang', () => {
    const comparison = { maxAbsError: 1e-7, meanAbsError: 1e-8, worstIndex: 0 };
    expect(() => expectWithinTolerance(comparison, 1e-5, 'gray_ramp/cmy_film')).not.toThrow();
  });

  it('memuat fixture gray_ramp', () => {
    const meta = loadCase('gray_ramp');
    expect(meta.width).toBe(32);
    expect(meta.height).toBe(16);
    const tap = loadTap('gray_ramp', 'cmy_film');
    expect(tap).toHaveLength(meta.width * meta.height * 3);
  });

  it('memperluas input RGB rapat fixture menjadi RGBA dengan alpha 1', () => {
    const meta = loadCase('gray_ramp');
    const rgba = loadInputAsRgba('gray_ramp');
    const rgb = loadTap('gray_ramp', 'input');
    expect(rgba).toHaveLength(meta.width * meta.height * 4);
    for (let p = 0; p < meta.width * meta.height; p += 1) {
      expect(rgba[p * 4]).toBe(rgb[p * 3]);
      expect(rgba[p * 4 + 1]).toBe(rgb[p * 3 + 1]);
      expect(rgba[p * 4 + 2]).toBe(rgb[p * 3 + 2]);
      expect(rgba[p * 4 + 3]).toBe(1);
    }
  });

  // Perbandingan tegak lurus dengan pemuatan fixture nyata, bukan cuma
  // data sintetis: rgb_pre dibandingkan dengan dirinya sendiri harus nol
  // galat persis (data f32 identik, bukan hasil komputasi ulang), jadi
  // ini juga memverifikasi loadInputAsRgba dan loadTap membaca fixture
  // yang sama dan bukan berkas yang berbeda secara diam-diam.
  it('rgb_pre fixture dibandingkan dengan dirinya sendiri sendiri adalah nol galat', () => {
    const rgbPre = loadTap('gray_ramp', 'rgb_pre');
    const asRgba = new Float32Array((rgbPre.length / 3) * 4);
    for (let p = 0; p < rgbPre.length / 3; p += 1) {
      asRgba[p * 4] = rgbPre[p * 3]!;
      asRgba[p * 4 + 1] = rgbPre[p * 3 + 1]!;
      asRgba[p * 4 + 2] = rgbPre[p * 3 + 2]!;
      asRgba[p * 4 + 3] = 1;
    }
    const result = compareRgb(asRgba, rgbPre);
    expect(result.maxAbsError).toBe(0);
    expect(result.worstIndex).toBe(0);
  });
});
