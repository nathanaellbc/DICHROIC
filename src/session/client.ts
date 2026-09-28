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
import { MissingNeutralFiltersError } from '../params/plan';
import { UnverifiedParameterError } from '../params/registry';
import type { RenderParams } from '../params/renderParams';
import { RenderSupersededError, SessionStateError } from './errors';
import type { MessagePortLike, RpcError, RpcResponse, SessionInit, SessionMethod } from './protocol';
import { transferablesOf } from './protocol';
import type { RenderQuality, RenderResult } from './session';

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
    const client = new SessionClient(port);
    await client.call('init', [init]);
    return client;
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

  render(quality: RenderQuality): Promise<RenderResult> {
    return this.call('render', [quality]) as Promise<RenderResult>;
  }

  exportCube(size: number): Promise<string> {
    return this.call('exportCube', [size]) as Promise<string>;
  }

  dispose(): Promise<void> {
    return this.call('dispose', []) as Promise<void>;
  }

  private call(method: SessionMethod | 'init', args: unknown[], transfer: Transferable[] = []): Promise<unknown> {
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
