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
import { RenderGraph, ScratchPool, returnFreedMemory } from '../engine/graph';
import { runPrecisionSelfTest } from '../engine/precisionSelfTest';
import { Tap } from '../engine/taps';
import type { Arenas } from '../engine/arena';
import { buildChain } from '../engine/chain';
import { precomputeArenaData, uploadArenas } from '../host/spectral';
import type { ArenaPlan } from '../host/spectral';
import type { DecodedImage } from '../io/decoded';
import { encodePng, encodeTiff16 } from '../io/encode';
import { EXIF_APP1_MAX_BYTES, exifForTiff, rewriteExif } from '../io/exif';
import { buildIccProfile } from '../io/icc';
import { encodeJpeg } from '../io/jpegEncoder';
import { CANVAS_FORMATS, offscreenCanvasEncoder } from '../io/canvasEncode';
import type { CanvasEncoder, CanvasFormat } from '../io/canvasEncode';
import { formatCube, identityLattice } from '../io/cube';
import { DICHROIC_VERSION } from '../version';
import { buildRenderPlan, FILM_FORMAT_LONG_EDGE_MM, validateStocks } from '../params/plan';
import { diffusionFftBytes, diffusionRadiusPx } from '../engine/stages/diffusionFft';
import type { ArenaInputs, RenderMode, RenderPlan } from '../params/plan';
import type { DepthMap } from '../host/lens';
import { applyParamsPatch } from '../params/registry';
import { BASELINE_RENDER_PARAMS } from '../params/renderParams';
import type { RenderParams } from '../params/renderParams';
import { loadAssets } from '../profiles/load';
import type { AssetBundle } from '../profiles/load';
import { RenderSupersededError, SessionStateError } from './errors';
import { PREVIEW_MAX_LONG_EDGE, boxDownscale } from './downscale';
import type { ScaledImage } from './downscale';
import { originalFrame, rgbToCanvas } from '../io/display';
import type { Frame } from '../io/display';
import { buildGuide } from '../depth/estimate';
import type { Guide } from '../depth/estimate';
import { assertImageBudget, imageMemoryBudget } from '../io/budget';

export type RenderQuality = 'full' | 'preview';

export interface PreparedPhoto {
  original: Frame;
  guide: Guide;
  preview: RenderResult;
  width: number;
  height: number;
  params: RenderParams;
}

/**
 * Format ekspor gambar. PNG 8/16-bit, TIFF 16-bit tak terkompresi (spec Fase
 * 2 §5), dan JPEG (`io/jpegEncoder.ts`) memakai encoder kita sendiri --
 * selalu tersedia, resolusi native tanpa batas kanvas iOS, dengan profil ICC
 * colour space keluaran dan EXIF asli. WebP/AVIF memakai encoder kanvas
 * browser dan hanya ditawarkan bila probing membuktikan browser
 * menghasilkannya (`exportFormats`).
 */
export type ExportFormat = 'png8' | 'png16' | 'tiff16' | CanvasFormat;
export const LOSSLESS_EXPORT_FORMATS: readonly ExportFormat[] = ['png8', 'png16', 'tiff16'];
/** Format dengan encoder sendiri (selalu ada). */
export const NATIVE_EXPORT_FORMATS: readonly ExportFormat[] = [...LOSSLESS_EXPORT_FORMATS, 'jpeg'];
/** Format lewat encoder kanvas browser. */
const BROWSER_EXPORT_FORMATS: readonly CanvasFormat[] = CANVAS_FORMATS.filter((f) => f !== 'jpeg');
export const EXPORT_FORMATS: readonly ExportFormat[] = [...NATIVE_EXPORT_FORMATS, ...BROWSER_EXPORT_FORMATS];

export interface ExportOptions {
  /**
   * Sisi panjang render ekspor (px). Tidak pernah memperbesar: nilai >= sisi
   * panjang gambar (atau tidak diisi) = resolusi sumber. Efek berukuran fisik
   * (grain, halation, DIR, difusi) dihitung pada pitch piksel render ini, jadi
   * ekspor kecil adalah render sungguhan, bukan hasil resize.
   */
  longEdge?: number;
  /** Kualitas format lossy, (0, 1]; bawaan 1. Diabaikan format lossless. */
  quality?: number;
}

export interface ExportRenderInfo {
  width: number;
  height: number;
}

export interface RenderResult {
  width: number;
  height: number;
  /** `rgb_out` 3 kanal rapat, sudah ter-encode di `outputColorSpace`. */
  rgb: Float32Array;
  quality: RenderQuality;
  /** Versi parameter saat render dimulai; UI membuang hasil yang versinya basi. */
  paramsVersion: number;
  outputColorSpace?: string;
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
  onDeviceLost?: (error: Error) => void;
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
  /**
   * Encoder JPEG/WebP/AVIF. Bawaan: `OffscreenCanvas` bila ada (worker
   * browser); tanpa encoder, format lossy tidak ditawarkan.
   */
  canvasEncoder?: CanvasEncoder;
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
  /** Ekstensi lens blur aktif: juga butuh frame utuh dalam satu binding. */
  lensBlur = false,
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
  if (sites.length === 0 && !lensBlur) return original;
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
  #photoId = 0;
  #preview: { imageId: number; image: ScaledImage } | undefined;
  /** Peta kedalaman foto terbuka (lens blur); dihapus saat `open`. */
  #depth: DepthMap | undefined;
  #depthId = 0;
  #disposed = false;
  /** Antrean terbaru-menang: paling banyak satu render berjalan dan satu menunggu. */
  #busy = false;
  private readonly idleWaiters = new Set<() => void>();
  #pending: PendingRender | undefined;
  /**
   * Satu hasil terakhir per kualitas. Slot `full` menampung render penuh
   * terakhir pada sisi panjang apa pun (ekspor); kuncinya memuat sisi itu.
   */
  readonly #cache = new Map<RenderQuality, { key: string; result: RenderResult }>();
  private readonly graphs = new Map<string, Promise<RenderGraph>>();
  private graphArenaKey: string | undefined;
  private cleanupPending = false;
  private exportCleanupPending = false;
  private exportVersion = 0;
  private staged: { id: number; image: DecodedImage; params: RenderParams; backup?: {
    image: DecodedImage | undefined; params: RenderParams; depth: DepthMap | undefined; photoId: number;
  } } | undefined;
  /**
   * Scratch GPU bersama semua graf: render berurutan (antrean di atas), jadi
   * satu pool cukup, dan mengganti stok/filter (graf baru) tidak menggandakan
   * scratch seukuran frame. Dilepas setelah setiap render penuh (`execute`).
   */
  #scratch: ScratchPool | undefined;

  private constructor(
    private readonly engine: EngineDevice,
    private readonly bundle: AssetBundle,
    private readonly arenas: ArenaProvider,
    private readonly ownedArenas: OwnedArenaProvider | undefined,
    private readonly previewMaxLongEdge: number,
    readonly diagnostics: Readonly<SessionDiagnostics>,
    private readonly canvasEncoder: CanvasEncoder | undefined,
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
    const session = new Session(
      engine,
      bundle,
      opts.arenaProvider ?? owned!,
      owned,
      opts.previewMaxLongEdge ?? PREVIEW_MAX_LONG_EDGE,
      Object.freeze({ iirPrecisionOk: selfTest.ok, iirMaxAbsError: selfTest.maxAbsError }),
      opts.canvasEncoder ?? (typeof OffscreenCanvas !== 'undefined' ? offscreenCanvasEncoder : undefined),
    );
    void engine.device.lost.then((info) => {
      if (session.#disposed) return;
      const error = new SessionStateError(`The GPU device was lost (${info.reason}): ${info.message}. Reopen the photo to retry.`);
      session.dispose();
      opts.onDeviceLost?.(error);
    });
    return session;
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
  /**
   * Lembar Ekspor ditutup: lepas render penuh yang di-cache (RGB f32 seukuran
   * foto) dan scratch GPU. Seperti EMULSION, hasil ekspor hanya dipegang
   * selama dialognya terbuka.
   */
  releaseExport(): void {
    this.#cache.delete('full');
    this.exportVersion += 1;
    this.exportCleanupPending = true;
    if (!this.#busy) {
      this.#scratch?.release();
      this.exportCleanupPending = false;
    }
  }

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
    assertImageBudget(image.width, image.height);
    if (image.rgba.length !== image.width * image.height * 4) {
      throw new RangeError(
        `DecodedImage ${image.width}x${image.height} butuh ${image.width * image.height * 4} float RGBA, ` +
          `diterima ${image.rgba.length}.`,
      );
    }
    this.#image = image;
    this.#photoId = 0;
    this.#imageId += 1;
    this.#preview = undefined;
    this.#depth = undefined;
    this.#depthId += 1;
    this.#cache.clear();
  }

  /**
   * Peta kedalaman foto terbuka untuk lens blur: disparitas ternormalisasi
   * (0 = tak hingga), baris atas-ke-bawah, orientasi sama dengan gambar.
   * Resolusinya bebas (diambil bilinear). `null` menghapusnya.
   */
  setDepthMap(map: DepthMap | null, photoId?: number): void {
    this.assertAlive();
    if (photoId !== undefined && photoId !== this.#photoId) throw new RenderSupersededError();
    if (map) {
      const { width, height, data } = map;
      if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) || data.length !== width * height) {
        throw new RangeError(`Peta kedalaman ${width}x${height} butuh ${width * height} float, diterima ${data.length}.`);
      }
    }
    this.#depth = map ?? undefined;
    this.#depthId += 1;
  }

  /** Prepare and render a candidate without replacing the current photo. */
  stageOpen(id: number, image: DecodedImage, patch: Partial<RenderParams>, guideMaxEdge: number): Promise<PreparedPhoto> {
    this.assertAlive();
    this.discardOpen(this.staged?.id ?? -1);
    const params = applyParamsPatch(this.#params, patch);
    validateStocks(this.bundle, params.film, params.paper, params.process);
    // The previous source is retained until a replacement commits. Bound
    // their combined storage, too, so cancellation remains affordable.
    assertImageBudget(image.width, image.height, 16, imageMemoryBudget() - (this.#image?.rgba.byteLength ?? 0));
    if (image.rgba.length !== image.width * image.height * 4) throw new RangeError('Invalid photo dimensions.');
    const staged = { id, image, params };
    this.staged = staged;
    return this.enqueue(async () => {
      if (this.staged !== staged) throw new RenderSupersededError();
      if (this.#image) {
        this.#cache.delete('full');
        this.clearResources();
      }
      const original = originalFrame(image, this.previewMaxLongEdge);
      const guide = buildGuide(image, guideMaxEdge);
      const frame = boxDownscale(image.rgba, image.width, image.height, this.previewMaxLongEdge);
      const { rgb } = await this.renderFrameWithPlan(frame, params, 'image', null);
      if (this.staged !== staged) throw new RenderSupersededError();
      return { original, guide, width: image.width, height: image.height, params,
        preview: { width: frame.width, height: frame.height, rgb, quality: 'preview', paramsVersion: this.#paramsVersion } };
    });
  }

  commitOpen(id: number): void {
    const staged = this.staged;
    if (!staged || staged.id !== id) throw new RenderSupersededError();
    staged.backup = { image: this.#image, params: this.#params, depth: this.#depth, photoId: this.#photoId };
    this.open(staged.image);
    this.#photoId = id;
    this.#params = staged.params;
    this.#paramsVersion += 1;
  }

  finishOpen(id: number): void {
    if (this.staged?.id === id) this.staged = undefined;
  }

  discardOpen(id: number): void {
    const staged = this.staged;
    if (staged?.id !== id) return;
    if (staged.backup) {
      this.#image = staged.backup.image;
      this.#photoId = staged.backup.photoId;
      this.#params = staged.backup.params;
      this.#depth = staged.backup.depth;
      this.#imageId += 1;
      this.#paramsVersion += 1;
      this.#depthId += 1;
      this.#preview = undefined;
      this.#cache.clear();
    }
    this.staged = undefined;
  }

  /** Ada peta kedalaman untuk foto terbuka. */
  hasDepthMap(): boolean {
    return this.#depth !== undefined;
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
    return this.renderAt(quality, undefined);
  }

  /** `render` dengan sisi panjang ekspor (`undefined` = sumber; hanya `full`). */
  private renderAt(quality: RenderQuality, longEdge: number | undefined): Promise<RenderResult> {
    const hit = this.#cache.get(quality);
    if (hit && hit.key === this.cacheKey(quality, longEdge)) return Promise.resolve(hit.result);
    return this.enqueue(() => this.execute(quality, longEdge));
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
    if (this.cleanupPending) this.clearResources();
    else if (this.exportCleanupPending) {
      this.#scratch?.release();
      this.exportCleanupPending = false;
    }
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
    const next = this.#pending;
    this.#pending = undefined;
    if (next) {
      this.#busy = true;
      next.start();
    }
  }

  private async execute(quality: RenderQuality, longEdge?: number): Promise<RenderResult> {
    this.assertAlive();
    const image = this.#image;
    if (!image) throw new SessionStateError('The photo was closed.');
    const params = this.#params;
    const paramsVersion = this.#paramsVersion;
    const exportVersion = this.exportVersion;
    const key = this.cacheKey(quality, longEdge);
    const frame =
      quality === 'preview'
        ? this.previewImage()
        : this.fitForDiffusion(longEdge === undefined ? image : boxDownscale(image.rgba, image.width, image.height, longEdge), params);
    let rgb: Float32Array;
    try {
      rgb = await this.renderFrame(frame, params, 'image');
    } finally {
      // Scratch seukuran foto penuh tidak dibiarkan menetap setelah ekspor:
      // pratinjau berikutnya hanya butuh sepotong kecilnya.
      if (quality === 'full') {
        this.#scratch?.release();
        returnFreedMemory(this.engine.device);
      }
    }
    const result: RenderResult = { width: frame.width, height: frame.height, rgb, quality, paramsVersion, outputColorSpace: params.outputColorSpace };
    if (!this.#disposed && key === this.cacheKey(quality, longEdge) && (quality !== 'full' || exportVersion === this.exportVersion)) this.#cache.set(quality, { key, result });
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
  private fitForDiffusion(
    image: { width: number; height: number; rgba: Float32Array },
    params: RenderParams,
  ): { width: number; height: number; rgba: Float32Array } {
    const lensBlur = params.lensBlurEnabled && this.#depth !== undefined;
    const longEdge = diffusionRenderLongEdge(
      image.width,
      image.height,
      params,
      this.engine.maxStorageBufferBindingSize,
      DIFFUSION_PLANE_BUDGET,
      lensBlur,
    );
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

  private cacheKey(quality: RenderQuality, longEdge?: number): string {
    return `${this.#imageId}|${this.#depthId}|${quality}|${longEdge ?? 'source'}|${JSON.stringify(this.#params)}`;
  }

  /** Sisi panjang ekspor yang efektif: `undefined` bila sama/lebih besar dari sumber. */
  private exportLongEdge(longEdge: number | undefined): number | undefined {
    const image = this.#image;
    if (longEdge === undefined || !image) return undefined;
    if (!Number.isFinite(longEdge) || longEdge < 1) {
      throw new RangeError(`longEdge ekspor harus >= 1 px, diterima ${String(longEdge)}.`);
    }
    const edge = Math.round(longEdge);
    return edge >= Math.max(image.width, image.height) ? undefined : edge;
  }

  /** Render penuh untuk ekspor; render yang tersalip sebelum mulai diantrekan ulang. */
  private async renderForExport(longEdge: number | undefined): Promise<RenderResult> {
    for (;;) {
      try {
        this.assertAlive();
        if (!this.#image) throw new SessionStateError('Ekspor sebelum open(): belum ada gambar.');
        return await this.renderAt('full', this.exportLongEdge(longEdge));
      } catch (e) {
        if (e instanceof RenderSupersededError) continue;
        throw e;
      }
    }
  }

  /**
   * Fase render ekspor saja (gaya EMULSION): UI memanggilnya saat lembar
   * Ekspor dibuka atau sisi panjang berubah, lalu `exportImage` dengan format
   * dan kualitas apa pun memakai hasil yang sama dari cache -- menggeser
   * kualitas hanya meng-encode ulang. Ukuran yang dikembalikan bisa lebih
   * kecil dari permintaan bila difusi memaksa `fitForDiffusion`.
   */
  async renderExport(longEdge?: number): Promise<ExportRenderInfo> {
    const { width, height } = await this.renderForExport(longEdge);
    return { width, height };
  }

  /**
   * Format ekspor yang bisa dihasilkan di sini: PNG/TIFF/JPEG selalu,
   * WebP/AVIF hanya yang lolos probing encoder kanvas.
   */
  async exportFormats(): Promise<ExportFormat[]> {
    const lossy = this.canvasEncoder ? await this.canvasEncoder.probe() : [];
    return [...NATIVE_EXPORT_FORMATS, ...BROWSER_EXPORT_FORMATS.filter((f) => lossy.includes(f))];
  }

  /** Profil ICC per label colour space keluaran (deterministik, jadi di-cache). */
  readonly #icc = new Map<string, Uint8Array | undefined>();

  private iccFor(label: string): Uint8Array | undefined {
    if (!this.#icc.has(label)) {
      const spec = this.bundle.manifest.outputColorSpaces[label];
      this.#icc.set(label, spec ? buildIccProfile(spec, label) : undefined);
    }
    return this.#icc.get(label);
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
  async exportImage(format: ExportFormat, options: ExportOptions = {}): Promise<Uint8Array> {
    if (!EXPORT_FORMATS.includes(format)) {
      throw new RangeError(`Format ekspor tidak dikenal: ${String(format)} (pilihan: ${EXPORT_FORMATS.join(', ')}).`);
    }
    const canvasFormat = (BROWSER_EXPORT_FORMATS as readonly string[]).includes(format) ? (format as CanvasFormat) : undefined;
    if (canvasFormat && !this.canvasEncoder) {
      throw new RangeError(`Format ${format} butuh encoder kanvas browser, yang tidak tersedia di sini.`);
    }
    const imageId = this.#imageId;
    const exif = this.#image?.exif;
    const result = await this.renderForExport(options.longEdge);
    if (imageId !== this.#imageId) throw new RenderSupersededError();
    const { rgb, width, height } = result;
    const outputColorSpace = result.outputColorSpace ?? this.#params.outputColorSpace;
    if (canvasFormat) {
      const colorSpace = outputColorSpace === 'Display P3' ? 'display-p3' : 'srgb';
      return this.canvasEncoder!.encode(rgbToCanvas(rgb, width, height, outputColorSpace, colorSpace, this.bundle.manifest.outputColorSpaces), width, height, canvasFormat, options.quality ?? 1, colorSpace);
    }
    const icc = this.iccFor(outputColorSpace);
    const exifOptions = { width, height, srgb: outputColorSpace === 'sRGB' };
    if (format === 'jpeg') {
      const quality = Math.min(100, Math.max(1, Math.round((options.quality ?? 1) * 100)));
      const app1 = exif && rewriteExif(exif, { ...exifOptions, maxBytes: EXIF_APP1_MAX_BYTES });
      return encodeJpeg(rgb, width, height, { quality, ...(icc ? { icc } : {}), ...(app1 ? { exif: app1 } : {}) });
    }
    if (format === 'tiff16') {
      const tiffExif = exif && exifForTiff(exif, exifOptions);
      return encodeTiff16(rgb, width, height, { ...(icc ? { icc } : {}), ...(tiffExif ? { exif: tiffExif } : {}) });
    }
    const pngExif = exif && rewriteExif(exif, exifOptions);
    return encodePng(rgb, width, height, format === 'png8' ? 8 : 16, {
      ...(icc ? { icc, iccName: outputColorSpace } : {}),
      ...(pngExif ? { exif: pngExif } : {}),
    });
  }

  /** Release photo resources after any active GPU job has completed. */
  close(): Promise<void> {
    this.staged = undefined;
    this.#pending?.reject(new RenderSupersededError());
    this.#pending = undefined;
    this.#image = undefined;
    this.#photoId = 0;
    this.#imageId += 1;
    this.#preview = undefined;
    this.#depth = undefined;
    this.#depthId += 1;
    this.#cache.clear();
    this.cleanupPending = true;
    if (!this.#busy) this.clearResources();
    return this.#busy ? new Promise((resolve) => this.idleWaiters.add(resolve)) : Promise.resolve();
  }

  private clearResources(): void {
    this.cleanupPending = false;
    for (const graph of this.graphs.values()) void graph.then((g) => g.dispose(), () => {});
    this.graphs.clear();
    this.graphArenaKey = undefined;
    this.#scratch?.release();
    this.#scratch = undefined;
    this.exportCleanupPending = false;
    this.ownedArenas?.destroy();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.close();
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
    depth: DepthMap | null | undefined = this.#depth,
  ): Promise<{ rgb: Float32Array; plan: RenderPlan }> {
    const plan = buildRenderPlan(params, this.bundle, frame, mode, mode === 'image' && depth ? { depth } : {});
    const graph = await this.graphFor(plan);
    this.assertAlive();
    const rgb = await graph.run(frame.rgba, plan.core, Tap.RGB_OUT, {
      maxBufferBytes: this.engine.maxStorageBufferBindingSize,
      overlap: plan.overlap,
      frame: plan.frame,
      output: 'rgb',
    });
    return { rgb, plan };
  }

  /**
   * Graf per (arena, varian rantai). Map menyimpan `Promise`, jadi dua
   * permintaan bersamaan untuk kunci yang sama berbagi satu graf alih-alih
   * membangun dua (yang kedua dulu tertimpa tanpa di-dispose).
   */
  private async graphFor(plan: RenderPlan): Promise<RenderGraph> {
    // All graph use is serialized by enqueue(). A new filter/stock variant
    // can safely retire the previous arenas and their dependent graphs here.
    if (this.graphArenaKey !== plan.arenaKey) {
      if (this.graphArenaKey !== undefined) this.clearResources();
      this.graphArenaKey = plan.arenaKey;
    }
    const key =
      `${plan.arenaKey}|${plan.chain.family}|grain=${plan.chain.grain}|scan=${plan.chain.scan ?? false}` +
      `|dc=${plan.chain.cameraDiffusion ?? false}|dp=${plan.chain.printDiffusion ?? false}|lb=${plan.chain.lensBlur ?? false}`;
    const existing = this.graphs.get(key);
    if (existing) {
      this.graphs.delete(key);
      this.graphs.set(key, existing);
      return existing;
    }
    if (this.graphs.size >= 4) {
      const oldest = this.graphs.entries().next().value!;
      this.graphs.delete(oldest[0]);
      (await oldest[1]).dispose();
    }
    const building = (async () => {
      const arenas = await this.arenas.get(plan.arenaKey, plan.arenaInputs);
      this.#scratch ??= new ScratchPool(this.engine.device);
      const graph = new RenderGraph(this.engine, this.#scratch);
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
