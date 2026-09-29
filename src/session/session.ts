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
import { buildRenderPlan, FILM_FORMAT_LONG_EDGE_MM, validateStocks } from '../params/plan';
import { diffusionFftBytes, diffusionRadiusPx } from '../engine/stages/diffusionFft';
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

/** Byte maksimum satu bidang FFT difusi (dari tiga; lih. `fitForDiffusion`). */
export const DIFFUSION_PLANE_BUDGET = 256 * 1024 * 1024;

/**
 * Sisi panjang terbesar (<= asli) tempat render penuh dengan difusi aktif
 * muat: frame utuh dalam satu binding storage, dan tiap bidang FFT df64
 * <= min(`planeBudget`, batas binding). Tanpa difusi: sisi panjang asli.
 */
export function diffusionRenderLongEdge(
  width: number,
  height: number,
  params: RenderParams,
  maxBindingBytes: number,
  planeBudget = DIFFUSION_PLANE_BUDGET,
): number {
  const original = Math.max(width, height);
  const sites = [
    params.cameraDiffusionEnabled && params.cameraDiffusionStrength > 0
      ? { family: params.cameraDiffusionFamily, strength: params.cameraDiffusionStrength }
      : undefined,
    params.process !== 'scanNegative' && params.printDiffusionEnabled && params.printDiffusionStrength > 0
      ? { family: params.printDiffusionFamily, strength: params.printDiffusionStrength }
      : undefined,
  ].filter((site) => site !== undefined);
  if (sites.length === 0) return original;
  const planeLimit = Math.min(planeBudget, maxBindingBytes);
  const filmFormatMm = FILM_FORMAT_LONG_EDGE_MM[params.filmFormat];
  const aspect = Math.min(width, height) / original;
  const dims = (edge: number) =>
    width >= height
      ? { w: edge, h: Math.max(1, Math.round(edge * aspect)) }
      : { w: Math.max(1, Math.round(edge * aspect)), h: edge };
  const fits = (edge: number) => {
    const { w, h } = dims(edge);
    return (
      w * h * 16 <= maxBindingBytes &&
      sites.every((site) => {
        const radius = diffusionRadiusPx(site, (filmFormatMm * 1000) / Math.max(w, h), w, h);
        return diffusionFftBytes(w, h, radius) / 3 <= planeLimit;
      })
    );
  };
  let edge = original;
  while (edge > 256 && !fits(edge)) edge = Math.floor(edge * 0.9);
  return edge;
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
  private readonly graphs = new Map<string, Promise<RenderGraph>>();

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

  /**
   * Ukuran render penuh terakhir (Fase 2D): lebih kecil dari gambar bila
   * difusi memaksa `fitForDiffusion`. UI membandingkannya setelah ekspor.
   */
  lastFullSize(): { width: number; height: number } | undefined {
    const hit = this.#cache.get('full');
    return hit ? { width: hit.result.width, height: hit.result.height } : undefined;
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
    validateStocks(this.bundle, next.film, next.paper, next.process);
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

    return this.enqueue(() => this.execute(quality));
  }

  /**
   * Mengompilasi lebih dulu varian rantai yang belum pernah dirender untuk
   * parameter saat ini: keluarga `measured` dengan grain hidup dan mati, dan
   * `lut` (ekspor `.cube`). Kompilasi shader pertama sebuah varian 2..9 s;
   * tanpa prewarm jeda itu jatuh saat pengguna pertama kali menyalakan grain
   * atau mengekspor kubus. Frame 8x8 cukup -- yang mahal kompilasinya.
   *
   * Lewat antrean yang sama dengan `render` (tidak pernah berjalan bersamaan
   * dengan render), dan seperti render yang menunggu, ia tersalip oleh
   * permintaan render berikutnya (`RenderSupersededError`). Tidak butuh
   * gambar terbuka.
   */
  prewarm(): Promise<void> {
    try {
      this.assertAlive();
    } catch (e) {
      return Promise.reject(e);
    }
    return this.enqueue(async () => {
      const params = this.#params;
      const tiny = { width: 8, height: 8, rgba: new Float32Array(8 * 8 * 4).fill(0.18) };
      for (const grainEnabled of [params.grainEnabled, !params.grainEnabled]) {
        this.assertAlive();
        await this.renderFrame(tiny, { ...params, grainEnabled }, 'image');
      }
      this.assertAlive();
      await this.renderFrame(identityLattice(2), params, 'cube');
    });
  }

  /** Antrean terbaru-menang bersama untuk `render` dan `prewarm`. */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: PendingRender = {
        start: () => {
          run()
            .finally(() => this.release())
            .then(resolve, reject);
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

  private release(): void {
    this.#busy = false;
    const next = this.#pending;
    this.#pending = undefined;
    if (next) {
      this.#busy = true;
      next.start();
    }
  }

  private async execute(quality: RenderQuality): Promise<RenderResult> {
    this.assertAlive();
    const image = this.#image!;
    const params = this.#params;
    const paramsVersion = this.#paramsVersion;
    const key = this.cacheKey(quality);
    const frame = quality === 'preview' ? this.previewImage() : this.fitForDiffusion(image, params);
    const rgb = await this.renderFrame(frame, params, 'image');
    const result: RenderResult = { width: frame.width, height: frame.height, rgb, quality, paramsVersion };
    if (!this.#disposed) this.#cache.set(quality, { key, result });
    return result;
  }

  /**
   * Fase 2D Task 4: konvolusi FFT difusi butuh frame utuh (tidak bisa di-tile)
   * dan tiga bidang kompleks df64 (16 byte per elemen) seukuran pangkat dua
   * >= (w + 2r) x (h + 2r). Bila render penuh tidak muat dalam
   * `DIFFUSION_PLANE_BUDGET` per bidang (dan batas binding storage device),
   * gambar diperkecil ke sisi panjang terbesar yang muat -- ekspor tetap
   * berjalan, hanya lebih kecil; `lastRenderSize` melaporkannya ke UI.
   */
  private fitForDiffusion(image: DecodedImage, params: RenderParams): { width: number; height: number; rgba: Float32Array } {
    const longEdge = diffusionRenderLongEdge(image.width, image.height, params, this.engine.maxStorageBufferBindingSize);
    if (longEdge >= Math.max(image.width, image.height)) return image;
    return boxDownscale(image.rgba, image.width, image.height, longEdge);
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
   * Lewat antrean render (graf `lut` juga dipakai `prewarm`); bila tersalip
   * sebelum mulai, diantrekan ulang seperti `exportImage`.
   */
  async exportCube(size: number): Promise<string> {
    this.assertAlive();
    const lattice = identityLattice(size);
    for (;;) {
      try {
        return await this.enqueue(() => this.renderCube(lattice, size));
      } catch (e) {
        if (e instanceof RenderSupersededError) continue;
        throw e;
      }
    }
  }

  private async renderCube(lattice: { width: number; height: number; rgba: Float32Array }, size: number): Promise<string> {
    this.assertAlive();
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
    for (const graph of this.graphs.values()) void graph.then((g) => g.dispose(), () => {});
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

  /**
   * Graf per (arena, varian rantai). Map menyimpan `Promise`, jadi dua
   * permintaan bersamaan untuk kunci yang sama berbagi satu graf alih-alih
   * membangun dua (yang kedua dulu tertimpa tanpa di-dispose).
   */
  private graphFor(plan: RenderPlan): Promise<RenderGraph> {
    const key =
      `${plan.arenaKey}|${plan.chain.family}|grain=${plan.chain.grain}|scan=${plan.chain.scan ?? false}` +
      `|dc=${plan.chain.cameraDiffusion ?? false}|dp=${plan.chain.printDiffusion ?? false}`;
    const existing = this.graphs.get(key);
    if (existing) return existing;
    const building = (async () => {
      const arenas = await this.arenas.get(plan.arenaKey, plan.arenaInputs);
      const graph = new RenderGraph(this.engine);
      for (const stage of buildChain(this.engine.device, arenas, plan.chain)) graph.addStage(stage);
      return graph;
    })();
    this.graphs.set(key, building);
    building.catch(() => {
      if (this.graphs.get(key) === building) this.graphs.delete(key);
    });
    return building;
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
