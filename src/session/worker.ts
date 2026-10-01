/**
 * Entry Dedicated Worker `Session`: bootstrap kecil, sengaja tanpa import
 * statis.
 *
 * Kenapa: dulu entry ini berisi server-nya sendiri, dan Rollup menaruh kode
 * bersama (mis. `DecodeError`) di chunk entry, sehingga chunk decoder yang
 * dimuat dinamis (`jpeg`, `png`, `tiff`, `exr`, `raw`) meng-import file entry
 * worker. Safari iOS mengevaluasi ulang modul itu saat di-import, sehingga
 * terpasang `serveSession` KEDUA yang tak pernah menerima `init`. Pada RPC
 * berikutnya salinan itu langsung membalas `RPC "stageOpen" sebelum "init"`,
 * dan balasan galat itu tiba lebih dulu dari balasan sesi yang sebenarnya
 * (iOS mengubah foto galeri menjadi JPEG, jadi decoder JPEG hampir selalu
 * dimuat). Chrome tidak mengevaluasi ulang, jadi hanya terlihat di iPhone.
 *
 * Sekarang server ada di `server.ts` (dimuat dinamis), tidak ada chunk yang
 * meng-import entry ini, dan penanda global menjamin satu server per worker.
 * Pesan yang tiba selagi `server.ts` dimuat ditampung lalu dilayani berurutan.
 */

import type { MessagePortLike } from './protocol';

/** Penanda di scope worker: server sudah (sedang) dipasang. */
export const SERVER_FLAG = '__dichroicSessionServer';

type WorkerScope = MessagePortLike & {
  importScripts?: unknown;
  name?: string;
  [SERVER_FLAG]?: true;
};

/**
 * Pasang server sekali per scope. `load` memuat `server.ts` (disuntik oleh
 * test). Mengembalikan `false` bila server sudah terpasang.
 */
export function bootWorker(
  scope: WorkerScope,
  load: () => Promise<{ startWorker(scope: MessagePortLike, backlog: ReadonlyArray<{ data?: unknown }>): void }>,
): boolean {
  if (scope[SERVER_FLAG]) return false;
  scope[SERVER_FLAG] = true;
  const backlog: Array<{ data?: unknown }> = [];
  const hold = (event: { data?: unknown }) => backlog.push(event);
  scope.addEventListener('message', hold);
  void load().then(
    ({ startWorker }) => {
      scope.removeEventListener?.('message', hold);
      startWorker(scope, backlog);
    },
    (error: unknown) => {
      // Modul server gagal dimuat (jaringan/offline): gagalkan semua RPC.
      scope.removeEventListener?.('message', hold);
      const message = error instanceof Error ? error.message : String(error);
      scope.postMessage({ id: 0, ok: false, error: { name: 'Error', message: `The image worker failed to load: ${message}` } });
    },
  );
  return true;
}

// Hanya di Dedicated Worker (punya importScripts), bukan thread pthread Emscripten.
const scope = globalThis as unknown as WorkerScope;
if (typeof scope.importScripts === 'function' && !scope.name?.startsWith('em-pthread')) {
  bootWorker(scope, () => import('./server'));
}
