# DICHROIC — Desain

**Tanggal:** 2026-09-11
**Status:** Disetujui untuk masuk ke rencana implementasi
**Lisensi karya ini:** GPL-3.0 (turunan dari `spektrafilm-ofx`)

---

## 1. Ringkasan

DICHROIC adalah aplikasi web yang menjalankan pipeline simulasi film spektral
dari SpektraFilm karya Andrea Volpato di dalam browser, di atas WebGPU. Dua
repositori hulu dipakai bersama: [`andreavolpato/spektrafilm`](https://github.com/andreavolpato/spektrafilm)
sebagai implementasi referensi dan oracle verifikasi, dan
[`chaert-s/spektrafilm-ofx`](https://github.com/chaert-s/spektrafilm-ofx)
sebagai rujukan struktur kernel GPU dan alat bake. Ia menerima satu gambar
diam, membawanya melalui sembilan tahap pemrosesan spektral, dan mengeluarkan
gambar jadi **atau** LUT `.cube` yang bisa dibawa kembali ke DaVinci Resolve,
Premiere, atau NLE lain.

Ia adalah aplikasi saudara dari EMULSION, bukan penggantinya. EMULSION
mengimplementasikan model fisik dari `main.tex`; DICHROIC mengimplementasikan
model spektral spektrafilm. Keduanya hidup di repositori yang sama tetapi tidak
berbagi satu baris kode pun.

### Apa yang dikerjakan untuk pengguna

1. Jatuhkan RAW / JPEG / TIFF / EXR.
2. Pilih mode proses, stock film, kertas print, dan setel parameter.
3. Ekspor gambar 16-bit, **atau** ekspor `.cube` 65³ untuk dipakai di NLE.

### Apa yang bukan

Bukan pemroses video, bukan editor timeline, bukan rilisan resmi SpektraFilm.

---

## 2. Aturan tetap proyek

**Kualitas gambar didahulukan di atas performa.** Kapan pun ada dua opsi dan
salah satunya menghasilkan gambar lebih baik, ambil yang lebih baik — ukuran
unduhan, VRAM, dan waktu render boleh dikorbankan.

Satu kualifikasi penting: di proyek ini "lebih baik" berarti **lebih setia
pada implementasi referensi**, bukan lebih halus secara teori. Ketika
spektrafilm memakai aproksimasi (misalnya blur piramida di stage Diffusion),
kita menirunya persis. Menyimpang ke sesuatu yang lebih "benar" akan mengubah
look dan membatalkan parity, yang merupakan satu-satunya ukuran kebenaran yang
kita punya.

---

## 3. Penempatan dan batas lisensi

```
D:\Projects\EMULSION\
├── web/          EMULSION — tidak disentuh, tetap tanpa lisensi
└── spektra/      DICHROIC — GPL-3.0
```

`spektra/` memiliki `package.json`, `LICENSE`, `README.md`, dan toolchain
sendiri. Ia **bukan** npm workspace bersama `web/`.

Dua batas dijaga secara mekanis, bukan dengan disiplin:

1. `package.json` terpisah — tidak ada `node_modules` bersama yang bisa
   menyeret kode antar proyek.
2. Aturan ESLint `no-restricted-imports` yang melarang path apa pun yang
   keluar dari `spektra/`, dan sebaliknya di `web/`. Dilanggar = build gagal.

`spektra/README.md` wajib menyatakan: karya turunan dari `spektrafilm-ofx`,
tautan ke repo asal, dan salinan `THIRD_PARTY_NOTICES.txt` mereka. Blok
`metadata.license`, `metadata.citation`, dan `metadata.datasource` di tiap
profil film ikut disalin ke aset ter-bake dan ditampilkan di UI pemilih stock.

Dialog ekspor `.cube` mencantumkan batasan `SPEKTRAFILM_OFX_LUT_LICENSE.txt`:
LUT hasil boleh dipakai di proyek apa pun termasuk komersial, tetapi tidak
boleh dijual, dijual-ulang, disublisensikan, atau dikemas ulang sebagai produk
LUT.

---

## 4. Arsitektur

### 4.1 Lima modul

| Modul | Tanggung jawab | Bergantung pada | Dapat diuji tanpa |
|---|---|---|---|
| `host/` | Port fungsi CPU dari `SpektraVulkanRenderer.cpp` ke TypeScript murni. Menyiapkan matriks, tabel, dan respons illuminant yang berubah saat parameter berubah. | tidak ada | GPU, DOM |
| `engine/` | Memiliki WebGPU. Menyusun dan menjalankan graf sembilan tahap. | `host/` | UI, format berkas |
| `profiles/` | Memuat dan memvalidasi aset stock ter-bake. | tidak ada | GPU, DOM |
| `io/` | Decode RAW/JPEG/TIFF/EXR → linear f32; encode keluaran; tulis `.cube`. | tidak ada | GPU |
| `ui/` | React. Berbicara hanya kepada satu facade `Session`. | facade | GPU (engine tiruan) |

`host/` adalah TypeScript murni tanpa akses GPU dan tanpa DOM. Itu bukan
kerapian gaya: konsekuensinya setiap fungsi di dalamnya dapat diadu langsung
dengan keluaran `generate_profile_curves.py` di unit test biasa. Di situlah
kesalahan spektral akan bersembunyi, dan di situ pula paling murah ditangkap.

Kontrak `engine/`: piksel masuk, buffer arena dari `host/`, `CoreParams` masuk;
piksel keluar. Ia tidak tahu apa itu berkas, tidak tahu apa itu React.

Facade `Session` adalah satu-satunya permukaan yang dilihat UI. Ia memiliki
gambar yang sedang dibuka, `RenderParams` saat ini, antrean render, dan cache
hasil. Semua interaksi UI melewatinya.

### 4.2 Graf render — sembilan tahap

```
FormatConvert
   └→ FilmExposure       RGB → eksposur raw spektral (Hanatos2026 / Mallett2019)
      └→ CurveDevelop    log raw → densitas film CMY, kurva 256 titik, push/pull
         └→ Dir          inhibisi DIR coupler, matriks crosstalk 9-gamma
            └→ Halation  hamburan lapisan antihalation
               └→ Grain  Poisson terfilter (Preview / ProductionLayers / Synthesis)
                  └→ Diffusion [kamera]
                     └→ PrintScan     enlarger + kertas + scan (1.488 baris)
                        └→ Diffusion [print]
                           └→ ScannerPost   unsharp + encode ke colour space keluaran
```

`Diffusion` adalah satu shader yang disisipkan pada **dua** titik dengan
parameter berbeda — difusi lensa kamera dan difusi sisi print. Parity case
mereka memisahkan keduanya (`camera_diffusion_final`, `print_diffusion_final`),
jadi graf ini bukan rantai lurus dan tidak boleh diperlakukan sebagai rantai
lurus.

Semua buffer antar tahap adalah storage buffer `vec4<f32>`, ping-pong A→B.

Batas antar tahap diberi nama mengikuti tap kanonis implementasi referensi
Python (`rgb_in`, `rgb_pre`, `log_e_film`, `cmy_film`, `log_e_print`,
`cmy_print`, `rgb_out`; lihat §6.3). Tiap tap dapat di-collect, sehingga
gerbang verifikasi per-tahap menjadi sifat bawaan arsitektur.

### 4.3 Dua penyesuaian WebGPU

**`push_constant` tidak ada di WebGPU.** Kesepuluh shader Vulkan memakainya.
Delapan dari sepuluh memakai blok `CoreParams` 26-field yang identik (`width`,
`height`, `tileOriginX/Y`, `activeOriginX/Y`, `activeWidth/Height`,
`fullWidth/Height`, `filmExposureEv`, `filmGamma`, `exposureCount`,
`inputColorSpace`, `rgbToRawMethod`, `colorSpaceCount`, `transferLutSize`,
`colorDecodeMin/Max`, `hanatosWidth/Height`, `filmPushPullMode`,
`filmPushPullStops`, dan tiga field padding yang dipakai sebagai bitfield flag).

Penyelesaian: satu struct WGSL bersama di `engine/params.ts`, satu uniform
buffer, ditulis ulang per-dispatch. `Copy` dan `FormatConvert` yang hanya
memerlukan dua field tetap memakai struct yang sama — membuang 24 field yang
tak terpakai lebih murah daripada memelihara dua jalur binding.

Catatan penting, diukur di Task 7: **ketiga field `_pad0`/`_pad1`/`_pad2`
bukan padding.** Mereka slot serbaguna yang maknanya berbeda per tahap, dan host
mengisinya berbeda tiap dispatch (`SpektraVulkanRenderer.cpp:6272-6274`:
`_pad0 = operation; _pad1 = sigmaMode; _pad2 = component`).

| Shader | slot0 (pos 14) | slot1 (pos 15) | slot2 (pos 16) |
|---|---|---|---|
| CurveDevelop | `_pad0` | `_pad1` (bitfield colour-adaptation) | `_pad2` |
| Diffusion | `operation` | `componentIndex` | `_pad2` (packed: groupCount + downsampleScale) |
| Dir | `operation` | `component` | `_pad2` |
| FilmExposure | `_pad0` (flag `== 1u`) | `_pad1` (bitfield colour-adaptation) | `_pad2` (selektor source-index) |
| Grain | `operation` | `_pad1` | `_pad2` |
| Halation | `operation` | `sigmaMode` | `component` |
| PrintScan | `_pad0` | `_pad1` | `_pad2` |
| ScannerPost | `operation` | `_pad1` | `_pad2` |

Tabel di atas diukur dari kedelapan shader yang berbagi blok ini, bukan tiga.
Perhatikan bahwa **hulu sendiri tidak sepakat dengan dirinya soal nama slot ini**
— slot0 disebut `operation` di lima shader dan dibiarkan `_pad0` di tiga, dan
slot1 berganti nama empat kali. Itu justru alasan struct kita memakai nama
netral: nama semantik apa pun akan benar di sebagian tahap dan menyesatkan di
sisanya.

Koreksi atas koreksi: versi sebelumnya dokumen ini mengatribusikan `sigmaMode`
ke Diffusion. Itu salah — `sigmaMode` adalah nama slot1 milik **Halation**, dan
baris `SpektraVulkanRenderer.cpp:6271-6274` yang dikutip berada di dalam lambda
`dispatchHalation`. Diffusion menamai slot1-nya `componentIndex`.

Ketiganya dipertahankan sebagai field terpisah dengan nama netral. Memberi satu
nama semantik akan menjadi dusta di dua dari tiga tahap, dan meleburkannya jadi
satu bitfield akan menghapus dua slot — dispatcher operasi Diffusion sepenuhnya
dikendalikan `_pad0` dan `_pad2`, jadi kehilangan itu akan membuat tahap tersebut
tidak dapat dibangun sama sekali.

Karena itu struct berisi **26 field**, dan blok uniform-nya **112 byte**
(`ceil(26 × 4 / 16) × 16`).

**Batas storage buffer.** WebGPU menjamin hanya 8 storage buffer per stage.
`SpektraPrintScan` memakai 30, `SpektraGrain` 13, `SpektraDiffusion` 9.

Penyelesaian: kelompokkan tabel read-only menjadi buffer arena menurut *kapan
isinya berubah*, dan akses dengan konstanta offset.

| Arena | Isi | Dibangun ulang |
|---|---|---|
| `static` | CMF pengamat standar, illuminant Th-KG3, matriks Mallett, LUT decode/encode warna, `ColorTransferKinds`, `AcademyPrinterDensityData`, matriks input→XYZ referensi | sekali, saat muat |
| `stock` | Kurva densitas film dan kertas, `channel_density`, `base_density`, `log_sensitivity`, layer maxima | saat stock berganti |
| `dynamic` | `FilteredEnlargerResponse`, `HanatosRawResponse` / `PaperHanatosResponse` / `PreflashPaperHanatosResponse`, `CustomEnlargerFilters`, `NeutralPrintFilters`, `ScanProducts`, `FilmScanToOutputRgb`, `PaperScanToOutputRgb` | saat parameter berubah (debounce) |

`SpektraPrintScan` menjadi enam binding: `source`, `dest`, `frameState`,
`static`, `stock`, `dynamic`. Di bawah batas terjamin, tanpa perlu
menegosiasikan limit adapter yang mungkin tidak tersedia. Grain dan Diffusion
turun dengan cara yang sama, dengan tambahan buffer scratch yang memang
dibutuhkan (`AuxPixelsA/B`, `MicroPixelsA/B`, `GrainLayerA/B` untuk Grain;
`Temp`, `Accum`, `Downsample*` untuk Diffusion).

Tidak ada penyesuaian lain yang diperlukan. Kesepuluh shader tidak memakai
sampler, tekstur, `barrier()`, memori `shared`, operasi atomik, subgroup, tipe
64-bit, atau `#extension` apa pun. Ia murni storage-buffer in/out — kandidat
port sebaik yang realistis bisa diharapkan.

### 4.3.1 Batas yang terukur

Diukur di Task 6, bukan diasumsikan.

**Compute: muat tanpa sisa.** Kesepuluh shader hulu memakai tepat **256 invokasi
per workgroup** — `32×8×1` untuk delapan di antaranya, `256×1×1` untuk
`SpektraCopy` dan `SpektraFormatConvert`. Keduanya pas di dalam jaminan minimum
WebGPU (`maxComputeInvocationsPerWorkgroup` 256, `maxComputeWorkgroupSizeX` 256)
tanpa kelonggaran sama sekali.

Karena itu **limit compute tidak dinaikkan.** Port ini muat di dalam yang
dijamin, jadi ia berjalan di perangkat WebGPU konforman apa pun. Meminta lebih
menukar jaminan itu dengan ketergantungan pada kemurahan adapter, tanpa imbalan.

**Storage buffer: kebalikannya, dan itu memperkuat rancangan arena.** Adapter
pada mesin pengembangan menawarkan `maxStorageBuffersPerShaderStage` **16**,
sementara `SpektraPrintScan` mengikat **30**. Bahkan pada maksimum adapter ia
tidak muat. Arena packing (§4.3) bukan kehati-hatian — ia wajib.

**Ukuran buffer diminta pada maksimum adapter:** `maxStorageBufferBindingSize`
dan `maxBufferSize` keduanya 2 GiB di mesin ini. Buffer lebih besar berarti
lebih sedikit tile, dan lebih sedikit tile berarti lebih sedikit kesempatan
jahitan pada efek spasial — konsisten dengan aturan §2.

### 4.4 Tiling

`CoreParams` sudah membawa `tileOriginX/Y` dan `activeWidth/Height`, dan
`estimateVulkanTileOverlap()` di `SpektraVulkanRenderer.cpp:1190` menghitung
apron yang dibutuhkan dengan menjumlahkan radius tiap efek spasial yang aktif
(halation, diffusion kamera, diffusion print, grain, unsharp scanner).

Fungsi itu **wajib** di-port persis. Tiling tanpa apron yang benar menghasilkan
jahitan yang terlihat pada efek spasial; tiling dengan apron yang benar tidak
menghasilkan perbedaan piksel sama sekali terhadap render full-frame.

Default: render full-frame. Tiling hanya diaktifkan ketika ukuran buffer yang
dibutuhkan melebihi `maxStorageBufferBindingSize` adapter.

---

## 5. Aset dan proses bake

### 5.1 Temuan yang menentukan

`Resources/data` (12 MB profil + 9,8 MB LUT) **bukan aset runtime**. CMake
hanya menyalin dua berkas turunan ke bundle plugin. Semuanya dilahirkan oleh
`tools/generate_profile_curves.py`, yang memakan 28 profil JSON, CSV filter
optik, dan `irradiance_xy_tc.npy`, lalu menghasilkan:

| Keluaran | Isi |
|---|---|
| `SpektraGeneratedProfileCurves.cpp` | Kurva dan matriks seluruh stock, sebagai literal C++ |
| `SpektraHanatos2025Spectra.f32` | LUT spektral 192×192×81 (2.985.984 float) |
| `SpektraOutputGamutCompression.f32` | Tabel kompresi gamut keluaran |

Catatan cakupan: 28 profil yang dipakai daftar stock plugin (20 film, 8 kertas)
adalah yang kita dukung. `Resources/data/profiles/archive/` berisi 28 profil
tambahan yang tidak diekspos di daftar tersebut — di luar cakupan, dapat
ditambahkan belakangan tanpa perubahan arsitektur.

Konsekuensinya: **derivasi colour-science mereka tidak perlu ditulis ulang.**
Kita menambahkan emitter baru ke skrip mereka yang menulis binary + JSON alih-alih
literal C++. Sekitar 1.300 baris logika spektral — adaptasi kromatik, matriks
OkLab, filter dichroic gabungan, knee Reinhard, jarak ray-polygon untuk
kompresi gamut — diwarisi utuh.

Yang tersisa untuk ditulis ulang di TypeScript hanyalah math host yang berubah
saat pengguna menggeser slider, bukan saat build: `filteredEnlargerIlluminantCpu`,
`remapHanatosResponseForInputGamutCompression`, `compressXyRadial`, dan
sejenisnya. Perkiraan: belasan fungsi, bukan empat puluh.

### 5.2 Payload web

| Aset | Format | Ukuran |
|---|---|---|
| LUT spektral Hanatos | f16 biner, 192×192×81 | 5,695 MB |
| Kurva dan data spektral 28 stock | f32 biner, 23 field per stock | 0,541 MB |
| Tabel global (14: CMF, illuminant, matriks, LUT transfer warna) | f32 biner | 0,825 MB |
| Manifes | JSON | 0,101 MB |
| **Total** | | **7,16 MB** |

Angka ini terukur setelah Task 4 berjalan, menggantikan perkiraan awal ≈6,3 MB
yang dibuat sebelum kontrak aset GPU yang sebenarnya diketahui. Selisihnya
berasal dari `colorDecodeLuts` dan `colorEncodeLuts` — masing-masing 26 colour
space × 4.096 entri — dan dari 21 field spektral per-stock yang tidak
terhitung di perkiraan awal. Lihat `SpektraProfileCurves.h` untuk kontrak
lengkapnya.

Dua keputusan:

**LUT spektral dikirim sebagai f16, dihitung sebagai f32.** Sumbernya memang
f16 — spektrafilm menaikkannya ke f32 saat bake hanya karena itu memudahkan
sisi C++. Mengirim f16 memotong separuh unduhan tanpa kehilangan presisi apa
pun terhadap data aslinya. Di sisi GPU, ekspansi f16→f32 dilakukan sekali saat
muat menjadi storage buffer f32 (11,9 MB VRAM).

Fitur WebGPU `shader-f16` **tidak** dipakai. Memakainya akan menciptakan dua
jalur numerik yang berbeda tergantung dukungan perangkat, dan itu bertentangan
dengan aturan kualitas maupun dengan parity. Satu jalur, f32, selalu.

**Kurva disimpan biner, bukan JSON.** Satu profil = 4.044 float: 207 KB sebagai
JSON teks, 15,8 KB sebagai f32 biner. Tiga belas kali lebih kecil, dan
`fetch` + `new Float32Array(buf)` lebih cepat daripada `JSON.parse`.

Grid 192×192 **tidak** diturunkan ke 128×128 (yang akan memangkas ke 2,5 MB).
Itu menukar 3 MB dengan hilangnya parity.

### 5.3 Pengiriman

Satu bundle, di-precache service worker — aplikasi berjalan penuh offline
setelah kunjungan pertama, seperti EMULSION. LUT spektral 5,7 MB dipisah
sebagai aset tersendiri agar shell UI tampil lebih dulu sementara ia mengalir.
Tidak ada lazy-load di luar itu: LUT tersebut dibutuhkan untuk frame pertama,
bukan untuk fitur lanjutan.

### 5.4 Prasyarat

Dua lingkungan Python dibutuhkan, dan keduanya hanya untuk pengembangan —
bukan untuk menjalankan aplikasi.

**Bake** (`spektrafilm-ofx/tools/generate_profile_curves.py`): `numpy`,
`scipy`, `colour-science`. Pada mesin pengembangan saat ini numpy 2.5.2
tersedia; scipy dan colour-science belum.

**Pembangkitan referensi** (paket `spektrafilm`): tambahan `scikit-image`,
`opt-einsum`, `numba`, `pyfftw`, `OpenImageIO`, `rawpy`, `exiv2`. Beberapa di
antaranya — terutama `OpenImageIO` dan `pyfftw` — sulit dipasang lewat pip di
Windows. Jika demikian, jalankan pembangkitan referensi di WSL atau Docker.
Ini tidak menghambat: referensi dibangkitkan sekali lalu di-commit sebagai
`.f32`, sehingga pengembangan sehari-hari dan CI tidak memerlukan Python sama
sekali.

Keduanya adalah tugas pertama dalam rencana implementasi, secara sengaja. Jika
toolchain ini tidak dapat dijalankan, seluruh strategi harus dipikirkan ulang —
dan itu harus diketahui di hari pertama, bukan di minggu ketiga.

## 6. Verifikasi

### 6.1 Koreksi terhadap asumsi awal

Rancangan awal mengasumsikan 33 parity case di `spektrafilm-ofx` menyediakan
keluaran referensi numerik. **Asumsi itu salah.** Repositori tersebut tidak
memuat satu pun berkas `.exr` atau `.f32`; tiap direktori kasus hanya berisi
`params.txt`, tiga PNG visualisasi 8-bit, dan `diff_exr_notes.json` yang
*mendeskripsikan* berkas diff tanpa memuatnya. `metal_stdout.txt` bahkan masih
menunjuk ke volume lokal penulisnya (`/Volumes/Discordia/...`).

### 6.2 Oracle sebenarnya

`tools/run_parity_harness.py` mengimpor `spektrafilm.runtime.pipeline.SimulationPipeline`
dan **membangkitkan referensi saat dijalankan**, bukan membacanya dari berkas.
Paket itu ada secara publik di
[`andreavolpato/spektrafilm`](https://github.com/andreavolpato/spektrafilm),
GPL-3.0, ~9.800 baris Python:

- `spektrafilm/model/` — `color_filters`, `couplers`, `density_curves`,
  `develop`, `diffusion`, `glare`, `grain`, `illuminants`, `parametric`, `stocks`
- `spektrafilm/runtime/stages/` — `filming`, `printing`, `scanning`
- `spektrafilm/runtime/topology.py` — dispatcher berbasis tap
- `spektrafilm/data/` — 28 profil dan LUT yang sama

Ini lebih baik daripada 33 kasus beku dalam tiga hal:

1. **Regenerable.** Referensi dapat dihasilkan untuk input apa pun, pada tap
   mana pun, dengan presisi f64 — bukan delapan titik sadap yang sudah
   ditentukan orang lain.
2. **Terbaca.** Model dalam NumPy jauh lebih mudah dibaca daripada GLSL.
   Transliterasi dilakukan dengan dua pandangan atas matematika yang sama:
   Python untuk *apa* yang dihitung, GLSL Vulkan untuk *bagaimana* ia disusun
   di GPU. Itu memangkas risiko salah baca GLSL secara drastis.
3. **QA bawaan.** `spektrafilm_lut_creator/qa/` berisi uji bake LUT dan emisi
   OCIO milik penulisnya — rujukan langsung untuk fitur ekspor `.cube` kita.

### 6.3 Tap

`runtime/topology.py` mendefinisikan tujuh tap kanonis:

```
rgb_in → rgb_pre → log_e_film → cmy_film → log_e_print → cmy_print → rgb_out
```

Engine DICHROIC **mencerminkan nama tap yang sama**, dan setiap tap dapat
di-collect. Akibatnya gerbang per-tahap menjadi sifat bawaan arsitektur, bukan
sesuatu yang ditempelkan untuk keperluan pengujian.

### 6.3.2 Satu tap TIDAK sama dengan satu tahap GPU

Tujuh nama tap di atas benar, tetapi asumsi tersembunyi di bawahnya salah, dan
Task 11 menabraknya: **satu tap Python tidak memetakan satu-ke-satu ke satu
shader compute hulu.**

`FilmingStage.expose()` (`runtime/stages/filming.py:52-71`) memanggil, dalam
satu fungsi, sebelum `log10` yang menghasilkan `log_e_film`:

```
_rgb_to_film_raw → *2**exposure_compensation_ev → boost_highlights
  → apply_diffusion_filter_um → apply_gaussian_blur_um → apply_halation_um
  → *black_white_filming_exposure_correction → log10
```

Empat dari langkah itu **spasial** (konvolusi), dan hulu memisahkannya ke shader
Vulkan-nya sendiri: `SpektraFilmExposure.comp` (263 baris) tidak punya kode
halation sama sekali; `SpektraHalation.comp` adalah 322 baris terpisah. Jadi
`log_e_film` yang dibangkitkan Python **tidak bisa** direproduksi oleh tahap
FilmExposure sendirian, apa pun benarnya port itu. Task 11 mengukur residual
seragam 3.41e-5 lintas ketiga kasus dan mengonfirmasinya dengan A/B di Python:
halation-off versus fixture yang sudah dikomit memberi 3.397e-5 maks / 3.040e-5
rata-rata — cocok dengan residual gerbangnya.

Ini bukan kabar buruk, karena hulu sudah menyediakan jawabannya.

### 6.3.3 Keluarga fixture: `lut_mode` adalah regime yang kita kapalkan

`DebugParams` (`runtime/params_schema.py:197-205`) punya TIGA saklar, bukan
satu, dan kita baru memakai satu:

| Saklar | Yang dimatikan |
|---|---|
| `deactivate_stochastic_effects` | `grain.active`, `glare.active` — hanya itu |
| `deactivate_spatial_effects` | halation (flag + sigma), `dir_couplers.diffusion_size_um`, semua lens blur, diffusion filter, unsharp |
| `lut_mode` | mempromosikan KEDUANYA, plus `auto_exposure`, `exposure_compensation_ev`, `halation.boost_ev`, dan koreksi white/black/unsharp scanner |

`deactivate_stochastic_effects` — satu-satunya yang dipakai Task 3 — **tidak
menyentuh halation**, dan itulah kenapa fixture "deterministik" kita tetap
mengandung efek spasial.

Keputusan: gerbang per-piksel (Task 11, 12, 13, 17, 18) diukur terhadap
keluarga fixture `lut_mode`; tahap spasial (halation Task 14, diffusion Task 15)
dan stokastik (grain Task 16) diukur di tapnya sendiri terhadap keluarga yang
efeknya HIDUP. Tidak ada yang dilewatkan — halation tetap diverifikasi, hanya
tidak di gerbang yang tidak mengimplementasikannya.

Dan `lut_mode` bukan konsesi supaya gerbang lulus. Produk DICHROIC adalah foto
plus ekspor LUT `.cube`; `lut_mode` adalah deskripsi hulu sendiri tentang
"pipeline sebagai transform per-piksel deterministik yang layak di-sample LUT".
Itu **persis regime yang jalur LUT kita harus reproduksi**. Komentar hulu di
`params_builder.py:105-114` bahkan menjelaskan kenapa `boost_ev` harus mati di
`lut_mode`: ia menormalkan dengan `np.max(x)` seluruh gambar, jadi tidak bisa
diwakili LUT 3D statis. Alasan yang sama berlaku untuk auto-exposure — dan
emulasi auto-exposure CPU yang Task 11 tulis (`measureAutoExposureEv` di
`test/parity/params.ts`) menjadi tidak perlu untuk keluarga ini. Kode itu tetap
disimpan, bukan dihapus: keluarga non-`lut_mode` di Task 14-16 masih
membutuhkannya.

### 6.3.1 Ketika hulu tidak sepakat dengan dirinya sendiri: Python yang menang

Ditemukan saat Task 11 buntu, dan ini mengoreksi asumsi verifikasi kita.

Task 4 memvalidasi setiap tabel yang dipancarkan terhadap literal C++ hulu, dan
seluruhnya lulus. Tetapi **oracle kita adalah Python**, dan di satu tempat kedua
sisi hulu berbeda: `tools/generate_profile_curves.py:470` mem-bake
`inputToReferenceXyz` dengan `chromatic_adaptation_transform="CAT02"`, sementara
runtime Python (`utils/spectral_upsampling.py:136`) menghitung dengan `'CAT16'`
— dipilih sadar, dengan komentar yang menyebut CAT16 menggantikan
ketidakstabilan cone-primary CAT02 di sekitar biru dan violet.

Terukur, untuk ProPhoto RGB terhadap D55:

| Piksel | Selisih xy, CAT02 vs CAT16 |
|---|---|
| Netral 0,5 | 1,57e-07 |
| Merah jenuh | 1,33e-03 |
| Hijau jenuh | 1,87e-03 |
| Biru jenuh | 5,18e-03 |

Setiap CAT memetakan putih sumber ke putih target menurut definisinya, jadi
netral nyaris tak tersentuh sementara warna jenuh bergeser. Itu persis yang
diamati gerbang `log_e_film` Task 11: akromatik 3,415e-5 versus kromatik
2,702e-2.

**Aturannya, sejak sekarang:** di mana bake C++ hulu dan runtime Python hulu
berbeda, **Python yang menang** — ia yang menghasilkan fixture referensi. Bake
kita mencocoki Python, bukan C++. `compare_cpp.py` (Task 4) tetap berguna
sebagai deteksi divergensi, tetapi kecocokan dengannya bukan bukti kebenaran;
setiap ketidakcocokan terhadap Python adalah cacat kita, dan setiap kecocokan
dengan C++ yang bertentangan dengan Python adalah cacat juga.

### 6.4 Aturan gerbang

Sebuah tahap belum selesai sampai tap keluarannya cocok dengan Python. Nilai
referensi dihasilkan sekali per kasus uji, disimpan sebagai `.f32` di dalam
repo (kecil: kasus uji berukuran 32×16 hingga 256×256), dan dibandingkan di
`vitest`. Membangkitkan ulang memerlukan Python; menjalankan test tidak.

### 6.5 Ambang

| Kelompok tap | Ambang | Metode |
|---|---|---|
| `rgb_pre`, `log_e_film`, `cmy_film`, `log_e_print`, `cmy_print`, `rgb_out` (pra-grain) | max abs error ≤ 1e-5 | per piksel |
| Pasca-grain | ≤ 1e-4 | statistik: mean, varians, spektrum daya, seed identik |

**Ambang tidak boleh dilonggarkan untuk membuat test lulus.** Python menghitung
dalam f64 dan kita dalam f32, jadi selisih di orde 1e-7 wajar. Meleset di orde
1e-3 berarti ada perbedaan struktural — urutan operasi, konvensi matriks baris
versus kolom, atau interpolasi yang keliru. Itu harus ditemukan, bukan
ditoleransi.

### 6.6 Harness

Pembangkitan referensi: skrip Python yang memanggil `SimulationPipeline` dengan
`collect=<tap>` dan menulis `.f32` mentah beserta `params.json`.

Perbandingan: `vitest` di Node, WebGPU lewat paket `webgpu` (Dawn). Bagian dari
`npm test`, bukan langkah manual. Cadangan jika Dawn bermasalah di Windows:
harness Playwright headless — Playwright sudah terpasang di repo ini.

## 7. Default di bawah aturan kualitas

| Keputusan | Default | Yang dikorbankan |
|---|---|---|
| Presisi komputasi | f32 di seluruh rantai | VRAM, bandwidth |
| LUT spektral | grid 192×192×81 penuh | 3 MB unduhan |
| Render | full-frame; tiling hanya saat VRAM tak cukup, dengan apron | waktu render |
| Model grain | `ProductionLayers` | kecepatan pratinjau |
| Ekspor gambar | 16-bit PNG/TIFF (8-bit tersedia) | ukuran berkas |
| Ekspor LUT | 65³ (33³ tersedia) | ukuran `.cube` |
| Interpolasi kurva | pencarian biner eksak seperti shader mereka | sedikit ALU |

### 7.1 Pratinjau interaktif

Kualitas-dulu bertabrakan dengan responsivitas slider. Jalan keluarnya bukan
menurunkan kualitas keluaran, melainkan memisahkan dua render:

- Saat slider **sedang digeser**: render pada salinan terskala, ditandai jelas
  di UI sebagai pratinjau.
- Saat slider **dilepas**: render presisi penuh otomatis dijalankan dan
  menggantikan pratinjau.

Gambar yang dilihat pengguna dalam keadaan diam selalu render penuh.

### 7.2 Ekspor LUT

`.cube` 3D memetakan warna per-piksel dan karenanya **secara prinsip tidak
dapat membawa grain, halation, atau diffusion** — ketiganya spasial.
`SpektraFilmPlugin.cpp` sudah menangani ini dengan mencatat `disabledEffects`
di header berkas. Kita mengikuti persis: efek spasial dinonaktifkan saat render
kubus, dan daftarnya ditulis sebagai komentar di `.cube` agar pengguna tahu apa
yang tidak ikut.

Mekanismenya sama dengan render biasa: kubus identitas `size³` diumpankan
sebagai "frame" ke chain yang sama, hasilnya dibaca balik dan diformat. Tidak
ada jalur kode kedua.

---

## 8. Permukaan UI

Engine dikerjakan lebih dulu dan berjalan headless sampai lulus parity. UI
dirancang setelahnya. Alasannya bukan kerapian urutan kerja: `RenderParams`
memiliki sekitar 150 field, dan makna sebagian besar darinya baru benar-benar
terbaca setelah tahapnya berjalan. Merancang panel untuk
`dirCouplersDiffusionTailWeight` sebelum mengetahui apa yang ia lakukan pada
gambar adalah menebak.

Desain visual DICHROIC dirancang dari nol, bukan menyalin EMULSION.

Yang sudah pasti tentang permukaannya, dari `SpektraParameters.h`:

- **Mode proses** — `PrintSimulation`, `ScanNegative`, `ProcessNegative`.
  Ini pilihan tertinggi, bukan sekadar setelan: ia mengubah arti semua yang di
  bawahnya.
- **Pemilihan stock** — 20 film negatif/reversal dan 8 kertas/print film, dengan
  pasangan `target_print` yang sudah tertulis di tiap profil (Portra 400 →
  Portra Endura) sebagai default.
- **Kelompok parameter** — Input/Output colour space (26 opsi) · Exposure dan
  push-pull · DIR coupler (9 gamma, difusi 20 µm dengan ekor 200 µm) · Halation ·
  Grain (3 model) · Enlarger (filter CMY, printer lights, preflash, scale dan
  offset) · Diffusion filter (Glimmerglass, BlackProMist, ProMist, CineBloom) ·
  Scanner post · Keluaran HDR (PQ/HLG, referensi white nits, peak nits, tone
  mapping).
- **Teks bantuan** — `src/SpektraTooltips.h` (191 baris) berisi deskripsi tiap
  parameter dari penulis aslinya. Itu dipakai langsung sebagai teks bantuan UI.

---

## 9. Urutan pengerjaan

Pekerjaan ini terlalu besar untuk satu rencana implementasi dan dipecah menjadi
dua fase. Tiap fase mendapat rencananya sendiri; fase kedua tidak direncanakan
sampai fase pertama selesai, karena semantik parameter baru benar-benar
terbaca setelah engine berjalan.

### Fase 1 — Engine terverifikasi (langkah 1–13)

Keluaran: engine headless yang lulus seluruh 33 parity case. Belum ada UI,
belum ada berkas masuk atau keluar. Tiap tahap divalidasi terhadap tap
parity-nya sebelum tahap berikutnya disentuh.

1. **Prasyarat toolchain** — pasang kedua lingkungan Python (§5.4); jalankan `generate_profile_curves.py` dan `SimulationPipeline` — pasang scipy dan colour-science; jalankan
   `generate_profile_curves.py` apa adanya sampai berhasil menghasilkan
   keluaran C++ mereka. Membuktikan toolchain sebelum apa pun dibangun.
2. **Emitter web** — tambahkan keluaran binary/JSON ke skrip bake. Verifikasi
   nilai yang dipancarkan identik dengan literal C++ mereka.
3. **Kerangka engine** — device WebGPU, negosiasi limit, `CoreParams`, packing
   arena, graf ping-pong, `FormatConvert` dan `Copy`.
4. **Harness parity** — jalankan di Node dengan tap yang masih kosong.
   Infrastruktur verifikasi ada sebelum ada yang perlu diverifikasi.
5. **FilmExposure** → gerbang `film_log_raw`
6. **CurveDevelop** → gerbang `film_density_cmy`
7. **Dir**
8. **Halation** → gerbang `halation_final`
9. **Diffusion** → gerbang `camera_diffusion_final`
10. **Grain** (gerbang statistik)
11. **PrintScan** → gerbang `print_log_raw`, `print_density_cmy`
12. **ScannerPost** → gerbang `final_linear_rgb`
13. **Tiling + apron** — verifikasi nol perbedaan piksel terhadap full-frame

### Fase 2 — Aplikasi (langkah 14–16)

Keluaran: aplikasi web yang bisa dipakai. Direncanakan setelah Fase 1 selesai.

14. **`io/`** — decode, encode, ekspor `.cube`
15. **UI** — dirancang dari nol
16. **PWA** — service worker, precache, manifest

---

## 10. Risiko

| Risiko | Penanganan |
|---|---|
| `colour-science` gagal dipasang di Windows | Tugas nomor satu. Jika gagal: bake di WSL atau Docker, atau (paling mahal) port derivasinya ke TypeScript. |
| `OpenImageIO` / `pyfftw` gagal dipasang di Windows | Bangkitkan referensi di WSL atau Docker. Hasilnya di-commit sebagai `.f32`, jadi CI dan pengembangan harian tidak butuh Python. |
| WebGPU di Node (Dawn) tidak stabil di Windows | Cadangan harness Playwright headless; Playwright sudah terpasang di repo ini. |
| Divergensi numerik tak terlacak di tahap lanjut | Gerbang per-tahap membuat ini hampir mustahil menumpuk. Itu seluruh alasan pendekatan ini dipilih. |
| Konvensi matriks GLSL versus WGSL (baris/kolom) | Sumber kesalahan paling mungkin. Diperiksa pertama kali setiap kali sebuah tap meleset. |
| `maxStorageBufferBindingSize` adapter lebih kecil dari gambar besar | Tiling dengan apron, sudah dirancang. |
| Perangkat tanpa WebGPU | Tidak ada fallback. Aplikasi menampilkan pesan yang jelas beserta daftar browser yang didukung. Ini keputusan sadar, bukan kelalaian. |
