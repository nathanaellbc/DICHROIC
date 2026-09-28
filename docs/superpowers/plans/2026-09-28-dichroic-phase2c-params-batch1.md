# DICHROIC Fase 2C — Batch parameter 1: Rencana Implementasi

> Eksekusi inline (executing-plans), satu commit per task, commit diakhiri
> baris `Co-Authored-By`. Checkbox (`- [ ]`) untuk pelacakan.

**Goal:** Menaikkan field `RenderParams` batch 1 (spec Fase 2 §6) dari
`locked` ke `verified`, masing-masing lewat fixture Python baru dan gerbang
parity dengan ambang yang sudah ada. Field yang ternyata butuh perubahan
struktur besar tetap `locked` dan dicatat sebagai temuan.

**Architecture:** Satu keluarga fixture baru, `param/<nama>`, dibangkitkan
`tools/gen_reference.py --param-case`. Setiap kasus mencatat di `case.json`
patch `RenderParams` (sisi TS) dan override Python yang menjadi padanannya.
Gerbangnya lewat **jalur produksi**: `buildRenderPlan(patch)` →
`precomputeArenaData(plan.arenaInputs)` → `buildChain(plan.chain)` →
`graph.run(plan.core, { frame: plan.frame })`. Jadi pemetaan field → engine
yang dibuktikan adalah pemetaan yang dipakai `Session`, bukan salinan di test.

**Tech Stack:** toolchain hulu di `../upstream` (spektrafilm `3bb2c2d`,
spektrafilm-ofx `86476af`, Python 3.13, versi paket `tools/README.md`).

**Spec:** `docs/superpowers/specs/2026-09-28-dichroic-phase2-core-design.md` §6.

## Global Constraints

- Ambang tidak dilonggarkan: tap deterministik ≤ 1e-5 per piksel (rezim IIR
  sama dengan 2A.5), gerbang stokastik memakai momen/spektrum seperti Gate B.
- Field naik ke `verified` hanya bila setiap test yang menyebutnya lewat
  `@verifies <field>` hijau. `renderParams.test.ts` menjaga penandanya.
- Fixture lama tidak disentuh; manifest hanya bertambah.
- Semua arena untuk satu berkas test dipra-hitung SEBELUM `acquireDevice`
  (CATATAN LINGKUNGAN `src/host/spectral.ts`).
- Fixture kecil (≤ 64 px); rezim resolusi produksi lewat `film_format_mm`
  kecil seperti 2A.5.

## Temuan awal yang membentuk urutan task

1. **`filmExposureEv` menyeret cabang `_comp`.** Default Python
   (`print_exposure_compensation=True`, `normalize_print_exposure=True`)
   memakai `factor_midgray_comp`, dari midgray `0.184 * 2**exposure_compensation_ev`
   (`filming.py::_compute_density_spectral_midgray_to_balance_print`). Pada
   ev = 0 nilainya sama dengan `factor_midgray`, sehingga gerbang lama lulus.
   Hanya EV kompensasi yang masuk, bukan EV auto-exposure.
2. **Push/pull `Standard`** di OFX hanya mengalikan gamma kurva film dengan
   `filmPushPullGamma(stops)` (`SpektraVulkanRenderer.cpp:2034`). Padanan
   Python: `film_render.density_curve_gamma`. Gamma itu juga dipakai
   `develop_simple` untuk midgray print.
3. **`grainAmount`** OFX: `base + (grained - base) * amount` di ruang densitas
   (`SpektraGrain.comp::applyGrainControls`, saturasi 1). Python tidak punya
   field ini. Oracle: `cmy_film` tanpa grain dan dengan grain dicampur di
   generator, lalu diinjeksi lewat `taps.inject = cmy_film` untuk tap hilir.
4. **Colour space.** Oracle Python hanya ada untuk label yang juga kunci
   `colour.RGB_COLOURSPACES`. Label log kamera (LogC4, S-Log3, …) tidak punya
   padanan Python dan tetap ditolak.
5. **Filter netral enlarger** ter-bake untuk satu pasangan saja. Membuka
   `film`/`paper` butuh tabel netral untuk setiap pasangan negatif × print.

---

### Task 1: Harness keluarga `param/`

**Files:** Modify `tools/gen_reference.py`, `tools/README.md`; Create
`test/parity/planRun.ts`, `test/parity/paramCases.ts`; Test
`test/parity/paramHarness.test.ts`.

- `gen_reference.py --param-case <nama>`: kasus = (citra, keluarga
  `deterministic|stochastic|lut`, `film`, `print`, fungsi override Python,
  patch `RenderParams`). `case.json` mencatat `renderParams`, `pythonOverrides`
  (teks, untuk dibaca manusia), `family`, `filmFormatMm`.
- `planRun.ts`: `prepareParamCases(names)` memuat aset dan memra-hitung arena
  semua kasus sebelum device; `runParamParity(name, tap, tolerance)` menjalankan
  jalur produksi di atas dan membandingkan.
- Gerbang harness: kasus `param/baseline_*` (patch kosong, tiga keluarga)
  identik dengan fixture lama yang setara (bit-identik terhadap berkas `.f32`
  lama untuk tap deterministik).

### Task 2: Exposure — `filmExposureEv`, `autoExposure`, `printExposureEv`

**Files:** `src/host/spectral.ts` (`addPrintScanDynamicData`), `src/params/plan.ts`,
`src/shaders/printScan.wgsl` bila perlu; fixture `param/exposure_*`.

- Implementasi `factor_midgray_comp` (midgray `0.184 * 2**filmExposureEv`) dan
  `print_exposure = 2**printExposureEv` di `printExposureScale`.
- Kasus: ev ∈ {−1.5, +2}, `autoExposure=false` (± ev), `printExposureEv` ∈ {−1, +0.7};
  keluarga deterministik dan `lut`. Gerbang tap `log_e_film`, `log_e_print`, `rgb_out`.

### Task 3: Enlarger — `filterMShift`, `filterYShift`, `filterC`

- Python: `m_filter_shift`, `y_filter_shift`; `filterC` OFX dipetakan setelah
  membaca `SpektraVulkanRenderer.cpp:1030-1060` (tambah ke `c_filter_neutral`?).
- Kasus: shift ±10/±20, `filterC` 15. Gerbang `log_e_print`, `rgb_out`.

### Task 4: Push/pull `Standard` — `filmPushPullStops`

- `filmGamma = filmPushPullGamma(stops)`; Python `density_curve_gamma` sama.
  Periksa `curveDevelop.wgsl` membaca `filmGamma` dan `develop_simple` midgray.
- Kasus: stops ∈ {−1, +1, +2}. Gerbang `cmy_film`, `rgb_out`.

### Task 5: Halation — `halationEnabled`, `halationAmount`

- `halation.wgsl` `kHalationAmount` jadi frame float; `halationEnabled=false`
  berarti tahap halation hanya menutup `log10`.
- Kasus: amount ∈ {0.4, 2.5}, enabled=false; rezim FIR (35 mm) dan IIR (px6um).
  Gerbang `log_e_film`, `rgb_out`.

### Task 6: Scanner — `scannerUnsharpAmount`, `glarePercent`

- Unsharp deterministik (keluarga `<case>`): amount ∈ {0, 1.5}. Gerbang `rgb_out`.
- Glare stokastik: percent ∈ {0, 0.1}; gerbang statistik seperti
  `scannerPostGlare.test.ts`.

### Task 7: Grain — `grainAmount`, `filmFormat`, `grainSeed`

- `grainAmount`: temuan 3. Gerbang statistik (momen, spektrum daya) di
  `cmy_film` dan `rgb_out`.
- `filmFormat`: kasus deterministik untuk tiap format lewat halation/DIR
  (ukuran piksel), dan satu kasus grain statistik.
- `grainSeed`: dua seed berbeda memberi realisasi berbeda dengan statistik
  yang sama-sama lulus Gate B.

### Task 8: Stock — `film`, `paper`

- Bake tabel filter netral semua pasangan negatif × print (illuminant
  TH-KG3) lewat `apply_database_neutral_print_filters` hulu ke aset; `resolveEnlargerFilters`
  membaca tabel.
- Kasus: setiap negatif dengan `kodak_portra_endura`, dan `kodak_portra_400`
  dengan setiap print; keluarga `lut` (`rgb_out`) plus satu measured per stock.
  Reversal tetap ditolak (batch 2).

### Task 9: Colour space — `inputColorSpace`, `inputCctfDecoding`, `outputColorSpace`

- `decodeInputRgb` memakai LUT decode bila flag `inputCctfDecoding` (bit baru
  `slot1` FilmExposure) menyala.
- Subset label yang punya kunci `colour.RGB_COLOURSPACES`; sisanya tetap ditolak
  dengan pesan yang menyebut alasannya.
- Gerbang `rgb_pre`/`log_e_film` (input) dan `rgb_out` (output).

### Task 10: Difusi — evaluasi

- Prasyarat: PSF per ukuran gambar (spec §2.3). Bila butuh konvolusi FFT di
  GPU untuk radius produksi, field tetap `locked` dan temuan dicatat dengan
  ukuran kerja.

### Task 11: Penutup

- Registri akhir, spec §6.1 (hasil), `HANDOFF.md`, suite penuh dua kali hijau.

## Status 2C

Dieksekusi 2026-09-28 di Windows (RTX 3060 Ti, Dawn/D3D12), branch
`phase2c/params-batch1` (di atas PR 2B #3).

| Task | Field | Gerbang | Commit |
|---|---|---|---|
| 1 harness `param/` | — | 3 kasus kendali bit-identik dengan fixture lama, 10/10 | `3744e84` |
| 2 exposure | `filmExposureEv`, `autoExposure`, `printExposureEv` | 28/28 @1e-5 | `0f883be` |
| 3 enlarger | `filterC`, `filterMShift`, `filterYShift` | 12/12 @1e-5 | `ddf258a` |
| 4 push/pull | `filmPushPullStops` (Standard) | 16/16 @1e-5 | `3c9839c` |
| 5 halation | `halationEnabled`, `halationAmount` | 15/15 @1e-5 (FIR + IIR) | `c36a692` |
| 6a unsharp | `scannerUnsharpAmount` | 3/3 @1e-5 | `feb749e` |
| 6b glare | `glarePercent`; kombinasi `grainEnabled` x `glareEnabled` | 5 statistik + 1 per piksel | `d6fbbc8` |
| 7 grain + format | `grainAmount`, `grainSeed`, `filmFormat` | 10 statistik + 1 seed + 9 per piksel | `24208d9` |
| 8 stock | `film` (16 negatif), `paper` (8) | 138/138 @1e-5 (23 pasangan x lut + measured) | `283fc4e`, `86968dd` |
| 9a colour space input | `inputColorSpace` (26), `inputCctfDecoding` | 150/150 @1e-5 | `b9bd804` |
| 9b colour space keluaran | `outputColorSpace` (10 SDR) | 13/13 @1e-5 | `bdee9d2` |
| 10 difusi | tetap `locked` (6 field) | evaluasi, lih. temuan | — |

### Temuan dan ruling

- **Midgray print memakai sRGB linear**, bukan colour space gambar:
  `_rgb_to_film_raw` dipanggil tanpa argumen colour space. Probe: jalur gambar
  ProPhoto 0.184 memberi log raw 0.0054330, jalur midgray 0.0055470. Port host
  (`src/host/printExposure.ts`) cocok dengan `densitySpectralMidgray` bake
  Python sampai 9.3e-8.
- **Ruling `filmExposureEv`:** Python default `print_exposure_compensation=True`
  me-retime print ke `0.184 * 2**ev`; OFX tidak. Kita mengikuti Python.
  Uji negatif: tanpa cabang `_comp`, `log_e_print` meleset 0.357.
- **`.cube` mengabaikan kedua EV** (`lut_mode` memaksa `exposure_compensation_ev=0`,
  `print_exposure=1`); tercatat di header `# disabled effects`.
- **Ruling filter enlarger:** OFX meng-clamp `netral + shift` di 0, Python
  tidak (cc negatif -> transmitansi > 1). Kita mengikuti Python, digerbangi
  `enlarger_m_minus58_lut`.
- **Unsharp amount besar:** galat maks `rgb_out` pada `color_patches` naik
  linear ~2.9e-6 per unit amount (8.3e-7 di 0, 8.3e-6 di 2.5, 1.14e-5 di 3.5):
  derau f32 diperkuat `(1 + 2a)` dan kemiringan CCTF sRGB, bukan galat
  struktural (sigma meleset 1% memberi ~1e-3). Gerbang berhenti di 2.5;
  ambang tidak dilonggarkan. Rentang OFX sampai 4.
- **Bug ditemukan dan diperbaiki (glare):** flag glare dulu diturunkan dari
  `grainEnabled` (sisa aturan kopling Fase 1), jadi glare tanpa grain diam-diam
  tidak menambahkan glare (varians 0). Kini grain dan glare independen.
- **Gerbang statistik baru** (`runParamStatParity`): satu realisasi engine vs
  pusat 16 realisasi Python, `|d| <= 4 sd sqrt(1+1/K) + lantai` untuk mean,
  varians, dan autokorelasi lag-1. Grain hulu identik antar-realisasi dalam
  satu proses (sd grain 0, diukur), jadi bila grain hidup lantainya konstanta
  Gate B (mean 1e-4, varians 2%). Uji negatif: percent +20% gagal di kasus glare
  saja (mean meleset 3.5x ambang).
- **`grainAmount`** tanpa padanan Python: oracle = campuran `cmy_film`
  grain-mati/grain-hidup Python `base + (grained - base) * amount` (titik OFX:
  setelah blur densitas akhir), tap hilir lewat `process(inject='cmy_film')`,
  yang terbukti identik bit-per-bit dengan run normal. Varians Python persis
  mengikuti amount^2.
- **Grain hulu di-seed tetap** (`grain.py`: `seed=[0,1,2]`): realisasi Python
  identik antar-run dalam satu proses, jadi fixture adalah SATU realisasi.
  Gerbang statistik karenanya mengukur sebaran realisasi dari ENGINE lewat
  `grainSeed` (8 seed) dan membandingkan rata-ratanya dengan realisasi Python
  itu -- menggantikan lantai Gate B 2%, yang terlalu sempit untuk citra 64x64
  berautokorelasi 0.5 (sd estimator varians ~4.5%). Uji negatif: amount +10%
  gagal.
- `grainSeed` dicampur ke hash RNG grain sebagai `(seed - 1) * 0x85ebca6b`:
  seed 1 mereproduksi realisasi Fase 1 bit-identik (gerbang tiling bit-identik
  tetap hijau).
- **Database filter netral OFX berbeda dari Python** sampai 77 CC
  (`kodak_2383`/`fujifilm_c200`), 3.3 CC pada pasangan baseline. Tabel Python
  di-bake ke `manifest.neutralPrintFilters` (bake ulang: ketiga blob
  bit-identik, kunci manifest lama tidak berubah). Pasangan di luar database
  dan film reversal ditolak `validateStocks` (juga di `Session.setParams`).
- **Colour space input:** tanpa decode ke-26 label sah (primaries kunci
  colour identik dengan `matrix_space` OFX). Decode OFX identik dengan
  `cctf_decoding` colour untuk 20 label; enam ditolak bila decode (Canon
  Log2/Log3 -- colour 'Cinema Gamut' ber-CCTF lain --, Linear Rec.709, P3-D65
  Gamma 2.2, Rec.709 Gamma 2.2/2.4). Decode kini flag independen (bit 4
  `slot1`), bukan `colorTransferKinds` seperti OFX.
- **Auto-exposure Python bekerja di ruang TER-ENCODE** (`image * 2**ev`
  sebelum `rgb_to_raw` men-decode), sedangkan EV kompensasi dikalikan pada raw.
  Tanpa decode keduanya setara (linear); dengan decode, EV auto dibawa
  `frame.inputDecodeScale`. Uji negatif: EV di ruang raw meleset sampai 11 di
  `log_e_film`. Metering host kini men-decode dengan LUT yang sama.
- **Colour space keluaran:** 10 label SDR yang encode OFX-nya identik dengan
  `cctf_encoding` colour (sRGB, Display P3, ProPhoto, Adobe RGB, DCI-P3,
  P3-D65 Gamma 2.6, dan empat ruang linear). Default OFX "Rec.709 Gamma 2.4"
  TIDAK termasuk: colour BT.709 memakai OETF. Matriks, whitepoint, tabel
  `C_max` CAM16, dan encode kini per ruang (manifest `outputColorSpaces`);
  CAM16 sRGB untuk semua ruang gagal 9/10 kasus lut.
- **Difusi tetap `locked`** (spec §6: field yang butuh kerja jauh lebih besar
  dicatat, batch tidak ditahan). PSF Python = jumlah eksponensial radial 2D
  `exp(-r/lambda)` (TIDAK separable, jadi primitif IIR Gaussian tidak berlaku),
  diterapkan `fftconvolve` pada radius `8 * lambda_max` yang di-clamp ke
  `min(h, w) // 2 - 1`. Radius terukur (35 mm, 3:2): glimmerglass 153/305/892
  px, black_pro_mist 223/445/1303 px, pro_mist dan cinebloom 340/681/1999 px
  pada 1024/2048/6000 px -- 94 ribu sampai 16 juta tap per piksel. Butuh
  konvolusi FFT 2D di GPU pada frame penuh (radius mendekati setengah gambar,
  jadi tiling tidak menolong), dengan padding reflect dan PSF ternormalisasi
  pada grid terpotong persis Python. Sub-proyek tersendiri.
- Kinerja: kunci arena menyertakan filter C/M/Y, jadi mengubah filter
  memra-hitung ulang arena (termasuk tabel Hanatos). Kandidat optimasi saat UI:
  pindahkan `printFilteredIlluminant` ke nilai per render.

### Registri akhir batch 1

`verified` (21): `film`, `paper`, `inputColorSpace`, `inputCctfDecoding`,
`outputColorSpace`, `autoExposure`, `filmExposureEv`, `printExposureEv`,
`filmPushPullStops`, `filterC`, `filterMShift`, `filterYShift`,
`halationEnabled`, `halationAmount`, `grainEnabled`, `grainAmount`,
`grainSeed`, `filmFormat`, `glareEnabled`, `glarePercent`,
`scannerUnsharpAmount`.

`locked` (7): `rgbToRawMethod` (OFX `Hanatos2026` tanpa oracle Python),
`cameraDiffusionEnabled`, `cameraDiffusionFamily`, `cameraDiffusionStrength`,
`printDiffusionEnabled`, `printDiffusionFamily`, `printDiffusionStrength`.

Nilai yang divalidasi di luar registri (butuh aset): `validateStocks`
(negatif saja, pasangan di database), `validateInputColorSpace`,
`validateOutputColorSpace` (`src/params/plan.ts`).

### Verifikasi akhir

Suite penuh dua kali berurutan hijau (2026-09-29, RTX 3060 Ti, Dawn/D3D12):
51 berkas, 2457 lulus, 2 dilewati (uji -0 registri: tidak ada lagi field
`locked` numerik berbaseline 0; batas lisensi yang butuh sumber web hulu),
0 gagal, ~260 s per run. `tsc` dan `eslint` bersih.
