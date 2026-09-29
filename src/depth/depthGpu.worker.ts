/// <reference lib="webworker" />
/** Build WebGPU ONNX Runtime: fp16 di GPU, dengan kernel CPU untuk fallback. */
import * as ort from 'onnxruntime-web/webgpu';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { serveDepth } from './workerCore';

serveDepth(ort, ortWasmUrl, 26_781_914);
