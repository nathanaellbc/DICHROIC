/**
 * Proxy bertipe `Session` untuk UI (spec Fase 2 §4.5). Semua metode asinkron
 * karena melewati `postMessage`; galat dari worker dipulihkan ke kelas
 * aslinya lewat `rehydrateError`.
 *
 * Pemakaian di browser:
 *   const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
 *   const session = await SessionClient.connect(worker, { assetsBaseUrl: `${base}data` });
 */

import type { DecodedImage } from '../io/decoded';
import type { RemovalCrop, RemovalMask } from '../retouch/patch';
import type { Frame } from '../io/display';
import type { Guide } from '../depth/estimate';
import { DecodeError } from '../io/errors';
import { MissingNeutralFiltersError } from '../params/plan';
import { UnverifiedParameterError } from '../params/registry';
import type { RenderParams } from '../params/renderParams';
import type { DepthMap } from '../host/lens';
import { RenderSupersededError, SessionStateError } from './errors';
import type { MessagePortLike, RpcError, RpcResponse, SessionInit, SessionMethod } from './protocol';
import { transferablesOf } from './protocol';
import type { ExportFormat, ExportOptions, ExportRenderInfo, RenderQuality, RenderResult, SessionDiagnostics, PreparedPhoto } from './session';

export class SessionClient {
  #nextId = 1;
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
  #failure: Error | undefined;
  readonly #onMessage = (event: { data?: unknown }) => {
    const response = event.data as RpcResponse;
    if (response.id === 0 && !response.ok) { this.shutdown(rehydrateError(response.error)); return; }
    const entry = this.#pending.get(response.id);
    if (!entry) return;
    this.#pending.delete(response.id);
    if (response.ok) entry.resolve(response.result);
    else entry.reject(rehydrateError(response.error));
  };
  readonly #onError = (event: { message?: string }) => this.shutdown(new Error(event.message || 'The image worker stopped responding. Reopen the photo to retry.'));

  private constructor(private readonly port: MessagePortLike, private readonly onFailure?: (error: Error) => void) {
    port.addEventListener('message', this.#onMessage);
    port.addEventListener('error', this.#onError);
    port.addEventListener('messageerror', this.#onError);
    port.start?.();
  }

  /** Sambungkan dan inisialisasi `Session` di worker (memuat aset, mengakuisisi device). */
  static async connect(port: MessagePortLike, init: SessionInit): Promise<SessionClient> {
    const client = SessionClient.attach(port);
    await client.init(init);
    return client;
  }

  /**
   * Sambungkan tanpa menunggu `init`: `decode` sudah bisa dipakai selagi
   * `Session.create` (aset, device, self-test) masih berjalan -- UI memakainya
   * agar berkas pertama didekode bersamaan dengan persiapan engine.
   */
  static attach(port: MessagePortLike, onFailure?: (error: Error) => void): SessionClient {
    return new SessionClient(port, onFailure);
  }

  /** Inisialisasi `Session` di worker; sekali per client. */
  init(init: SessionInit): Promise<void> {
    return this.call('init', [init]) as Promise<void>;
  }

  /**
   * Decode berkas di worker (`io/decodeImage`). `bytes` DITRANSFER ke worker
   * (buffer pemanggil ter-detach). Galat decode tiba sebagai `DecodeError`.
   * Boleh dipanggil sebelum `connect` selesai menginisialisasi `Session`.
   */
  decode(bytes: Uint8Array, name?: string): Promise<DecodedImage> {
    return this.call('decode', [bytes, name], transferablesOf(bytes)) as Promise<DecodedImage>;
  }

  /** `image.rgba` DITRANSFER ke worker (buffer pemanggil ter-detach). */
  open(image: DecodedImage): Promise<void> {
    return this.call('open', [image], transferablesOf(image)) as Promise<void>;
  }

  close(): Promise<void> {
    return this.call('close', []) as Promise<void>;
  }
  prepareRemoval(mask: RemovalMask): Promise<RemovalCrop> { return this.call('prepareRemoval', [mask], transferablesOf(mask)) as Promise<RemovalCrop>; }
  applyRemoval(crop: RemovalCrop, output: Float32Array): Promise<{ original: Frame; guide: Guide }> { return this.call('applyRemoval', [crop, output], transferablesOf([crop, output])) as Promise<{ original: Frame; guide: Guide }>; }
  undoRemoval(): Promise<{ original: Frame; guide: Guide }> { return this.call('undoRemoval', []) as Promise<{ original: Frame; guide: Guide }>; }

  stageOpen(id: number, image: DecodedImage, patch: Partial<RenderParams>, guideMaxEdge: number): Promise<PreparedPhoto> {
    return this.call('stageOpen', [id, image, patch, guideMaxEdge], transferablesOf(image)) as Promise<PreparedPhoto>;
  }

  commitOpen(id: number): Promise<void> { return this.call('commitOpen', [id]) as Promise<void>; }
  finishOpen(id: number): Promise<void> { return this.call('finishOpen', [id]) as Promise<void>; }
  discardOpen(id: number): Promise<void> { return this.call('discardOpen', [id]) as Promise<void>; }

  /** Peta kedalaman lens blur; `data` DITRANSFER (buffer pemanggil ter-detach). */
  setDepthMap(map: DepthMap | null, photoId?: number): Promise<void> {
    return this.call('setDepthMap', photoId === undefined ? [map] : [map, photoId], map ? transferablesOf(map) : []) as Promise<void>;
  }

  setParams(patch: Partial<RenderParams>): Promise<void> {
    return this.call('setParams', [patch]) as Promise<void>;
  }

  getParams(): Promise<RenderParams> {
    return this.call('getParams', []) as Promise<RenderParams>;
  }

  getDiagnostics(): Promise<SessionDiagnostics> {
    return this.call('getDiagnostics', []) as Promise<SessionDiagnostics>;
  }

  render(quality: RenderQuality, longEdge?: number): Promise<RenderResult> {
    return this.call('render', longEdge === undefined ? [quality] : [quality, longEdge]) as Promise<RenderResult>;
  }

  /** Ukuran render penuh terakhir (lihat `Session.lastFullSize`). */
  lastFullSize(): Promise<{ width: number; height: number } | undefined> {
    return this.call('lastFullSize', []) as Promise<{ width: number; height: number } | undefined>;
  }

  /** Kompilasi varian rantai lebih dulu (lihat `Session.prewarm`). */
  prewarm(): Promise<void> {
    return this.call('prewarm', []) as Promise<void>;
  }

  exportCube(size: number): Promise<string> {
    return this.call('exportCube', [size]) as Promise<string>;
  }

  /** Render ekspor saja pada sisi panjang itu (lihat `Session.renderExport`). */
  renderExport(longEdge?: number): Promise<ExportRenderInfo> {
    return this.call('renderExport', [longEdge]) as Promise<ExportRenderInfo>;
  }

  /** Format yang bisa di-encode worker ini (lihat `Session.exportFormats`). */
  exportFormats(): Promise<ExportFormat[]> {
    return this.call('exportFormats', []) as Promise<ExportFormat[]>;
  }

  /** Berkas gambar dari render penuh (lihat `Session.exportImage`). */
  exportImage(format: ExportFormat, options?: ExportOptions): Promise<Uint8Array> {
    return this.call('exportImage', options === undefined ? [format] : [format, options]) as Promise<Uint8Array>;
  }

  /** Release the cached export render. */
  releaseExport(): Promise<void> {
    return this.call('releaseExport', []) as Promise<void>;
  }

  async dispose(): Promise<void> {
    try { await this.call('dispose', []); }
    finally { this.shutdown(new SessionStateError('Session client was disposed.'), false); }
  }

  shutdown(error: Error, notify = true): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const entry of this.#pending.values()) entry.reject(error);
    this.#pending.clear();
    this.port.removeEventListener?.('message', this.#onMessage);
    this.port.removeEventListener?.('error', this.#onError);
    this.port.removeEventListener?.('messageerror', this.#onError);
    this.port.terminate?.();
    if (notify) this.onFailure?.(error);
  }

  private call(method: SessionMethod | 'init' | 'decode', args: unknown[], transfer: Transferable[] = []): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try { this.port.postMessage({ id, method, args }, transfer); }
      catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }
}

export function rehydrateError(e: RpcError): Error {
  const data = e.data ?? {};
  let err: Error;
  switch (e.name) {
    case 'UnverifiedParameterError':
      err = new UnverifiedParameterError(data.field as keyof RenderParams, data.value, data.baseline);
      break;
    case 'RenderSupersededError':
      err = new RenderSupersededError();
      break;
    case 'SessionStateError':
      err = new SessionStateError(e.message);
      break;
    case 'DecodeError':
      err = new DecodeError(data.format as DecodeError['format'], String(data.reason));
      break;
    case 'MissingNeutralFiltersError':
      err = new MissingNeutralFiltersError('', '');
      break;
    default:
      err = new Error(e.message);
      err.name = e.name;
  }
  err.message = e.message;
  return err;
}
