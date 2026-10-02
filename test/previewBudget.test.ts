import { describe, expect, it } from 'vitest';
import { planTiles } from '../src/engine/tiling';
import { previewRenderLongEdge } from '../src/session/session';
import { BASELINE_RENDER_PARAMS } from '../src/params/renderParams';
import { MOBILE_PREVIEW_PIXELS } from '../src/io/budget';

describe('bounded developing work', () => {
  it('uses a single full frame when it fits, even with an enormous spatial margin', () => {
    const tiles = planTiles(8144, 5424, 8144 * 5424 * 16, 10000);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.activeWidth).toBe(8144);
    expect(tiles[0]!.activeHeight).toBe(5424);
  });
  it('rejects impossible margins before allocating millions of tiny tiles', () => {
    expect(() => planTiles(8144, 5424, 128 * 1024 * 1024, 10000)).toThrow(/GPU tile budget/);
  });
  it('retains deliberate tiling for parity verification', () => {
    expect(planTiles(64, 64, 65536, 16)).toHaveLength(1);
    expect(planTiles(64, 64, 65536, 16, true)).toHaveLength(4);
  });
  it.each([[8144, 5424], [5120, 7168]])('limits zoom previews to RAM and grain binding capacity: %i x %i', (w, h) => {
    const binding = 128 * 1024 * 1024;
    const edge = previewRenderLongEdge(w, h, Math.max(w, h), BASELINE_RENDER_PARAMS, binding, 1024 * 1024 * 1024);
    const short = Math.round(edge * Math.min(w, h) / Math.max(w, h));
    expect(edge * short * 48).toBeLessThanOrEqual(binding);
    expect(planTiles(edge, short, binding, 10000)).toHaveLength(1);
    expect(previewRenderLongEdge(w, h, 512, BASELINE_RENDER_PARAMS, binding)).toBe(512);
  });
  it('caps mobile zoom before the renderer allocates a multi-megapixel GPU frame', () => {
    const edge = previewRenderLongEdge(6000, 4000, 6000, BASELINE_RENDER_PARAMS, 128 * 1024 * 1024, 768 * 1024 * 1024);
    const short = Math.round(edge * 4000 / 6000);
    expect(edge * short).toBeLessThanOrEqual(MOBILE_PREVIEW_PIXELS);
    expect(edge).toBeGreaterThan(1024);
  });
});
