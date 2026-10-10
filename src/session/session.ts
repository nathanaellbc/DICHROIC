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
import { GpuMemoryError, RenderGraph, ScratchPool, returnFreedMemory } from '../engine/graph';
import type { TileSource } from '../engine/graph';
import { DIFFUSION_PLANE_BUDGET, previewRenderLongEdge, diffusionRenderLongEdge } from './renderSize';
export { DIFFUSION_PLANE_BUDGET, previewRenderLongEdge, diffusionRenderLongEdge } from './renderSize';
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
import { buildRenderPlan, validateStocks } from '../params/plan';
import type { PlanImage } from '../params/plan';
import type { ArenaInputs, RenderMode, RenderPlan } from '../params/plan';
import type { DepthMap } from '../host/lens';
import { applyParamsPatch } from '../params/registry';
import { BASELINE_RENDER_PARAMS } from '../params/renderParams';
import type { RenderParams } from '../params/renderParams';
import { loadAssets } from '../profiles/load';
import { loadPrintCube } from '../profiles/printLuts';
import type { AssetBundle } from '../profiles/load';
import { RenderSupersededError, SessionStateError } from './errors';
import { ExportPixels } from './exportPixels';
import { exportTarget } from './exportTarget';
import type { ExportTarget } from './exportTarget';
import { SourcePixels } from './sourcePixels';
import { PREVIEW_MAX_LONG_EDGE, boxDownscale, boxDownscaleRegion, boxDownscaleSize, measurementImage } from './downscale';
import type { ScaledImage } from './downscale';
import { originalFrame } from '../io/display';
import type { Frame } from '../io/display';
import { buildGuide } from '../depth/estimate';
import { applyRemoval, prepareRemoval, restoreRemoval } from '../retouch/patch';
import type { RemovalCrop, RemovalMask } from '../retouch/patch';
import type { Guide } from '../depth/estimate';
import { MIN_EXPORT_TILE_SCALE, assertImageBudget, clampTileScale, exportTileMemoryBudget, wholeFrameMemoryBudget, imageMemoryBudget, previewCacheBudgetBytes } from '../io/budget';

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

/**
 * Foto terbuka: metadata `DecodedImage` + piksel sumber ringkas
 * (`SourcePixels`, lossless). Hanya hapus objek yang mengubahnya ke f32.
 */
type SessionImage = Omit<DecodedImage, 'rgba'> & { pixels: SourcePixels };

function toSessionImage(image: DecodedImage): SessionImage {
  const { rgba, ...meta } = image;
  return { ...meta, pixels: SourcePixels.from(rgba) };
}

/** `DecodedImage` kecil (sisi panjang <= `maxEdge`) untuk fungsi yang butuh RGBA f32. */
function scaledDecoded(image: SessionImage, maxEdge: number): DecodedImage {
  const { pixels, ...meta } = image;
  return { ...meta, ...boxDownscale(pixels, image.width, image.height, maxEdge) };
}

export interface ExportRenderInfo {
  width: number;
  height: number;
  /** Skala anggaran tile yang berhasil (lih. `exportTileMemoryBudget`); UI menyimpannya. */
  tileScale: number;
}

export interface ExportRenderOptions {
  /** Skala anggaran tile awal (0..1] yang dipelajari UI lintas sesi. */
  tileScale?: number;
  /** Piksel yang disimpan (`exportTarget(format)`); baku `'rgb8'`. */
  target?: ExportTarget;
}

/** Kemajuan render ekspor yang sedang berjalan (`Session.exportProgress`). */
export interface ExportProgress {
  done: number;
  total: number;
  tileWidth: number;
  tileHeight: number;
  width: number;
  height: number;
  tileScale: number;
}

export interface RenderResult {
  /** Original at the same resolution as an explicitly sized preview. */
  original?: Frame;
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

export class Session {
  #params: RenderParams = { ...BASELINE_RENDER_PARAMS };
  #paramsVersion = 0;
  #image: SessionImage | undefined;
  #imageId = 0;
  #removalUndo: { crop: RemovalCrop; backup: Float32Array } | undefined;
  #photoId = 0;
  #preview: { imageId: number; longEdge: number; image: ScaledImage } | undefined;
  #draftPreview: { imageId: number; longEdge: number; image: ScaledImage } | undefined;
  #originalPreview: { imageId: number; longEdge: number; frame: Frame } | undefined;
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
  #exportCache: { key: string; result: ExportPixels } | undefined;
  /** Recent zoom/undo results, bounded by both RAM and entry count. */
  readonly #previewCache = new Map<string, RenderResult>();
  private readonly graphs = new Map<string, Promise<RenderGraph>>();
  private graphArenaKey: string | undefined;
  private cleanupPending = false;
  private exportCleanupPending = false;
  private exportVersion = 0;
  private staged: { id: number; image: SessionImage; params: RenderParams; backup?: {
    image: SessionImage | undefined; params: RenderParams; depth: DepthMap | undefined; photoId: number;
  } } | undefined;
  /**
   * Scratch GPU bersama semua graf: render berurutan (antrean di atas), jadi
   * satu pool cukup, dan mengganti stok/filter (graf baru) tidak menggandakan
   * scratch seukuran frame. Dilepas setelah setiap render penuh (`execute`).
   */
  #scratch: ScratchPool | undefined;
  /** Skala anggaran tile ekspor yang dipelajari (1 = awal; dibagi dua tiap GPU kehabisan memori). */
  #tileScale = 1;
  #exportProgress: ExportProgress | undefined;

  private constructor(
    private readonly engine: EngineDevice,
    private readonly bundle: AssetBundle,
    private readonly arenas: ArenaProvider,
    private readonly ownedArenas: OwnedArenaProvider | undefined,
    private readonly previewMaxLongEdge: number,
    readonly diagnostics: Readonly<SessionDiagnostics>,
    private readonly canvasEncoder: CanvasEncoder | undefined,
    private readonly assetsBaseUrl: string,
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
      opts.assetsBaseUrl,
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
    this.#exportCache = undefined;
    this.exportVersion += 1;
    this.exportCleanupPending = true;
    if (!this.#busy) {
      this.#scratch?.release();
      this.exportCleanupPending = false;
    }
  }

  lastFullSize(): { width: number; height: number } | undefined {
    if (this.#exportCache) return { width: this.#exportCache.result.width, height: this.#exportCache.result.height };
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

  open(image: DecodedImage | SessionImage): void {
    this.assertAlive();
    assertImageBudget(image.width, image.height);
    const length = 'rgba' in image ? image.rgba.length : image.pixels.length;
    if (length !== image.width * image.height * 4) {
      throw new RangeError(
        `DecodedImage ${image.width}x${image.height} butuh ${image.width * image.height * 4} float RGBA, ` +
          `diterima ${length}.`,
      );
    }
    this.#image = 'rgba' in image ? toSessionImage(image) : image;
    this.#removalUndo = undefined;
    this.#photoId = 0;
    this.#imageId += 1;
    this.#preview = undefined;
    this.#draftPreview = undefined;
    this.#originalPreview = undefined;
    this.#depth = undefined;
    this.#depthId += 1;
    this.#cache.clear();
    this.#exportCache = undefined;
    this.#previewCache.clear();
  }

  prepareRemoval(selection: RemovalMask): RemovalCrop {
    this.assertAlive();
    if (!this.#image) throw new SessionStateError('Open a photo first.');
    return prepareRemoval(this.editableImage(), selection, this.#imageId);
  }

  async applyRemoval(crop: RemovalCrop, output: Float32Array): Promise<{ original: Frame; guide: Guide }> {
    while (this.#busy) await new Promise<void>(resolve => this.idleWaiters.add(resolve));
    this.assertAlive();
    if (!this.#image || crop.revision !== this.#imageId) throw new RenderSupersededError();
    this.#removalUndo = { crop, backup: applyRemoval(this.editableImage(), crop, output) };
    return this.removalChanged();
  }

  async undoRemoval(): Promise<{ original: Frame; guide: Guide }> {
    while (this.#busy) await new Promise<void>(resolve => this.idleWaiters.add(resolve));
    this.assertAlive();
    if (!this.#image || !this.#removalUndo) throw new SessionStateError('No removal to undo.');
    restoreRemoval(this.editableImage(), this.#removalUndo.crop, this.#removalUndo.backup);
    this.#removalUndo = undefined;
    return this.removalChanged();
  }

  private removalChanged(): { original: Frame; guide: Guide } {
    this.#imageId += 1;
    this.#preview = undefined; this.#draftPreview = undefined; this.#originalPreview = undefined;
    this.#cache.clear(); this.#previewCache.clear();
    this.#exportCache = undefined;
    this.#depth = undefined; this.#depthId += 1;
    // The full render was removed with #cache; keep preview buffers for the
    // immediate regrade and the next film/paper selection.
    this.exportVersion += 1;
    const small = scaledDecoded(this.#image!, 1024);
    return { original: originalFrame(small, 1024), guide: buildGuide(small, 1024) };
  }

  /**
   * Foto sebagai RGBA f32 yang bisa diubah di tempat (hapus objek). Sumber
   * ringkas (8/16-bit) diubah sekali ke f32: hasil LaMa bukan kode 8-bit.
   */
  private editableImage(): DecodedImage {
    let image = this.#image!;
    if (!image.pixels.float) {
      image = { ...image, pixels: SourcePixels.float(image.pixels.toFloat()) };
      this.#image = image;
    }
    const { pixels, ...meta } = image;
    return { ...meta, rgba: pixels.float! };
  }

  /** Frame f32 seukuran sumber (render penuh tanpa downscale); salinan sementara bila sumber ringkas. */
  private sourceFrame(image: SessionImage): ScaledImage {
    return { width: image.width, height: image.height, rgba: image.pixels.toFloat() };
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
      const layers = map.layers;
      if (layers && [layers.foreground, layers.background, layers.alpha].some((plane) => plane.length !== width * height)) {
        throw new RangeError(`Lapisan kedalaman ${width}x${height} butuh ${width * height} float per bidang.`);
      }
    }
    this.#depth = map ?? undefined;
    this.#depthId += 1;
    this.#previewCache.clear();
  }

  /** Prepare and render a candidate without replacing the current photo. */
  stageOpen(id: number, image: DecodedImage, patch: Partial<RenderParams>, guideMaxEdge: number): Promise<PreparedPhoto> {
    this.assertAlive();
    this.discardOpen(this.staged?.id ?? -1);
    const params = applyParamsPatch(this.#params, patch);
    validateStocks(this.bundle, params.film, params.paper, params.process);
    // The previous source is retained until a replacement commits. Bound
    // their combined storage, too, so cancellation remains affordable.
    assertImageBudget(image.width, image.height, 16, imageMemoryBudget() - (this.#image?.pixels.byteLength ?? 0));
    if (image.rgba.length !== image.width * image.height * 4) throw new RangeError('Invalid photo dimensions.');
    // Diringkas sekarang: larik f32 hasil decode tidak dipegang lagi.
    const source = toSessionImage(image);
    const staged = { id, image: source, params };
    this.staged = staged;
    return this.enqueue(async () => {
      if (this.staged !== staged) throw new RenderSupersededError();
      if (this.#image) {
        this.#cache.delete('full');
        this.#exportCache = undefined;
        this.clearResources();
      }
      const original = originalFrame(scaledDecoded(source, this.previewMaxLongEdge), this.previewMaxLongEdge);
      const guide = buildGuide(scaledDecoded(source, guideMaxEdge), guideMaxEdge);
      const frame = boxDownscale(source.pixels, source.width, source.height, this.previewMaxLongEdge);
      const { rgb } = await this.renderFrameWithPlan(frame, params, 'image', null);
      if (this.staged !== staged) throw new RenderSupersededError();
      return { original, guide, width: source.width, height: source.height, params,
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
      this.#draftPreview = undefined;
      this.#originalPreview = undefined;
      this.#cache.clear();
      this.#exportCache = undefined;
      this.#previewCache.clear();
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
  render(quality: RenderQuality, longEdge?: number): Promise<RenderResult> {
    try {
      this.assertAlive();
      if (!this.#image) throw new SessionStateError('render() sebelum open(): belum ada gambar.');
    } catch (e) {
      return Promise.reject(e);
    }
    if (longEdge !== undefined && (!Number.isFinite(longEdge) || longEdge < 1)) return Promise.reject(new RangeError('Preview resolution must be positive and finite.'));
    return this.renderAt(quality, longEdge);
  }

  /** `render` dengan sisi panjang ekspor (`undefined` = sumber; hanya `full`). */
  private renderAt(quality: RenderQuality, longEdge: number | undefined): Promise<RenderResult> {
    const key = this.cacheKey(quality, longEdge);
    if (quality === 'preview') {
      const cached = this.#previewCache.get(key);
      if (cached) {
        this.#previewCache.delete(key);
        this.#previewCache.set(key, cached);
        return Promise.resolve(cached.paramsVersion === this.#paramsVersion ? cached : { ...cached, paramsVersion: this.#paramsVersion });
      }
    }
    const hit = this.#cache.get(quality);
    if (hit && hit.key === key) return Promise.resolve(hit.result.paramsVersion === this.#paramsVersion ? hit.result : { ...hit.result, paramsVersion: this.#paramsVersion });
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
        ? this.fitForDiffusion(this.previewImage(previewRenderLongEdge(image.width, image.height, longEdge ?? this.previewMaxLongEdge, params, this.engine.maxStorageBufferBindingSize)), params)
        : this.fitForDiffusion(longEdge === undefined ? this.sourceFrame(image) : boxDownscale(image.pixels, image.width, image.height, longEdge), params);
    let rgb: Float32Array;
    try {
      rgb = await this.renderFrame(frame, params, 'image');
    } finally {
      // Scratch seukuran foto penuh tidak dibiarkan menetap setelah ekspor:
      // pratinjau berikutnya hanya butuh sepotong kecilnya.
      if (quality === 'full' || (longEdge ?? 0) > this.previewMaxLongEdge) {
        this.#scratch?.release();
        returnFreedMemory(this.engine.device);
      }
    }
    const result: RenderResult = { width: frame.width, height: frame.height, rgb, quality, paramsVersion, outputColorSpace: params.outputColorSpace };
    if (quality === 'preview' && longEdge !== undefined) result.original = this.comparisonFrame(image, Math.max(frame.width, frame.height));
    if (!this.#disposed && key === this.cacheKey(quality, longEdge) && (quality !== 'full' || exportVersion === this.exportVersion)) {
      this.#cache.set(quality, { key, result });
      if (quality === 'preview') this.cachePreview(key, result);
    }
    return result;
  }

  private cachePreview(key: string, result: RenderResult): void {
    const size = (frame: RenderResult) => frame.rgb.byteLength + (frame.original?.pixels.byteLength ?? 0);
    const budget = previewCacheBudgetBytes();
    if (size(result) > budget) return; // The current frame still lives in #cache.
    this.#previewCache.delete(key);
    this.#previewCache.set(key, result);
    let bytes = [...this.#previewCache.values()].reduce((sum, frame) => sum + size(frame), 0);
    while (this.#previewCache.size > 6 || bytes > budget) {
      const oldest = this.#previewCache.entries().next().value!;
      bytes -= size(oldest[1]);
      this.#previewCache.delete(oldest[0]);
    }
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
      wholeFrameMemoryBudget(),
    );
    if (longEdge >= Math.max(image.width, image.height)) return image;
    return boxDownscale(image.rgba, image.width, image.height, longEdge);
  }

  private previewImage(longEdge = this.previewMaxLongEdge): ScaledImage {
    for (const cached of [this.#preview, this.#draftPreview]) {
      if (cached?.imageId === this.#imageId && cached.longEdge === longEdge) return cached.image;
    }
    const image = this.#image!;
    const cached = { imageId: this.#imageId, longEdge, image: boxDownscale(image.pixels, image.width, image.height, longEdge) };
    // Keep both refinement and draft inputs: switching quality must not scan
    // the entire 44 MP original again on every parameter change.
    if (longEdge <= 512) this.#draftPreview = cached;
    else this.#preview = cached;
    return cached.image;
  }

  /** Comparison pixels depend only on the source and size, never slider values. */
  private comparisonFrame(image: SessionImage, longEdge: number): Frame {
    if (image !== this.#image) return originalFrame(scaledDecoded(image, longEdge), longEdge);
    if (this.#originalPreview?.imageId !== this.#imageId || this.#originalPreview.longEdge !== longEdge) {
      this.#originalPreview = { imageId: this.#imageId, longEdge, frame: originalFrame(scaledDecoded(image, longEdge), longEdge) };
    }
    return this.#originalPreview.frame;
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
  private async renderForExport(longEdge: number | undefined, target: ExportTarget): Promise<ExportPixels> {
    const exportVersion = this.exportVersion;
    for (;;) {
      try {
        this.assertAlive();
        if (!this.#image) throw new SessionStateError('Ekspor sebelum open(): belum ada gambar.');
        const edge = this.exportLongEdge(longEdge);
        const key = `${this.cacheKey('full', edge)}|${target}`;
        if (this.#exportCache?.key === key) return this.#exportCache.result;
        return await this.enqueue(() => this.executeExport(edge, target));
      } catch (e) {
        if (e instanceof RenderSupersededError && exportVersion === this.exportVersion) continue;
        throw e;
      }
    }
  }

  /**
   * Siklus ekspor gaya EMULSION: render per tile, gambar inti, yield, cache,
   * lepas pekerjaan GPU. Ukuran tile adaptif (`exportTileMemoryBudget`):
   * mulai dari skala yang dipelajari, dibagi dua dan diulang tiap kali GPU
   * kehabisan memori. Tile dibaca langsung dari foto sumber (tanpa frame
   * terskala utuh) kecuali efek yang butuh frame utuh.
   */
  private async executeExport(longEdge: number | undefined, target: ExportTarget): Promise<ExportPixels> {
    this.assertAlive();
    const image = this.#image;
    if (!image) throw new SessionStateError('The photo was closed.');
    const params = this.#params;
    const renderKey = this.cacheKey('full', longEdge);
    const key = `${renderKey}|${target}`;
    if (this.#exportCache?.key === key) return this.#exportCache.result;
    // Drop the previous size before allocating its replacement.
    this.#exportCache = undefined;
    const version = this.exportVersion;
    const cancelled = () => this.#disposed || version !== this.exportVersion || renderKey !== this.cacheKey('full', longEdge);
    // Lepas working set pratinjau dulu: tanpa ini buffer pratinjau (~300 MB
    // di HP) masih hidup saat buffer tile pertama dibuat. Salinan pratinjau
    // di CPU juga dibuang; dibuat ulang dari sumber saat pratinjau berikutnya.
    this.#scratch?.release();
    this.#preview = undefined;
    this.#draftPreview = undefined;
    this.#originalPreview = undefined;
    this.#previewCache.clear();
    const size = boxDownscaleSize(image.width, image.height, longEdge ?? Math.max(image.width, image.height));
    // Frame virtual: tile diambil dari sumber lewat `boxDownscaleRegion`.
    // `rgba` tidak dibaca rencana bila `measure` ada (lih. `PlanImage.measure`).
    const measure = measurementImage(image.pixels, image.width, image.height, size.width, size.height);
    const virtual: PlanImage = { width: size.width, height: size.height, rgba: measure.rgba, measure };
    const extras = this.#depth ? { depth: this.#depth } : {};
    let plan = buildRenderPlan(params, this.bundle, virtual, 'image', extras);
    const wholeFrame = plan.chain.cameraDiffusion || plan.chain.printDiffusion || plan.chain.lensBlur;
    let frame: PlanImage = virtual;
    if (wholeFrame) {
      // FFT and lens gather currently require their complete global grid.
      frame = this.fitForDiffusion(longEdge === undefined ? this.sourceFrame(image) : boxDownscale(image.pixels, image.width, image.height, longEdge), params);
      plan = buildRenderPlan(params, this.bundle, frame, 'image', extras);
    }
    const pixels = new ExportPixels(frame.width, frame.height, params.outputColorSpace, this.bundle.manifest.outputColorSpaces, target);
    // Reuse diagnostic/full renders without retaining another whole float frame.
    const full = this.#cache.get('full');
    let exportGraph: RenderGraph | undefined;
    try {
      if (full?.key === renderKey) pixels.draw(full.result.rgb, 0, 0, frame.width, frame.height);
      else {
        const graph = await this.graphFor(plan);
        exportGraph = graph;
        const input: Float32Array | TileSource = wholeFrame ? frame.rgba
          : (tile, into) => boxDownscaleRegion(image.pixels, image.width, image.height, size.width, size.height,
            tile.tileOriginX, tile.tileOriginY, tile.tileWidth, tile.tileHeight, into);
        for (;;) {
          try {
            await graph.runToTiles(input, plan.core, Tap.RGB_OUT,
              (rgb, tile) => pixels.draw(rgb, tile.activeOriginX, tile.activeOriginY, tile.activeWidth, tile.activeHeight), {
                onProgress: (done, total, tile) => {
                  this.#exportProgress = { done, total, tileWidth: tile.tileWidth, tileHeight: tile.tileHeight,
                    width: frame.width, height: frame.height, tileScale: this.#tileScale };
                },
                maxBufferBytes: this.engine.maxStorageBufferBindingSize,
                memoryBudget: exportTileMemoryBudget(this.engine.limits?.maxBufferSize, this.#tileScale),
                // Tile pakai apron ekspor 5 sigma (`plan.exportOverlap`); frame utuh tetap `overlap`.
                overlap: plan.overlap, exportOverlap: plan.exportOverlap, frame: plan.frame, isCancelled: cancelled,
                wholeFrame,
              });
            break;
          } catch (error) {
            // GPU penuh: kecilkan tile dan ulang (piksel yang sudah tergambar ditimpa lagi).
            if (!(error instanceof GpuMemoryError) || wholeFrame || this.#tileScale <= MIN_EXPORT_TILE_SCALE || cancelled()) throw error;
            this.#tileScale = clampTileScale(this.#tileScale / 2);
            graph.releaseFrameResources();
            this.#scratch?.release();
            returnFreedMemory(this.engine.device);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        }
      }
      if (cancelled()) throw new RenderSupersededError();
      this.#cache.delete('full');
      this.#exportCache = { key, result: pixels };
      return pixels;
    } catch (error) {
      if (cancelled()) throw new RenderSupersededError();
      throw error;
    } finally {
      this.#exportProgress = undefined;
      exportGraph?.releaseFrameResources();
      this.#scratch?.release();
      returnFreedMemory(this.engine.device);
    }
  }

  /**
   * Fase render ekspor saja (gaya EMULSION): UI memanggilnya saat pengguna
   * menekan Develop di lembar Ekspor, lalu `exportImage` dengan format
   * dan kualitas apa pun memakai hasil yang sama dari cache -- menggeser
   * kualitas hanya meng-encode ulang. Ukuran yang dikembalikan bisa lebih
   * kecil dari permintaan bila difusi memaksa `fitForDiffusion`.
   */
  async renderExport(longEdge?: number, options: ExportRenderOptions = {}): Promise<ExportRenderInfo> {
    // Skala tile dari UI (mis. sudah dibagi dua karena tab mati di Develop
    // sebelumnya) tidak boleh menaikkan skala yang sudah dipelajari sesi ini.
    if (options.tileScale !== undefined) this.#tileScale = Math.min(this.#tileScale, clampTileScale(options.tileScale));
    const { width, height } = await this.renderForExport(longEdge, options.target ?? 'rgb8');
    return { width, height, tileScale: this.#tileScale };
  }

  /**
   * Kemajuan render ekspor (tile selesai / total), `undefined` bila tidak ada
   * yang berjalan. RPC ini dilayani di sela tile, jadi UI bisa menampilkan
   * kemajuan dan mencatat tahap terakhir sebelum tab mati.
   */
  exportProgress(): ExportProgress | undefined {
    return this.#exportProgress;
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
    const result = await this.renderForExport(options.longEdge, exportTarget(format, this.#params.outputColorSpace));
    if (imageId !== this.#imageId) throw new RenderSupersededError();
    const { width, height } = result;
    const outputColorSpace = result.outputColorSpace ?? this.#params.outputColorSpace;
    if (canvasFormat) {
      const colorSpace = outputColorSpace === 'Display P3' ? 'display-p3' : 'srgb';
      return this.canvasEncoder!.encode(result.canvas(), width, height, canvasFormat, options.quality ?? 1, colorSpace);
    }
    const icc = this.iccFor(outputColorSpace);
    const exifOptions = { width, height, srgb: outputColorSpace === 'sRGB' };
    if (format === 'jpeg') {
      const quality = Math.min(100, Math.max(1, Math.round((options.quality ?? 1) * 100)));
      const app1 = exif && rewriteExif(exif, { ...exifOptions, maxBytes: EXIF_APP1_MAX_BYTES });
      return encodeJpeg(result.rgb8, width, height, { quality, ...(icc ? { icc } : {}), ...(app1 ? { exif: app1 } : {}) });
    }
    if (format === 'tiff16') {
      const tiffExif = exif && exifForTiff(exif, exifOptions);
      return encodeTiff16(result.rgb16, width, height, { ...(icc ? { icc } : {}), ...(tiffExif ? { exif: tiffExif } : {}) });
    }
    const pngExif = exif && rewriteExif(exif, exifOptions);
    return encodePng(format === 'png8' ? result.rgb8 : result.rgb16, width, height, format === 'png8' ? 8 : 16, {
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
    this.#removalUndo = undefined;
    this.#photoId = 0;
    this.#imageId += 1;
    this.#preview = undefined;
    this.#draftPreview = undefined;
    this.#originalPreview = undefined;
    this.#depth = undefined;
    this.#depthId += 1;
    this.#cache.clear();
    this.#exportCache = undefined;
    this.#previewCache.clear();
    this.cleanupPending = true;
    if (!this.#busy) this.clearResources();
    return this.#busy ? new Promise((resolve) => this.idleWaiters.add(resolve)) : Promise.resolve();
  }

  private clearResources(keepPreviewBuffers = false): void {
    this.cleanupPending = false;
    for (const graph of this.graphs.values()) void graph.then((g) => g.dispose(), () => {});
    this.graphs.clear();
    this.graphArenaKey = undefined;
    if (!keepPreviewBuffers) {
      this.#scratch?.release();
      this.#scratch = undefined;
    }
    this.exportCleanupPending = false;
    this.ownedArenas?.destroy();
    returnFreedMemory(this.engine.device);
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
      if (this.graphArenaKey !== undefined) this.clearResources(true);
      this.graphArenaKey = plan.arenaKey;
    }
    const key =
      `${plan.arenaKey}|${plan.chain.family}|grain=${plan.chain.grain}|scan=${plan.chain.scan ?? false}` +
      `|off=${plan.chain.filmOff ?? false}|lut=${plan.chain.printLut ?? ''}|dc=${plan.chain.cameraDiffusion ?? false}|dp=${plan.chain.printDiffusion ?? false}|lb=${plan.chain.lensBlur ?? false}|soft=${plan.chain.softenDetail ?? false}`;
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
      const cube = plan.chain.printLut ? await loadPrintCube(plan.chain.printLut, this.assetsBaseUrl) : undefined;
      this.assertAlive();
      this.#scratch ??= new ScratchPool(this.engine.device);
      const graph = new RenderGraph(this.engine, this.#scratch);
      for (const stage of buildChain(this.engine.device, arenas, plan.chain, cube)) graph.addStage(stage);
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
