/// <reference lib="webworker" />
/** Build WebGPU ONNX Runtime: fp16 di GPU, dengan kernel CPU untuk fallback. */
import * as ort from 'onnxruntime-web/webgpu';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { RUNTIME_BYTES } from './model';
import { serveDepth } from './workerCore';

serveDepth(ort, ortWasmUrl, RUNTIME_BYTES.webgpu);
