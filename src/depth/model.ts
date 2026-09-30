/**
 * Model kedalaman lens blur: Depth Anything V2 Small (Apache-2.0), ekspor
 * ONNX `onnx-community/depth-anything-v2-small`, dijalankan onnxruntime-web
 * (MIT) di perangkat -- foto tidak pernah meninggalkan perangkat.
 *
 * Small, bukan Base/Large: hanya Small yang Apache-2.0 (Base dan Large
 * CC-BY-NC-4.0), dan Large ratusan MB -- terlalu besar untuk HP.
 *
 * Bobot diunduh dari Hugging Face saat pertama dipakai, DIPATOK ke satu
 * revisi (berkas di balik URL yang di-cache tidak bisa berubah), dan
 * disimpan di bucket Cache Storage sendiri. Nama bucket sengaja bukan
 * precache workbox: `cleanupOutdatedCaches` di `sw.ts` tidak menyentuhnya,
 * jadi model yang sekali diunduh bertahan lintas rilis dan bekerja offline.
 */

export const DEPTH_MODEL = {
  name: 'Depth Anything V2 Small',
  license: 'Apache-2.0',
  repo: 'onnx-community/depth-anything-v2-small',
  revision: '4472b7362082ad9968fee890ca0f1e5aca36b93d',
  /** Sisi pendek masukan jaringan, kelipatan 14 (`image2tensor`). */
  inputSize: 518,
  multipleOf: 14,
  mean: [0.485, 0.456, 0.406] as const,
  std: [0.229, 0.224, 0.225] as const,
} as const;

export type DepthBackend = 'webgpu' | 'wasm';

export interface ModelVariant {
  id: 'fp16' | 'int8';
  file: string;
  bytes: number;
}

/**
 * fp16 di GPU (WebGPU dengan `shader-f16`), int8 di CPU (WebAssembly) di
 * tempat lain -- kernel int8 CPU yang cepat, fp16 di CPU akan diemulasi.
 */
export const VARIANTS: Readonly<Record<DepthBackend, ModelVariant>> = {
  webgpu: { id: 'fp16', file: 'onnx/model_fp16.onnx', bytes: 49_642_442 },
  wasm: { id: 'int8', file: 'onnx/model_quantized.onnx', bytes: 27_258_801 },
};

/**
 * Biner WASM ONNX Runtime per build (`depthGpu.worker.ts` memakai build
 * WebGPU/asyncify, `depthCpu.worker.ts` build WASM polos). Diunduh sekali ke
 * cache kedalaman bersama bobot, jadi ikut dihitung dalam ukuran unduhan
 * pertama yang ditampilkan ke pengguna.
 */
export const RUNTIME_BYTES: Readonly<Record<DepthBackend, number>> = {
  webgpu: 26_781_914,
  wasm: 14_239_897,
};

/** Ukuran unduhan pertama di backend ini: bobot + runtime. */
export function firstDownloadBytes(backend: DepthBackend): number {
  return VARIANTS[backend].bytes + RUNTIME_BYTES[backend];
}

export const DEPTH_CACHE = 'dichroic.depth.v1';

export function variantUrl(v: ModelVariant): string {
  return `https://huggingface.co/${DEPTH_MODEL.repo}/resolve/${DEPTH_MODEL.revision}/${v.file}`;
}

/**
 * Cara estimasi berjalan di perangkat ini. Tab HP hidup di bawah batas memori
 * keras (iOS Safari membunuh halaman tanpa galat), dan engine WebGPU sudah
 * di dalam batas itu saat jaringan mulai: HP mendapat masukan lebih kecil
 * (392 px -- matriks atensi berskala kuadrat jumlah token), guide lebih
 * kecil, dan worker yang ditutup setelah tiap foto.
 */
export interface DepthProfile {
  backend: DepthBackend;
  inputSize: number;
  guideMaxEdge: number;
  lowMemory: boolean;
}

export function isAppleMobile(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

interface AdapterLike {
  features: { has(name: string): boolean };
}

/** Bisakah perangkat ini menjalankan fp16 di GPU? */
export async function preferredBackend(): Promise<DepthBackend> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<AdapterLike | null> } }).gpu;
  if (!gpu) return 'wasm';
  try {
    const adapter = await gpu.requestAdapter();
    return adapter?.features.has('shader-f16') ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

/**
 * iOS memakai jalur CPU: backend WebGPU ORT di Safari paling sedikit diuji,
 * akan menaruh device GPU kedua di samping engine, dan biner runtime-nya dua
 * kali lebih besar.
 */
export async function depthProfile(): Promise<DepthProfile> {
  if (isAppleMobile()) return { backend: 'wasm', inputSize: 392, guideMaxEdge: 1024, lowMemory: true };
  const coarse = window.matchMedia?.('(pointer: coarse)').matches === true;
  const backend = await preferredBackend();
  return coarse
    ? { backend, inputSize: 392, guideMaxEdge: 1024, lowMemory: true }
    : { backend, inputSize: DEPTH_MODEL.inputSize, guideMaxEdge: 1536, lowMemory: false };
}

export async function isModelCached(backend: DepthBackend): Promise<boolean> {
  try {
    const cache = await caches.open(DEPTH_CACHE);
    return (await cache.match(variantUrl(VARIANTS[backend]))) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Ambil `url` lewat cache kedalaman dan kembalikan byte-nya (satu salinan).
 * Unduhan dialirkan langsung ke cache lalu dibaca kembali -- mengumpulkan
 * potongan di memori lalu menyalinnya ke cache menahan model tiga kali
 * sekaligus, cukup untuk membuat tab HP dibunuh. Cache yang menolak (kuota,
 * mode privat) bukan galat: unduh ulang ke memori.
 */
export class DepthAssetNotCachedError extends Error {
  constructor() {
    super('The depth model and runtime are not on this device yet.');
    this.name = 'DepthAssetNotCachedError';
  }
}

export async function fetchCached(
  url: string,
  expectedBytes: number,
  onProgress?: (loaded: number, total: number) => void,
  allowDownload = true,
): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(DEPTH_CACHE);
    const hit = await cache.match(url);
    if (hit) return await hit.arrayBuffer();
  } catch {
    cache = null;
  }
  if (!allowDownload) throw new DepthAssetNotCachedError();
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length')) || expectedBytes;
  if (cache && res.body) {
    let loaded = 0;
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          loaded += chunk.byteLength;
          onProgress?.(loaded, total);
          controller.enqueue(chunk);
        },
      }),
    );
    try {
      await cache.put(url, new Response(counted, { headers: { 'content-type': 'application/octet-stream' } }));
      const stored = await cache.match(url);
      if (stored) return await stored.arrayBuffer();
    } catch {
      // Kuota atau konteks tanpa penyimpanan: jatuh ke memori.
    }
    const again = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!again.ok) throw new Error(`Download failed: ${again.status} ${again.statusText}`);
    return downloadToMemory(again, total, onProgress);
  }
  return downloadToMemory(res, total, onProgress);
}

async function downloadToMemory(res: Response, total: number, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  if (!res.body) {
    const buf = await res.arrayBuffer();
    onProgress?.(buf.byteLength, buf.byteLength);
    return buf;
  }
  let buffer = new Uint8Array(Math.max(total, 1));
  let loaded = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.byteLength > buffer.byteLength) {
      const grown = new Uint8Array(Math.max(buffer.byteLength * 2, loaded + value.byteLength));
      grown.set(buffer.subarray(0, loaded));
      buffer = grown;
    }
    buffer.set(value, loaded);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
  }
  return loaded === buffer.byteLength ? buffer.buffer : buffer.slice(0, loaded).buffer;
}
