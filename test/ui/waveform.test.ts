import { describe, it, expect } from 'vitest';
import {
  WAVEFORM_LINES_10BIT,
  accumulateWaveform,
  laneBox,
  levelRow,
  paradeLayout,
  shadeWaveform,
  waveformLayout,
} from '../../src/ui/model/waveform';

/** Waveform/parade: sumbu, skala, dan mode seperti DaVinci Resolve (10-bit, 0 di bawah). */
describe('waveform dan parade', () => {
  const rgba = (...px: Array<[number, number, number]>) => new Uint8ClampedArray(px.flatMap(([r, g, b]) => [r, g, b, 255]));
  const rowOf = (d: Float32Array, width: number, col: number, height: number) => {
    for (let r = 0; r < height; r += 1) if (d[r * width + col]! > 0) return r;
    return -1;
  };

  it('graticule 10-bit Resolve dan pemetaan level', () => {
    expect([...WAVEFORM_LINES_10BIT]).toEqual([0, 128, 256, 384, 512, 640, 768, 896, 1023]);
    expect(levelRow(1, 101)).toBe(0);
    expect(levelRow(0, 101)).toBe(100);
    expect(levelRow(0.5, 101)).toBe(50);
    expect(levelRow(1.4, 101)).toBe(0);
  });

  it("mode Y = Y' Rec.709: putih atas, hitam bawah, hijau murni di 0.7152", () => {
    const t = accumulateWaveform(rgba([255, 255, 255], [0, 0, 0], [0, 255, 0]), 3, 1, 3, 1001, waveformLayout('y'));
    expect(t.channels).toEqual(['y']);
    expect(rowOf(t.density[0]!, 3, 0, 1001)).toBe(0);
    expect(rowOf(t.density[0]!, 3, 1, 1001)).toBe(1000);
    expect(Math.abs(rowOf(t.density[0]!, 3, 2, 1001) - Math.round((1 - 0.7152) * 1000))).toBeLessThanOrEqual(1);
  });

  it('mode RGB bertumpuk dan kanal bisa dimatikan; CbCr netral di 0.5', () => {
    expect(waveformLayout('rgb').channels).toEqual(['r', 'g', 'b']);
    expect(waveformLayout('rgb', [true, false, true]).channels).toEqual(['r', 'b']);
    expect(waveformLayout('rgb').lanes).toBe(false);
    const t = accumulateWaveform(rgba([128, 128, 128]), 1, 1, 1, 101, waveformLayout('cbcr'));
    expect(t.channels).toEqual(['cb', 'cr']);
    for (const d of t.density) expect(Math.abs(rowOf(d, 1, 0, 101) - 50)).toBeLessThanOrEqual(1);
  });

  it('parade RGB / YRGB / YCbCr: lajur berdampingan dengan celah', () => {
    expect(paradeLayout('rgb').channels).toEqual(['r', 'g', 'b']);
    expect(paradeLayout('yrgb').channels).toEqual(['y', 'r', 'g', 'b']);
    expect(paradeLayout('ycbcr').channels).toEqual(['y', 'cb', 'cr']);
    const width = 300;
    const t = accumulateWaveform(rgba([255, 0, 0]), 1, 1, width, 64, paradeLayout('rgb'));
    const lanes = [0, 1, 2].map((i) => laneBox(width, 3, i));
    expect(rowOf(t.density[0]!, width, lanes[0]!.x, 64)).toBe(0);
    expect(rowOf(t.density[1]!, width, lanes[1]!.x, 64)).toBe(63);
    expect(rowOf(t.density[2]!, width, lanes[2]!.x, 64)).toBe(63);
    expect(lanes[1]!.x).toBeGreaterThan(lanes[0]!.width);
  });

  it('Colorize: RGB setara = putih, satu kanal = warnanya; mati = putih polos', () => {
    const grey = shadeWaveform(accumulateWaveform(rgba([128, 128, 128]), 1, 1, 1, 64, waveformLayout('rgb')), true);
    const k = grey.findIndex((v, i) => i % 4 === 3 && v > 0) - 3;
    expect(Math.min(grey[k]!, grey[k + 1]!, grey[k + 2]!)).toBeGreaterThan(230);
    const red = shadeWaveform(accumulateWaveform(rgba([255, 0, 0]), 1, 1, 1, 64, waveformLayout('rgb', [true, false, false])), true);
    expect(red[0]).toBe(255);
    expect(red[1]).toBeLessThan(80);
    const plain = shadeWaveform(accumulateWaveform(rgba([255, 0, 0]), 1, 1, 1, 64, waveformLayout('rgb', [true, false, false])), false);
    expect(Math.min(plain[0]!, plain[1]!, plain[2]!)).toBeGreaterThan(230);
  });

  it('Extents menandai nilai tertinggi/terendah per kolom; Low Pass meratakan derau', () => {
    const px = rgba([0, 0, 0], [255, 255, 255], [0, 0, 0], [255, 255, 255], [0, 0, 0]);
    const t = accumulateWaveform(px, 5, 1, 1, 101, waveformLayout('y'));
    expect([t.extentTop[0]![0], t.extentBottom[0]![0]]).toEqual([0, 100]);
    const smooth = accumulateWaveform(px, 5, 1, 1, 101, waveformLayout('y'), { lowPass: true });
    expect(smooth.extentTop[0]![0]).toBeGreaterThan(20);
    expect(smooth.extentBottom[0]![0]).toBeLessThanOrEqual(80);
  });
});
