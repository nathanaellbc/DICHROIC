# Coba native iOS dari Windows tanpa membership berbayar

Keputusan saat ini: pengguna memakai Windows dan tidak ingin membeli Apple
Developer Program. Build source dan pengujian Metal tetap berjalan di runner
macOS GitHub/Codemagic. Tidak ada workflow TestFlight yang diaktifkan.

## Build yang dapat diambil

Di GitHub Actions, buka workflow **Native iOS build**, pilih run hijau terbaru,
dan download artifact **dichroic-ios-unsigned-ipa**. Ekstrak ZIP artifact untuk
mendapatkan `Exposure-unsigned.ipa`. Codemagic juga menghasilkan file ini dari
workflow `exposure-ios-native`.

IPA ini belum ditandatangani. File tersebut tidak dapat langsung dibuka untuk
menginstal aplikasi di iPhone; alat sideload perlu menandatanganinya dahulu.
Artifact simulator hanya untuk simulator di Mac, bukan iPhone.

## Instalasi pribadi lewat AltStore Classic

1. Ikuti [panduan Windows resmi AltStore](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows)
   untuk memasang AltServer, iTunes/iCloud yang kompatibel, dan AltStore Classic.
2. Hubungkan iPhone ke Windows, pilih Trust jika diminta, lalu pasang AltStore
   lewat menu AltServer. Lakukan login Apple Account sendiri di aplikasi alat
   sideload tersebut. Source dan pipeline cloud tidak memerlukan kredensial akun.
3. Pindahkan `Exposure-unsigned.ipa` ke Files di iPhone. Buka AltStore Classic,
   masuk ke My Apps, tekan `+`, lalu pilih IPA itu.
4. Ikuti instruksi Trust/Developer Mode yang ditampilkan iPhone dan AltStore.
   AltServer harus tersedia ketika proses signing/install memerlukannya.
5. Dengan akun gratis, refresh aplikasi sebelum masa 7 harinya habis. Periksa
   tanggal kedaluwarsa di My Apps. AltStore menjelaskan batas aplikasi aktif
   pada [Activating Apps](https://faq.altstore.io/altstore-classic/activating-apps).

Panduan ini mengikuti kemampuan alat yang didokumentasikan; instalasi Exposure
lewat AltStore pada perangkat pengguna belum diverifikasi. Bila gagal, catat
pesan error dan versi iOS/AltServer agar penyebabnya dapat diperiksa.

## Alternatif jika nanti tersedia Mac

Apple mendukung pengujian pribadi dengan Apple Account gratis dan **Personal
Team** di Xcode. [Perbandingan membership Apple](https://developer.apple.com/support/compare-memberships/)
menjelaskan masa 7 hari provisioning gratis. Dari checkout bersih pada Mac:

```sh
rustup default 1.85.0
bash mobile/scripts/build_native.sh
bash mobile/scripts/prepare_ios.sh
open mobile/ios/Runner.xcworkspace
```

Toolchain Flutter 3.44.0, Rust dan Xcode diperlukan. Pilih Personal Team pada
Signing & Capabilities, hubungkan iPhone, lalu Run. Untuk bundle ID pribadi,
jalankan prepare dengan `IOS_BUNDLE_ID=com.nama.exposure` sebelum membuka Xcode.

## Cakupan aplikasi saat ini

Aplikasi masih berupa port bertahap: pilih foto, exposure, preview texture,
pinch/drag elastis, before/after asli, dan export PNG. Shader kurva densitas asli
sedang divalidasi secara terpisah; film/paper lengkap, efek spasial, RAW, erase,
dan seluruh UI belum tersedia. Jangan gunakan keberhasilan build atau signing
sebagai bukti bahwa port atau pengujian crash di iPhone sudah selesai.
