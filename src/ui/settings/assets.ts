/**
 * Data di perangkat untuk Settings: model kedalaman/Refine Edge yang bisa
 * diunduh lebih dulu (dan dihapus), pemakaian penyimpanan, dan "Clear App
 * Data". Model memakai cache yang sama dengan worker kedalaman
 * (`DEPTH_CACHE`), berikut runtime ONNX untuk backend perangkat ini -- jadi
 * model yang diunduh di sini langsung terpakai tanpa unduhan kedua.
 */
import gpuRuntimeUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import cpuRuntimeUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import {
  DEPTH_CACHE, DEPTH_MODELS, MATTE_MODEL, MATTE_URL, RUNTIME_BYTES,
  ensureCached, modelBackend, modelFiles, variantUrl,
} from '../../depth/model';
import type { DepthBackend, DepthModelId, DepthProfile } from '../../depth/model';

export type AssetId = DepthModelId | 'matte';

export interface ModelAsset {
  id: AssetId;
  /** Nama pendek (Fast, Detail, Pro, Refine Edge) dan nama model. */
  label: string;
  name: string;
  /** Berkas model saja (dihapus per model). */
  files: Array<{ url: string; bytes: number }>;
  /** Runtime ONNX backend ini (dibagi semua model; ikut diunduh bila belum ada). */
  runtime: { url: string; bytes: number };
}

function runtimeFor(backend: DepthBackend): { url: string; bytes: number } {
  // Sama dengan worker: URL aset relatif terhadap halaman (basis cadangan di luar browser).
  const url = new URL(backend === 'webgpu' ? gpuRuntimeUrl : cpuRuntimeUrl, globalThis.location?.href ?? 'http://localhost/').href;
  return { url, bytes: RUNTIME_BYTES[backend] };
}

/** Model yang bisa dipakai perangkat ini, plus ViTMatte (Refine Edge). */
export function modelAssets(run: DepthProfile, available: readonly DepthModelId[]): ModelAsset[] {
  const depth = available.map((id): ModelAsset => {
    const backend = modelBackend(id, run) ?? run.backend;
    return {
      id,
      label: DEPTH_MODELS[id].label,
      name: DEPTH_MODELS[id].name,
      files: modelFiles(id, backend).map((f) => ({ url: variantUrl(f, id), bytes: f.bytes })),
      runtime: runtimeFor(backend),
    };
  });
  // ViTMatte berjalan di worker backend profil (CPU di dalamnya).
  const matte: ModelAsset = {
    id: 'matte', label: 'Refine Edge', name: MATTE_MODEL.name,
    files: [{ url: MATTE_URL, bytes: MATTE_MODEL.bytes }], runtime: runtimeFor(run.backend),
  };
  return [...depth, matte];
}

/** Ukuran unduhan (byte) yang masih kurang untuk model ini; 0 = siap dipakai. */
export async function missingBytes(asset: ModelAsset): Promise<number> {
  try {
    const cache = await caches.open(DEPTH_CACHE);
    let missing = 0;
    for (const f of [...asset.files, asset.runtime]) if (!(await cache.match(f.url))) missing += f.bytes;
    return missing;
  } catch {
    return [...asset.files, asset.runtime].reduce((n, f) => n + f.bytes, 0);
  }
}

/** Unduh model (dan runtime bila belum ada) ke cache; progres 0..1. */
export async function downloadAsset(asset: ModelAsset, onProgress: (fraction: number) => void): Promise<void> {
  const parts = [...asset.files, asset.runtime];
  const total = parts.reduce((n, f) => n + f.bytes, 0);
  let done = 0;
  for (const part of parts) {
    const ok = await ensureCached(part.url, part.bytes, (loaded) => onProgress(Math.min(1, (done + loaded) / total)));
    if (!ok) throw new Error('This browser won’t keep downloads (private mode or storage full).');
    done += part.bytes;
    onProgress(done / total);
  }
}

/** Hapus berkas model ini (runtime bersama tetap). */
export async function removeAsset(asset: ModelAsset): Promise<void> {
  const cache = await caches.open(DEPTH_CACHE);
  await Promise.all(asset.files.map((f) => cache.delete(f.url)));
}

/** Hapus semua model dan runtime yang diunduh. */
export async function clearModels(): Promise<void> {
  await caches.delete(DEPTH_CACHE);
}

/** Pemakaian dan kuota penyimpanan situs (byte), bila browser memberi tahu. */
export async function storageUsage(): Promise<{ usage: number; quota: number } | undefined> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e && e.usage !== undefined && e.quota !== undefined ? { usage: e.usage, quota: e.quota } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hapus semua data app di perangkat: proyek (lewat `removeProjects`, supaya
 * koneksi database yang terbuka tidak memblokir), semua cache (model, aset
 * offline), preferensi, dan service worker -- lalu muat ulang.
 */
export async function clearAppData(removeProjects: () => Promise<void>): Promise<void> {
  await removeProjects().catch(() => {});
  try {
    for (const key of await caches.keys()) await caches.delete(key);
  } catch { /* Cache API tidak ada */ }
  try {
    for (const reg of (await navigator.serviceWorker?.getRegistrations?.()) ?? []) await reg.unregister();
  } catch { /* tanpa service worker */ }
  try { localStorage.clear(); } catch { /* diblokir */ }
  try { sessionStorage.clear(); } catch { /* diblokir */ }
  location.reload();
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
