/**
 * Pendaftaran service worker (`src/sw.ts`) dan dua perilaku yang bergantung
 * pada keadaan editor:
 *
 * - **Pembaruan** tidak pernah memuat ulang halaman di tengah suntingan: versi
 *   baru diaktifkan begitu tidak ada foto terbuka (sekarang, atau saat foto
 *   ditutup).
 * - **Cross-origin isolation** di hosting tanpa header COOP/COEP: begitu
 *   service worker mengendalikan halaman, satu muat ulang (hanya bila editor
 *   kosong) membuat header dari service worker berlaku. Bila setelah itu
 *   halaman tetap tidak terisolasi, browser tidak mendukung cara ini dan
 *   percobaannya tidak diulang.
 */
import { registerSW } from 'virtual:pwa-register';
import { engine } from './engine/engine';

const RELOADED = 'dichroic:isolation-reload';
const UNSUPPORTED = 'dichroic:isolation-unsupported';

function storage(kind: 'local' | 'session'): Storage | undefined {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return undefined;
  }
}

function read(kind: 'local' | 'session', key: string): string | null {
  try {
    return storage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(kind: 'local' | 'session', key: string, value: string | null): void {
  try {
    if (value === null) storage(kind)?.removeItem(key);
    else storage(kind)?.setItem(key, value);
  } catch {
    // penyimpanan diblokir: perilaku tetap benar, hanya tanpa ingatan.
  }
}

const idle = () => engine.getState().phase === 'idle';

function tryIsolationReload(): void {
  if (window.crossOriginIsolated || !navigator.serviceWorker.controller) return;
  if (read('local', UNSUPPORTED) || read('session', RELOADED) || !idle()) return;
  write('session', RELOADED, '1');
  window.location.reload();
}

export function startPwa(): void {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;

  if (window.crossOriginIsolated) {
    write('session', RELOADED, null);
  } else if (read('session', RELOADED)) {
    write('local', UNSUPPORTED, '1');
  }

  let pendingUpdate: (() => void) | undefined;
  const applyWhenIdle = () => {
    if (pendingUpdate && idle()) {
      const apply = pendingUpdate;
      pendingUpdate = undefined;
      apply();
    }
  };
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      pendingUpdate = () => void updateSW(true);
      applyWhenIdle();
    },
  });
  engine.subscribe(applyWhenIdle);

  navigator.serviceWorker.addEventListener('controllerchange', tryIsolationReload);
  void navigator.serviceWorker.ready.then(tryIsolationReload);
}
