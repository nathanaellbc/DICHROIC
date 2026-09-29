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
import { DecodeError } from '../io/errors';
import { MissingNeutralFiltersError } from '../params/plan';
import { UnverifiedParameterError } from '../params/registry';
import type { RenderParams } from '../params/renderParams';
import { RenderSupersededError, SessionStateError } from './errors';
import type { MessagePortLike, RpcError, RpcResponse, SessionInit, SessionMethod } from './protocol';
import { transferablesOf } from './protocol';
import type { ExportFormat, ExportOptions, ExportRenderInfo, RenderQuality, RenderResult, SessionDiagnostics } from './session';

export class SessionClient {
  #nextId = 1;
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();

  private constructor(private readonly port: MessagePortLike) {
    port.addEventListener('message', (event) => {
      const response = event.data as RpcResponse;
      const entry = this.#pending.get(response.id);
      if (!entry) return;
      this.#pending.delete(response.id);
      if (response.ok) entry.resolve(response.result);
      else entry.reject(rehydrateError(response.error));
    });
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
  static attach(port: MessagePortLike): SessionClient {
    return new SessionClient(port);
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

  setParams(patch: Partial<RenderParams>): Promise<void> {
    return this.call('setParams', [patch]) as Promise<void>;
  }

  getParams(): Promise<RenderParams> {
    return this.call('getParams', []) as Promise<RenderParams>;
  }

  getDiagnostics(): Promise<SessionDiagnostics> {
    return this.call('getDiagnostics', []) as Promise<SessionDiagnostics>;
  }

  render(quality: RenderQuality): Promise<RenderResult> {
    return this.call('render', [quality]) as Promise<RenderResult>;
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

  dispose(): Promise<void> {
    return this.call('dispose', []) as Promise<void>;
  }

  private call(method: SessionMethod | 'init' | 'decode', args: unknown[], transfer: Transferable[] = []): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.port.postMessage({ id, method, args }, transfer);
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
