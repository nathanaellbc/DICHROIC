/// <reference lib="webworker" />
/**
 * Service worker DICHROIC (spec induk §5.3): seluruh aplikasi -- shell UI,
 * worker Session, LibRaw WASM, dan aset spektral `data/` (~7 MB) -- di-precache
 * saat pemasangan, jadi setelah kunjungan pertama aplikasi berjalan penuh
 * tanpa jaringan. Daftar berkas (`__WB_MANIFEST`) disuntik vite-plugin-pwa
 * saat build; berkas yang revisinya tidak berubah tidak diunduh ulang.
 *
 * Setiap respons yang dilayani dari sini diberi header cross-origin isolation
 * (COOP/COEP/CORP). Hosting yang bisa memasang header (lihat `public/_headers`)
 * sudah mengirimnya sendiri; di hosting yang tidak bisa (GitHub Pages), header
 * dari service worker inilah yang membuat `SharedArrayBuffer` -- dan decoder
 * RAW -- tersedia mulai kunjungan kedua.
 *
 * Versi baru menunggu (tidak `skipWaiting` sendiri): UI memintanya lewat
 * pesan `SKIP_WAITING` hanya saat tidak ada foto terbuka (`ui/pwa.ts`).
 */
import { addPlugins, cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

const ISOLATION_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function withIsolation(response: Response): Response {
  if (response.type === 'opaque' || response.status === 0) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

addPlugins([{ handlerWillRespond: async ({ response }) => withIsolation(response) }]);
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

// Pemasangan pertama langsung mengendalikan halaman yang terbuka, supaya
// header isolasi berlaku setelah satu muat ulang (lihat `ui/pwa.ts`).
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
