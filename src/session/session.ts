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
import { runPrecisionSelfTest } from '../engine/precisionSelfTest';
import { Tap } from '../engine/taps';
import type { Arenas } from '../engine/arena';
import { buildChain } from '../engine/chain';
import { precomputeArenaData, uploadArenas } from '../host/spectral';
import type { ArenaPlan } from '../host/spectral';
import type { DecodedImage } from '../io/decoded';
import { encodePng, encodeTiff16 } from '../io/encode';
import { formatCube, identityLattice } from '../io/cube';
import { DICHROIC_VERSION } from '../version';
import { buildRenderPlan, validateStocks } from '../params/plan';
import type { ArenaInputs, RenderMode, RenderPlan } from '../params/plan';
import { applyParamsPatch } from '../params/registry';
import { BASELINE_RENDER_PARAMS } from '../params/renderParams';
import type { RenderParams } from '../params/renderParams';
import { loadAssets } from '../profiles/load';
import type { AssetBundle } from '../profiles/load';
import { RenderSupersededError, SessionStateError } from './errors';
import { PREVIEW_MAX_LONG_EDGE, boxDownscale } from './downscale';
import type { ScaledImage } from './downscale';

export type RenderQuality = 'full' | 'preview';

/** Format ekspor gambar (spec Fase 2 §5): PNG 8/16-bit, TIFF 16-bit tak terkompresi. */
export type ExportFormat = 'png8' | 'png16' | 'tiff16';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['png8', 'png16', 'tiff16'];

export interface RenderResult {
  width: number;
  height: number;
  /** `rgb_out` 3 kanal rapat, sudah ter-encode di `outputColorSpace`. */
  rgb: Float32Array;
  quality: RenderQuality;
  /** Versi parameter saat render dimulai; UI membuang hasil yang versinya basi. */
  paramsVersion: number;
}

/**
 * Diagnostik perangkat (spec Fase 2 §6a.1). `iirPrecisionOk = false` berarti
 * backend shader meruntuhkan aritmetika df64 blur IIR (reasosiasi
 * fast-math): render tetap berjalan, tapi halation/DIR bisa meleset ~1e-3 dari
 * referensi. UI sebaiknya memperingatkan pengguna.
 */
export interface SessionDiagnostics {
  iirPrecisionOk: boolean;
  iirMaxAbsError: number;
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
  /**
   * Sisi terpanjang render pratinjau (default `PREVIEW_MAX_LONG_EDGE`, 1024).
   * UI boleh menurunkannya di perangkat lemah; render penuh tidak terpengaruh.
   */
  previewMaxLongEdge?: number;
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
  #imageId = 0;
  #preview: { imageId: number; image: ScaledImage } | undefined;
  #disposed = false;
  /** Antrean terbaru-menang: paling banyak satu render berjalan dan satu menunggu. */
  #busy = false;
  #pending: PendingRender | undefined;
  /** Satu hasil terakhir per kualitas. */
  readonly #cache = new Map<RenderQuality, { key: string; result: RenderResult }>();
  private readonly graphs = new Map<string, RenderGraph>();

  private constructor(
    private readonly engine: EngineDevice,
    private readonly bundle: AssetBundle,
    private readonly arenas: ArenaProvider,
    private readonly ownedArenas: OwnedArenaProvider | undefined,
    private readonly previewMaxLongEdge: number,
    readonly diagnostics: Readonly<SessionDiagnostics>,
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
    const selfTest = await runPrecisionSelfTest(engine.device);
    return new Session(
      engine,
      bundle,
      opts.arenaProvider ?? owned!,
      owned,
      opts.previewMaxLongEdge ?? PREVIEW_MAX_LONG_EDGE,
      Object.freeze({ iirPrecisionOk: selfTest.ok, iirMaxAbsError: selfTest.maxAbsError }),
    );
  }

  get params(): Readonly<RenderParams> {
    return this.#params;
  }

  /** Naik setiap `setParams` yang diterima. */
  get paramsVersion(): number {
    return this.#paramsVersion;
  }

  /** Bentuk method `diagnostics` untuk RPC. */
  getDiagnostics(): SessionDiagnostics {
    return { ...this.diagnostics };
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
    this.#imageId += 1;
    this.#preview = undefined;
    this.#cache.clear();
  }

  /** Validasi segera dan atomik: patch yang ditolak tidak mengubah apa pun. */
  setParams(patch: Partial<RenderParams>): void {
    this.assertAlive();
    const next = applyParamsPatch(this.#params, patch);
    validateStocks(this.bundle, next.film, next.paper);
    this.#params = next;
    this.#paramsVersion += 1;
  }

  /**
   * Antrean terbaru-menang (spec Fase 2 §4.4): bila tidak ada render
   * berjalan, permintaan langsung mulai (parameter dibaca SAAT MULAI). Bila
   * ada, permintaan menunggu di satu slot; permintaan berikutnya menolak
   * yang menunggu dengan `RenderSupersededError` lalu menggantikannya. Render
   * yang sedang berjalan selalu diselesaikan -- hasilnya membawa
   * `paramsVersion` saat ia mulai, supaya UI bisa membuangnya bila basi.
   */
  render(quality: RenderQuality): Promise<RenderResult> {
    try {
      this.assertAlive();
      if (!this.#image) throw new SessionStateError('render() sebelum open(): belum ada gambar.');
    } catch (e) {
      return Promise.reject(e);
    }
    const hit = this.#cache.get(quality);
    if (hit && hit.key === this.cacheKey(quality)) return Promise.resolve(hit.result);

    return new Promise<RenderResult>((resolve, reject) => {
      const job: PendingRender = {
        start: () => {
          this.execute(quality).then(resolve, reject);
        },
        reject,
      };
      if (!this.#busy) {
        this.#busy = true;
        job.start();
      } else {
        this.#pending?.reject(new RenderSupersededError());
        this.#pending = job;
      }
    });
  }

  private async execute(quality: RenderQuality): Promise<RenderResult> {
    try {
      this.assertAlive();
      const image = this.#image!;
      const params = this.#params;
      const paramsVersion = this.#paramsVersion;
      const key = this.cacheKey(quality);
      const frame = quality === 'preview' ? this.previewImage() : image;
      const rgb = await this.renderFrame(frame, params, 'image');
      const result: RenderResult = { width: frame.width, height: frame.height, rgb, quality, paramsVersion };
      if (!this.#disposed) this.#cache.set(quality, { key, result });
      return result;
    } finally {
      this.#busy = false;
      const next = this.#pending;
      this.#pending = undefined;
      if (next) {
        this.#busy = true;
        next.start();
      }
    }
  }

  private previewImage(): ScaledImage {
    if (this.#preview?.imageId !== this.#imageId) {
      const image = this.#image!;
      this.#preview = {
        imageId: this.#imageId,
        image: boxDownscale(image.rgba, image.width, image.height, this.previewMaxLongEdge),
      };
    }
    return this.#preview.image;
  }

  private cacheKey(quality: RenderQuality): string {
    return `${this.#imageId}|${quality}|${JSON.stringify(this.#params)}`;
  }

  /**
   * `.cube` `size^3` (spec induk §7.2, spec Fase 2 §4.6): lattice identitas
   * dirender sebagai frame lewat rencana `'cube'` (semantik `lut_mode`,
   * digerbangi `test/parity/cube.test.ts`). Tidak butuh gambar terbuka.
   */
  async exportCube(size: number): Promise<string> {
    this.assertAlive();
    const lattice = identityLattice(size);
    const params = this.#params;
    const { rgb, plan } = await this.renderFrameWithPlan(lattice, params, 'cube');
    return formatCube(rgb, size, {
      title: `DICHROIC ${params.film} / ${params.paper}`,
      film: params.film,
      paper: params.paper,
      inputColorSpace: params.inputColorSpace,
      outputColorSpace: params.outputColorSpace,
      disabledEffects: plan.disabledEffects,
      version: DICHROIC_VERSION,
    });
  }

  /**
   * Ekspor render penuh (rencana 2B Task 7). Lewat `render('full')`, jadi
   * cache dipakai bila parameter dan gambar belum berubah, dan antrean
   * terbaru-menang tetap berlaku. Ekspor yang tersalip render lain sebelum
   * sempat mulai diantrekan ulang, bukan digagalkan: pengguna meminta berkas,
   * bukan pratinjau yang boleh dibuang.
   */
  async exportImage(format: ExportFormat): Promise<Uint8Array> {
    if (!EXPORT_FORMATS.includes(format)) {
      throw new RangeError(`Format ekspor tidak dikenal: ${String(format)} (pilihan: ${EXPORT_FORMATS.join(', ')}).`);
    }
    for (;;) {
      let result: RenderResult;
      try {
        result = await this.render('full');
      } catch (e) {
        if (e instanceof RenderSupersededError) continue;
        throw e;
      }
      const { rgb, width, height } = result;
      if (format === 'tiff16') return encodeTiff16(rgb, width, height);
      return encodePng(rgb, width, height, format === 'png8' ? 8 : 16);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pending?.reject(new SessionStateError('Session di-dispose() sebelum render ini dimulai.'));
    this.#pending = undefined;
    this.#cache.clear();
    for (const graph of this.graphs.values()) graph.dispose();
    this.graphs.clear();
    this.ownedArenas?.destroy();
    this.#image = undefined;
  }

  /** Render satu frame lewat rencana `mode`; keluaran 3 kanal rapat. */
  private async renderFrame(
    frame: { width: number; height: number; rgba: Float32Array },
    params: RenderParams,
    mode: RenderMode,
  ): Promise<Float32Array> {
    return (await this.renderFrameWithPlan(frame, params, mode)).rgb;
  }

  private async renderFrameWithPlan(
    frame: { width: number; height: number; rgba: Float32Array },
    params: RenderParams,
    mode: RenderMode,
  ): Promise<{ rgb: Float32Array; plan: RenderPlan }> {
    const plan = buildRenderPlan(params, this.bundle, frame, mode);
    const graph = await this.graphFor(plan);
    this.assertAlive();
    const rgba = await graph.run(frame.rgba, plan.core, Tap.RGB_OUT, {
      maxBufferBytes: this.engine.maxStorageBufferBindingSize,
      overlap: plan.overlap,
      frame: plan.frame,
    });
    return { rgb: packRgb(rgba, frame.width * frame.height), plan };
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

interface PendingRender {
  start(): void;
  reject(reason: unknown): void;
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
