import { describe, it, expect } from 'vitest';
import { WAVEFORM_LINES_10BIT, accumulateWaveform, levelRow, paradeGap, shadeWaveform } from '../../src/ui/model/waveform';

/** Waveform/parade: sumbu dan skala seperti DaVinci Resolve (10-bit, 0 di bawah). */
describe('waveform dan parade', () => {
  const rgba = (...px: Array<[number, number, number]>) => new Uint8ClampedArray(px.flatMap(([r, g, b]) => [r, g, b, 255]));
  const hit = (d: Float32Array, width: number) => {
    const k = d.findIndex((v) => v > 0);
    return k < 0 ? undefined : [k % width, Math.floor(k / width)];
  };

  it('graticule 10-bit Resolve dan pemetaan level', () => {
    expect([...WAVEFORM_LINES_10BIT]).toEqual([0, 128, 256, 384, 512, 640, 768, 896, 1023]);
    expect(levelRow(1, 101)).toBe(0);
    expect(levelRow(0, 101)).toBe(100);
    expect(levelRow(0.5, 101)).toBe(50);
    expect(levelRow(1.4, 101)).toBe(0); // superwhite dijepit ke tepi atas
  });

  it("waveform = Y' Rec.709: putih di atas, hitam di bawah, hijau murni di 0.7152", () => {
    const t = accumulateWaveform(rgba([255, 255, 255], [0, 0, 0], [0, 255, 0]), 3, 1, 3, 1001, false);
    expect(t.density).toHaveLength(1);
    const rows = [0, 1, 2].map((col) => {
      for (let r = 0; r < 1001; r += 1) if (t.density[0]![r * 3 + col]! > 0) return r;
      return -1;
    });
    expect(rows[0]).toBe(0);
    expect(rows[1]).toBe(1000);
    expect(Math.abs(rows[2]! - Math.round((1 - 0.7152) * 1000))).toBeLessThanOrEqual(1);
  });

  it('kolom gambar dipetakan ke kolom scope, kiri ke kanan', () => {
    const t = accumulateWaveform(rgba([128, 128, 128], [0, 0, 0], [0, 0, 0], [0, 0, 0]), 4, 1, 40, 64, false);
    expect(hit(t.density[0]!, 40)![0]).toBe(0);
  });

  it('parade: R, G, B di sepertiga masing-masing dengan celah', () => {
    const width = 300;
    const t = accumulateWaveform(rgba([255, 0, 0]), 1, 1, width, 64, true);
    const gap = paradeGap(width);
    const lane = Math.floor((width - 2 * gap) / 3);
    expect(t.density).toHaveLength(3);
    expect(hit(t.density[0]!, width)).toEqual([0, 0]); // R penuh di atas lajur 1
    expect(hit(t.density[1]!, width)).toEqual([lane + gap, 63]); // G nol di bawah lajur 2
    expect(hit(t.density[2]!, width)).toEqual([2 * (lane + gap), 63]);
    const shaded = shadeWaveform(t);
    expect(shaded[3]).toBeGreaterThan(0);
    expect(shaded[0]).toBeGreaterThan(shaded[1]!); // trace R kemerahan
  });
});
