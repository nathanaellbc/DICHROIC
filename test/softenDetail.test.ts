// @extends cameraSoftenDetail -- spatial input extension, checked against the independent CPU reference
import { describe, expect, it } from 'vitest';
import { softenDetailReference, softenKernel } from '../src/host/softenDetail';
import { createSoftenDetailStage } from '../src/engine/stages/softenDetail';
import { RenderGraph } from '../src/engine/graph';
import { Tap } from '../src/engine/taps';
import { buildRenderPlan, validateCamera } from '../src/params/plan';
import { BASELINE_RENDER_PARAMS } from '../src/params/renderParams';
import { sharedResources } from './parity/run';
import { buildChain } from '../src/engine/chain';
import { findTool, sliderPatch, sliderRange, valueText } from '../src/ui/model/tools';
import type { SliderTool } from '../src/ui/model/tools';

function input(width = 64, height = 48): Float32Array {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const level = (x < width / 2 ? 0.15 : 0.7) + ((x + y) % 2 ? 0.015 : -0.015);
    data.set([level, level * 0.7, level * 0.5, 1], (y * width + x) * 4);
  }
  return data;
}
const luma = [0.2126, 0.7152, 0.0722];
describe('Soften Detail', () => {
  it('UI exposes 0..100 and maps reset/default to a true bypass', () => {
    const tool = findTool('cameraSoftenDetail') as SliderTool;
    expect(sliderRange(tool, BASELINE_RENDER_PARAMS)).toEqual({ min: 0, max: 100, step: 1 });
    expect(sliderPatch(tool, 35)).toEqual({ cameraSoftenDetail: 0.35 });
    expect(valueText(tool, BASELINE_RENDER_PARAMS)).toBe('0');
  });
  it('neutral is exact; smoothing reduces fine texture while preserving edge contrast and chromaticity', () => {
    const data = input();
    expect(softenDetailReference(data, 64, 48, 0)).toEqual(data);
    const soft = softenDetailReference(data, 64, 48, 1, 4096);
    const index = (x: number) => (24 * 64 + x) * 4;
    expect(Math.abs(soft[index(12)]! - soft[index(13)]!)).toBeLessThan(Math.abs(data[index(12)]! - data[index(13)]!));
    expect(soft[index(40)]! - soft[index(20)]!).toBeGreaterThan(0.5);
    for (let p = 0; p < data.length; p += 4) {
      expect(soft[p + 1]! / soft[p]!).toBeCloseTo(data[p + 1]! / data[p]!, 6);
      expect(soft[p + 3]).toBe(data[p + 3]);
      expect(soft[p]).toBeGreaterThan(0);
    }
    expect(() => validateCamera({ ...BASELINE_RENDER_PARAMS, cameraSoftenDetail: 1.01 })).toThrow();
    expect(() => validateCamera({ ...BASELINE_RENDER_PARAMS, cameraSoftenDetail: NaN })).toThrow();
    expect(softenKernel(8192).sigma / softenKernel(4096).sigma).toBe(2);
  });

  it('GPU matches reference and tiled output has no seams', async () => {
    const { engine, bundle, arenas } = await sharedResources('kodak_portra_400', { printStockId: 'kodak_portra_endura', enlargerFilters: { cFilterNeutral: 0, mFilterNeutral: 51.56801468495496, mFilterShift: 0, yFilterNeutral: 52.53400422349596, yFilterShift: 0 } });
    const width = 64, height = 48, rgba = input();
    const plan = buildRenderPlan({ ...BASELINE_RENDER_PARAMS, cameraSoftenDetail: 1 }, bundle, { width, height, rgba }, 'image');
    expect(plan.chain.softenDetail).toBe(true);
    const stages = buildChain(engine.device, arenas, plan.chain).map((stage) => stage.name);
    expect(stages.indexOf('softenDetail')).toBeLessThan(stages.indexOf('filmExposure'));
    const neutral = buildRenderPlan(BASELINE_RENDER_PARAMS, bundle, { width, height, rgba }, 'image');
    expect(neutral.chain.softenDetail).toBeUndefined();
    expect(buildRenderPlan({ ...BASELINE_RENDER_PARAMS, cameraSoftenDetail: 1 }, bundle, { width, height, rgba }, 'cube').chain.softenDetail).toBeUndefined();
    const graph = new RenderGraph(engine);
    graph.addStage(createSoftenDetailStage(engine.device));
    const core = { ...plan.core, fullWidth: 4096, fullHeight: 3072 };
    const frame = { ...plan.frame, softenDetail: { amount: 1, luma } };
    const result = await graph.run(rgba, core, Tap.RGB_PRE, { frame });
    const expected = softenDetailReference(rgba, width, height, 1, 4096, luma);
    let error = 0;
    for (let i = 0; i < result.length; i++) error = Math.max(error, Math.abs(result[i]! - expected[i]!));
    expect(error).toBeLessThan(2e-5);
    const tiled = await graph.run(rgba, core, Tap.RGB_PRE, { frame, maxBufferBytes: 30000, overlap: 6 });
    let seamError = 0;
    for (let i = 0; i < result.length; i++) seamError = Math.max(seamError, Math.abs(tiled[i]! - result[i]!));
    expect(seamError).toBeLessThan(2e-6);
    graph.dispose();
  }, 120000);
});
