/**
 * Facade `Session` -- satu-satunya permukaan yang dilihat UI (spec induk §4.1,
 * spec Fase 2 §4.4). Tanpa DOM: berjalan langsung di Node (test) atau di
 * dalam Web Worker (`worker.ts`).
 *
 * URUTAN PRA-HITUNG vs DEVICE. Kerja float CPU panjang setelah `GPUDevice`
 * hidup men-segfault Dawn di Node (CATATAN LINGKUNGAN `src/host/spectral.ts`).
 * Karena itu `create()` tanpa engine memuat aset, MEMPRA-HITUNG arena
 * baseline, BARU mengakuisisi device. Arena untuk kunci baru yang diminta
 * belakangan dipra-hitung saat itu juga (device sudah hidup) -- aman di
 * browser, tapi di Node test harus menyuntikkan `arenaProvider` yang
 * mempra-hitung lebih dulu (`test/parity/run.ts::sharedResources`).
 */

import { acquireDevice } from '../engine/device';
import type { EngineDevice } from '../engine/device';
import { RenderGraph } from '../engine/graph';
import { Tap } from '../engine/taps';
import type { Arenas } from '../engine/arena';
import { buildChain } from '../engine/chain';
import { precomputeArenaData, uploadArenas } from '../host/spectral';
import type { ArenaPlan } from '../host/spectral';
import type { DecodedImage } from '../io/decoded';
import { buildRenderPlan } from '../params/plan';
import type { ArenaInputs, RenderMode, RenderPlan } from '../params/plan';
import { applyParamsPatch } from '../params/registry';
import { BASELINE_RENDER_PARAMS } from '../params/renderParams';
import type { RenderParams } from '../params/renderParams';
import { loadAssets } from '../profiles/load';
import type { AssetBundle } from '../profiles/load';
import { SessionStateError } from './errors';

export type RenderQuality = 'full' | 'preview';

export interface RenderResult {
  width: number;
  height: number;
  /** `rgb_out` 3 kanal rapat, sudah ter-encode di `outputColorSpace`. */
  rgb: Float32Array;
  quality: RenderQuality;
  /** Versi parameter saat render dimulai; UI membuang hasil yang versinya basi. */
  paramsVersion: number;
}

export interface ArenaProvider {
  get(key: string, inputs: ArenaInputs): Promise<Arenas>;
}

export interface SessionOptions {
  assetsBaseUrl: string;
  engine?: EngineDevice;
  bundle?: AssetBundle;
  /** Pemilik arena. Arena dari provider suntikan TIDAK dihancurkan `dispose()`. */
  arenaProvider?: ArenaProvider;
}

/** Provider bawaan: pra-hitung -> unggah, di-cache per kunci, dihancurkan saat dispose. */
class OwnedArenaProvider implements ArenaProvider {
  private readonly cache = new Map<string, Arenas>();
  private readonly plans = new Map<string, ArenaPlan>();

  constructor(
    private readonly bundle: AssetBundle,
    private readonly device: () => GPUDevice,
  ) {}

  /** Pra-hitung tanpa menyentuh device -- dipanggil `create()` SEBELUM akuisisi device. */
  precompute(key: string, inputs: ArenaInputs): void {
    if (this.cache.has(key) || this.plans.has(key)) return;
    this.plans.set(key, precomputeArenaData(this.bundle, inputs.stockId, inputs.printScan));
  }

  async get(key: string, inputs: ArenaInputs): Promise<Arenas> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    this.precompute(key, inputs);
    const arenas = uploadArenas(this.device(), this.plans.get(key)!);
    this.plans.delete(key);
    this.cache.set(key, arenas);
    return arenas;
  }

  destroy(): void {
    for (const arenas of this.cache.values()) {
      arenas.static.destroy();
      arenas.stock.destroy();
      arenas.dynamic.destroy();
      arenas.frameState.destroy();
    }
    this.cache.clear();
    this.plans.clear();
  }
}

export class Session {
  #params: RenderParams = { ...BASELINE_RENDER_PARAMS };
  #paramsVersion = 0;
  #image: DecodedImage | undefined;
  #disposed = false;
  private readonly graphs = new Map<string, RenderGraph>();

  private constructor(
    private readonly engine: EngineDevice,
    private readonly bundle: AssetBundle,
    private readonly arenas: ArenaProvider,
    private readonly ownedArenas: OwnedArenaProvider | undefined,
  ) {}

  static async create(opts: SessionOptions): Promise<Session> {
    const bundle = opts.bundle ?? (await loadAssets(opts.assetsBaseUrl));
    let engine = opts.engine;
    let owned: OwnedArenaProvider | undefined;
    if (!opts.arenaProvider) {
      owned = new OwnedArenaProvider(bundle, () => {
        if (!engine) throw new Error('Session: device belum diakuisisi.');
        return engine.device;
      });
      // Pra-hitung baseline SEBELUM device (lih. dokumentasi modul).
      const baseline = baselineArenaInputs(bundle);
      owned.precompute(baseline.key, baseline.inputs);
    }
    engine ??= await acquireDevice();
    return new Session(engine, bundle, opts.arenaProvider ?? owned!, owned);
  }

  get params(): Readonly<RenderParams> {
    return this.#params;
  }

  /** Salinan parameter saat ini (bentuk method untuk RPC). */
  getParams(): RenderParams {
    return { ...this.#params };
  }

  open(image: DecodedImage): void {
    this.assertAlive();
    if (image.rgba.length !== image.width * image.height * 4) {
      throw new RangeError(
        `DecodedImage ${image.width}x${image.height} butuh ${image.width * image.height * 4} float RGBA, ` +
          `diterima ${image.rgba.length}.`,
      );
    }
    this.#image = image;
  }

  /** Validasi segera dan atomik: patch yang ditolak tidak mengubah apa pun. */
  setParams(patch: Partial<RenderParams>): void {
    this.assertAlive();
    this.#params = applyParamsPatch(this.#params, patch);
    this.#paramsVersion += 1;
  }

  async render(quality: RenderQuality): Promise<RenderResult> {
    this.assertAlive();
    const image = this.#image;
    if (!image) throw new SessionStateError('render() sebelum open(): belum ada gambar.');
    const paramsVersion = this.#paramsVersion;
    const rgb = await this.renderFrame(
      { width: image.width, height: image.height, rgba: image.rgba },
      this.#params,
      'image',
    );
    return { width: image.width, height: image.height, rgb, quality, paramsVersion };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const graph of this.graphs.values()) graph.dispose();
    this.graphs.clear();
    this.ownedArenas?.destroy();
    this.#image = undefined;
  }

  /** Render satu frame lewat rencana `mode`; keluaran 3 kanal rapat. */
  protected async renderFrame(
    frame: { width: number; height: number; rgba: Float32Array },
    params: RenderParams,
    mode: RenderMode,
  ): Promise<Float32Array> {
    const plan = buildRenderPlan(params, this.bundle, frame, mode);
    const graph = await this.graphFor(plan);
    this.assertAlive();
    const rgba = await graph.run(frame.rgba, plan.core, Tap.RGB_OUT, {
      maxBufferBytes: this.engine.maxStorageBufferBindingSize,
      overlap: plan.overlap,
    });
    return packRgb(rgba, frame.width * frame.height);
  }

  private async graphFor(plan: RenderPlan): Promise<RenderGraph> {
    const key = `${plan.arenaKey}|${plan.chain.family}|grain=${plan.chain.grain}`;
    const existing = this.graphs.get(key);
    if (existing) return existing;
    const arenas = await this.arenas.get(plan.arenaKey, plan.arenaInputs);
    const graph = new RenderGraph(this.engine);
    for (const stage of buildChain(this.engine.device, arenas, plan.chain)) graph.addStage(stage);
    this.graphs.set(key, graph);
    return graph;
  }

  private assertAlive(): void {
    if (this.#disposed) throw new SessionStateError('Session sudah di-dispose().');
  }
}

function baselineArenaInputs(bundle: AssetBundle): { key: string; inputs: ArenaInputs } {
  // Rencana baseline hanya butuh dimensi untuk bagian arena; gambar 1x1 cukup.
  const plan = buildRenderPlan(BASELINE_RENDER_PARAMS, bundle, { width: 1, height: 1, rgba: new Float32Array(4) }, 'cube');
  return { key: plan.arenaKey, inputs: plan.arenaInputs };
}

function packRgb(rgba: Float32Array, pixels: number): Float32Array {
  const rgb = new Float32Array(pixels * 3);
  for (let p = 0; p < pixels; p += 1) {
    rgb[p * 3] = rgba[p * 4]!;
    rgb[p * 3 + 1] = rgba[p * 4 + 1]!;
    rgb[p * 3 + 2] = rgba[p * 4 + 2]!;
  }
  return rgb;
}
