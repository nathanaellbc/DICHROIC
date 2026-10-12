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
import { DEPTH_CACHE, DEPTH_MODELS, DepthAssetNotCachedError, fetchCached, modelVariant, variantUrl } from './model';
import type { DepthBackend, DepthModelId } from './model';
import { jointBilateralUpsample, modelInputSize, normaliseDisparity, resampleRGB, rgbaFrom, toModelTensor } from './refine';
import { detailDepth } from './matte';
import type { DepthRequest, DepthResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

/** Pasang handler pesan worker untuk satu build ONNX Runtime. */
export function serveDepth(ort: typeof Ort, ortWasmUrl: string, runtimeBytes: number): void {
  let runtimeReady: Promise<void> | null = null;
  const sessions = new Map<string, Promise<Ort.InferenceSession>>();

  const post = (msg: DepthResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

  function loadRuntime(id: number, allowDownload: boolean): Promise<void> {
    runtimeReady ??= (async () => {
      const wasm = await fetchCached(new URL(ortWasmUrl, self.location.href).href, runtimeBytes, (loaded, total) =>
        post({ type: 'progress', id, phase: 'runtime', loaded, total }),
        allowDownload,
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

  /** Satu sesi hidup: berganti model melepas sesi lama (ratusan MB bobot). */
  const key = (model: DepthModelId, backend: DepthBackend) => `${model}|${backend}`;

  async function releaseOthers(keep: string): Promise<void> {
    for (const [k, s] of [...sessions]) {
      if (k === keep) continue;
      sessions.delete(k);
      await s.then((x) => x.release(), () => {}).catch(() => {});
    }
  }

  function session(model: DepthModelId, backend: DepthBackend, id: number, allowDownload: boolean, lowMemory: boolean): Promise<Ort.InferenceSession> {
    const k = key(model, backend);
    let s = sessions.get(k);
    if (!s) {
      s = (async () => {
        const variant = modelVariant(model, backend);
        if (!variant) throw new Error(`${DEPTH_MODELS[model].name} needs a GPU with fp16 support.`);
        const url = variantUrl(variant, model);
        if (!allowDownload) {
          const cache = await globalThis.caches?.open(DEPTH_CACHE).catch(() => null);
          const runtimeUrl = new URL(ortWasmUrl, self.location.href).href;
          if (!(await cache?.match(url)) || (!runtimeReady && !(await cache?.match(runtimeUrl)))) throw new DepthAssetNotCachedError();
        }
        await releaseOthers(k);
        await loadRuntime(id, allowDownload);
        const bytes = await fetchCached(url, variant.bytes, (loaded, total) => post({ type: 'progress', id, phase: 'model', loaded, total }), allowDownload);
        post({ type: 'progress', id, phase: 'compile', loaded: 0, total: 1 });
        return ort.InferenceSession.create(new Uint8Array(bytes), {
          executionProviders: [backend],
          graphOptimizationLevel: 'all',
          // Arena dan memory pattern menahan memori yang tidak bisa diambil kembali di HP.
          enableCpuMemArena: !lowMemory,
          enableMemPattern: !lowMemory,
        });
      })();
      sessions.set(k, s);
      s.catch(() => sessions.delete(k));
    }
    return s;
  }

  async function infer(backend: DepthBackend, req: DepthRequest) {
    const spec = DEPTH_MODELS[req.model];
    const s = await session(req.model, backend, req.id, req.allowDownload, req.lowMemory);
    // Depth Pro melihat persegi tetap (direntang; upsample bilateral memetakan
    // tiap sumbu terpisah), Depth Anything sisi pendek kelipatan 14.
    const [mw, mh] = spec.fixedInput ? [spec.fixedInput, spec.fixedInput] : modelInputSize(req.width, req.height, req.inputSize);
    const rgb = resampleRGB(req.rgba, req.width, req.height, mw, mh);
    const input = new ort.Tensor('float32', toModelTensor(rgb, mw, mh, spec.mean, spec.std), [1, 3, mh, mw]);
    post({ type: 'progress', id: req.id, phase: 'infer', loaded: 0, total: 1 });
    const t0 = performance.now();
    let out: Ort.InferenceSession.ReturnType | undefined;
    try {
      out = await s.run({ [s.inputNames[0]!]: input });
      const inferMs = performance.now() - t0;
      const tensor = out['predicted_depth'] ?? out[s.outputNames[0]!]!;
      const raw = ((await tensor.getData()) as Float32Array).slice();
      // Jarak -> disparitas: refine dan lens blur bekerja di disparitas
      // (0 di tak hingga); skalanya dinormalisasi `normaliseDisparity`.
      if (spec.output === 'depth') for (let i = 0; i < raw.length; i += 1) raw[i] = 1 / Math.max(raw[i]!, 1e-3);
      const dims = tensor.dims;
      return { raw, ow: dims[dims.length - 1]!, oh: dims[dims.length - 2]!, rgb, mw, mh, inferMs };
    } finally {
      input.dispose();
      if (out) for (const tensor of Object.values(out)) tensor.dispose();
    }
  }

  self.onmessage = async (e: MessageEvent<DepthRequest>) => {
    const req = e.data;
    if (req.type !== 'estimate') return;
    try {
      let backend: DepthBackend = req.backend;
      let result: Awaited<ReturnType<typeof infer>>;
      try {
        result = await infer(backend, req);
      } catch (err) {
        if (err instanceof DepthAssetNotCachedError || backend === 'wasm' || !modelVariant(req.model, 'wasm')) throw err;
        // Jalur GPU bisa gagal belakangan (kernel tidak ada, device hilang); CPU selalu ada.
        const failed = sessions.get(key(req.model, 'webgpu'));
        sessions.delete(key(req.model, 'webgpu'));
        if (failed) await failed.then((s) => s.release(), () => {}).catch(() => {});
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
      // Detail halus (matte.ts): kedalaman dibersihkan berpanduan foto, lalu dua
      // lapis + matte di tepi subjek supaya helai rambut tetap tajam di atas
      // latar yang blur.
      const { depth, layers } = detailDepth(up, req.rgba, req.width, req.height, { lowMemory: req.lowMemory }, normaliseDisparity);
      post(
        { type: 'result', id: req.id, width: req.width, height: req.height, depth, layers, backend, model: req.model, variant: modelVariant(req.model, backend)!.id, inferMs: Math.round(result.inferMs) },
        [depth.buffer, layers.foreground.buffer, layers.background.buffer, layers.alpha.buffer],
      );
    } catch (err) {
      post({
        type: 'error',
        id: req.id,
        code: err instanceof DepthAssetNotCachedError ? 'not-cached' : 'failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
