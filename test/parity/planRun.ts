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
import type { FrameParams } from '../../src/engine/graph';
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
import { expect } from 'vitest';
import { compareRgb, expectWithinTolerance, loadCase, loadInputAsRgba, loadTap } from './compare';
import type { CaseMeta, Comparison } from './compare';
import { lag1Correlation, momentsBinned } from './statistics';

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
const graphs = new Map<string, RenderGraph>();

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

/**
 * Render `tap` untuk kasus lewat jalur produksi; keluaran RGBA. `frame`
 * menimpa sebagian `plan.frame` (mis. `grainSeed` untuk mengukur sebaran
 * realisasi engine) -- dipakai HANYA oleh gerbang statistik.
 */
export async function renderParamCase(
  name: string,
  tap: TapName,
  frame?: Partial<FrameParams>,
): Promise<{ rgba: Float32Array; meta: ParamCaseMeta }> {
  const p = prepared.get(name);
  if (!p || !enginePromise) throw new Error(`Kasus "${name}" belum disiapkan lewat prepareParamCases.`);
  const engine = await enginePromise;
  // Satu graf per kasus: kompilasi shader dibayar sekali, bukan per render
  // (gerbang statistik merender 8 seed).
  let graph = graphs.get(name);
  if (!graph) {
    graph = new RenderGraph(engine);
    for (const stage of buildChain(engine.device, arenas.get(p.plan.arenaKey)!, p.plan.chain)) graph.addStage(stage);
    graphs.set(name, graph);
  }
  const rgba = await graph.run(p.input, p.plan.core, tap, {
    maxBufferBytes: engine.maxStorageBufferBindingSize,
    overlap: p.plan.overlap,
    frame: { ...p.plan.frame, ...frame },
  });
  return { rgba, meta: p.meta };
}

interface StatSummary {
  bins: number;
  realizations: number;
  mean: [number, number];
  variance: [number, number];
  lag1: [number, number];
}

/** Jumlah seed engine untuk mengukur sebaran realisasi grain. */
const ENGINE_SEEDS = 8;

/**
 * Gerbang statistik keluarga `stochastic` (Fase 2C), spec §6.5.1 "ambang
 * terikat sebaran terukur". Momen: mean, varians, dan autokorelasi lag-1
 * kanal hijau.
 *
 * Dua sumber keacakan diperlakukan berbeda karena sebarannya terukur di
 * tempat berbeda:
 *
 * - Glare: RNG hulu tidak di-seed, jadi `pythonStats` (K realisasi) memberi
 *   pusat `mu` dan sebaran `sd_py` satu realisasi.
 * - Grain: hulu memakai seed TETAP -- K realisasi Python identik (sd 0,
 *   diukur), jadi fixture adalah SATU realisasi grain. Sebaran satu
 *   realisasi diukur dari ENGINE lewat `grainSeed` (seed dasar kasus + 0..7),
 *   dan rata-rata 8 seed dibandingkan dengan realisasi Python itu (preseden:
 *   "rata-rata 16 salt" Gate B, `scannerPostGlare.test.ts`).
 *
 *   |engine - mu| <= 4 * sqrt(sd_e^2 * (1 + 1/Ke) + sd_py^2 * (1 + 1/K)) + lantai
 *
 * dengan `engine` rata-rata Ke seed (grain hidup) atau satu realisasi
 * (grain mati, sd_e = 0, Ke = 1 dianggap tak berhingga). Lantai = derau f32
 * deterministik: mean 1e-5 (ambang per piksel), varians 1e-12, lag-1 1e-3.
 */
export async function runParamStatParity(name: string, tap: TapName): Promise<void> {
  const meta = loadParamCase(name) as ParamCaseMeta & { pythonStats?: Record<string, StatSummary> };
  const stats = meta.pythonStats?.[tap];
  if (meta.family !== 'stochastic' || !stats) {
    throw new Error(`runParamStatParity: "${name}" tidak punya pythonStats untuk ${tap}.`);
  }
  const params = paramCaseRenderParams(meta);
  const seeds = params.grainEnabled ? ENGINE_SEEDS : 1;
  const samples: Array<{ mean: number; variance: number; lag1: number }> = [];
  for (let i = 0; i < seeds; i += 1) {
    const { rgba } = await renderParamCase(name, tap, { grainSeed: params.grainSeed + i });
    const m = momentsBinned(rgba, meta.width, meta.height, stats.bins);
    samples.push({ mean: m.mean, variance: m.variance, lag1: lag1Correlation(rgba, meta.width, meta.height) });
  }
  const summarize = (key: 'mean' | 'variance' | 'lag1'): [number, number] => {
    const values = samples.map((s) => s[key]);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    if (values.length < 2) return [avg, 0];
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - avg) ** 2, 0) / (values.length - 1));
    return [avg, sd];
  };
  const check = (key: 'mean' | 'variance' | 'lag1', floor: number) => {
    const [value, sdEngine] = summarize(key);
    const [mu, sdPython] = stats[key];
    const spread = Math.sqrt(
      sdEngine ** 2 * (1 + 1 / seeds) * (seeds > 1 ? 1 : 0) + sdPython ** 2 * (1 + 1 / stats.realizations),
    );
    const tolerance = 4 * spread + floor;
    expect(
      Math.abs(value - mu),
      `${tap} / param/${name}: ${key} ${value.toExponential(4)} vs Python ${mu.toExponential(4)} ` +
        `(sd engine ${sdEngine.toExponential(2)} x${seeds}, sd Python ${sdPython.toExponential(2)}, ` +
        `ambang ${tolerance.toExponential(2)})`,
    ).toBeLessThanOrEqual(tolerance);
  };
  check('mean', 1e-5);
  check('variance', 1e-12);
  check('lag1', 1e-3);
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
