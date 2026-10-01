import { describe, expect, it } from 'vitest';
import { PRINT_LUTS, loadPrintCube, encodeCineon, decodeCineon, samplePrintCube, type PrintLutId } from '../src/profiles/printLuts';
import { Session } from '../src/session/session';
import { sharedResources } from './parity/run';
import { BASELINE_RENDER_PARAMS } from '../src/params/renderParams';
import { stockPatch, choicePatch, findTool, type ChoiceTool } from '../src/ui/model/tools';

const print = { printStockId: 'kodak_portra_endura', enlargerFilters: { cFilterNeutral: 0, mFilterNeutral: 51.56801468495496, mFilterShift: 0, yFilterNeutral: 52.53400422349596, yFilterShift: 0 } };
describe('Cineon print LUTs', () => {
  it('loads all seven original assets and preserves standard Cineon endpoints', async () => {
    for (const id of Object.keys(PRINT_LUTS) as PrintLutId[]) {
      const cube = await loadPrintCube(id, 'public/data');
      expect(cube.rgba.length).toBe(PRINT_LUTS[id].size ** 3 * 4);
      expect(await loadPrintCube(id, 'public/data')).toBe(cube);
    }
    expect(encodeCineon(0)).toBeCloseTo(95 / 1023, 12);
    expect(encodeCineon(1)).toBeCloseTo(685 / 1023, 12);
    for (const v of [0, 0.001, 0.18, 1, 8]) expect(decodeCineon(encodeCineon(v))).toBeCloseTo(v, 10);
  });
  it('selecting a print LUT enables Print, including with Film Off or reversal film', () => {
    const params = { ...BASELINE_RENDER_PARAMS, filmEnabled: false, process: 'scanNegative' as const };
    expect(stockPatch('paper', 'lut_kodak_2383_d60', params)).toEqual({ paper: 'lut_kodak_2383_d60', process: 'printSimulation' });
    expect(stockPatch('film', 'fujifilm_velvia_100', { ...params, paper: 'lut_kodak_2383_d60' }).process).toBe('printSimulation');
    const process = findTool('process') as ChoiceTool;
    expect(choicePatch(process, 'scanNegative', { ...params, paper: 'lut_kodak_2383_d60' })).toEqual({ process: 'scanNegative', paper: 'kodak_portra_endura' });
  });
  it('GPU matches independent CST/Cineon/tetrahedral/gamma reference; controls remain live in Off', async () => {
    const { engine, bundle } = await sharedResources('kodak_portra_400', print);
    const session = await Session.create({ assetsBaseUrl: 'public/data', engine, bundle,
      arenaProvider: { get: async (_key, inputs) => (await sharedResources(inputs.stockId, inputs.printScan)).arenas } });
    const colors = [[0, 0, 0], [0.02, 0.02, 0.02], [0.18, 0.18, 0.18], [1, 1, 1], [0.8, 0.4, 0.1], [0.8, 0.1, 0.4], [0.4, 0.8, 0.1], [0.1, 0.8, 0.4], [0.4, 0.1, 0.8], [0.1, 0.4, 0.8], [4, 2, 0.4]];
    const rgba = Float32Array.from(colors.flatMap(rgb => [...rgb, 1]));
    try {
      session.open({ width: colors.length, height: 1, rgba, suggestedColorSpace: 'sRGB', encoding: 'linear', source: { format: 'fixture', bitDepth: 32 } });
      session.setParams({ filmEnabled: false, autoExposure: false, inputColorSpace: 'sRGB', inputCctfDecoding: false,
        outputColorSpace: 'sRGB', grainEnabled: false, halationEnabled: false, dirCouplersEnabled: false,
        glareEnabled: false, scannerUnsharpAmount: 0 });
      const results: Float32Array[] = [];
      engine.device.pushErrorScope('validation');
      for (const paper of Object.keys(PRINT_LUTS) as PrintLutId[]) {
        session.setParams({ paper });
        const result = await session.render('preview');
        const cube = await loadPrintCube(paper, 'public/data');
        let error = 0;
        for (let p = 0; p < colors.length; p++) {
          const expected = samplePrintCube(cube, colors[p]!.map(encodeCineon)).map(v => {
            const linear = Math.max(v, 0) ** 2.4;
            return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
          });
          for (let c = 0; c < 3; c++) error = Math.max(error, Math.abs(result.rgb[p * 3 + c]! - expected[c]!));
        }
        expect(error, paper).toBeLessThan(0.0005);
        expect((await session.render('full')).rgb).toEqual(result.rgb);
        results.push(result.rgb);
      }
      expect(await engine.device.popErrorScope()).toBeNull();
      expect(results[0]).not.toEqual(results[1]);
      const original = results.at(-1)!;
      session.setParams({ filmExposureEv: 1 });
      expect((await session.render('preview')).rgb).not.toEqual(original);
      session.setParams({ filmExposureEv: 0, filmPushPullStops: 1 });
      expect((await session.render('preview')).rgb).not.toEqual(original);
      session.setParams({ filmPushPullStops: 0, grainEnabled: true, filmFormat: 'standard16' });
      expect((await session.render('preview')).rgb).not.toEqual(original);
      session.setParams({ grainEnabled: false, filmEnabled: true });
      const film = await session.render('preview');
      expect(film.rgb).not.toEqual(original);
      expect(film.rgb.every(Number.isFinite)).toBe(true);
      session.setParams({ film: 'fujifilm_velvia_100' });
      expect((await session.render('preview')).rgb.every(Number.isFinite)).toBe(true);
    } finally { session.dispose(); }
  }, 120000);
});
