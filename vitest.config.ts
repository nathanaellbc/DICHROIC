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
    // Batas waktu per test: 30 detik, bukan 5 detik bawaan vitest.
    //
    // Gerbang parity GPU memang lambat, dan yang bawaan tidak pernah
    // dikalibrasi untuk itu. Diukur pada grain.test.ts (tahap terberat,
    // beberapa buffer scratch): 2.758 ms sampai 5.487 ms per kasus, dengan
    // kasus PERTAMA di tiap berkas paling lambat karena ia yang membayar
    // pemuatan aset, akuisisi device, dan unggah arena sekali-saja. Artinya
    // ia duduk TEPAT di ambang 5.000 ms, dan suite penuh gagal 1 dari 3 run
    // pada kontensi GPU.
    //
    // Itu bukan cuma gangguan: vitest melaporkan timeout sebagai test GAGAL,
    // jadi jam dinding yang lewat sedikit tidak bisa dibedakan dari REGRESI
    // PARITY oleh siapa pun yang membaca hasilnya. Seluruh nilai gerbang-gerbang
    // ini ada pada angka yang bisa dipercaya, jadi ambang yang bisa memerah
    // sendiri tanpa ada yang salah justru merusak hal yang paling kami jaga.
    //
    // 30 detik memberi kelonggaran ~5x di atas kasus terlambat yang terukur.
    // Kalau suatu test benar-benar menggantung, pembatas sebenarnya adalah
    // timeout proses di luar vitest, bukan angka ini.
    testTimeout: 30000,

    pool: 'forks',
    fileParallelism: false,
  },
});
