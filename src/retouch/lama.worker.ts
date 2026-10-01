/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { PATCH_SIZE } from './patch';

const MODEL = 'https://huggingface.co/g-ronimo/lama/resolve/418036c6b541e526cdbb0bead1ec3a87dabede53/lama_512_int8.onnx';
ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
let session: ort.InferenceSession | undefined;
self.onmessage = async (event: MessageEvent<{ rgb: Float32Array; mask: Float32Array }>) => {
  try {
    if (!session) {
      self.postMessage({ status: 'Downloading LaMa (62 MB, cached for next time)…' });
      const cache = typeof caches !== 'undefined' ? await caches.open('dichroic-lama-v1').catch(() => undefined) : undefined;
      let response = await cache?.match(MODEL);
      if (!response) {
        response = await fetch(MODEL);
        if (!response.ok) throw new Error(`LaMa download failed (${response.status}). Retry when connected.`);
        await cache?.put(MODEL, response.clone()).catch(() => {});
      }
      const bytes = await response.arrayBuffer();
      self.postMessage({ status: 'Preparing LaMa…' });
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    }
    self.postMessage({ status: 'Removing object on this device…' });
    const n = PATCH_SIZE ** 2, input = new Float32Array(n * 4);
    const { rgb, mask } = event.data;
    for (let i = 0; i < n; i++) { for (let c = 0; c < 3; c++) input[c * n + i] = rgb[i * 3 + c]! * (1 - mask[i]!); input[3 * n + i] = mask[i]!; }
    const tensor = new ort.Tensor('float32', input, [1, 4, PATCH_SIZE, PATCH_SIZE]);
    const result = await session.run({ [session.inputNames[0]!]: tensor });
    const output = result[session.outputNames[0]!]!;
    const data = new Float32Array(output.data as Float32Array);
    tensor.dispose(); for (const value of Object.values(result)) value.dispose();
    self.postMessage({ output: data }, [data.buffer]);
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
