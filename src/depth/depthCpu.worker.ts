/// <reference lib="webworker" />
/** Build WebAssembly polos ONNX Runtime: int8 di CPU, setengah ukuran build WebGPU. */
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { RUNTIME_BYTES } from './model';
import { serveDepth } from './workerCore';

// Thread pthread ONNX Runtime dibuat dengan `new Worker(import.meta.url,
// { name: 'em-pthread' })`. Setelah dibundel, `import.meta.url` adalah worker
// INI, jadi setiap thread memuat berkas ini lagi. Di thread itu handler
// Emscripten sudah dipasang saat modul ORT dievaluasi; memasang `serveDepth`
// di atasnya menimpa `self.onmessage` Emscripten, thread tidak pernah
// menerima `load`, dan pembuatan sesi menunggu selamanya ("Preparing the
// depth model... 0%" di iPhone).
if (!self.name.startsWith('em-pthread')) serveDepth(ort, ortWasmUrl, RUNTIME_BYTES.wasm);
