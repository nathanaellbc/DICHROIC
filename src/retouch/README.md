# Local LaMa object removal

Original research/code: [advimman/lama](https://github.com/advimman/lama), Resolution-robust Large Mask Inpainting with Fourier Convolutions (WACV 2022).
Browser export: [g-ronimo/lama](https://huggingface.co/g-ronimo/lama), Apache-2.0 model card. We use `lama_512_int8.onnx` at immutable revision `418036c6b541e526cdbb0bead1ec3a87dabede53`. Weights are downloaded on the first explicit Remove action, not included in the application bundle. No image is uploaded.

The model runs with ONNX Runtime Web in a dedicated single-threaded WASM worker. Its fixed FFT-as-matmul graph avoids unsupported DFT operations. Cache Storage retains the approximately 62 MB model when the browser allows it; the worker/session is released on modal close. Closing the modal cancels in-flight inference and discards unapplied previews.

Brush masks are drawn in original-preview coordinates directly in the main editor photo area. Removal controls occupy the existing inspector/bottom panel via portals owned by one mounted component. The original frame bypasses grading only for display; parameters remain unchanged. The image worker extracts a native-source crop with context, bounded to 4 MP, and samples it to the model's 512x512 input. LaMa consumes masked encoded sRGB plus a binary mask and emits planar encoded RGB. Apply bilinearly samples the generated patch into the native source, blending the inner mask edge. Unmasked pixels and metadata are preserved. One native float crop supports exact Undo removal, including after reopening the mode. Parameter undo remains independent.

Initial supported sources: encoded sRGB and linear Rec.709 (common camera RAW decode). Other source color spaces are rejected explicitly rather than silently converted or flattened. Generated regions are LDR sRGB, even within an HDR source. Large selections are rejected to avoid memory growth and excessively upscaled reconstruction. Removal invalidates image/preview/export/depth caches; lens depth is re-estimated when enabled.

Performance and Safari compatibility must be measured on physical devices. Browser desktop tests do not certify iPhone performance. A first download/compile can take tens of seconds. Persistent model cache is optional; private browsing or storage eviction can require a new download.
