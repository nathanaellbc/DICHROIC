import { it, expect } from 'vitest';
import { buildRenderPlan } from '../src/params/plan';
import { BASELINE_RENDER_PARAMS } from '../src/params/renderParams';
import { buildChain } from '../src/engine/chain';
import { RenderGraph, ScratchPool } from '../src/engine/graph';
import { Tap } from '../src/engine/taps';
import { planExportTiles } from '../src/engine/tiling';
import { sharedResources } from './parity/run';

/**
 * Apron ekspor 5 sigma (`EXPORT_APRON_SIGMAS`, `plan.exportOverlap`): ekspor
 * ter-tile harus sama dengan render frame utuh di rgb_out dalam ambang parity
 * 1e-5. Format standard16 pada 1536 px = pitch 6,7 um (lebih halus dari ekspor
 * 4096 px 35 mm, jadi radius blur dalam piksel lebih besar -- kasus lebih
 * berat), highlight 20x untuk ekor halation/DIR yang panjang.
 */
const PRINT = { printStockId: 'kodak_portra_endura', enlargerFilters: { cFilterNeutral: 0, mFilterNeutral: 51.56801468495496, mFilterShift: 0, yFilterNeutral: 52.53400422349596, yFilterShift: 0 } };

function scene(w: number, h: number) {
  const rgba = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0.02 + (0.6 * x) / w;
    if ((x >> 6) % 2 === (y >> 6) % 2) v *= 0.3;
    for (const [cx, cy] of [[0.3, 0.4], [0.62, 0.55], [0.5, 0.2], [0.8, 0.8]]) if ((x - cx! * w) ** 2 + (y - cy! * h) ** 2 < 400) v = 20;
    rgba.set([v, v * 0.85, v * 0.7, 1], (y * w + x) * 4);
  }
  return { width: w, height: h, rgba };
}

it('ekspor ter-tile dengan apron 5 sigma == frame utuh (<= 1e-5 rgb_out)', async () => {
  const { engine, bundle, arenas } = await sharedResources('kodak_portra_400', PRINT);
  const w = 1536; const h = 1024;
  const img = scene(w, h);
  const params = { ...BASELINE_RENDER_PARAMS, autoExposure: false, grainEnabled: false, glareEnabled: false, filmFormat: 'standard16' as const };
  const plan = buildRenderPlan(params, bundle, img, 'image');
  expect(plan.exportOverlap).toBeLessThan(plan.overlap);
  const graph = new RenderGraph(engine, new ScratchPool(engine.device));
  try {
    for (const s of buildChain(engine.device, arenas, plan.chain)) graph.addStage(s);
    const render = async (budget: number, whole: boolean) => {
      const out = new Float32Array(w * h * 3);
      await graph.runToTiles(img.rgba, plan.core, Tap.RGB_OUT, (rgb, t) => {
        for (let r = 0; r < t.activeHeight; r++) out.set(rgb.subarray(r * t.activeWidth * 3, (r + 1) * t.activeWidth * 3), ((t.activeOriginY + r) * w + t.activeOriginX) * 3);
      }, { maxBufferBytes: 2 ** 31, memoryBudget: budget, overlap: plan.overlap, exportOverlap: plan.exportOverlap, frame: plan.frame, wholeFrame: whole });
      return out;
    };
    const reference = await render(0, true);
    const budget = 160 * 2 ** 20;
    expect(planExportTiles(w, h, 2 ** 31, plan.exportOverlap, budget).length).toBeGreaterThan(1);
    const tiled = await render(budget, false);
    let max = 0;
    for (let i = 0; i < tiled.length; i++) max = Math.max(max, Math.abs(tiled[i]! - reference[i]!));
    expect(max, `jahitan rgb_out ${max.toExponential(2)}`).toBeLessThanOrEqual(1e-5);
  } finally { graph.dispose(); }
}, 600_000);

it('buffer uniform per tile dihancurkan setelah tiap tile (tidak menumpuk menunggu GC)', async () => {
  const { engine, bundle, arenas } = await sharedResources('kodak_portra_400', PRINT);
  const w = 768; const h = 512;
  const img = scene(w, h);
  const params = { ...BASELINE_RENDER_PARAMS, autoExposure: false, filmFormat: 'standard16' as const };
  const plan = buildRenderPlan(params, bundle, img, 'image');
  const graph = new RenderGraph(engine, new ScratchPool(engine.device));
  const device = engine.device as GPUDevice & { createBuffer: GPUDevice['createBuffer'] };
  const live = new Set<GPUBuffer>();
  try {
    for (const s of buildChain(engine.device, arenas, plan.chain)) graph.addStage(s);
    const original = device.createBuffer.bind(device);
    device.createBuffer = (descriptor: GPUBufferDescriptor) => {
      const buffer = original(descriptor);
      if (descriptor.size <= 4096) {
        live.add(buffer); (buffer as unknown as { _l: string })._l = String(descriptor.label);
        const destroy = buffer.destroy.bind(buffer);
        buffer.destroy = () => { live.delete(buffer); destroy(); };
      }
      return buffer;
    };
    const budget = 24 * 2 ** 20;
    const tiles = planExportTiles(w, h, 2 ** 31, plan.exportOverlap, budget).length;
    expect(tiles).toBeGreaterThan(2);
    let drawn = 0;
    await graph.runToTiles(img.rgba, plan.core, Tap.RGB_OUT, () => { drawn += 1; }, {
      maxBufferBytes: 2 ** 31, memoryBudget: budget, overlap: plan.overlap, exportOverlap: plan.exportOverlap, frame: plan.frame,
    });
    expect(drawn).toBe(tiles);
    const labels: Record<string, number> = {}; for (const b of live) { const l = (b as unknown as { _l: string })._l; labels[l] = (labels[l] ?? 0) + 1; }
    expect(labels).toEqual({});
  } finally {
    delete (device as unknown as Record<string, unknown>).createBuffer;
    graph.dispose();
  }
}, 600_000);
