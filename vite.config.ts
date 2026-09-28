import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Decoder RAW (`libraw-wasm`) memakai memori WASM bersama untuk pthread, yang
// hanya tersedia bila halaman cross-origin isolated. Header yang sama wajib
// dipasang di hosting (fase PWA).
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  // Pra-bundling esbuild memutus `new URL('libraw.wasm', import.meta.url)` dan
  // worker pthread Emscripten; paketnya disajikan apa adanya.
  optimizeDeps: { exclude: ['libraw-wasm'] },
  // Worker Session mengimpor modul ES (dan LibRaw memuat pthread sebagai modul).
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
