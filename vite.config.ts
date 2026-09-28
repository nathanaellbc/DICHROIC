import { defineConfig } from 'vite';

// Decoder RAW (`libraw-wasm`) memakai memori WASM bersama untuk pthread, yang
// hanya tersedia bila halaman cross-origin isolated. Header yang sama wajib
// dipasang di hosting (fase PWA).
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  // Pra-bundling esbuild memutus `new URL('libraw.wasm', import.meta.url)` dan
  // worker pthread Emscripten; paketnya disajikan apa adanya.
  optimizeDeps: { exclude: ['libraw-wasm'] },
});
