// @extends cameraNatural -- membalik gaya ISP pada input ter-encode, digerbangi referensi CPU host/naturalize.ts
import { describe, expect, it } from 'vitest';
import { inverseSmoothstep, naturalPixel, pixelNoise } from '../src/host/naturalize';
import type { NaturalFrame } from '../src/host/naturalize';
import { createNaturalStage } from '../src/engine/stages/natural';
import { RenderGraph } from '../src/engine/graph';
import { Tap } from '../src/engine/taps';
import { buildChain } from '../src/engine/chain';
import { buildRenderPlan, validateCamera } from '../src/params/plan';
import { BASELINE_RENDER_PARAMS } from '../src/params/renderParams';
import type { RenderParams } from '../src/params/renderParams';
import { findTool } from '../src/ui/model/tools';
import { Session } from '../src/session/session';
import { sharedResources } from './parity/run';

const PRINT = { printStockId: 'kodak_portra_endura', enlargerFilters: { cFilterNeutral: 0, mFilterNeutral: 51.56801468495496, mFilterShift: 0, yFilterNeutral: 52.53400422349596, yFilterShift: 0 } };
const W = 64, H = 48;
const NATURAL: RenderParams = { ...BASELINE_RENDER_PARAMS, inputColorSpace: 'sRGB', inputCctfDecoding: true, cameraNatural: 1 };

/** "Foto HP": langit terang hampir terpotong, subjek jenuh, bayangan; ter-encode sRGB. */
function phonePhoto(): Float32Array {
  const rgba = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    let c: [number, number, number];
    if (y < 12) c = [0.97, 0.985, 0.995];
    else if (x < 24) c = [0.86, 0.32, 0.18];
    else if (x < 44) c = [0.42, 0.44, 0.46];
    else c = [0.08, 0.09, 0.12];
    rgba.set([...c, 1], (y * W + x) * 4);
  }
  return rgba;
}

async function naturalFrameFor(params: RenderParams, rgba = phonePhoto()) {
  const { bundle } = await sharedResources('kodak_portra_400', PRINT);
  return buildRenderPlan(params, bundle, { width: W, height: H, rgba }, 'image');
}

describe('Natural: referensi', () => {
  it('kebalikan kurva S kamera tepat (smoothstep -> inverse = identitas)', () => {
    for (const x of [0, 0.1, 0.25, 0.5, 0.8, 1]) expect(inverseSmoothstep(3 * x * x - 2 * x ** 3)).toBeCloseTo(x, 9);
    // Derau ~N(0,1): rata-rata ~0, simpangan ~1.
    let s = 0, s2 = 0;
    for (let i = 0; i < 20000; i += 1) { const n = pixelNoise(i % 200, Math.floor(i / 200)); s += n; s2 += n * n; }
    expect(Math.abs(s / 20000)).toBeLessThan(0.03);
    expect(Math.sqrt(s2 / 20000)).toBeGreaterThan(0.9);
    expect(Math.sqrt(s2 / 20000)).toBeLessThan(1.1);
  });

  it('highlight dekat-terpotong diperluas di atas 1.0; warna jenuh diturunkan; abu tengah hampir tetap', async () => {
    const plan = await naturalFrameFor(NATURAL);
    const f = plan.frame.natural as NaturalFrame;
    const decode = (v: number) => {
      const t = Math.min(Math.max((v - f.lutMin) / (f.lutMax - f.lutMin), 0), 1) * (f.lut.length - 1);
      const i = Math.min(Math.floor(t), f.lut.length - 2);
      return f.lut[i]! + (f.lut[i + 1]! - f.lut[i]!) * (t - i);
    };
    const sky = naturalPixel([0.97, 0.985, 0.995], 10, 4, W, H, f);
    expect(decode(Math.max(...sky)), 'langit melewati putih JPEG').toBeGreaterThan(1.0);
    const subject = naturalPixel([0.86, 0.32, 0.18], 10, 30, W, H, f);
    const satIn = (0.86 - 0.18) / 0.86;
    const lin = subject.map(decode);
    const satOut = (Math.max(...lin) - Math.min(...lin)) / Math.max(...lin);
    const linIn = [0.86, 0.32, 0.18].map(decode);
    const satLinIn = (Math.max(...linIn) - Math.min(...linIn)) / Math.max(...linIn);
    expect(satOut, `saturasi ${satIn.toFixed(2)}`).toBeLessThan(satLinIn);
    const grey = naturalPixel([0.42, 0.44, 0.46], 34, 30, W, H, f);
    for (let c = 0; c < 3; c += 1) expect(Math.abs(grey[c]! - [0.42, 0.44, 0.46][c]!)).toBeLessThan(0.06);
    // Saturasi normal (di bawah knee vibrance) praktis tidak berubah: kurva tone
    // dibalik pada luminans saja, bukan per kanal.
    const skin = naturalPixel([0.6, 0.52, 0.47], 34, 30, W, H, f).map(decode);
    const skinIn = [0.6, 0.52, 0.47].map(decode);
    const sat = (c: number[]) => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
    expect(sat(skinIn)).toBeLessThan(0.55);
    expect(Math.abs(sat(skin) - sat(skinIn)) / sat(skinIn)).toBeLessThan(0.03);
    expect(() => validateCamera({ ...NATURAL, cameraNatural: 1.01 })).toThrow();
  });
});

describe('Natural: rencana dan GPU', () => {
  it('hanya untuk input ter-encode; menaikkan Soften Detail; urutan sebelum filmExposure', async () => {
    const { engine, arenas } = await sharedResources('kodak_portra_400', PRINT);
    const on = await naturalFrameFor(NATURAL);
    expect(on.chain.natural).toBe(true);
    expect(on.chain.softenDetail).toBe(true);
    expect(on.frame.softenDetail!.amount).toBeCloseTo(0.5, 12);
    const stages = buildChain(engine.device, arenas, on.chain).map((s) => s.name);
    expect(stages.indexOf('softenDetail')).toBeLessThan(stages.indexOf('natural'));
    expect(stages.indexOf('natural')).toBeLessThan(stages.indexOf('filmExposure'));
    // RAW/EXR (tanpa decode CCTF), nilai 0, dan kubus: tahap tidak ada.
    expect((await naturalFrameFor({ ...NATURAL, inputCctfDecoding: false, inputColorSpace: 'ACES2065-1' })).chain.natural).toBeUndefined();
    expect((await naturalFrameFor({ ...NATURAL, cameraNatural: 0 })).chain.natural).toBeUndefined();
    const { bundle } = await sharedResources('kodak_portra_400', PRINT);
    expect(buildRenderPlan(NATURAL, bundle, { width: W, height: H, rgba: phonePhoto() }, 'cube').chain.natural).toBeUndefined();
    // Soften Detail pilihan pengguna yang lebih besar tidak diturunkan.
    expect((await naturalFrameFor({ ...NATURAL, cameraSoftenDetail: 0.8 })).frame.softenDetail!.amount).toBe(0.8);
    expect(findTool('cameraNatural')).toMatchObject({ requires: 'inputCctfDecoding' });
  }, 120_000);

  it('GPU = referensi CPU, dan render ter-tile tanpa sambungan', async () => {
    const { engine } = await sharedResources('kodak_portra_400', PRINT);
    const rgba = phonePhoto();
    const plan = await naturalFrameFor(NATURAL, rgba);
    const f = plan.frame.natural as NaturalFrame;
    const graph = new RenderGraph(engine);
    graph.addStage(createNaturalStage(engine.device));
    const result = await graph.run(rgba, plan.core, Tap.RGB_PRE, { frame: plan.frame });
    let error = 0;
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      const ref = naturalPixel([rgba[i]!, rgba[i + 1]!, rgba[i + 2]!], x, y, W, H, f);
      for (let c = 0; c < 3; c += 1) error = Math.max(error, Math.abs(result[i + c]! - ref[c]!));
      expect(result[i + 3]).toBe(rgba[i + 3]);
    }
    expect(error).toBeLessThan(2e-4);
    const tiled = await graph.run(rgba, plan.core, Tap.RGB_PRE, { frame: plan.frame, maxBufferBytes: 12000, overlap: 0 });
    let seam = 0;
    for (let i = 0; i < result.length; i += 1) seam = Math.max(seam, Math.abs(tiled[i]! - result[i]!));
    expect(seam).toBe(0);
    graph.dispose();
  }, 120_000);

  it('Session: menyalakan mengubah hasil, mematikan kembali bit-identik', async () => {
    const { engine, bundle } = await sharedResources('kodak_portra_400', PRINT);
    const session = await Session.create({ assetsBaseUrl: 'public/data', engine, bundle,
      arenaProvider: { get: async (_key, inputs) => (await sharedResources(inputs.stockId, inputs.printScan)).arenas } });
    try {
      session.open({ width: W, height: H, rgba: phonePhoto(), suggestedColorSpace: 'sRGB', encoding: 'encoded', source: { format: 'fixture', bitDepth: 32 } });
      session.setParams({ autoExposure: false, grainEnabled: false, glareEnabled: false, inputColorSpace: 'sRGB', inputCctfDecoding: true });
      const before = await session.render('preview');
      session.setParams({ cameraNatural: 1 });
      const after = await session.render('preview');
      let difference = 0;
      for (let i = 0; i < before.rgb.length; i += 1) difference = Math.max(difference, Math.abs(after.rgb[i]! - before.rgb[i]!));
      expect(difference).toBeGreaterThan(0.01);
      session.setParams({ cameraNatural: 0 });
      expect((await session.render('preview')).rgb).toEqual(before.rgb);
    } finally { session.dispose(); }
  }, 120_000);
});
