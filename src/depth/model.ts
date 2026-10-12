/**
 * Model kedalaman lens blur, dijalankan onnxruntime-web (MIT) di perangkat --
 * foto tidak pernah meninggalkan perangkat. Bawaannya Depth Anything V2 Small
 * (ekspor ONNX `onnx-community/depth-anything-v2-small`, ringan untuk HP);
 * desktop bisa memilih model yang lebih berat (`DEPTH_MODELS`).
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

export type VariantId = 'fp16' | 'int8' | 'q4f16';

export interface ModelVariant {
  id: VariantId;
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
 * Model kedalaman yang bisa dipilih pengguna. Semua melewati refine yang sama
 * (upsample bilateral, guided filter, matte dua lapis); yang berbeda hanya
 * jaringannya:
 *
 * - `fast`: Depth Anything V2 Small -- bawaan, jalan di semua perangkat.
 * - `detail`: Distill Any Depth Base (ViT-B, arsitektur Depth Anything V2,
 *   prapemrosesan dan keluaran sama), lebih akurat, ~100-200 MB. Di HP
 *   eksperimental (int8 102 MB, masukan 392 px).
 * - `pro`: Apple Depth Pro -- tepi paling tajam, masukan 1536^2, keluaran
 *   JARAK (dibalik ke disparitas di worker); 600 MB q4f16, hanya desktop GPU.
 */
export type DepthModelId = 'fast' | 'detail' | 'pro';

export interface DepthModelSpec {
  id: DepthModelId;
  /** Label pemilih di grup Lens. */
  label: string;
  name: string;
  repo: string;
  revision: string;
  variants: Partial<Record<DepthBackend, ModelVariant>>;
  /** Masukan persegi tetap; tanpa ini sisi pendek profil, kelipatan 14. */
  fixedInput?: number;
  mean: readonly [number, number, number];
  std: readonly [number, number, number];
  /** `disparity`: makin dekat makin besar. `depth`: jarak, makin jauh makin besar. */
  output: 'disparity' | 'depth';
  /**
   * Profil memori rendah (HP): `no` disembunyikan, `experimental` boleh dipilih
   * tapi bisa kehabisan memori tab (engine kembali ke `fast` bila tab mati).
   */
  mobile: 'yes' | 'experimental' | 'no';
}

export const DEPTH_MODELS: Readonly<Record<DepthModelId, DepthModelSpec>> = {
  fast: {
    id: 'fast',
    label: 'Fast',
    name: DEPTH_MODEL.name,
    repo: DEPTH_MODEL.repo,
    revision: DEPTH_MODEL.revision,
    variants: VARIANTS,
    mean: DEPTH_MODEL.mean,
    std: DEPTH_MODEL.std,
    output: 'disparity',
    mobile: 'yes',
  },
  detail: {
    id: 'detail',
    label: 'Detail',
    name: 'Distill Any Depth Base',
    repo: 'Ko033/distill-any-depth-base-onnx',
    revision: '7ca2c05fd248d13fcb537698c44d3e7792f01868',
    variants: {
      webgpu: { id: 'fp16', file: 'onnx/model_fp16.onnx', bytes: 196_847_178 },
      wasm: { id: 'int8', file: 'onnx/model_quantized.onnx', bytes: 102_212_799 },
    },
    mean: DEPTH_MODEL.mean,
    std: DEPTH_MODEL.std,
    output: 'disparity',
    mobile: 'experimental',
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    name: 'Apple Depth Pro',
    repo: 'onnx-community/DepthPro-ONNX',
    revision: 'feefb662b967b477367485dc4f133aeecd638ba4',
    variants: {
      webgpu: { id: 'q4f16', file: 'onnx/model_q4f16.onnx', bytes: 600_274_893 },
    },
    fixedInput: 1536,
    mean: [0.5, 0.5, 0.5],
    std: [0.5, 0.5, 0.5],
    output: 'depth',
    mobile: 'no',
  },
};

export const DEPTH_MODEL_IDS: readonly DepthModelId[] = ['fast', 'detail', 'pro'];

export function isDepthModelId(value: unknown): value is DepthModelId {
  return typeof value === 'string' && (DEPTH_MODEL_IDS as readonly string[]).includes(value);
}

/** Varian `model` untuk backend ini, atau `undefined` bila model tidak jalan di sana. */
export function modelVariant(model: DepthModelId, backend: DepthBackend): ModelVariant | undefined {
  return DEPTH_MODELS[model].variants[backend];
}

/** Model yang bisa dipilih di perangkat dengan profil ini. */
export function availableModels(profile: DepthProfile): DepthModelId[] {
  return DEPTH_MODEL_IDS.filter((id) => {
    const spec = DEPTH_MODELS[id];
    return spec.variants[profile.backend] !== undefined && !(spec.mobile === 'no' && profile.lowMemory);
  });
}

/** Model ini di perangkat ini berisiko kehabisan memori tab. */
export function isExperimental(model: DepthModelId, profile: DepthProfile): boolean {
  return profile.lowMemory && DEPTH_MODELS[model].mobile === 'experimental';
}

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

/** Ukuran unduhan pertama model ini di backend ini: bobot + runtime. */
export function firstDownloadBytes(backend: DepthBackend, model: DepthModelId = 'fast'): number {
  return (modelVariant(model, backend)?.bytes ?? 0) + RUNTIME_BYTES[backend];
}

export const DEPTH_CACHE = 'dichroic.depth.v1';

export function variantUrl(v: ModelVariant, model: DepthModelId = 'fast'): string {
  const spec = DEPTH_MODELS[model];
  return `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${v.file}`;
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
  if (coarse) return { backend, inputSize: 392, guideMaxEdge: 1024, lowMemory: true };
  // Desktop: guide 2048 untuk matte rambut (`matte.ts`). Di GPU jaringan
  // melihat 770 px (bukan 518): tepi subjek lebih rapat; atensi berskala
  // kuadrat token, jadi jalur CPU tetap 518.
  return { backend, inputSize: backend === 'webgpu' ? HIGH_DETAIL_INPUT : DEPTH_MODEL.inputSize, guideMaxEdge: 2048, lowMemory: false };
}

/** Masukan jaringan desktop ber-GPU (kelipatan 14). */
export const HIGH_DETAIL_INPUT = 770;

export async function isModelCached(backend: DepthBackend, model: DepthModelId = 'fast'): Promise<boolean> {
  const variant = modelVariant(model, backend);
  if (!variant) return false;
  try {
    const cache = await caches.open(DEPTH_CACHE);
    return (await cache.match(variantUrl(variant, model))) !== undefined;
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
