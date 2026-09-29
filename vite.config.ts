import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Decoder RAW (`libraw-wasm`) memakai memori WASM bersama untuk pthread, yang
// hanya tersedia bila halaman cross-origin isolated. Hosting memasang header
// yang sama (`public/_headers`); bila tidak bisa, service worker yang
// menambahkannya (`src/sw.ts`).
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Subpath hosting, mis. `/DICHROIC/` untuk GitHub Pages proyek.
const base = process.env.DICHROIC_BASE ?? '/';

/** Tag `apple-touch-startup-image` per ukuran iPhone (dibangkitkan `tools/gen_icons.mjs`). */
function iosSplashScreens(): Plugin {
  const screens = JSON.parse(readFileSync('tools/splash-screens.json', 'utf8')) as Array<{ file: string; media: string }>;
  return {
    name: 'dichroic-ios-splash',
    transformIndexHtml: () =>
      screens.map(({ file, media }) => ({
        tag: 'link',
        attrs: { rel: 'apple-touch-startup-image', media, href: `${base}icons/${file}` },
        injectTo: 'head' as const,
      })),
  };
}

export default defineConfig({
  base,
  plugins: [
    react(),
    iosSplashScreens(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // Pendaftaran dan pembaruan diatur `src/ui/pwa.ts`.
      injectRegister: false,
      registerType: 'prompt',
      // Ikon manifest sudah tercakup globPatterns di bawah.
      includeManifestIcons: false,
      injectManifest: {
        // Manifest aplikasi ditambahkan plugin sendiri.
        globPatterns: ['**/*.{html,js,css,wasm,svg,png,json,f16,f32}'],
        // Layar pembuka hanya diminta iOS saat memasang; tidak perlu offline.
        globIgnores: ['icons/splash-*.png'],
        // Aset spektral terbesar (hanatos.f16) sekitar 6 MB.
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
      },
      manifest: {
        id: base,
        name: 'DICHROIC',
        short_name: 'DICHROIC',
        description: 'Spectral film simulation, on your device.',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'any',
        background_color: '#000000',
        theme_color: '#000000',
        categories: ['photo'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  // Pra-bundling esbuild memutus `new URL('libraw.wasm', import.meta.url)` dan
  // worker pthread Emscripten; paketnya disajikan apa adanya.
  optimizeDeps: { exclude: ['libraw-wasm'] },
  // Worker Session mengimpor modul ES (dan LibRaw memuat pthread sebagai modul).
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
