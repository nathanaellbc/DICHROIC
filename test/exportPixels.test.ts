import { describe, expect, it } from 'vitest';
import { ExportPixels } from '../src/session/exportPixels';
import { quantize } from '../src/io/encode';
import { rgbToCanvas } from '../src/io/display';
import { EXPORT_GPU_BYTES_PER_PIXEL, planExportTiles } from '../src/engine/tiling';
import { loadAssets } from '../src/profiles/load';
import { buildRenderPlan } from '../src/params/plan';
import { BASELINE_RENDER_PARAMS } from '../src/params/renderParams';
import { outputColorSpaces } from '../public/data/manifest.json';
import type { OutputColorSpaceSpec } from '../src/profiles/types';

const spaces = outputColorSpaces as unknown as Record<string, OutputColorSpaceSpec>;

describe('final export tiles', () => {
  it('packs both bit depths exactly from floats, including partial rows and nonfinite samples', () => {
    const rgb = new Float32Array([0.5, -1, NaN, Infinity, 0.007, 0.9999, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8]);
    const pixels = new ExportPixels(2, 2, 'sRGB', spaces);
    pixels.draw(rgb.subarray(0, 6), 0, 0, 2, 1);
    pixels.draw(rgb.subarray(6, 9), 0, 1, 1, 1);
    pixels.draw(rgb.subarray(9), 1, 1, 1, 1);
    expect(pixels.rgb8).toEqual(quantize(rgb, 8));
    expect(pixels.rgb16).toEqual(quantize(rgb, 16));
    expect(quantize(pixels.rgb8, 8)).toBe(pixels.rgb8);
    expect(quantize(pixels.rgb16, 16)).toBe(pixels.rgb16);
    expect(pixels.canvas()).toEqual(rgbToCanvas(rgb, 2, 2, 'sRGB'));
    expect(pixels.rgb8.byteLength + pixels.rgb16.byteLength).toBe(2 * 2 * 9);
  });

  it('converts wide-gamut float tiles before clipping to integer samples', () => {
    const rgb = new Float32Array([1.1, -0.02, 0.5, 0.1, 0.5, 0.9]);
    const pixels = new ExportPixels(2, 1, 'ProPhoto RGB', spaces);
    pixels.draw(rgb.subarray(0, 3), 0, 0, 1, 1);
    pixels.draw(rgb.subarray(3), 1, 0, 1, 1);
    expect(pixels.canvas()).toEqual(rgbToCanvas(rgb, 2, 1, 'ProPhoto RGB', 'srgb', spaces));
  });

  it('covers irregular images exactly once and keeps every tile within the GPU budget', () => {
    const width = 2049; const height = 1025; const binding = 128 * 1024 * 1024;
    const budget = 16 * 1024 * 1024;
    const tiles = planExportTiles(width, height, binding, 0, budget);
    expect(tiles.length).toBeGreaterThan(1);
    const coverage = new Uint8Array(width * height);
    for (const t of tiles) {
      expect(t.tileWidth * t.tileHeight * EXPORT_GPU_BYTES_PER_PIXEL).toBeLessThanOrEqual(budget);
      for (let row = 0; row < t.activeHeight; row++) for (let col = 0; col < t.activeWidth; col++) {
        coverage[(t.activeOriginY + row) * width + t.activeOriginX + col]!++;
      }
    }
    expect(coverage.every((v) => v === 1)).toBe(true);
  });

  it('iPhone 4096 px export: 5-sigma apron keeps tiles near the mobile budget with little rework', async () => {
    const bundle = await loadAssets('public/data');
    const image = { width: 4096, height: 3072, rgba: new Float32Array(16) };
    const plan = buildRenderPlan({ ...BASELINE_RENDER_PARAMS, autoExposure: false }, bundle, image, 'image');
    // 10 sigma + konstanta OFX (pratinjau/parity) vs 5 sigma fisik (ekspor).
    expect(plan.overlap).toBeGreaterThan(1000);
    expect(plan.exportOverlap).toBeLessThan(plan.overlap / 2);
    const budget = 384 * 1024 * 1024;
    const tiles = planExportTiles(4096, 3072, 256 * 1024 * 1024, plan.exportOverlap, budget);
    const work = tiles.reduce((a, t) => a + t.tileWidth * t.tileHeight, 0) / (4096 * 3072);
    const peak = Math.max(...tiles.map((t) => t.tileWidth * t.tileHeight)) * EXPORT_GPU_BYTES_PER_PIXEL;
    expect(peak).toBeLessThanOrEqual(budget);
    expect(work).toBeLessThan(5); // dulu 66,8x (apron 10 sigma)
    for (const t of tiles) {
      expect(t.tileOriginX).toBe(Math.max(0, t.activeOriginX - plan.exportOverlap));
      expect(t.tileOriginY).toBe(Math.max(0, t.activeOriginY - plan.exportOverlap));
    }
  });

  it('includes the entire spatial apron while enforcing hard GPU binding limits', () => {
    const tiles = planExportTiles(2049, 1025, 128 * 1024 * 1024, 100, 16 * 1024 * 1024);
    for (const t of tiles) {
      expect(t.tileOriginX).toBeLessThanOrEqual(Math.max(0, t.activeOriginX - 100));
      expect(t.tileOriginY).toBeLessThanOrEqual(Math.max(0, t.activeOriginY - 100));
      expect(t.tileOriginX + t.tileWidth).toBeGreaterThanOrEqual(Math.min(2049, t.activeOriginX + t.activeWidth + 100));
      expect(t.tileOriginY + t.tileHeight).toBeGreaterThanOrEqual(Math.min(1025, t.activeOriginY + t.activeHeight + 100));
      expect(t.tileWidth * t.tileHeight * 16).toBeLessThanOrEqual(128 * 1024 * 1024);
    }
    expect(() => planExportTiles(4000, 4000, 1024 * 1024, 500, 16 * 1024 * 1024)).toThrow(/margins/);
  });
});
