import { describe, it, expect } from 'vitest';
import { longEdgeDetents } from '../../src/ui/model/exportSizes';
import { asciiName, exportFileName, formatBytes } from '../../src/ui/share';
import { rgbToRgba8, clampQuality } from '../../src/io/canvasEncode';

describe('detent sisi panjang ekspor', () => {
  it('hanya detent yang memperkecil, lalu Source', () => {
    expect(longEdgeDetents(6000, 4000).map((d) => [d.label, d.width, d.height, d.request])).toEqual([
      ['2048', 2048, 1365, 2048],
      ['4096', 4096, 2731, 4096],
      ['Source · 6000', 6000, 4000, undefined],
    ]);
    expect(longEdgeDetents(1200, 800).map((d) => d.label)).toEqual(['Source · 1200']);
    // Potret: sisi panjang = tinggi.
    expect(longEdgeDetents(3000, 4500)[0]).toMatchObject({ width: 1365, height: 2048 });
  });

  it('batas kanvas iOS (16,7 MP) memberi "Max" untuk format lossy', () => {
    const detents = longEdgeDetents(8064, 6048, { area: 16_777_216, side: 16_384 });
    const last = detents[detents.length - 1]!;
    expect(last.label).toBe('Max · 4729');
    expect(last.request).toBe(4729);
    expect(last.width * last.height).toBeLessThanOrEqual(16_777_216);
    expect(detents.map((d) => d.longEdge)).toEqual([2048, 4096, null]);
  });
});

describe('nama berkas ekspor', () => {
  it('ASCII polos (Chromium membuang nama download non-ASCII)', () => {
    expect(asciiName('Café — night')).toBe('Cafe - night');
    expect(exportFileName('IMG_0012.HEIC', 'Kodak Portra 400', 'Kodak Endura Premier', 'jpg')).toBe(
      'IMG_0012 - Kodak Portra 400 on Kodak Endura Premier.jpg',
    );
    expect(exportFileName(undefined, 'Fujifilm Provia 100F', undefined, 'png')).toBe('photo - Fujifilm Provia 100F scan.png');
  });

  it('ukuran berkas', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
});

describe('encoder kanvas', () => {
  it('RGB f32 -> RGBA 8-bit: clamp, bulatkan, alfa penuh', () => {
    expect([...rgbToRgba8(Float32Array.of(0, 0.5, 1, -0.2, 1.4, 0.2), 2, 1)]).toEqual([0, 128, 255, 255, 0, 255, 51, 255]);
    expect(clampQuality(0)).toBe(0.01);
    expect(clampQuality(1.5)).toBe(1);
    expect(clampQuality(Number.NaN)).toBe(1);
  });
});
