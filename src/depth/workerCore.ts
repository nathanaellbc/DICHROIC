/// <reference lib="webworker" />
/**
 * Estimasi kedalaman di luar thread UI: runtime ONNX, jaringan, dan refine
 * bilateral berjalan di sini. Dua entri tipis berbagi badan ini, satu per
 * build ONNX Runtime (`depthGpu.worker.ts`: WebGPU + kernel CPU untuk
 * fallback; `depthCpu.worker.ts`: WebAssembly polos, setengah ukurannya);
 * perangkat hanya mengunduh yang dipakainya.
 *
 * Biner WASM runtime diambil lewat cache kedalaman yang sama dengan bobot dan
 * diserahkan sebagai byte: dibiarkan mengambil sendiri, ia masuk precache
 * service worker dan diunduh ulang setiap rilis.
 */

import type * as Ort from 'onnxruntime-web';
import { DEPTH_CACHE, VARIANTS, fetchCached, variantUrl } from './model';
import type { DepthBackend } from './model';
import { jointBilateralUpsample, modelInputSize, normaliseDisparity, resampleRGB, rgbaFrom, toModelTensor } from './refine';
import type { DepthRequest, DepthResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

class NotCachedError extends Error {
  constructor() {
    super('The depth model is not on this device yet.');
    this.name = 'NotCachedError';
  }
}

/** Pasang handler pesan worker untuk satu build ONNX Runtime. */
export function serveDepth(ort: typeof Ort, ortWasmUrl: string, runtimeBytes: number): void {
  let runtimeReady: Promise<void> | null = null;
  const sessions = new Map<DepthBackend, Promise<Ort.InferenceSession>>();

  const post = (msg: DepthResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

  function loadRuntime(id: number): Promise<void> {
    runtimeReady ??= (async () => {
      const wasm = await fetchCached(new URL(ortWasmUrl, self.location.href).href, runtimeBytes, (loaded, total) =>
        post({ type: 'progress', id, phase: 'runtime', loaded, total }),
      );
      ort.env.wasm.wasmBinary = wasm;
      // Thread butuh SharedArrayBuffer, yang butuh cross-origin isolation.
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, Math.max(1, navigator.hardwareConcurrency || 1)) : 1;
      ort.env.wasm.proxy = false;
    })().catch((err: unknown) => {
      runtimeReady = null;
      throw err;
    });
    return runtimeReady;
  }

  function session(backend: DepthBackend, id: number, allowDownload: boolean, lowMemory: boolean): Promise<Ort.InferenceSession> {
    let s = sessions.get(backend);
    if (!s) {
      s = (async () => {
        const variant = VARIANTS[backend];
        const url = variantUrl(variant);
        if (!allowDownload) {
          const cache = await caches.open(DEPTH_CACHE).catch(() => null);
          if (!(await cache?.match(url))) throw new NotCachedError();
        }
        const bytes = await fetchCached(url, variant.bytes, (loaded, total) => post({ type: 'progress', id, phase: 'model', loaded, total }));
        post({ type: 'progress', id, phase: 'compile', loaded: 0, total: 1 });
        return ort.InferenceSession.create(new Uint8Array(bytes), {
          executionProviders: [backend],
          graphOptimizationLevel: 'all',
          // Arena dan memory pattern menahan memori yang tidak bisa diambil kembali di HP.
          enableCpuMemArena: !lowMemory,
          enableMemPattern: !lowMemory,
        });
      })();
      sessions.set(backend, s);
      s.catch(() => sessions.delete(backend));
    }
    return s;
  }

  async function infer(backend: DepthBackend, req: DepthRequest) {
    const s = await session(backend, req.id, req.allowDownload, req.lowMemory);
    const [mw, mh] = modelInputSize(req.width, req.height, req.inputSize);
    const rgb = resampleRGB(req.rgba, req.width, req.height, mw, mh);
    const input = new ort.Tensor('float32', toModelTensor(rgb, mw, mh), [1, 3, mh, mw]);
    post({ type: 'progress', id: req.id, phase: 'infer', loaded: 0, total: 1 });
    const t0 = performance.now();
    const out = await s.run({ [s.inputNames[0]!]: input });
    const inferMs = performance.now() - t0;
    const tensor = out[s.outputNames[0]!]!;
    const raw = (await tensor.getData()) as Float32Array;
    const dims = tensor.dims;
    const oh = dims[dims.length - 2]!;
    const ow = dims[dims.length - 1]!;
    input.dispose();
    tensor.dispose();
    return { raw, ow, oh, rgb, mw, mh, inferMs };
  }

  self.onmessage = async (e: MessageEvent<DepthRequest>) => {
    const req = e.data;
    if (req.type !== 'estimate') return;
    try {
      await loadRuntime(req.id);
      let backend: DepthBackend = req.backend;
      let result: Awaited<ReturnType<typeof infer>>;
      try {
        result = await infer(backend, req);
      } catch (err) {
        if (err instanceof NotCachedError || backend === 'wasm') throw err;
        // Jalur GPU bisa gagal belakangan (kernel tidak ada, device hilang); CPU selalu ada.
        sessions.delete('webgpu');
        console.warn('[depth] WebGPU failed, falling back to WebAssembly:', err);
        backend = 'wasm';
        result = await infer(backend, req);
      }
      post({ type: 'progress', id: req.id, phase: 'refine', loaded: 0, total: 1 });
      const guideLow =
        result.ow === result.mw && result.oh === result.mh
          ? result.rgb
          : resampleRGB(rgbaFrom(result.rgb, result.mw, result.mh), result.mw, result.mh, result.ow, result.oh);
      const up = jointBilateralUpsample(result.raw, result.ow, result.oh, guideLow, req.rgba, req.width, req.height);
      const depth = normaliseDisparity(up);
      post(
        { type: 'result', id: req.id, width: req.width, height: req.height, depth, backend, variant: VARIANTS[backend].id, inferMs: Math.round(result.inferMs) },
        [depth.buffer],
      );
    } catch (err) {
      post({
        type: 'error',
        id: req.id,
        code: err instanceof NotCachedError ? 'not-cached' : 'failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
