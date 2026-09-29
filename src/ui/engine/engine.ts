/**
 * Jembatan UI <-> `Session` di Web Worker. Bebas React: state disimpan di sini
 * dan diamati lewat `subscribe`/`getState` (`useSyncExternalStore`).
 *
 * Alur buka berkas: decode di worker (boleh selagi engine masih disiapkan) ->
 * pratinjau "sebelum" dibuat di thread UI -> `open` (buffer ditransfer) ->
 * saran colour space input dari decoder -> render pratinjau pertama.
 *
 * Render dikoalesikan di sini (satu permintaan berjalan + satu penanda
 * "kotor"), jadi menggeser slider 60 kali per detik tidak membanjiri worker;
 * `Session` sendiri juga membuang permintaan yang tersalip.
 */
import { detectFormat } from '../../io/detect';
import { DecodeError } from '../../io/errors';
import type { DecodedImage } from '../../io/decoded';
import { captureExif } from '../../io/exif';
import { BASELINE_RENDER_PARAMS } from '../../params/renderParams';
import type { RenderParams } from '../../params/renderParams';
import { SessionClient } from '../../session/client';
import { PREVIEW_MAX_LONG_EDGE } from '../../session/downscale';
import { RenderSupersededError } from '../../session/errors';
import type { ExportFormat, ExportOptions } from '../../session/session';
import { isScanMode, suggestedInput } from '../model/tools';
import { stockInfo } from '../model/stocks';
import { exportFileName } from '../share';
import { decodeWithBrowser, isBrowserImage } from './browserDecode';
import { DepthEstimator, buildGuide } from '../../depth/estimate';
import { depthProfile, firstDownloadBytes } from '../../depth/model';
import type { DepthMap } from '../../host/lens';
import type { DepthProfile } from '../../depth/model';
import { DepthController } from './depthController';
import type { DepthState } from './depthController';
import { canvasColorSpaceFor, originalFrame, rgbToPixels, type Frame } from './display';

export type EngineStatus = 'connecting' | 'ready' | 'unsupported' | 'failed';
export type Phase = 'idle' | 'opening' | 'editing';

export interface AppError {
  title: string;
  message: string;
}

export interface EngineState {
  engine: EngineStatus;
  phase: Phase;
  opening?: { name: string; stage: string };
  fileName?: string;
  params: RenderParams;
  /** Nilai "reset" untuk foto ini: baseline + saran input dari decoder. */
  defaults: RenderParams;
  frame?: Frame;
  original?: Frame;
  /** Render sedang berjalan (pratinjau masih menampilkan frame sebelumnya). */
  rendering: boolean;
  error?: AppError;
  /** Alasan teknis dari `acquireDevice` saat `engine === 'unsupported'`. */
  unsupportedReason?: string;
  /** `false` bila backend meruntuhkan aritmetika df64 (halation/DIR bisa meleset ~1e-3). */
  precisionOk: boolean;
  /** Peta kedalaman lens blur untuk foto terbuka. */
  depth: DepthState;
  /** Langkah undo/redo yang tersedia untuk foto terbuka. */
  history: { canUndo: boolean; canRedo: boolean };
}

/** Perubahan beruntun yang lebih rapat dari ini (satu seretan slider) jadi satu langkah undo. */
const HISTORY_GAP_MS = 600;
const HISTORY_LIMIT = 100;

function diffParams(from: RenderParams, to: RenderParams): Partial<RenderParams> {
  const patch: Partial<RenderParams> = {};
  for (const key of Object.keys(to) as Array<keyof RenderParams>) {
    if (from[key] !== to[key]) (patch as Record<string, unknown>)[key] = to[key];
  }
  return patch;
}

/** Profil cadangan bila deteksi perangkat gagal: CPU, masukan kecil, hemat memori. */
const FALLBACK_DEPTH_PROFILE: DepthProfile = { backend: 'wasm', inputSize: 392, guideMaxEdge: 1024, lowMemory: true };

type Listener = () => void;

function withExif(image: DecodedImage, bytes: Uint8Array): DecodedImage {
  const exif = captureExif(bytes);
  return exif ? { ...image, exif } : image;
}

export const EXPORT_MIME: Record<ExportFormat, string> = {
  png8: 'image/png',
  png16: 'image/png',
  tiff16: 'image/tiff',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
};
export const EXPORT_EXT: Record<ExportFormat, string> = {
  png8: 'png',
  png16: 'png',
  tiff16: 'tif',
  jpeg: 'jpg',
  webp: 'webp',
  avif: 'avif',
};

export function describeError(error: unknown, fileName?: string): AppError {
  if (error instanceof DecodeError) {
    const title = fileName ? `Can’t Open “${fileName}”` : 'Can’t Open This File';
    if (error.format === 'unknown') {
      return { title, message: 'This file format isn’t supported. Export it as JPEG or TIFF, or open the camera’s original RAW file.' };
    }
    if (error.format === 'raw' && /COOP|cross-origin/i.test(error.reason)) {
      return { title, message: 'RAW files need this page to be served with cross-origin isolation. Open DICHROIC from its installed address.' };
    }
    return { title, message: `The ${error.format.toUpperCase()} file looks damaged, or uses a feature that isn’t supported yet.` };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { title: 'Something Went Wrong', message };
}

/**
 * Decode lewat `io/` di worker. Format yang tidak dikenal `io/` maupun LibRaw
 * masih dicoba lewat decoder browser sebelum ditolak (galat aslinya yang
 * dilaporkan bila browser juga gagal).
 */
async function decodeInWorker(client: SessionClient, bytes: Uint8Array, file: File): Promise<DecodedImage> {
  try {
    return await client.decode(bytes, file.name);
  } catch (error) {
    if (!(error instanceof DecodeError) || error.format !== 'unknown') throw error;
    return decodeWithBrowser(file, file.name).catch(() => {
      throw error;
    });
  }
}

export class Engine {
  #state: EngineState = {
    engine: 'connecting',
    phase: 'idle',
    params: { ...BASELINE_RENDER_PARAMS },
    defaults: { ...BASELINE_RENDER_PARAMS },
    rendering: false,
    precisionOk: true,
    depth: { status: 'idle' },
    history: { canUndo: false, canRedo: false },
  };
  readonly #listeners = new Set<Listener>();
  #past: RenderParams[] = [];
  #future: RenderParams[] = [];
  #lastEditAt = 0;
  #client: SessionClient | undefined;
  #ready: Promise<void> | undefined;
  #openToken = 0;
  /** Ukuran gambar asli yang terbuka (untuk membandingkan ukuran ekspor). */
  #imageSize: { width: number; height: number } | undefined;
  /** Ekspor terakhir lebih kecil dari aslinya (difusi, Fase 2D). */
  lastExportLimited: { width: number; height: number } | undefined;
  #inFlight = false;
  #dirty = false;
  #depthProfile: Promise<DepthProfile> | undefined;
  #estimator: DepthEstimator | undefined;
  #depthMap: DepthMap | undefined;
  readonly #depth = new DepthController({
    estimate: async (guide, allowDownload, onProgress) => {
      const profile = await this.#profile();
      this.#estimator ??= new DepthEstimator();
      return this.#estimator.estimate(guide, { allowDownload, profile, onProgress });
    },
    deliver: async (map) => {
      // Salinan untuk cek fokus di thread UI: peta aslinya DITRANSFER ke worker.
      this.#depthMap = map ? { width: map.width, height: map.height, data: map.data.slice() } : undefined;
      await this.#client!.setDepthMap(map);
      this.requestRender();
    },
    downloadBytes: async () => firstDownloadBytes((await this.#profile()).backend),
    onChange: (depth) => this.#set({ depth }),
    cancel: () => {
      this.#estimator?.dispose();
      this.#estimator = undefined;
    },
  });

  getState = (): EngineState => this.#state;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(patch: Partial<EngineState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  #profile(): Promise<DepthProfile> {
    this.#depthProfile ??= depthProfile().catch(() => FALLBACK_DEPTH_PROFILE);
    return this.#depthProfile;
  }

  /** Menyalakan worker dan menyiapkan `Session` (aset, device WebGPU, self-test). */
  start(): void {
    if (this.#client) return;
    const worker = new Worker(new URL('../../session/worker.ts', import.meta.url), { type: 'module', name: 'dichroic-session' });
    const client = SessionClient.attach(worker);
    this.#client = client;
    const assetsBaseUrl = new URL(`${import.meta.env.BASE_URL}data`, window.location.href).href;
    this.#ready = client.init({ assetsBaseUrl }).then(
      async () => {
        const diagnostics = await client.getDiagnostics();
        this.#set({ engine: 'ready', precisionOk: diagnostics.iirPrecisionOk });
        // Shader dikompilasi selagi pengguna memilih foto. Render pertama
        // menunggu varian yang sedang dikompilasi (yang memang ia butuhkan)
        // dan menyalip sisanya; prewarm yang tersalip atau gagal tidak fatal.
        client.prewarm().catch(() => {});
      },
      (error: unknown) => {
        const unsupported = error instanceof Error && error.name === 'WebGPUUnavailableError';
        this.#set({
          engine: unsupported ? 'unsupported' : 'failed',
          error: unsupported ? undefined : describeError(error),
          unsupportedReason: unsupported ? (error as Error).message : undefined,
        });
        throw error;
      },
    );
    this.#ready.catch(() => {});
  }

  async openFile(file: File): Promise<void> {
    const client = this.#client;
    if (!client) return;
    const token = ++this.#openToken;
    const stillCurrent = () => token === this.#openToken;
    this.#set({ phase: 'opening', opening: { name: file.name, stage: 'Reading…' }, error: undefined });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const format = detectFormat(bytes);
      if (!stillCurrent()) return;
      const viaBrowser = format === 'unknown' && isBrowserImage(bytes);
      this.#set({ opening: { name: file.name, stage: format === 'raw' || (format === 'unknown' && !viaBrowser) ? 'Decoding RAW…' : 'Decoding…' } });
      // HEIC lewat decoder browser: EXIF (kamera, lensa, GPS) diambil dari
      // berkas aslinya supaya tetap ikut ke ekspor.
      const image: DecodedImage = viaBrowser ? withExif(await decodeWithBrowser(file, file.name), bytes) : await decodeInWorker(client, bytes, file);
      if (!stillCurrent()) return;
      const original = originalFrame(image, PREVIEW_MAX_LONG_EDGE);
      const imageSize = { width: image.width, height: image.height };
      const input = suggestedInput(image);

      // Gambar yang dilihat jaringan kedalaman dibangun SEBELUM `open`, yang
      // mentransfer `image.rgba` ke worker.
      const guide = buildGuide(image, (await this.#profile()).guideMaxEdge);
      if (!stillCurrent()) return;

      if (this.#state.engine !== 'ready') this.#set({ opening: { name: file.name, stage: 'Preparing the darkroom…' } });
      await this.#ready;
      if (!stillCurrent()) return;
      await client.open(image);
      this.#imageSize = imageSize;
      this.#depthMap = undefined;
      this.#depth.reset(guide);
      // Tampilan (film, kertas, penyesuaian, lensa) dibawa ke foto berikutnya;
      // colour space input, auto exposure, dan titik fokus milik berkas.
      const fileParams = { ...input, lensFocusX: 0.5, lensFocusY: 0.5 };
      const params = { ...this.#state.params, ...fileParams };
      await client.setParams(fileParams);
      this.#clearHistory();
      this.#set({
        params,
        defaults: { ...BASELINE_RENDER_PARAMS, ...input },
        original,
        fileName: file.name,
        opening: { name: file.name, stage: 'Developing…' },
      });
      await this.#renderOnce();
      if (!stillCurrent()) return;
      this.#set({ phase: 'editing', opening: undefined });
      if (params.lensBlurEnabled) this.#depth.ensure();
    } catch (error) {
      if (!stillCurrent()) return;
      this.#set({ phase: this.#state.frame && this.#state.phase === 'editing' ? 'editing' : 'idle', opening: undefined, error: describeError(error, file.name) });
    }
  }

  cancelOpening(): void {
    this.#openToken += 1;
    this.#set({ phase: this.#state.fileName && this.#state.frame ? 'editing' : 'idle', opening: undefined });
  }

  closePhoto(): void {
    this.#openToken += 1;
    this.#depthMap = undefined;
    this.#depth.reset(undefined);
    this.#clearHistory();
    this.#set({ phase: 'idle', frame: undefined, original: undefined, fileName: undefined, opening: undefined });
  }

  #clearHistory(): void {
    this.#past = [];
    this.#future = [];
    this.#lastEditAt = 0;
    this.#set({ history: { canUndo: false, canRedo: false } });
  }

  #historyState(): EngineState['history'] {
    return { canUndo: this.#past.length > 0, canRedo: this.#future.length > 0 };
  }

  undo(): void {
    const target = this.#past.pop();
    if (!target) return;
    this.#future.push(this.#state.params);
    this.#lastEditAt = 0;
    this.setParams(diffParams(this.#state.params, target), false);
  }

  redo(): void {
    const target = this.#future.pop();
    if (!target) return;
    this.#past.push(this.#state.params);
    this.#lastEditAt = 0;
    this.setParams(diffParams(this.#state.params, target), false);
  }

  dismissError(): void {
    this.#set({ error: undefined });
  }

  isEdited(): boolean {
    const { params, defaults } = this.#state;
    return (Object.keys(params) as Array<keyof RenderParams>).some((k) => params[k] !== defaults[k]);
  }

  /** `record: false` untuk undo/redo sendiri (tidak menambah langkah). */
  setParams(patch: Partial<RenderParams>, record = true): void {
    const client = this.#client;
    if (!client) return;
    const previous = this.#state.params;
    const changed = (Object.keys(patch) as Array<keyof RenderParams>).some((k) => previous[k] !== patch[k]);
    if (record && changed) {
      const now = performance.now();
      if (this.#past.length === 0 || this.#future.length > 0 || now - this.#lastEditAt > HISTORY_GAP_MS) {
        this.#past.push(previous);
        if (this.#past.length > HISTORY_LIMIT) this.#past.shift();
      }
      this.#future = [];
      this.#lastEditAt = now;
    }
    this.#set({ params: { ...previous, ...patch }, history: this.#historyState() });
    client.setParams(patch).then(
      () => {
        this.requestRender();
        // Lens blur baru berarti setelah ada peta kedalaman.
        if (patch.lensBlurEnabled === true) this.#depth.ensure();
      },
      (error: unknown) => this.#set({ params: previous, error: describeError(error) }),
    );
  }

  /** Pengguna menyetujui unduhan model kedalaman. */
  downloadDepth(): void {
    this.#depth.download();
  }

  /** Coba lagi setelah estimasi gagal. */
  retryDepth(): void {
    this.#depth.ensure();
  }

  resetAll(): void {
    const { params, defaults } = this.#state;
    const patch: Partial<RenderParams> = {};
    for (const key of Object.keys(defaults) as Array<keyof RenderParams>) {
      if (params[key] !== defaults[key]) (patch as Record<string, unknown>)[key] = defaults[key];
    }
    if (Object.keys(patch).length > 0) this.setParams(patch);
  }

  requestRender(): void {
    if (this.#state.phase === 'idle') return;
    if (this.#inFlight) {
      this.#dirty = true;
      return;
    }
    void this.#renderLoop();
  }

  async #renderLoop(): Promise<void> {
    this.#inFlight = true;
    this.#set({ rendering: true });
    try {
      do {
        this.#dirty = false;
        await this.#renderOnce();
      } while (this.#dirty);
    } catch (error) {
      this.#set({ error: describeError(error) });
    } finally {
      this.#inFlight = false;
      this.#set({ rendering: false });
    }
  }

  async #renderOnce(): Promise<void> {
    const client = this.#client!;
    try {
      const result = await client.render('preview');
      this.#set({
        frame: {
          width: result.width,
          height: result.height,
          pixels: rgbToPixels(result.rgb, result.width, result.height),
          colorSpace: canvasColorSpaceFor(this.#state.params.outputColorSpace),
        },
      });
    } catch (error) {
      if (error instanceof RenderSupersededError) return;
      throw error;
    }
  }

  /** Peta kedalaman foto terbuka (salinan UI, untuk cek fokus), bila sudah ada. */
  get depthMap(): DepthMap | undefined {
    return this.#depthMap;
  }

  /** Ukuran gambar asli yang terbuka. */
  get imageSize(): { width: number; height: number } | undefined {
    return this.#imageSize;
  }

  /** Format yang bisa di-encode worker (lossy hanya bila lolos probing). */
  exportFormats(): Promise<ExportFormat[]> {
    return this.#client!.exportFormats();
  }

  /**
   * Fase render ekspor (gaya EMULSION): dipanggil saat lembar Ekspor dibuka
   * dan saat sisi panjang berubah. `limited` = difusi FFT memaksa ukuran
   * lebih kecil dari yang diminta (Fase 2D).
   */
  async renderExport(longEdge: number | undefined, requested: { width: number; height: number }): Promise<{ width: number; height: number; limited: boolean }> {
    const size = await this.#client!.renderExport(longEdge);
    const limited = size.width < requested.width || size.height < requested.height;
    this.lastExportLimited = limited ? size : undefined;
    return { ...size, limited };
  }

  /** Nama berkas ASCII: `<foto> - <film> on <kertas>.<ext>`. */
  exportName(ext: string, suffix = ''): string {
    const { params, fileName } = this.#state;
    const film = stockInfo(params.film).name;
    const name = exportFileName(fileName, film, isScanMode(params) ? undefined : stockInfo(params.paper).name, ext);
    return suffix ? name.replace(/\.[^.]+$/, ` ${suffix}.${ext}`) : name;
  }

  async exportImage(format: ExportFormat, options?: ExportOptions): Promise<File> {
    const bytes = await this.#client!.exportImage(format, options);
    if (!options) {
      // Difusi FFT butuh frame utuh; render penuh yang terlalu besar untuk
      // device diperkecil `Session` (Fase 2D) -- beri tahu pengguna.
      const size = await this.#client!.lastFullSize();
      const full = this.#imageSize;
      this.lastExportLimited = size && full && size.width < full.width ? size : undefined;
    }
    return new File([bytes as Uint8Array<ArrayBuffer>], this.exportName(EXPORT_EXT[format]), { type: EXPORT_MIME[format] });
  }

  /** Lembar Ekspor ditutup: worker melepas render penuh dan scratch GPU-nya. */
  releaseExport(): void {
    this.#client?.releaseExport().catch(() => {});
  }

  async exportCube(size: number): Promise<File> {
    const text = await this.#client!.exportCube(size);
    return new File([text], this.exportName('cube', `${size}`), { type: 'text/plain' });
  }
}

export const engine = new Engine();
