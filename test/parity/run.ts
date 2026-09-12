import { acquireDevice } from '../../src/engine/device';
import { RenderGraph } from '../../src/engine/graph';
import { buildArenas } from '../../src/host/spectral';
import { loadAssets } from '../../src/profiles/load';
import type { Arenas } from '../../src/engine/arena';
import type { Stage } from '../../src/engine/graph';
import type { TapName } from '../../src/engine/taps';
import { compareRgb, expectWithinTolerance, loadCase, loadInputAsRgba, loadTap } from './compare';
import { defaultCoreParams } from './params';

/**
 * Dipindahkan ke sini dari Task 10 (lih. ledger K5): `run.ts` mengimpor
 * `buildArenas` dari `src/host/spectral.ts`, yang baru lahir di Task 11.
 */
export interface TapParityOptions {
  case: string;
  tap: TapName;
  tolerance: number;
  stages: (device: GPUDevice, arenas: Arenas) => Stage[];
  stockId?: string;
}

export async function runTapParity(opts: TapParityOptions): Promise<void> {
  const engine = await acquireDevice();
  const bundle = await loadAssets('public/data');
  const arenas = buildArenas(engine.device, bundle, opts.stockId ?? 'kodak_portra_400');

  const graph = new RenderGraph(engine);
  for (const stage of opts.stages(engine.device, arenas)) graph.addStage(stage);

  const meta = loadCase(opts.case);
  const inputRgba = loadInputAsRgba(opts.case);
  // `defaultCoreParams` butuh `inputRgba` untuk meniru auto-exposure metering
  // Python (bergantung isi gambar) -- lih. test/parity/params.ts untuk bukti
  // kenapa ini bukan sekadar (width, height, bundle) seperti sketsa brief.
  const params = defaultCoreParams(meta.width, meta.height, bundle, inputRgba);

  const actual = await graph.run(inputRgba, params, opts.tap);

  expectWithinTolerance(
    compareRgb(actual, loadTap(opts.case, opts.tap)),
    opts.tolerance,
    `${opts.tap} / ${opts.case}`,
  );
}
