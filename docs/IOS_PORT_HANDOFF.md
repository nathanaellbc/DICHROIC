# Catatan lanjutan port iOS

Status: prototipe Flutter native pertama, belum port lengkap aplikasi web.
Source dan perbaikan berikutnya sudah dikirim ke main GitHub.

## Yang sudah ditulis

- UI Flutter untuk pilih foto, preview texture native, slider exposure, dan tombol Develop & Share.
- Bridge Swift untuk decode ImageIO/HEIC, orientasi foto, preview 1600 px, texture, dan export PNG 8-bit sRGB.
- Engine Rust/wgpu dengan backend Metal iOS, kernel exposure linear-light, dan buffer GPU per tile.
- Penjadwalan slider satu render aktif dengan nilai terbaru; export dijalankan setelah tombol ditekan.
- Export menunggu render aktif; preview nilai slider terakhir dipulihkan setelah export.
- Export in-place memakai satu buffer foto CPU dan salinan kerja maksimal 4 MiB, bukan buffer output seluruh foto kedua.
- Pinch zoom/drag dengan batas elastis, spring dan reset double-tap pada texture yang sudah ada.
- Before/after memakai texture import asli terpisah; membandingkan dan zoom tidak menjalankan develop.
- Tahap curve development native memakai `src/shaders/curveDevelop.wgsl` asli dan layout CoreParams yang diturunkan saat build dari `src/engine/params.ts`.
- Workflow Codemagic `exposure-ios-native` untuk build iOS unsigned, serta dependency lockfiles.
- GitHub Actions macOS menjalankan tes Metal dan build; packaging IPA unsigned untuk sideload pribadi dan simulator universal disiapkan.

Build iOS unsigned pertama dan perbaikan export sudah berhasil di GitHub Actions.
Pengujian perangkat asli belum dilakukan.
Kernel exposure belum menggantikan sistem film/paper spectral aplikasi web.
CurveDevelop menghasilkan densitas sebelum DIR dan belum dihubungkan ke UI film.
Decode dan encoding resolusi penuh masih menggunakan memori CPU; batas 50 MP
bukan jaminan aplikasi bebas crash pada iPhone.

## Pemeriksaan yang sudah dilakukan

- `npm run typecheck`: lulus.
- `npx vitest run test/nativeExposure.test.ts`: lulus, satu test GPU WGSL.
- Dart formatter dan Flutter analyze: lulus, tanpa lint tersisa.
- Flutter test lokal: lima test lulus (latest-value scheduling, export ordering, comparison texture, elastic drag, pinch/reset).
- Build Rust/Swift, XCFramework iPhone + arm64 simulator, Flutter analyze/test dan build iOS unsigned: lulus pada commit `bbe9f4f`, [run 37632022742](https://github.com/nathanaellbc/DICHROIC/actions/runs/37632022742).
- CurveDevelop Metal tests: lulus pada langkah Rust run `37633653392`; mencakup profil Portra 400 terukur, interpolasi/gamma, alpha, dan batas tile pada toleransi 1e-5. Ini bukan parity final pipeline film/paper.
- Commit `8c746a4`: semua langkah Rust/Metal, XCFramework tiga target, Flutter analyze/5 tests, build release iPhone, debug simulator dan packaging/upload IPA berhasil pada [run 37634116643](https://github.com/nathanaellbc/DICHROIC/actions/runs/37634116643). Status keseluruhan run menjadi cancelled karena push dokumentasi berikutnya, sesudah seluruh langkah selesai. Ketiga artifact tersedia; jangan menyebut status keseluruhan run ini green.
- Pemeriksaan ulang commit dokumentasi `9abdf8a`, run `37635171685`, tidak memulai job: GitHub melaporkan masalah account payments/spending limit. Tidak ada kegagalan source atau test pada run tersebut. Jangan menaikkan batas billing otomatis; gunakan artifact terverifikasi di atas atau workflow Codemagic yang sudah terhubung pengguna.
- IPA diunduh lokal ke `artifacts/ios-native-8c746a4/Exposure-unsigned.ipa` (diabaikan Git). Struktur Payload, executable arm64 dan framework diperiksa. Signing/install tetap belum diverifikasi.
- Pengujian iPhone, sideload, peak memory dan latency nyata belum dilakukan.

## Urutan pekerjaan berikutnya

1. Pertahankan gerbang macOS/Metal dan Flutter test pada setiap perubahan native.
2. Codemagic sudah dihubungkan pengguna. Jalankan `exposure-ios-native` jika ingin build dari sana; build verifikasi yang sudah hijau berasal dari GitHub Actions.
3. Pengguna menolak membership Apple berbayar dan hanya memiliki Windows. Pakai jalur sideload pribadi gratis di [IOS_FREE_INSTALL.md](IOS_FREE_INSTALL.md), bukan TestFlight. ID sementara `com.nathanaellbc.exposureIos` dapat diganti melalui `IOS_BUNDLE_ID` saat prepare host.
4. Verifikasi signing/install IPA via AltStore pada iPhone pengguna. Packaging unsigned bukan bukti instalasi berhasil. Jangan simpan credential di repository.
5. Uji pada iPhone: orientasi/HEIC, slider cepat, texture, background/foreground, memory pressure, foto besar, export, dan share sheet. Ukur memori/latency sebelum menyatakan optimisasi berhasil.
6. Port persiapan asset/arena dan shader film/paper spectral asli. Bandingkan hasil final dengan fixture/parity engine web sebelum membuka fitur film.
7. Port grain, halation, DIR, diffusion/FFT, dan lens dengan pengelolaan memori dan tiling yang sesuai tiap tahap.
8. Port erase, depth, RAW, metadata, wide-gamut/16-bit export, dan lengkapi UI. Tambahkan fitur baru setelah fitur lama sudah berfungsi.

## Lokasi penting

- `mobile/`: aplikasi Flutter dan plugin Swift `packages/exposure_engine/`.
- `native/`: engine Rust, C ABI, dan WGSL exposure.
- `mobile/scripts/`: generator host iOS dan builder XCFramework.
- `codemagic.yaml`: konfigurasi build cloud awal.

Toolchain `.tools/`, build cache, host `mobile/ios/` yang dihasilkan, dan binary
XCFramework sengaja diabaikan Git. Workflow menghasilkan host dan binary dari source.
