import { it } from 'vitest';
import { Session } from '../src/session/session';
import { sharedResources } from './parity/run';
import type { DecodedImage } from '../src/io/decoded';

const PRINT = { printStockId: 'kodak_portra_endura', enlargerFilters: { cFilterNeutral: 0, mFilterNeutral: 51.56801468495496, mFilterShift: 0, yFilterNeutral: 52.53400422349596, yFilterShift: 0 } };
function photo(w: number, h: number): DecodedImage {
  const rgba = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; rgba[i] = x / w; rgba[i + 1] = y / h; rgba[i + 2] = 0.5 + 0.4 * Math.sin(x / 37); rgba[i + 3] = 1; }
  return { width: w, height: h, rgba, suggestedColorSpace: 'sRGB', encoding: 'encoded', source: { format: 'fixture', bitDepth: 32 } };
}
it('perf', async () => {
  const { engine, bundle } = await sharedResources('kodak_portra_400', PRINT);
  const s = await Session.create({ assetsBaseUrl: 'public/data', engine, bundle, previewMaxLongEdge: 4096,
    arenaProvider: { get: async (_k, inputs) => (await sharedResources(inputs.stockId, inputs.printScan)).arenas } });
  s.open(photo(2016, 1512));
  s.setParams({ inputColorSpace: 'sRGB' });
  let n = 0;
  const time = async (label: string, edge: number) => {
    await s.render('preview', edge); // warm
    const ts: number[] = [];
    for (let i = 0; i < 4; i++) { s.setParams({ printExposureEv: (n++ % 7) * 0.1 } as never); const t = performance.now(); await s.render('preview', edge); ts.push(performance.now() - t); }
    ts.sort((a, b) => a - b);
    console.log(`${label.padEnd(28)} ${String(edge).padStart(5)}px  ${ts[1]!.toFixed(0)} ms`);
  };
  for (const e of [256, 384, 512, 768, 1024]) await time('baseline', e);
  for (const [k, v] of [['grainEnabled', false], ['halationEnabled', false], ['glareEnabled', false], ['dirCouplersEnabled', false]] as const) {
    s.setParams({ [k]: v } as never); await time(`${k}=off`, 1024); s.setParams({ [k]: !v } as never);
  }
  s.setParams({ grainEnabled: false, halationEnabled: false, glareEnabled: false, dirCouplersEnabled: false } as never); await time('all spatial off', 1024);
  s.dispose();
}, 600000);
