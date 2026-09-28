/**
 * Sisi worker RPC `Session`. `serveSession` bebas lingkungan (diuji di Node
 * dengan `MessageChannel`); entry browser di bawah memanggilnya dengan
 * `self` bila modul ini berjalan sebagai Dedicated Worker.
 *
 * Panggilan dilayani BERURUTAN sesuai kedatangan, kecuali `render` dan
 * `exportCube` yang asinkron: keduanya dimulai berurutan tapi boleh selesai
 * tidak berurutan (antrean terbaru-menang ada di `Session` sendiri).
 */

import type { MessagePortLike, RpcError, RpcRequest, RpcResponse, SessionInit, SessionLike } from './protocol';
import { cloneTypedArrays, transferablesOf } from './protocol';
import { Session } from './session';

export function serveSession(port: MessagePortLike, factory: (init: SessionInit) => Promise<SessionLike>): void {
  let session: Promise<SessionLike> | undefined;

  const reply = (response: RpcResponse, transfer: Transferable[] = []): void => {
    port.postMessage(response, transfer);
  };

  port.addEventListener('message', (event) => {
    const request = event.data as RpcRequest;
    void (async () => {
      try {
        let result: unknown;
        if (request.method === 'init') {
          session = factory(request.args[0] as SessionInit);
          await session;
        } else {
          if (!session) throw new Error(`RPC "${request.method}" sebelum "init".`);
          const target = await session;
          const method = target[request.method] as (...args: unknown[]) => unknown;
          result = await method.apply(target, request.args);
        }
        const copy = cloneTypedArrays(result);
        reply({ id: request.id, ok: true, result: copy }, transferablesOf(copy));
      } catch (e) {
        reply({ id: request.id, ok: false, error: serializeError(e) });
      }
    })();
  });
  port.start?.();
}

function serializeError(e: unknown): RpcError {
  if (e instanceof Error) {
    const data: Record<string, unknown> = {};
    for (const key of ['field', 'value', 'baseline'] as const) {
      if (key in e) data[key] = (e as unknown as Record<string, unknown>)[key];
    }
    return { name: e.name, message: e.message, data };
  }
  return { name: 'Error', message: String(e) };
}

// Entry browser: hanya aktif di dalam Dedicated Worker (punya importScripts).
const scope = globalThis as unknown as { importScripts?: unknown } & MessagePortLike;
if (typeof scope.importScripts === 'function') {
  serveSession(scope, (init) => Session.create({ assetsBaseUrl: init.assetsBaseUrl }));
}
