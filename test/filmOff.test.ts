// @extends filmEnabled paperOnly -- film bypass, camera output identity and cached Session transitions
import { describe, expect, it } from 'vitest';
import { Session } from '../src/session/session';
import { sharedResources } from './parity/run';
import { BASELINE_RENDER_PARAMS } from '../src/params/renderParams';
import { buildRenderPlan } from '../src/params/plan';
import { buildChain } from '../src/engine/chain';
import { stockPatch } from '../src/ui/model/tools';

const print = { printStockId: 'kodak_portra_endura', enlargerFilters: { cFilterNeutral: 0, mFilterNeutral: 51.56801468495496, mFilterShift: 0, yFilterNeutral: 52.53400422349596, yFilterShift: 0 } };
function image() {
  const rgba = new Float32Array(64 * 48 * 4);
  for (let p = 0; p < 64 * 48; p++) rgba.set([0.2 + (p % 64) / 100, 0.5, 0.3, 1], p * 4);
  return { width: 64, height: 48, rgba };
}
describe('Film Off', () => {
  it('Off preserves the selected stocks; selecting a film enables simulation', () => {
    expect(stockPatch('film', 'off', BASELINE_RENDER_PARAMS)).toEqual({ filmEnabled: false, paperOnly: false });
    expect(stockPatch('film', 'kodak_portra_400', BASELINE_RENDER_PARAMS)).toEqual({ filmEnabled: true, film: 'kodak_portra_400' });
  });
  it('skips film/paper/grain while preserving camera/lens stages and an output transform', async () => {
    const { engine, bundle, arenas } = await sharedResources('kodak_portra_400', print);
    const plan = buildRenderPlan({ ...BASELINE_RENDER_PARAMS, filmEnabled: false, inputColorSpace: 'sRGB', inputCctfDecoding: true, cameraHsvSaturation: 1.5, cameraSoftenDetail: 0.5 }, bundle, image(), 'image');
    const stages = buildChain(engine.device, arenas, plan.chain);
    expect(stages.map(s => s.name)).toEqual(['materializeActiveRegion', 'softenDetail', 'cameraLinear', 'cameraOutput']);
    expect(plan.frame.camera).toBeDefined();
    expect(plan.frame.cameraOutput).toHaveLength(16);
    expect(plan.frame.inputDecodeScale).toBe(1);
    const cube = buildRenderPlan({ ...BASELINE_RENDER_PARAMS, filmEnabled: false }, bundle, image(), 'cube');
    expect(cube.chain.filmOff).toBe(true);
  });
  it('Paper can render directly with film off, independent of the saved film, and export/reset work', async () => {
    const { engine, bundle } = await sharedResources('kodak_portra_400', print);
    const session = await Session.create({ assetsBaseUrl: 'public/data', engine, bundle,
      arenaProvider: { get: async (_key, inputs) => (await sharedResources(inputs.stockId, inputs.printScan)).arenas } });
    try {
      session.open({ ...image(), suggestedColorSpace: 'sRGB', encoding: 'encoded', source: { format: 'fixture', bitDepth: 32 } });
      session.setParams({ filmEnabled: false, inputColorSpace: 'sRGB', inputCctfDecoding: true, glareEnabled: false });
      const off = await session.render('preview');
      session.setParams(stockPatch('paper', 'kodak_portra_endura', session.params));
      const paper = await session.render('preview');
      expect(session.params.filmEnabled).toBe(false);
      expect(paper.rgb).not.toEqual(off.rgb);
      expect([...paper.rgb].every(Number.isFinite)).toBe(true);
      expect((await session.render('full')).rgb).toEqual(paper.rgb);
      session.setParams({ film: 'fujifilm_velvia_100', process: 'scanNegative' });
      expect((await session.render('preview')).rgb).toEqual(paper.rgb);
      session.setParams({ paper: 'kodak_2383' });
      const cinema = await session.render('preview');
      expect(cinema.rgb).not.toEqual(paper.rgb);
      expect([...cinema.rgb].every(Number.isFinite)).toBe(true);
      for (const paperId of ['kodak_endura_premier', 'kodak_ultra_endura', 'kodak_supra_endura', 'kodak_ektacolor_edge', 'fujifilm_crystal_archive_typeii', 'kodak_2393']) {
        session.setParams({ paper: paperId });
        const result = await session.render('preview');
        expect([...result.rgb].every(Number.isFinite), paperId).toBe(true);
        expect(Math.max(...result.rgb), paperId).toBeGreaterThan(0.05);
      }

      session.setParams(stockPatch('paper', 'off', session.params));
      expect((await session.render('preview')).rgb).toEqual(off.rgb);
    } finally { session.dispose(); }
  }, 120000);

  it('renders source colors without film; camera changes affect preview/full, on restores cached film exactly', async () => {
    const { engine, bundle } = await sharedResources('kodak_portra_400', print);
    const session = await Session.create({ assetsBaseUrl: 'public/data', engine, bundle,
      arenaProvider: { get: async (_key, inputs) => (await sharedResources(inputs.stockId, inputs.printScan)).arenas } });
    const source = image();
    try {
      session.open({ ...source, suggestedColorSpace: 'sRGB', encoding: 'encoded', source: { format: 'fixture', bitDepth: 32 } });
      session.setParams({ autoExposure: false, inputColorSpace: 'sRGB', inputCctfDecoding: true });
      const film = await session.render('preview');
      session.setParams({ filmEnabled: false });
      const off = await session.render('preview');
      let error = 0;
      for (let p = 0; p < 64 * 48; p++) for (let c = 0; c < 3; c++) error = Math.max(error, Math.abs(off.rgb[p * 3 + c]! - source.rgba[p * 4 + c]!));
      expect(error).toBeLessThan(0.0005);
      expect(off.rgb).not.toEqual(film.rgb);
      session.setParams({ cameraHsvSaturation: 1.8, cameraExposureEv: 0.5 });
      const edited = await session.render('preview');
      expect(edited.rgb).not.toEqual(off.rgb);
      expect((await session.render('full')).rgb).toEqual(edited.rgb);
      session.setParams({ filmEnabled: true, cameraHsvSaturation: 1, cameraExposureEv: 0 });
      expect((await session.render('preview')).rgb).toEqual(film.rgb);
    } finally { session.dispose(); }
  }, 120000);
});
