/**
 * Harness keluarga fixture `param/` (Fase 2C). Gerbangnya lewat JALUR
 * PRODUKSI yang sama dengan `Session.renderFrameWithPlan`:
 *
 *   RenderParams -> buildRenderPlan -> arena per plan.arenaKey
 *     -> buildChain(plan.chain) -> graph.run(plan.core, { frame, overlap })
 *
 * jadi yang dibuktikan adalah pemetaan field -> engine yang dipakai `Session`,
 * bukan rakitan terpisah di test. `case.json` setiap kasus mencatat patch
 * `renderParams` (sisi TS) dan `pythonOverrides` (padanan Python), keduanya
 * ditulis `tools/gen_reference.py --param-case` dari `tools/param_cases.py`.
 *
 * Urutan WAJIB, sama seperti `run.ts::sharedResources`: semua arena kasus
 * dipra-hitung SEBELUM `acquireDevice` (CATATAN LINGKUNGAN
 * `src/host/spectral.ts`). Karena itu setiap berkas test memanggil
 * `prepareParamCases` sekali dengan SEMUA kasusnya, di `beforeAll`.
 */

import { acquireDevice } from '../../src/engine/device';
import type { EngineDevice } from '../../src/engine/device';
import { RenderGraph } from '../../src/engine/graph';
import type { Arenas } from '../../src/engine/arena';
import { buildChain } from '../../src/engine/chain';
import type { TapName } from '../../src/engine/taps';
import { precomputeArenaData, uploadArenas } from '../../src/host/spectral';
import type { ArenaPlan } from '../../src/host/spectral';
import { buildRenderPlan } from '../../src/params/plan';
import type { RenderPlan } from '../../src/params/plan';
import { BASELINE_RENDER_PARAMS } from '../../src/params/renderParams';
import type { RenderParams } from '../../src/params/renderParams';
import { loadAssets } from '../../src/profiles/load';
import type { AssetBundle } from '../../src/profiles/load';
import { compareRgb, expectWithinTolerance, loadCase, loadInputAsRgba, loadTap } from './compare';
import type { CaseMeta, Comparison } from './compare';

export type ParamFamily = 'deterministic' | 'stochastic' | 'lut';

export interface ParamCaseMeta extends CaseMeta {
  family: ParamFamily;
  film: string;
  print: string;
  renderParams: Partial<RenderParams>;
  pythonOverrides: string[];
  /** Tuas rezim ukuran piksel (teknik 2A.5); menimpa `plan.frame` di test saja. */
  filmFormatMm?: number;
}

export function paramCaseDir(name: string): string {
  return `param/${name}`;
}

export function loadParamCase(name: string): ParamCaseMeta {
  return loadCase(paramCaseDir(name)) as ParamCaseMeta;
}

/**
 * `RenderParams` lengkap untuk kasus: baseline, stock kasus, saklar
 * stokastik dari keluarga (grain dan glare bersama, seperti
 * `deactivate_stochastic_effects`), lalu patch kasus.
 */
export function paramCaseRenderParams(meta: ParamCaseMeta): RenderParams {
  const stochastic = meta.family === 'stochastic' || meta.family === 'lut';
  return {
    ...BASELINE_RENDER_PARAMS,
    film: meta.film,
    paper: meta.print,
    grainEnabled: stochastic,
    glareEnabled: stochastic,
    ...meta.renderParams,
  };
}

interface Prepared {
  meta: ParamCaseMeta;
  input: Float32Array;
  plan: RenderPlan;
}

let bundlePromise: Promise<AssetBundle> | undefined;
let enginePromise: Promise<EngineDevice> | undefined;
const prepared = new Map<string, Prepared>();
const pendingArenas = new Map<string, ArenaPlan>();
const arenas = new Map<string, Arenas>();

export function planForCase(bundle: AssetBundle, name: string): Prepared {
  const meta = loadParamCase(name);
  const input = loadInputAsRgba(paramCaseDir(name));
  const mode = meta.family === 'lut' ? 'cube' : 'image';
  const plan = buildRenderPlan(
    paramCaseRenderParams(meta),
    bundle,
    { width: meta.width, height: meta.height, rgba: input },
    mode,
  );
  if (meta.filmFormatMm !== undefined) plan.frame = { ...plan.frame, filmFormatMm: meta.filmFormatMm };
  return { meta, input, plan };
}

/** Muat aset dan pra-hitung arena SEMUA `names`, lalu baru akuisisi device. */
export async function prepareParamCases(names: string[]): Promise<void> {
  bundlePromise ??= loadAssets('public/data');
  const bundle = await bundlePromise;
  if (enginePromise) {
    const missing = names.filter((n) => !prepared.has(n));
    if (missing.length > 0) {
      throw new Error(`prepareParamCases dipanggil lagi setelah device hidup (${missing.join(', ')}).`);
    }
    return;
  }
  for (const name of names) {
    const p = planForCase(bundle, name);
    prepared.set(name, p);
    const { arenaKey, arenaInputs } = p.plan;
    if (!pendingArenas.has(arenaKey)) {
      pendingArenas.set(arenaKey, precomputeArenaData(bundle, arenaInputs.stockId, arenaInputs.printScan));
    }
  }
  enginePromise = acquireDevice();
  const engine = await enginePromise;
  for (const [key, plan] of pendingArenas) arenas.set(key, uploadArenas(engine.device, plan));
  pendingArenas.clear();
}

/** Render `tap` untuk kasus lewat jalur produksi; keluaran RGBA. */
export async function renderParamCase(name: string, tap: TapName): Promise<{ rgba: Float32Array; meta: ParamCaseMeta }> {
  const p = prepared.get(name);
  if (!p || !enginePromise) throw new Error(`Kasus "${name}" belum disiapkan lewat prepareParamCases.`);
  const engine = await enginePromise;
  const graph = new RenderGraph(engine);
  for (const stage of buildChain(engine.device, arenas.get(p.plan.arenaKey)!, p.plan.chain)) graph.addStage(stage);
  const rgba = await graph.run(p.input, p.plan.core, tap, {
    maxBufferBytes: engine.maxStorageBufferBindingSize,
    overlap: p.plan.overlap,
    frame: p.plan.frame,
  });
  return { rgba, meta: p.meta };
}

/** Gerbang per piksel untuk kasus deterministik/`lut`. */
export async function runParamParity(name: string, tap: TapName, tolerance: number): Promise<Comparison> {
  const { rgba, meta } = await renderParamCase(name, tap);
  if (meta.family === 'stochastic') {
    throw new Error(`runParamParity: "${name}" keluarga stochastic; pakai gerbang statistik.`);
  }
  const comparison = compareRgb(rgba, loadTap(paramCaseDir(name), tap));
  expectWithinTolerance(comparison, tolerance, `${tap} / param/${name}`);
  return comparison;
}
