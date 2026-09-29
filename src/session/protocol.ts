/**
 * Protokol RPC antara UI (thread utama) dan `Session` di Web Worker (spec
 * Fase 2 §4.5). Pesan bertipe, dijawab per `id`; galat diserialisasi dengan
 * nama kelasnya supaya `client.ts` bisa memulihkan kelas yang sama
 * (`UnverifiedParameterError` tetap `instanceof` di sisi UI).
 */

import type { DecodedImage } from '../io/decoded';
import type { RenderParams } from '../params/renderParams';
import type { DepthMap } from '../host/lens';
import type { ExportFormat, ExportOptions, ExportRenderInfo, RenderQuality, RenderResult, SessionDiagnostics } from './session';

/** Permukaan publik `Session` yang dilayani lewat RPC. */
export interface SessionLike {
  open(image: DecodedImage): void;
  setDepthMap(map: DepthMap | null): void;
  setParams(patch: Partial<RenderParams>): void;
  getParams(): RenderParams;
  getDiagnostics(): SessionDiagnostics;
  render(quality: RenderQuality): Promise<RenderResult>;
  prewarm(): Promise<void>;
  lastFullSize(): { width: number; height: number } | undefined;
  exportCube(size: number): Promise<string>;
  renderExport(longEdge?: number): Promise<ExportRenderInfo>;
  exportFormats(): Promise<ExportFormat[]>;
  exportImage(format: ExportFormat, options?: ExportOptions): Promise<Uint8Array>;
  releaseExport(): void;
  dispose(): void;
}

export type SessionMethod = keyof SessionLike;

export interface SessionInit {
  assetsBaseUrl: string;
}

/**
 * `decode` dilayani worker tanpa `Session` (boleh sebelum `init` selesai):
 * decode berkas besar dan kompilasi shader `Session.create` bisa berjalan
 * bersamaan, dan thread UI tidak pernah menyentuh decoder.
 */
export type RpcRequest =
  | { id: number; method: 'init'; args: [SessionInit] }
  | { id: number; method: 'decode'; args: [Uint8Array, string | undefined] }
  | { id: number; method: SessionMethod; args: unknown[] };

export interface RpcError {
  name: string;
  message: string;
  data?: Record<string, unknown>;
}

export type RpcResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: RpcError };

/** Bentuk minimal port: `MessagePort`/`Worker`/`DedicatedWorkerGlobalScope` DOM. */
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  start?(): void;
}

/** Semua `ArrayBuffer` di balik typed array di dalam `value`, tanpa duplikat. */
export function transferablesOf(value: unknown): Transferable[] {
  const found = new Set<ArrayBuffer>();
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer) found.add(v.buffer);
      return;
    }
    for (const child of Object.values(v)) walk(child);
  };
  walk(value);
  return [...found];
}

/**
 * Salinan dalam untuk typed array di `value` (objek dan larik biasa ikut
 * disalin dangkal). Worker mentransfer SALINAN, bukan aslinya: `Session`
 * men-cache `RenderResult`, dan mentransfer buffer cache akan men-detach-nya.
 */
export function cloneTypedArrays<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return (value as unknown as { slice(): T }).slice();
  if (Array.isArray(value)) return value.map((v: unknown) => cloneTypedArrays(v)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = cloneTypedArrays(v);
  return out as T;
}
