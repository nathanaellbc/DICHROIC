import { describe, it, expect, beforeEach } from 'vitest';
import { boxDownscale, boxDownscaleRegion, boxDownscaleSize, measurementImage } from '../src/session/downscale';
import { measureAutoExposureEv } from '../src/host/autoExposure';
import { measureScenePivot } from '../src/host/cameraDevelop';
import { MIN_EXPORT_TILE_SCALE, exportTileMemoryBudget } from '../src/io/budget';
import { EXPORT_TILES_KEY, finishExportEncode, finishExportTiles, noteExportStage, previousExportCrash, rememberExportTiles, startExportEncode, startExportTiles } from '../src/ui/engine/exportTiles';

function noise(w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 4);
  let seed = 12345;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out[i] = (seed / 2 ** 32) * 4;
  }
  return out;
}

describe('ekspor membaca tile langsung dari sumber', () => {
  it('boxDownscaleRegion == wilayah boxDownscale, bit demi bit', () => {
    const [W, H] = [517, 389];
    const src = noise(W, H);
    for (const edge of [517, 300, 211, 64]) {
      const full = boxDownscale(src, W, H, edge);
      const size = boxDownscaleSize(W, H, edge);
      expect([full.width, full.height]).toEqual([size.width, size.height]);
      for (const [x, y, w, h] of [[0, 0, size.width, size.height], [7, 13, 40, 29], [size.width - 11, size.height - 5, 11, 5]]) {
        const region = boxDownscaleRegion(src, W, H, size.width, size.height, x!, y!, w!, h!);
        for (let row = 0; row < h!; row++) {
          const start = ((y! + row) * size.width + x!) * 4;
          expect(region.subarray(row * w! * 4, (row + 1) * w! * 4)).toEqual(full.rgba.subarray(start, start + w! * 4));
        }
      }
    }
  });

  it('pengukuran auto-exposure dan pivot pada kisi kecil == pada frame utuh', () => {
    const [W, H] = [1203, 811];
    const src = noise(W, H);
    const meter = Float32Array.from({ length: 9 * 4 }, (_, i) => [0.2, 0.7, 0.1][i % 3]!);
    for (const edge of [1203, 900, 300, 200]) {
      const full = boxDownscale(src, W, H, edge);
      const m = measurementImage(src, W, H, full.width, full.height);
      expect(Math.max(m.width, m.height)).toBeLessThanOrEqual(256);
      expect(measureAutoExposureEv(m.rgba, m.width, m.height, meter, 1)).toBe(measureAutoExposureEv(full.rgba, full.width, full.height, meter, 1));
      expect(measureScenePivot(m.rgba, m.width, m.height, [0.2, 0.7, 0.1])).toBe(measureScenePivot(full.rgba, full.width, full.height, [0.2, 0.7, 0.1]));
    }
  });
});

describe('anggaran tile adaptif', () => {
  it('dibatasi maxBufferSize GPU dan diskalakan, dengan lantai', () => {
    const start = exportTileMemoryBudget();
    expect(exportTileMemoryBudget(16 * 2 ** 20)).toBe(192 * 2 ** 20);
    expect(exportTileMemoryBudget(Infinity, 0.5)).toBe(Math.floor(start / 2));
    expect(exportTileMemoryBudget(Infinity, 0)).toBe(Math.floor(start * MIN_EXPORT_TILE_SCALE));
  });

  class MemoryStore {
    data = new Map<string, string>();
    getItem(k: string) { return this.data.get(k) ?? null; }
    setItem(k: string, v: string) { this.data.set(k, v); }
  }
  let store: MemoryStore;
  beforeEach(() => { store = new MemoryStore(); });

  it('Develop yang mati di tengah jalan membagi dua skala berikutnya dan mencatat tahapnya', () => {
    expect(startExportTiles(store)).toBe(1);
    finishExportTiles(true, store);
    expect(startExportTiles(store)).toBe(1);
    noteExportStage('tile 12/35', store);
    // Tab mati: finish tidak pernah terpanggil pada store ini.
    finishExportTiles(false, new MemoryStore());
    expect(previousExportCrash(store)).toBe('tile 12/35');
    expect(startExportTiles(store)).toBe(0.5);
    finishExportTiles(true, store);
    expect(previousExportCrash(store)).toBeUndefined();
    rememberExportTiles(0.25, store);
    expect(startExportTiles(store)).toBe(0.25);
    finishExportTiles(true, store);
    expect(JSON.parse(store.getItem(EXPORT_TILES_KEY)!)).toEqual({ scale: 0.25, pending: false });
  });

  it('encode yang mati dicatat tanpa mengecilkan tile', () => {
    startExportEncode('png8', store);
    finishExportEncode(new MemoryStore());
    expect(previousExportCrash(store)).toBe('Encoding png8');
    expect(startExportTiles(store)).toBe(1);
    finishExportTiles(true, store);
  });

  it('tidak pernah di bawah lantai, dan penyimpanan rusak = skala penuh', () => {
    store.setItem(EXPORT_TILES_KEY, JSON.stringify({ scale: MIN_EXPORT_TILE_SCALE, pending: true }));
    expect(startExportTiles(store)).toBe(MIN_EXPORT_TILE_SCALE);
    finishExportTiles(false, store);
    store.setItem(EXPORT_TILES_KEY, '{oops');
    expect(startExportTiles(store)).toBe(1);
    finishExportTiles(false, store);
  });
});
