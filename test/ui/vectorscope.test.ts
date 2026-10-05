import { describe, it, expect } from 'vitest';
import { SKIN_TONE_ANGLE_DEG, accumulateScope, angleDeg, scopeTargets, shadeScope, toCbCr } from '../../src/ui/model/vectorscope';

/**
 * Vectorscope harus membaca sama dengan DaVinci Resolve / vectorscope siaran
 * BT.709: sudut target bar warna standar, target 100 % di lingkaran
 * graticule (|C| ~ 0.5), dan garis skin tone pada 123 derajat.
 */
describe('vectorscope Rec.709', () => {
  it("sudut target bar warna = Y'CbCr BT.709 (bukan sudut BT.601 lama)", () => {
    const want: Record<string, number> = { R: 102.91, Mg: 49.68, B: 354.76, Cy: 282.91, G: 229.68, Yl: 174.76 };
    for (const t of scopeTargets(1)) expect(angleDeg(t.cb, t.cr), t.label).toBeCloseTo(want[t.label]!, 1);
  });

  it('magnitudo target 100 % Rec.709 (lingkaran = 0.5), 75 % di tiga perempat', () => {
    const mag = (t: { cb: number; cr: number }) => Math.hypot(t.cb, t.cr);
    const full = scopeTargets(1);
    expect(mag(full.find((t) => t.label === 'B')!)).toBeCloseTo(0.5021, 4);
    expect(mag(full.find((t) => t.label === 'Yl')!)).toBeCloseTo(0.5021, 4);
    expect(mag(full.find((t) => t.label === 'R')!)).toBeCloseTo(0.513, 3);
    expect(mag(full.find((t) => t.label === 'G')!)).toBeCloseTo(0.5957, 4);
    scopeTargets(0.75).forEach((t, i) => expect(mag(t) / mag(full[i]!)).toBeCloseTo(0.75, 9));
  });

  it('netral di pusat; skin tone 123 derajat, di antara R dan Yl', () => {
    for (const v of [0, 0.18, 0.5, 1]) {
      const [cb, cr] = toCbCr(v, v, v);
      expect(Math.abs(cb) + Math.abs(cr)).toBeLessThan(1e-12);
    }
    expect(SKIN_TONE_ANGLE_DEG).toBe(123);
    // Kulit sRGB khas (mis. 224,172,140) jatuh dalam beberapa derajat dari garis.
    const [cb, cr] = toCbCr(224 / 255, 172 / 255, 140 / 255);
    expect(Math.abs(angleDeg(cb, cr) - SKIN_TONE_ANGLE_DEG)).toBeLessThan(8);
  });

  it('akumulasi: merah murni jatuh di bin target, zoom 2x menggandakan jarak', () => {
    const px = new Uint8ClampedArray([255, 0, 0, 255]);
    const size = 200;
    const radius = 90;
    for (const zoom of [1, 2] as const) {
      const trace = accumulateScope(px, 1, 1, size, radius, zoom);
      const k = trace.density.findIndex((d) => d > 0);
      const [cb, cr] = toCbCr(1, 0, 0);
      const scale = (radius * zoom) / 0.5;
      if (zoom === 2) {
        expect(k).toBe(-1); // 2x: merah 100 % di luar kisi, dibuang
        continue;
      }
      expect(k % size).toBe(Math.floor(size / 2 + cb * scale));
      expect(Math.floor(k / size)).toBe(Math.floor(size / 2 - cr * scale));
    }
  });

  it('shade: bin kosong transparan, bin terisi terlihat', () => {
    const px = new Uint8ClampedArray([128, 128, 128, 255, 128, 128, 128, 255]);
    const out = shadeScope(accumulateScope(px, 2, 1, 32, 14, 1), false);
    const lit = [];
    for (let k = 0; k < 32 * 32; k += 1) if (out[k * 4 + 3]! > 0) lit.push(k);
    expect(lit.length).toBeGreaterThan(0);
    expect(lit.length).toBeLessThanOrEqual(4);
  });
});
