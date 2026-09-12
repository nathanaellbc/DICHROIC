import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // SATU proses, SATU berkas test pada satu waktu.
    //
    // Binding `webgpu` (Dawn) memasang state global per proses, dan empat
    // berkas test di sini mengakuisisi `GPUDevice`. Dengan pool default
    // vitest, beberapa worker memegang instance Dawn-nya sendiri secara
    // bersamaan dan salah satu worker mati dengan segfault ("Worker exited
    // unexpectedly") tanpa pernah melaporkan test mana yang bermasalah --
    // kegagalan yang menyamar sebagai kegagalan test, yang justru paling
    // mahal untuk gerbang parity Task 11-19.
    //
    // Akar masalah yang sama juga melahirkan pemisahan
    // `precomputeArenaData()`/`uploadArenas()` -- lih. CATATAN LINGKUNGAN di
    // `src/host/spectral.ts`. Yang ini menutup sisi pool-nya.
    //
    // `singleFork` SENGAJA TIDAK dipakai: satu proses untuk SEMUA berkas
    // membuat berkas pertama yang menyentuh device meracuni sisanya, dan satu
    // segfault menghabisi seluruh suite (terukur: hanya 2 dari 10 berkas
    // sempat jalan). Yang dipakai adalah satu proses SEGAR per berkas,
    // dijalankan satu per satu -- jadi Dawn tidak pernah hidup dua kali
    // sekaligus, dan kalau satu berkas jatuh, sembilan lainnya tetap
    // melaporkan hasilnya.
    //
    // Biayanya wall-clock: berkas test berjalan berurutan, bukan paralel.
    // Untuk suite sebesar ini (~20 detik) itu harga yang murah dibanding
    // gerbang yang hasilnya tidak bisa dipercaya.
    pool: 'forks',
    fileParallelism: false,
  },
});
