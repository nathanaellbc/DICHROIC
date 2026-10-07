# Catatan lanjutan port iOS

Status: prototipe Flutter native pertama, belum port lengkap aplikasi web.
Source disimpan apa adanya agar pekerjaan bisa dilanjutkan dari GitHub.

## Yang sudah ditulis

- UI Flutter untuk pilih foto, preview texture native, slider exposure, dan tombol Develop & Share.
- Bridge Swift untuk decode ImageIO/HEIC, orientasi foto, preview 1600 px, texture, dan export PNG 8-bit sRGB.
- Engine Rust/wgpu dengan backend Metal iOS, kernel exposure linear-light, dan buffer GPU per tile.
- Penjadwalan slider satu render aktif dengan nilai terbaru; export dijalankan setelah tombol ditekan.
- Workflow Codemagic `exposure-ios-native` untuk build iOS unsigned, serta dependency lockfiles.

Implementasi ini belum diverifikasi melalui build iOS atau perangkat asli.
Kernel exposure belum menggantikan sistem film/paper spectral aplikasi web.
Decode dan output resolusi penuh masih menggunakan memori CPU; batas 50 MP
bukan jaminan aplikasi bebas crash pada iPhone.

## Pemeriksaan yang sudah dilakukan

- `npm run typecheck`: lulus.
- `npx vitest run test/nativeExposure.test.ts`: lulus, satu test GPU WGSL.
- Dart formatter: sudah dijalankan.
- Flutter analyze: empat lint `curly_braces_in_flow_control_structures` pada `mobile/lib/main.dart` (baris 55, 95, 112, 119 saat catatan dibuat).
- Flutter test: belum dijalankan karena rangkaian command berhenti setelah analyze.
- Rust test: terhenti pada dependency Windows karena `dlltool.exe` tidak tersedia; source engine belum berhasil diperiksa compiler.
- Swift, XCFramework, build iOS, dan pengujian iPhone: belum dilakukan.

## Urutan pekerjaan berikutnya

1. Perbaiki empat lint Flutter, lalu jalankan `flutter analyze` dan `flutter test` dari `mobile/`.
2. Hubungkan repository GitHub ke Codemagic dan jalankan workflow unsigned. Perbaiki kegagalan Rust, Swift, Swift Package Manager, atau XCFramework sampai build hijau.
3. Konfirmasi keanggotaan Apple Developer aktif dan bundle ID produksi. ID sementara yang dihasilkan adalah `com.nathanaellbc.exposureIos`.
4. Buat aplikasi App Store Connect, konfigurasi signing lewat integrasi aman Codemagic, lalu tambahkan workflow `flutter build ipa --release` untuk TestFlight. Jangan simpan credential di repository. Artifact unsigned saat ini belum bisa dipasang ke iPhone.
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
