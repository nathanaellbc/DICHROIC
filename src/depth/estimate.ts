/**
 * Sisi halaman estimasi kedalaman: membangun gambar yang dilihat jaringan,
 * menyerahkannya ke worker, dan mengembalikan peta disparitas.
 */
import type { DecodedImage } from '../io/decoded';
import { boxDownscale } from '../session/downscale';
import { TO_REC709, srgbEncode, rgbToCanvas } from '../io/display';
import type { DepthBackend, DepthProfile } from './model';
import type { DepthPhase, DepthRequest, DepthResponse } from './protocol';

export interface DepthResult {
  width: number;
  height: number;
  /** Disparitas ternormalisasi, baris atas-ke-bawah: 0 = tak hingga. */
  data: Float32Array;
  backend: DepthBackend;
  variant: 'fp16' | 'int8';
  inferMs: number;
}

export interface DepthProgress {
  phase: DepthPhase;
  loaded: number;
  total: number;
}

export class DepthNotCachedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DepthNotCachedError';
  }
}

export class DepthCancelledError extends Error {
  constructor() {
    super('Superseded by a newer request.');
    this.name = 'DepthCancelledError';
  }
}

export interface Guide {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Gambar yang dilihat jaringan: sRGB display-referred, seperti foto yang
 * dipakai melatihnya. Berkas ter-encode dipakai apa adanya; berkas linear
 * (RAW, EXR) dibawa ke Rec.709, rata-rata log luminansnya dijangkarkan ke
 * abu-abu 0.18, lalu di-encode sRGB -- "JPEG kamera" polos, tanpa film.
 */
export function buildGuide(image: DecodedImage, maxEdge: number): Guide {
  const { width, height, rgba } = boxDownscale(image.rgba, image.width, image.height, maxEdge);
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  if (image.encoding !== 'linear') {
    if (image.suggestedColorSpace !== 'sRGB') {
      const rgb = new Float32Array(n * 3);
      for (let i = 0; i < n; i += 1) rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
      return { rgba: rgbToCanvas(rgb, width, height, image.suggestedColorSpace), width, height };
    }
    for (let i = 0; i < n; i += 1) {
      out[i * 4] = rgba[i * 4]! * 255;
      out[i * 4 + 1] = rgba[i * 4 + 1]! * 255;
      out[i * 4 + 2] = rgba[i * 4 + 2]! * 255;
      out[i * 4 + 3] = 255;
    }
    return { rgba: out, width, height };
  }
  const m = TO_REC709[image.suggestedColorSpace] ?? TO_REC709['Linear Rec.709']!;
  const lin = new Float32Array(n * 3);
  let logSum = 0;
  let count = 0;
  for (let i = 0; i < n; i += 1) {
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    const lr = m[0] * r + m[1] * g + m[2] * b;
    const lg = m[3] * r + m[4] * g + m[5] * b;
    const lb = m[6] * r + m[7] * g + m[8] * b;
    lin.set([lr, lg, lb], i * 3);
    const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    if (lum > 1e-5) {
      logSum += Math.log(lum);
      count += 1;
    }
  }
  const gain = count ? 0.18 / Math.exp(logSum / count) : 1;
  for (let i = 0; i < n; i += 1) {
    out[i * 4] = srgbEncode(lin[i * 3]! * gain) * 255;
    out[i * 4 + 1] = srgbEncode(lin[i * 3 + 1]! * gain) * 255;
    out[i * 4 + 2] = srgbEncode(lin[i * 3 + 2]! * gain) * 255;
    out[i * 4 + 3] = 255;
  }
  return { rgba: out, width, height };
}

/**
 * Worker kedalaman, dibuat saat pertama dipakai untuk backend profil ini. Di
 * profil memori rendah (HP) ia ditutup setelah setiap estimasi: memori WASM
 * tidak pernah menyusut dan device WebGPU menahan buffernya selama hidup.
 */
export class DepthEstimator {
  #worker: Worker | null = null;
  #backend: DepthBackend | null = null;
  #nextId = 1;
  #pending: {
    id: number;
    resolve: (m: DepthResult) => void;
    reject: (e: Error) => void;
    onProgress?: (p: DepthProgress) => void;
    lowMemory: boolean;
  } | null = null;

  #ensureWorker(backend: DepthBackend): Worker {
    if (this.#worker && this.#backend === backend) return this.#worker;
    this.#terminate();
    // Dua URL literal supaya bundler melihat kedua entri; perangkat hanya memuat satu.
    const w =
      backend === 'webgpu'
        ? new Worker(new URL('./depthGpu.worker.ts', import.meta.url), { type: 'module', name: 'dichroic-depth' })
        : new Worker(new URL('./depthCpu.worker.ts', import.meta.url), { type: 'module', name: 'dichroic-depth' });
    w.onmessage = (e: MessageEvent<DepthResponse>) => this.#receive(e.data);
    w.onerror = (e) => {
      const p = this.#pending;
      this.#pending = null;
      this.#terminate();
      p?.reject(new Error(e.message || 'The depth worker failed to start.'));
    };
    this.#worker = w;
    this.#backend = backend;
    return w;
  }

  #terminate(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#backend = null;
  }

  #receive(msg: DepthResponse): void {
    const p = this.#pending;
    if (!p || msg.id !== p.id) return;
    if (msg.type === 'progress') {
      p.onProgress?.({ phase: msg.phase, loaded: msg.loaded, total: msg.total });
      return;
    }
    this.#pending = null;
    if (p.lowMemory) this.#terminate();
    if (msg.type === 'error') {
      p.reject(msg.code === 'not-cached' ? new DepthNotCachedError(msg.message) : new Error(msg.message));
      return;
    }
    p.resolve({ width: msg.width, height: msg.height, data: msg.depth, backend: msg.backend, variant: msg.variant, inferMs: msg.inferMs });
  }

  /**
   * Estimasi kedalaman `guide`. Panggilan baru menyalip yang lama (yang ditolak
   * `DepthCancelledError`). `allowDownload: false` memberi
   * `DepthNotCachedError` alih-alih unduhan kejutan.
   */
  estimate(guide: Guide, opts: { allowDownload: boolean; profile: DepthProfile; onProgress?: (p: DepthProgress) => void }): Promise<DepthResult> {
    const { profile } = opts;
    if (this.#pending) {
      this.#pending.reject(new DepthCancelledError());
      this.#pending = null;
      this.#terminate();
    }
    const worker = this.#ensureWorker(profile.backend);
    const id = this.#nextId++;
    const rgba = guide.rgba.slice();
    return new Promise<DepthResult>((resolve, reject) => {
      this.#pending = { id, resolve, reject, onProgress: opts.onProgress, lowMemory: profile.lowMemory };
      const req: DepthRequest = {
        type: 'estimate',
        id,
        rgba,
        width: guide.width,
        height: guide.height,
        allowDownload: opts.allowDownload,
        backend: profile.backend,
        inputSize: profile.inputSize,
        lowMemory: profile.lowMemory,
      };
      worker.postMessage(req, [rgba.buffer]);
    });
  }

  dispose(): void {
    this.#pending?.reject(new DepthCancelledError());
    this.#pending = null;
    this.#terminate();
  }
}
