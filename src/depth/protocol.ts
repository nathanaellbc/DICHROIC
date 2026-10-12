/** Pesan antara halaman dan worker kedalaman (`workerCore.ts`). */
import type { DepthBackend, DepthModelId, VariantId } from './model';

export type DepthPhase = 'runtime' | 'model' | 'compile' | 'infer' | 'refine' | 'matte';

export interface DepthRequest {
  type: 'estimate';
  id: number;
  /** Guide: sRGB RGBA8, baris atas-ke-bawah, orientasi foto. */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** `false`: gagal dengan 'not-cached' alih-alih mulai mengunduh. */
  allowDownload: boolean;
  backend: DepthBackend;
  /** Jaringan yang dipakai (`DEPTH_MODELS`). */
  model: DepthModelId;
  /** Sisi pendek yang dilihat jaringan. */
  inputSize: number;
  lowMemory: boolean;
}

/** Refine Edge: alfa ViTMatte untuk potongan `rgba` (sRGB RGBA8) dengan trimap 0/128/255. */
export interface MatteRequest {
  type: 'matte';
  id: number;
  rgba: Uint8ClampedArray;
  trimap: Uint8Array;
  width: number;
  height: number;
  allowDownload: boolean;
  lowMemory: boolean;
}

export type DepthResponse =
  | { type: 'progress'; id: number; phase: DepthPhase; loaded: number; total: number }
  | {
      type: 'result';
      id: number;
      width: number;
      height: number;
      /** Disparitas ternormalisasi: 0 di jangkar jauh (tak hingga), 1 di jangkar dekat. */
      depth: Float32Array;
      backend: DepthBackend;
      model: DepthModelId;
      variant: VariantId;
      inferMs: number;
    }
  | { type: 'matte-result'; id: number; alpha: Float32Array }
  | { type: 'error'; id: number; code: 'not-cached' | 'failed'; message: string };
