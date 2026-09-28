# DICHROIC Fase 2 (inti, sebelum UI) — Desain

Tanggal: 2026-09-28. Melanjutkan `2026-09-11-dichroic-design.md` (§9, Fase 2).
Dokumen ini hanya mencakup bagian Fase 2 **sebelum** UI. UI dirancang dari
dokumen desain dan panduan visual yang diberikan pemilik proyek, dan tidak
dimulai sebelum titik henti di §8.

---

## 1. Tujuan dan titik henti

Keluaran: sebuah facade `Session` headless yang bisa membuka gambar nyata
(JPEG/PNG/TIFF/EXR/RAW), merendernya dengan sekumpulan parameter yang
**semuanya digerbangi parity**, mengekspor gambar 16-bit, dan mengekspor
`.cube`. UI nanti hanya berbicara dengan `Session`.

Syarat berhasil:

- Seluruh gerbang Fase 1 tetap hijau, sekarang lewat rantai produksi di
  `src/`, bukan rakitan di `test/`.
- Setiap parameter yang bisa diubah lewat `Session` punya gerbang parity
  terhadap Python pada nilai non-default. Ambang tidak dilonggarkan.
- Parameter yang belum digerbangi **tidak bisa** diubah: `Session` menolak
  dengan galat keras, bukan diam-diam memakai default.

Keputusan pemilik proyek (2026-09-28): parameter dibuka **bertahap**;
**semua** format input termasuk RAW; model parameter mencerminkan
`RenderParams` OFX; `Session` berjalan di Web Worker.

---

## 2. Temuan yang membentuk desain

1. **Rantai produksi belum ada di `src/`.** Urutan 11 tahap (`fullChain`) dan
   pembangun `CoreParams` beserta auto-exposure (`defaultCoreParams`,
   `measureAutoExposureEv`) hidup di `test/parity/`. `Session` membutuhkan
   keduanya, jadi keduanya dipindah ke `src/` dan test mengimpor dari sana.
2. **Engine terverifikasi hanya di konfigurasi default Python.** DIR, filter
   difusi, halation, grain, preflash, dan unsharp dikunci di
   `precomputeArenaData` atau di konstanta tahap. Input dikunci ke
   ProPhoto RGB tanpa decode CCTF (`decodeInputRgb` adalah identitas),
   output dikunci ke sRGB.
3. **PSF difusi dibakukan pada ukuran piksel fixture.**
   `CAMERA_DIFFUSION_PIXEL_SIZE_UM = 546.875` (35 mm / 64 px). Halation, DIR,
   dan grain sudah menghitung ukuran piksel per render dari `fullWidth/Height`;
   difusi belum. Di gambar 6000 px ukuran piksel sebenarnya sekitar 5,8 µm,
   jadi PSF harus dihitung per ukuran gambar sebelum difusi bisa dibuka.
4. **`.cube` bisa memakai jalur yang sudah terverifikasi.** Kubus tidak boleh
   bergantung pada isi gambar dan tidak bisa membawa efek spasial. Itu
   persis semantik `debug.lut_mode` Python: auto-exposure mati, efek spasial
   dan stokastik mati. Keluarga fixture `_lut` sudah digerbangi sampai
   `rgb_out` di Fase 1. Kubus dirender lewat rantai `_lut` yang sama.
5. **Decode RAW hulu** (`spektrafilm/utils/raw_file_processor.py`):
   `rawpy.postprocess(output_color=ACES, output_bps=16, no_auto_bright=True,
   gamma=(1,1), use_camera_wb=True)`, dibagi 65535. Hasilnya ACES2065-1 linear.
   LibRaw-WASM dengan setelan yang sama memberi oracle yang setara.
6. **Model grain.** Python hanya punya satu model grain (lapisan produksi).
   `Preview` dan `GrainSynthesis` di OFX tidak punya oracle Python, jadi
   **tidak dibuka** di fase ini.
7. **Stock reversal** (`ektachrome_100`, `kodachrome_64`, `velvia_100`,
   `provia_100f`) tidak masuk rantai print di `PrintSimulation`. Keempatnya
   ikut batch parameter 2 bersama mode proses.

8. **(Ditemukan saat eksekusi 2A, Task 6.) Rezim resolusi produksi belum
   di-port.** Semua blur spasial hulu (DIR, halation/scatter, filter difusi,
   glare, grain) memakai `fast_gaussian_filter`, yang beralih dari FIR ke IIR
   Young-van Vliet pada sigma ≥ 3 px (`SMALL_SIGMA_MAX`). Fase 1 hanya
   mem-port jalur FIR, karena semua fixture ≤ 64 px (ukuran piksel sekitar
   550 µm, sigma < 3 px). Di foto sungguhan sigma jauh di atas 3 px:
   `dir.ts` melempar galat di radius > 16, dan tahap lain belum diaudit.
   Engine saat ini hanya benar untuk gambar dengan sisi terpanjang sekitar
   ≤ 500 px. Ini menjadi sub-proyek **2A.5** (§6a) dan wajib selesai sebelum
   `Session` berguna untuk foto nyata.

---

## 3. Struktur modul

```
src/
  engine/         (ada)  + chain.ts              rantai produksi (dari test/parity/chain.ts)
  host/           (ada)  + autoExposure.ts       metering (dari test/parity/params.ts)
  params/         BARU   renderParams.ts         RenderParams (nama OFX) + baseline terverifikasi
                         registry.ts             status per field: verified | locked
                         plan.ts                 RenderParams + gambar -> RenderPlan
  io/             BARU   decoded.ts              tipe DecodedImage
                         jpeg.ts png.ts tiff.ts exr.ts raw.ts   decoder
                         detect.ts               deteksi format dari magic bytes
                         encodePng.ts encodeTiff.ts             encoder
                         cube.ts                 lattice identitas + penulis .cube
  session/        BARU   session.ts              facade Session (tanpa DOM)
                         protocol.ts             tipe pesan RPC
                         worker.ts               entry Web Worker
                         client.ts               proxy bertipe untuk UI
```

Arah dependensi: `session` → `params`, `engine`, `io`, `profiles`, `host`.
`params` → `host`, `profiles`, `engine/params` (tipe saja). `io` tidak
bergantung pada apa pun di proyek selain tipenya sendiri. Test batas lisensi
yang ada tetap berlaku untuk seluruh `src/`.

---

## 4. 2A — Tulang punggung

### 4.1 `RenderParams` dan registri status

`RenderParams` di `src/params/renderParams.ts` memakai **nama field dan
enum dari `SpektraParameters.h`** apa adanya, supaya `SpektraTooltips.h`
nanti bisa dipakai langsung sebagai teks bantuan. Hanya field yang relevan
untuk fase ini yang didefinisikan sekarang. Field lain ditambah saat
batchnya dikerjakan; YAGNI.

**Nilai baseline** (`BASELINE_RENDER_PARAMS`) **bukan** default OFX. Baseline
adalah konfigurasi yang dibuktikan Fase 1: `digest_params(init_params())`
Python, dinyatakan dalam nama OFX. Contoh: `autoExposure = true`,
`inputColorSpace = ProPhotoRgb`, `outputColorSpace = Srgb`,
`film = kodak_portra_400`. Tiap field mencatat padanan Python-nya di komentar.
Stock dirujuk dengan **id string** (`'kodak_portra_400'`), bukan indeks
integer OFX, karena id itulah kunci aset ter-bake.

`registry.ts` memberi tiap field status:

- `verified`: nilai apa pun di rentangnya boleh; ada gerbang parity yang
  menyebut field ini.
- `locked`: hanya nilai baseline yang boleh.

`validateRenderParams(p)` melempar `UnverifiedParameterError` (menyebut nama
field, nilai, dan baseline-nya) untuk setiap field `locked` yang berbeda dari
baseline. Tidak ada jalur yang meneruskan nilai tak terverifikasi ke engine.
Satu test memastikan setiap field `verified` punya setidaknya satu test
parity yang merujuknya lewat penanda `@verifies <field>` di berkas testnya.

### 4.2 `RenderPlan`

`buildRenderPlan(params, bundle, image, mode)` di `src/params/plan.ts` adalah
satu-satunya tempat `RenderParams` diterjemahkan ke engine. Keluarannya:

```ts
interface RenderPlan {
  core: CoreParams;              // termasuk EV auto-exposure yang sudah diukur
  arenaKey: string;              // kunci cache arena (stock, print, filter, ukuran PSF, ...)
  arenaInputs: ArenaInputs;      // argumen untuk precomputeArenaData
  chain: ChainSpec;              // 'measured' | 'lut' + opsi per tahap
  overlap: number;               // apron dari estimateTileOverlap
  disabledEffects: string[];     // untuk header .cube
}
```

`mode` adalah `'image'` (render gambar) atau `'cube'` (render kubus, semantik
`lut_mode`). `defaultCoreParams` dan `measureAutoExposureEv` pindah dari
`test/parity/params.ts` ke `src/host/autoExposure.ts` dan `plan.ts`. Test
parity lama memanggil `buildRenderPlan(BASELINE_RENDER_PARAMS, ...)`, dan
kesetaraan hasilnya dengan `defaultCoreParams` lama dibuktikan field per
field sebelum yang lama dihapus.

### 4.3 Rantai produksi

`src/engine/chain.ts` mengekspor `buildChain(device, arenas, spec)`. Kedua
varian yang sekarang tersebar di test (`fullChain` untuk keluarga measured,
daftar pendek untuk `_lut`) menjadi dua cabang dari satu fungsi. Komentar
panjang soal urutan di `test/parity/chain.ts` ikut pindah. Semua test parity
yang merakit rantai lengkap memakai `buildChain`. Test per tahap yang
sengaja memakai daftar tahap parsial tetap seperti sekarang.

### 4.4 `Session`

`src/session/session.ts`, tanpa DOM, bisa dijalankan langsung di Node:

```ts
class Session {
  static create(opts: { assetsBaseUrl: string }): Promise<Session>;
  open(image: DecodedImage): void;
  setParams(patch: Partial<RenderParams>): void;   // validasi segera, galat keras
  render(quality: 'full' | 'preview'): Promise<RenderResult>;
  exportImage(format: 'png16' | 'png8' | 'tiff16'): Promise<Uint8Array>;
  exportCube(size: 33 | 65): Promise<string>;
  dispose(): void;
}
interface RenderResult {
  width: number; height: number;
  rgb: Float32Array;          // rgb_out, sudah ter-encode di outputColorSpace
  quality: 'full' | 'preview';
  paramsVersion: number;      // untuk membuang hasil basi di UI
}
```

- **Arena di-cache** per `arenaKey`. Arena statis dan per-stock dipakai ulang
  lintas render; hanya bagian yang bergantung parameter yang dibangun ulang.
- **Pratinjau** (§7.1 spec induk): input diperkecil dengan box filter sampai
  sisi terpanjang ≤ 1024 px. Efek yang bergantung ukuran piksel sudah
  menghitungnya dari `fullWidth`, jadi skala fisiknya tetap benar di
  resolusi kecil.
- **Antrean render: yang terbaru menang.** Permintaan baru membatalkan
  permintaan yang belum mulai. Render yang sedang berjalan diselesaikan lalu
  hasilnya dibuang kalau `paramsVersion`-nya sudah basi.
- **Tiling** memakai `run(..., { maxBufferBytes, overlap })` yang sudah ada,
  dengan `maxBufferBytes` dari limit device.
- **Cache hasil**: satu entri terakhir per kualitas, dikunci dengan hash
  `RenderParams` dan identitas gambar.

### 4.5 Worker

`worker.ts` membungkus satu `Session`. `client.ts` mengekspor
`SessionClient` dengan metode yang sama, tetapi berbasis `postMessage`.
Buffer piksel dipindah sebagai transferable, tidak disalin. `protocol.ts`
mendefinisikan union pesan bertipe (`id`, `method`, `args`, dan `result` atau
`error`), dan galat diserialisasi dengan nama kelasnya sehingga
`UnverifiedParameterError` tetap dikenali di sisi UI. Lapisan RPC diuji di
Node dengan `MessageChannel`; `Session` sendiri diuji langsung tanpa worker.

### 4.6 Ekspor `.cube`

`src/io/cube.ts`:

- `identityLattice(size)`: frame berukuran `size² × size` berisi titik
  lattice, R bergerak paling cepat (urutan `.cube`), dalam ruang input yang
  ter-encode, domain `[0,1]`.
- `formatCube(rgb, size, meta)`: `TITLE`, komentar `# DICHROIC <versi>`,
  stock film dan print, colour space input dan output, lalu
  `# disabled effects: ...` dari `RenderPlan.disabledEffects` (§7.2 spec
  induk), `LUT_3D_SIZE`, `DOMAIN_MIN`/`DOMAIN_MAX`, dan baris data dengan 6
  angka desimal.

`Session.exportCube` membangun plan dengan `mode: 'cube'`, merender lattice
lewat rantai `_lut`, lalu memformatnya. Tidak ada jalur kode kedua.

Gerbang:

- (a) Titik lattice yang tepat sama dengan piksel fixture `_lut` memberi hasil
  bit-identik dengan render gambar ber-`mode: 'cube'`.
- (b) Kubus 65³ yang diterapkan dengan trilinear ke input `color_patches_lut`
  cocok dengan `rgb_out` Python di dalam ambang interpolasi yang terukur dan
  tercatat. Ini gerbang informatif; angkanya dicatat, bukan ditebak.

---

## 5. 2B — `io/`

```ts
interface DecodedImage {
  width: number; height: number;
  rgba: Float32Array;                  // 4 kanal, alpha diabaikan engine
  suggestedColorSpace: ColorSpaceLabel; // label manifest, mis. 'sRGB', 'ACES2065-1'
  encoding: 'encoded' | 'linear';
  source: { format: 'jpeg'|'png'|'tiff'|'exr'|'raw'; bitDepth: number; name?: string };
}
```

| Format | Pustaka | Keluaran | Saran colour space |
|---|---|---|---|
| JPEG | decoder sendiri meniru libjpeg-turbo (`jpegDecoder.ts`; semula `jpeg-js`, lihat §5.1) | 8-bit → `[0,1]` ter-encode | `sRGB` |
| PNG | `fast-png` (MIT) | 1/2/4/8/16-bit, gray/RGB(A)/palet → `[0,1]` ter-encode | `sRGB` |
| TIFF | pembaca sendiri (`tiff.ts`) + `fflate` (MIT) untuk Deflate (semula `utif2`, lihat §5.1) | 8/16/32-bit int → ter-encode; float 16/32/64 → linear | `sRGB` untuk int, `Linear Rec.709` untuk float |
| EXR | `parse-exr` (MIT) dengan pagar (`exr.ts`) | half/float → linear | dari atribut `chromaticities` (AP0, AP1, Rec.709, Rec.2020, P3-D65) bila ada; selain itu `Linear Rec.709` |
| RAW | `libraw-wasm` (ISC; LibRaw LGPL-2.1/CDDL) | setelan rawpy §2.5 → linear | `ACES2065-1` |

Semua decoder murni JS/WASM, jadi bisa diuji di Node tanpa DOM. Profil ICC
belum dibaca di fase ini: warna yang disarankan hanya saran, dan colour space
input tetap parameter yang dipilih pengguna (`inputColorSpace`, §6). Ini
dicatat sebagai keterbatasan, bukan disembunyikan.

`detect.ts` memilih decoder dari magic bytes, bukan dari ekstensi. Galat
decode dibungkus `DecodeError` yang menyebut format dan alasannya.

**Encoder:** PNG 8/16-bit (`fast-png`); TIFF 16-bit tak terkompresi dengan
penulis baseline sendiri (sekitar 100 baris, tanpa dependensi). Nilai
`rgb_out` di-clamp ke `[0,1]` lalu dibulatkan ke bilangan bulat terdekat.

**Gerbang io:**

- Round-trip: encode lalu decode dengan pustaka pihak lain harus bit-identik.
- JPEG dan PNG: decode dicocokkan dengan Pillow di `.venv-ref` untuk fixture
  kecil yang di-commit.
- EXR: dicocokkan dengan OpenImageIO di `.venv-ref`.
- **RAW**: satu sampel RAW kecil yang bisa didistribusikan ulang
  didecode dengan rawpy (setelan §2.5) dan dengan `libraw-wasm`; ambangnya
  diukur lalu dikunci. Kalau `libraw-wasm` tidak bisa memberi setelan yang
  sama persis (misalnya `output_color=ACES` tidak diekspos), itu dicatat dan
  diganti oleh build LibRaw-WASM sendiri. Ambang tidak dilonggarkan untuk
  menutupinya.

### 5.1 Hasil (2026-09-28, selesai)

Rencana: `docs/superpowers/plans/2026-09-28-dichroic-phase2b-io.md`. Oracle:
Pillow 12.3 (libjpeg-turbo), OpenImageIO 3.1.17 (OpenEXR, libpng), tifffile
2026.3, rawpy 0.27.1 (LibRaw 0.22.1). Fixture dibangkitkan
`tools/gen_io_reference.py` dan `tools/gen_raw_reference.py`, deterministik
(tiga run berturut-turut, manifest sama).

| Format | Fixture | Terukur | Gerbang |
|---|---|---|---|
| JPEG | 7 (baseline q90 4:2:0, progresif, gray, progresif gray, 4:4:4, 4:2:2, restart) | bit-identik; juga 60 JPEG acak (1×1..259×199, q5..100, semua subsampling, progresif, optimize, restart) | bit-identik |
| PNG | 9 (RGB8, RGBA8, gray8, gray1, palet 8-bit, palet 2-bit, RGB16, gray16) | bit-identik | bit-identik |
| TIFF | 17 (8/16-bit LE/BE, float16/32 LE/BE, LZW, LZW+predictor 16-bit, Deflate, Deflate+predictor BE, predictor floating-point LE/BE, PackBits, tile, planar, gray16, RGBA16) | bit-identik; juga 40 TIFF acak sampai 400×300 | bit-identik |
| EXR | 15 (half none/RLE/ZIPS/ZIP/PIZ, float RGBA ZIP, float PXR24, tile, decreasingY, data window, Y saja, AP0, AP1, Rec.2020) | bit-identik | bit-identik |
| EXR DWAA | 1 (lossy, di luar rencana) | ≤ 3 ULP half (1440 identik, 1896 × 1, 561 × 2, 18 × 3 dari 3915) | ≤ 3 ULP half |
| RAW | 2 DNG sintetis (tanpa Orientation, Orientation 6) | ≤ 1 LSB 16-bit (1,53e-5), 59 % nilai identik | ≤ 2 LSB (3,1e-5) |
| Encoder | PNG 8/16, TIFF 16 | round-trip bit-identik lewat decoder `io/` dan lewat Pillow / OIIO-libpng / tifffile | bit-identik |

Ruling yang diambil (keputusan — alasan — biaya bila salah):

- **JPEG: `jpeg-js` diganti decoder sendiri yang meniru libjpeg-turbo** (IDCT
  islow, upsampling chroma fancy h2v1/h1v2/h2v2 dengan replikasi tepi
  `jdmainct`, YCbCr titik tetap) — `jpeg-js` terukur meleset **125/255** di tepi
  chroma 4:2:0 (upsampling nearest-neighbour; juga IDCT poppler dan konversi
  warna float): gambar yang berbeda dari yang dilihat pengguna di browser,
  bukan derau pembulatan. Target rencana ≤ 2/255 tidak dilonggarkan; decodernya
  yang diganti — sekitar 840 baris untuk dirawat; aritmetika, lossless,
  12-bit, dan CMYK/YCCK ditolak `DecodeError`. 24 MP ≈ 1 s di Node.
- **TIFF: `utif2` diganti pembaca sendiri** — `utif2` mengembalikan piksel nol
  tanpa galat untuk kompresi tak dikenal, tidak membalik byte float
  big-endian, hanya me-log planar 2, dan mencetak `console.log` untuk berkas
  ber-tile: semuanya gambar salah yang diam-diam — sekitar 400 baris.
  JPEG-in-TIFF, BigTIFF, CMYK/YCbCr/Lab ditolak jelas.
- **EXR: `parse-exr` dipertahankan dengan pagar** — ia menulis baris terbalik
  (konvensi tekstur three.js; dibalik), menempatkan chunk `decreasingY`
  menurut urutan berkas (disusun ulang dari y chunk sebelum parsing),
  mengambil satu tipe piksel untuk semua kanal (campuran half/float ditolak),
  dan mengembalikan Y saja dari berkas luminance-chroma (ditolak). Kanal
  ber-layer (`diffuse.R`) ditolak dengan daftar kanal. Y saja disebar ke RGB
  (grayscale sah; Review Focus #3 rencana menyebut "hanya Y" sebagai kanal
  hilang — yang ditolak kini luminance-chroma dan kanal tanpa R/G/B/Y).
- **EXR DWAA/DWAB didukung dengan gerbang terpisah ≤ 3 ULP half** — lossy,
  tidak ada di rencana, dan `parse-exr` punya implementasi DCT DWA sendiri;
  menolaknya berarti menolak berkas yang umum di pipeline VFX. Gerbang
  bit-identik kasus lain tidak disentuh — bila pemilik proyek lebih suka
  menolak DWA, cukup lempar `DecodeError` di `exr.ts`.
- **RAW: `gamm` tidak dikirim ke LibRaw** (rencana menyebut `gamm: [1, 1]`
  "demi masa depan") — bila binding kelak menghormatinya, keluaran linear
  akan dibalik dua kali tanpa galat. Tanpa `gamm`, LibRaw selalu memakai kurva
  bawaannya (0,45; 4,5; `imax = 0x10000` karena `no_auto_bright`), yang
  dibalik tabel `gamma_curve` yang sama persis.
- **RAW: format yang tidak dikenali magic bytes tetap dicoba LibRaw** sebelum
  `DecodeError('unknown')` — LibRaw mengenali jauh lebih banyak RAW daripada
  `detect.ts`.
- **RAW berbasis TIFF dikenali dari DNGVersion, header CR2, atau IFD/SubIFD
  ber-photometric CFA/LinearRaw atau berkompresi vendor**, bukan dari tag
  `Make` saja (rencana) — TIFF biasa buatan kamera/scanner juga membawa
  `Make`.
- **`Session.exportImage` mengantre ulang ekspor yang tersalip** sebelum mulai,
  alih-alih menolaknya dengan `RenderSupersededError` — pengguna meminta
  berkas, bukan pratinjau yang boleh dibuang; akibatnya pratinjau yang sedang
  menunggu justru yang tersalip.
- **RPC `decode` tidak butuh `init`** dan hasilnya ditransfer tanpa salinan —
  decode berkas besar dan kompilasi shader `Session.create` berjalan
  bersamaan; gambar RAW 24 MP = 384 MB f32 RGBA.

**Browser dan COOP/COEP.** `libraw-wasm` memakai memori WASM bersama
(pthread), jadi halaman harus cross-origin isolated. `vite.config.ts` kini
memasang `Cross-Origin-Opener-Policy: same-origin` dan
`Cross-Origin-Embedder-Policy: require-corp` untuk dev dan preview, dan
mengecualikan `libraw-wasm` dari pra-bundling. Hosting (fase PWA) wajib
memasang header yang sama. Tanpa isolasi, `decodeRaw` melempar alasan yang
menyebut COOP/COEP. Diverifikasi di Chromium headless lewat Vite: kelima
format ter-decode, baik di halaman maupun lewat RPC `decode` di worker
`Session` (pthread LibRaw bersarang di worker itu).

**Keterbatasan yang tercatat** (bukan disembunyikan): profil ICC tidak dibaca
(dan tidak disematkan saat ekspor), tag orientasi EXIF/TIFF tidak diterapkan
pada JPEG/PNG/TIFF (RAW memakai orientasi berkas), EXR multi-part/deep dan
mipmap selain level 0 tidak didukung, halaman TIFF selain IFD pertama
diabaikan.

---

## 6a. 2A.5 — Rezim resolusi produksi

Tujuan: setiap tahap spasial benar di ukuran piksel foto sungguhan
(sekitar 3–40 µm), bukan hanya di ukuran piksel fixture.

- Satu modul Gaussian WGSL bersama yang mencerminkan
  `fast_gaussian_filter.py` persis: FIR terpotong (`truncate=3`) untuk
  sigma < 3 px dan IIR Young-van Vliet (`_yvv_coeffs`, pass horizontal lalu
  vertikal, batas reflect) untuk sigma ≥ 3 px. `fast_exponential_filter`
  (jumlah beberapa Gaussian) memakai modul yang sama.
- Setiap tahap yang di hulu memanggil `fast_gaussian_filter` memakai modul
  itu: DIR (`couplers.py:104`), halation/scatter (`diffusion.py:53,74`),
  filter difusi (`diffusion.py:19,86,100`), glare (`glare.py:23`), grain
  (`grain.py:50,62,106,162`). Tahap yang sudah punya kernel sendiri diaudit
  apakah hasilnya sama di rezim sigma besar.
- **Fixture** tetap kecil (64 px): ukuran piksel produksi dicapai dengan
  menurunkan `camera.film_format_mm` (teknik Task 16b), misalnya 0,4 mm →
  6,25 µm/px. Satu keluarga fixture per efek spasial, di dua ukuran piksel
  (sekitar 6 dan 30 µm).
- **Tiling:** apron `SPATIAL_EFFECT_RADIUS_PX = 256` diukur ulang terhadap
  ekor IIR. Gerbang bit-identik tile vs full-frame diulang di rezim ini.
- **Penerimaan:** `Session.render('preview')` pada gambar 2048 px
  menghasilkan 1024 px tanpa galat, dan render penuh gambar ≥ 4000 px
  berjalan lewat tiling.

### 6a.1 Hasil (2026-09-28, selesai)

- **Primitif `GaussianBlur`** vs `fast_gaussian_filter` numba f64: galat maks
  ≤ 2,4e-7 di semua kasus oracle (ambang 1e-6). IIR Young-van Vliet dalam f32
  polos meleset hingga 1,6e-3 (koefisien YvV hampir saling menghapus,
  B ≈ 2e-3 pada σ 13), jadi rekursinya dihitung dalam **df64** (pasangan
  hi+lo f32, two-sum Knuth dan two-prod dengan split Dekker, tidak
  bergantung `fma`). **Risiko portabilitas terbuka:** compiler yang
  melakukan reasosiasi fast-math akan meruntuhkan df64 ke presisi f32
  polos. Mitigasi (sudah diterapkan): `Session.create` menjalankan self-test
  kecil (blur σ 2/9/25 di GPU dibandingkan referensi CPU f64 yang digerbangi
  terhadap Python, ambang 1e-5) dan melaporkannya lewat
  `Session.diagnostics.iirPrecisionOk`, supaya UI bisa memperingatkan.
  **Risiko itu terbukti nyata (2026-09-28):** Dawn/D3D12 di Windows (jalur
  bawaan Chrome) pada RTX 3060 Ti meruntuhkan df64 -- self-test 8,9e-5, 11
  gerbang parity IIR gagal -- sementara D3D11 lulus 1,4e-7. Perbaikan:
  setiap hasil antara transformasi bebas galat dilewatkan `opq` (XOR bit
  dengan `BlurParams.opaqueZero`, selalu 0 dari host, tak diketahui
  compiler), sehingga identitas aljabar seperti `t-(t-a) -> a` tidak bisa
  dilipat. Hasil: D3D12 1,395e-7, bit-identik dengan D3D11; bahkan dengan
  toggle `d3d_disable_ieee_strictness` (tanpanya 2,2e-4) lulus 1,5e-7.
  Self-test tetap dipertahankan sebagai jaring pengaman.
- **Halation dan DIR** memakai primitif ini. Gerbang rezim produksi
  (`hard_edge`/`impulse_highlight` di 6,25 dan 31,25 µm/px) lulus
  `log_e_film`, `cmy_film`, dan `rgb_out` di ambang 1e-5. FIR lama meleset
  hingga 3,3e-2.
- **`filmFormatMm`** dibawa `FrameParams` (bukan `CoreParams`, yang tetap
  cermin persis 26 field push-constant OFX).
- **Apron tiling** dihitung dari σ sebenarnya: FIR memakai support eksak,
  IIR memakai `ceil(10σ)`. Ekor maju-mundur YvV eksponensial dan
  berosilasi, bukan Gaussian: massa ekor 5,5σ sekitar 6e-4. Apron 256 px
  OFX tidak lagi dipakai untuk halation dan DIR.
- **Invarian tiling (menggantikan "nol perbedaan" spec induk §4.4 untuk
  rezim IIR saja):** rezim FIR tetap bit-identik. Rezim IIR: jahitan
  `cmy_film` ≤ 1e-6 (terukur 2,4e-7) dan `rgb_out` rantai penuh ≤ 2e-6
  (terukur 1,55e-6). Didiagnosis per tap sebagai derau pembulatan f32
  1–2 ulp yang diperkuat kurva print/scan, bukan jahitan.
- **Performa** (mesin pengembangan, Dawn/D3D12): pratinjau hangat 1024 px
  sekitar 0,3 s; render penuh 2048 px sekitar 1,8 s; graf varian rantai
  baru butuh 2–9 s untuk kompilasi shader pertama (kandidat *prewarm*).

---

## 6. 2C — Batch parameter 1

Setiap field di bawah naik dari `locked` ke `verified` hanya setelah:

1. `tools/gen_reference.py` punya builder kasus yang menyetel padanan
   Python-nya ke nilai non-default (satu atau lebih nilai yang menguji
   cabangnya);
2. fixture dibangkitkan dengan `.venv-ref` dan di-commit;
3. `buildRenderPlan` dan tahap terkait meneruskan field itu;
4. gerbang parity dengan ambang yang sudah ada untuk tap itu lulus.

| Kelompok | Field OFX | Catatan |
|---|---|---|
| Stock | `film` (16 negatif), `paper` (8 print) | Satu kasus kecil per stock untuk keluarga `_lut` dan measured. Reversal ke batch 2 (§2.7) |
| Exposure | `filmExposureEv`, `autoExposure`, `printExposureEv` | `printExposureEv` menyentuh cabang `print_exposure_compensation` yang belum diimplementasi; ditangani di sini |
| Push/pull | `filmPushPullStops` (mode `Standard`) | Mode `Experimental` tetap `locked` |
| Colour space | `inputColorSpace` (26), `outputColorSpace` (SDR) | Butuh decode CCTF input yang sebenarnya di `filmExposure.wgsl`, menggantikan identitas sekarang. `OutputRole` HDR tetap `locked` |
| Enlarger | `filterC`, `filterMShift`, `filterYShift` | `m`/`y` sudah runtime-tunable di arena; `c` diperiksa |
| Halation | `halationEnabled`, `halationAmount` | |
| Grain | `grainEnabled`, `grainAmount`, `filmFormat` | `grainModel` tetap `Production`; `grainSeed` diekspos tetapi digerbangi secara statistik seperti Gate B |
| Difusi | `camera/printDiffusionEnabled`, `...Family`, `...Strength` | Prasyarat: PSF dihitung per ukuran gambar (§2.3) |
| Scanner | `glarePercent`, `scannerUnsharpAmount` | |

Kalau suatu field ternyata butuh pekerjaan yang jauh lebih besar dari
perkiraan (misalnya struktur tahap harus berubah), field itu tetap `locked`
dan dicatat sebagai temuan. Batch tidak ditahan demi satu field.

---

## 7. Testing

- `npm test` tetap menjalankan seluruh suite; berkas baru mengikuti pola yang
  ada (satu proses per berkas, timeout 30 detik).
- Test yang tidak butuh GPU (params, registry, io, cube, protocol) tidak boleh
  mengakuisisi device.
- Setiap fixture baru dibangkitkan oleh `tools/gen_reference.py` dan
  didokumentasikan di `tools/README.md` bersama hash commit hulu.
- Penjaga agenda #2 Fase 1 (tabel OFX vs Python) diperluas ke setiap tabel
  baru yang bersumber dari OFX.

---

## 8. Titik henti

Setelah 2A, 2A.5, 2B, dan 2C selesai dan diverifikasi (tsc, eslint, dan suite penuh
hijau pada dua run berurutan), pekerjaan **berhenti**. Laporan ke pemilik
proyek memuat daftar field `verified` dan `locked` serta keterbatasan yang
tercatat. UI baru dimulai setelah pemilik proyek memberikan dokumen desain
dan panduan visualnya.

Batch parameter 2 (DIR, preflash, printer lights, `ProcessMode`, reversal,
HDR, `Experimental` push/pull) dan PWA dikerjakan setelah UI.

---

## 9. Risiko

| Risiko | Penanganan |
|---|---|
| `libraw-wasm` tidak mengekspos setelan rawpy yang sama | Build LibRaw-WASM sendiri dengan emscripten; RAW tetap digerbangi |
| Sampel RAW yang bisa didistribusikan ulang tidak tersedia | Pakai sampel publik berlisensi terbuka (mis. dari raw.pixls.us, CC0); fixture disimpan ter-decode sebagai `.f32` kecil bila berkas aslinya besar |
| Dawn di Node tidak tersedia di worker | `Session` diuji langsung; worker hanya lapisan RPC yang diuji dengan `MessageChannel` |
| Parameter yang cabang Python-nya tak terduga (seperti `print_exposure_compensation`) | Temukan lewat gerbang, bukan asumsi; field tetap `locked` sampai lulus |
| Ukuran bundle naik karena WASM | Diterima (aturan kualitas-dulu); WASM dimuat saat RAW pertama dibuka, bukan saat start. Ini penyimpangan sadar dari "tidak ada lazy-load" di spec induk §5.3: decoder RAW tidak dibutuhkan untuk frame pertama gambar non-RAW, dan tetap ikut di-precache PWA |
