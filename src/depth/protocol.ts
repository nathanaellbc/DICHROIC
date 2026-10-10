/** Pesan antara halaman dan worker kedalaman (`workerCore.ts`). */
import type { DepthBackend } from './model';

export type DepthPhase = 'runtime' | 'model' | 'compile' | 'infer' | 'refine';

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
  /** Sisi pendek yang dilihat jaringan. */
  inputSize: number;
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
      /** Dua lapis di tepi subjek (`matte.ts` `depthLayers`), seukuran `depth`. */
      layers: { foreground: Float32Array; background: Float32Array; alpha: Float32Array };
      backend: DepthBackend;
      variant: 'fp16' | 'int8';
      inferMs: number;
    }
  | { type: 'error'; id: number; code: 'not-cached' | 'failed'; message: string };
