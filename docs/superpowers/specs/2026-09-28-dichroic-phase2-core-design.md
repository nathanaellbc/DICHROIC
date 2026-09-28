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
| JPEG | `jpeg-js` (BSD-3) | 8-bit → `[0,1]` ter-encode | `sRGB` |
| PNG | `fast-png` (MIT) | 8/16-bit → `[0,1]` ter-encode | `sRGB` |
| TIFF | `utif2` (MIT) | 8/16-bit int → ter-encode; 32-bit float → linear | `sRGB` untuk int, `Linear Rec.709` untuk float |
| EXR | `parse-exr` (MIT) | half/float → linear | dari atribut `chromaticities` bila ada; selain itu `Linear Rec.709` |
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
