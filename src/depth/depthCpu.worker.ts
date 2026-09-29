/// <reference lib="webworker" />
/** Build WebAssembly polos ONNX Runtime: int8 di CPU, setengah ukuran build WebGPU. */
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { serveDepth } from './workerCore';

serveDepth(ort, ortWasmUrl, 14_239_897);
