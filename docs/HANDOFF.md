# DICHROIC — Handoff Fase 2

Ditulis 2026-09-28, saat pekerjaan dijeda untuk dipindah ke mesin lain. Ledger
kerja (`.superpowers/`) sengaja di-ignore git, jadi isinya yang penting
dipindah ke sini. Sumber otoritatif tetap di spec dan rencana; dokumen ini
peta jalan untuk melanjutkan.

## Posisi sekarang (diperbarui 2026-09-28, akhir 2B)

- **Branch:** `claude/admiring-galileo-1vwlrk`, bercabang dari `main` setelah
  PR #2 (2A + 2A.5 sudah digabung). Belum ada PR untuk 2B.
- **Suite:** 842 test di 39 berkas; `tsc` dan `eslint` bersih. Semua test
  non-GPU hijau, termasuk 309 test baru 2B. Sesi 2B berjalan di mesin TANPA
  GPU: Dawn dijalankan di atas lavapipe (Mesa, Vulkan perangkat lunak), dan
  di sana 39 gerbang parity GPU lama gagal karena presisi (self-test df64
  `iirPrecisionOk = false`) -- sama persis sebelum dan sesudah 2B. Test GPU
  yang bukan parity (antrean, cache, tiling paksa, `exportImage`) lulus.
  **Konfirmasi suite penuh dua kali hijau di mesin ber-GPU sebelum merge.**
- **Update 2026-09-28 (Windows, RTX 3060 Ti, Dawn/D3D12):** run pertama
  gagal 11 test -- semuanya gerbang IIR, karena D3D12 meruntuhkan df64
  (self-test 8,9e-5; D3D11 lulus 1,4e-7). Diperbaiki dengan penghalang
  optimasi `opq` di `gaussian.wgsl` (spec §6a.1). Setelahnya suite penuh
  **hijau dua kali**: 838 lulus, 4 dilewati (butuh toolchain hulu), 0 gagal.
  Backend Vulkan tidak bisa dimuat Dawn di mesin ini (`vulkan-1.dll`
  Windows Error 87), jadi tidak ikut diuji.

| Sub-proyek | Status | Rencana |
|---|---|---|
| 2A tulang punggung (`Session`, `RenderParams`, `RenderPlan`, rantai produksi, `.cube`, RPC worker) | selesai | `docs/superpowers/plans/2026-09-28-dichroic-phase2a-backbone.md` |
| 2A.5 rezim resolusi produksi (blur IIR, apron dari sigma, self-test df64) | selesai | `docs/superpowers/plans/2026-09-28-dichroic-phase2a5-production-regime.md` |
| 2B `io/` (decode JPEG/PNG/TIFF/EXR/RAW, encode PNG 8/16 + TIFF 16, `exportImage`, RPC `decode`) | **selesai** | `docs/superpowers/plans/2026-09-28-dichroic-phase2b-io.md` (Status 2B) |
| 2C batch parameter 1 | belum direncanakan; butuh toolchain hulu + GPU (lihat di bawah) | spec Fase 2 §6 |
| UI | **titik henti**: minta dokumen desain dan panduan visual dari pemilik proyek dulu | — |

Spec Fase 2: `docs/superpowers/specs/2026-09-28-dichroic-phase2-core-design.md`
(§5.1 berisi angka terukur 2B, ruling, dan keterbatasan; §6a.1 angka 2A.5).

## Cara kerja yang disepakati pemilik proyek

- Lanjut terus ("gas") sampai **tepat sebelum UI**, lalu berhenti dan minta
  dokumen desain + panduan visual. Pakai skill yang relevan.
- Parameter dibuka **bertahap**; setiap field baru `locked` → `verified`
  hanya setelah gerbang parity Python lulus. Ambang parity tidak pernah
  dilonggarkan.
- Semua format input termasuk RAW. Model parameter memakai nama
  `RenderParams` OFX. `Session` berjalan di Web Worker.
- Komunikasi dan dokumen dalam Bahasa Indonesia. Eksekusi rencana inline
  (skill executing-plans), satu commit per task, commit diakhiri baris
  `Co-Authored-By`.

## Ringkasan 2B (detail di spec §5.1)

- JPEG, PNG, TIFF, EXR bit-identik terhadap Pillow / OIIO / tifffile (48
  fixture + 100 berkas acak JPEG/TIFF). `jpeg-js` dan `utif2` dilepas: yang
  pertama meleset 125/255 di tepi chroma 4:2:0, yang kedua mengembalikan
  piksel nol diam-diam untuk kompresi tak dikenal. Penggantinya
  `src/io/jpegDecoder.ts` (meniru libjpeg-turbo) dan `src/io/tiff.ts`.
- EXR DWAA (lossy) punya gerbang sendiri ≤ 3 ULP half -- ruling yang bisa
  dibalik pemilik proyek (tolak DWA).
- RAW ≤ 1 LSB terhadap rawpy (gerbang 2 LSB), termasuk DNG ber-Orientation 6.
  `gamm` sengaja tidak dikirim ke LibRaw (lihat §5.1).
- Browser: `vite.config.ts` memasang COOP/COEP (wajib untuk pthread
  `libraw-wasm`) dan mengecualikan `libraw-wasm` dari pra-bundling. Hosting
  PWA wajib memasang header yang sama. Diverifikasi di Chromium headless.
- Keterbatasan: ICC tidak dibaca/disematkan, orientasi EXIF JPEG/PNG/TIFF
  tidak diterapkan, EXR multi-part/deep ditolak.

## Lingkungan sesi 2B (Linux, tanpa GPU)

- `.venv-ref` dibuat di `../upstream/.venv-ref` (sejajar repositori, meniru
  tata letak `D:/Projects/upstream/`) berisi numpy, Pillow 12.3, tifffile,
  imagecodecs, rawpy, OpenImageIO -- cukup untuk generator io/RAW. Paket
  `spektrafilm` TIDAK terpasang, jadi `gen_reference.py` (tap parity) tidak
  bisa dijalankan di sana.
- Tanpa GPU, `sudo apt-get install mesa-vulkan-drivers` memberi adapter
  lavapipe ke Dawn: berguna untuk test non-parity, tidak untuk gerbang
  parity.

## Kenapa 2C belum dimulai

Setiap field 2C naik ke `verified` hanya lewat fixture baru dari
`gen_reference.py` (butuh `spektrafilm` di `.venv-ref`) dan gerbang parity
GPU yang lulus. Keduanya tidak tersedia di sesi 2B: paket hulu tidak
terpasang, dan lavapipe sudah menggagalkan gerbang parity yang ada. Membuka
field tanpa gerbang melanggar aturan "tidak ada parameter tanpa parity".
Langkah berikutnya: di mesin ber-GPU dengan toolchain hulu, tulis rencana 2C
dari spec §6 dan temuan di bawah, lalu eksekusi.

## Temuan yang harus dibawa ke 2C

- `DecodedImage` dari 2B membawa `suggestedColorSpace` (label manifest) dan
  `encoding` (`encoded`/`linear`). Begitu `inputColorSpace` terverifikasi,
  UI bisa mengisinya dari saran ini (JPEG/PNG/TIFF int → `sRGB`, TIFF float
  dan EXR → dari chromaticities / `Linear Rec.709`, RAW → `ACES2065-1`).
- Filter netral enlarger hanya ter-bake untuk **satu** pasangan
  (`kodak_portra_400` / `kodak_portra_endura`, `manifest.printScan`). Membuka
  `film`/`paper` butuh bake tabel netral untuk semua pasangan
  (`apply_database_neutral_print_filters` Python).
- `EnlargerParams.print_exposure_compensation` default `True` di Python,
  tapi cabang `_comp` belum diimplementasi (`addPrintScanDynamicData`).
  `printExposureEv` menyentuhnya.
- `decodeInputRgb` di `filmExposure.wgsl` masih identitas: decode CCTF input
  belum ada. `inputColorSpace` dan `inputCctfDecoding` butuh itu. Tanpanya,
  JPEG sRGB yang dibuka akan ditafsirkan sebagai ProPhoto tanpa decode (jalur
  terverifikasi, tapi warnanya belum benar untuk foto nyata).
- Filter difusi masih `bypassConvolution` di rantai produksi. PSF-nya
  dibakukan pada ukuran piksel fixture (546,875 µm), dan hulu memakai
  konvolusi FFT dengan radius ratusan piksel di resolusi produksi. Membuka
  difusi butuh PSF per ukuran gambar dan FFT di GPU.
- Stock reversal (`ektachrome_100`, `kodachrome_64`, `velvia_100`,
  `provia_100f`) ikut batch 2 bersama `ProcessMode`. `grainModel` hanya
  `Production` (Preview/GrainSynthesis tidak punya oracle Python).
- `.cube` pada input linear (baseline ProPhoto linear) meleset 9e-3 bila
  diinterpolasi trilinear; UI sebaiknya menyarankan input log saat ekspor
  kubus, setelah `inputColorSpace` terverifikasi.

## Ruling 2A dan 2A.5 (keputusan yang diambil atas nama pemilik proyek)

Setiap baris: keputusan — alasan — biaya bila salah.

**2A**
- `Session` menerima `arenaProvider` suntikan; provider bawaan mempra-hitung
  arena baseline SEBELUM `acquireDevice` — Dawn di Node segfault bila
  pra-hitung float panjang terjadi setelah device hidup (CATATAN LINGKUNGAN
  `src/host/spectral.ts`) — kunci arena baru di runtime dipra-hitung setelah
  device (aman di browser; test Node wajib menyuntik provider).
- `defaultCoreParams` (test) dipertahankan sebagai pembungkus tipis
  `buildRenderPlan` — dipakai 4 berkas test, dan dengan begitu semua gerbang
  lama melewati jalur produksi — satu berkas helper tambahan.
- `SessionOptions.previewMaxLongEdge` (default 1024) — berguna bagi UI di
  perangkat lemah — satu opsi publik ekstra.
- `src/version.ts` untuk header `.cube`, dijaga sama dengan `package.json`
  oleh test — satu konstanta duplikat.
- RPC memakai handshake `init` (`SessionClient.connect(port, { assetsBaseUrl
  })`) — URL aset di worker tidak bisa ditebak andal — satu pesan ekstra.
- Worker mentransfer SALINAN typed array — `Session` men-cache
  `RenderResult`, mentransfer aslinya men-detach cache — satu memcpy per
  hasil.
- `applyParamsPatch` menolak kunci tak dikenal dan tipe salah (perbaikan
  review akhir) — patch dari UI lewat RPC tidak bertipe.

**2A.5**
- Rekursi IIR Young-van Vliet dihitung **df64** (hi+lo f32, two-sum Knuth +
  two-prod split Dekker) — f32 polos meleset 1e-4..1,6e-3 terhadap numba f64
  — rentan hanya terhadap reasosiasi fast-math; `Session.create`
  menjalankan self-test dan melaporkan `diagnostics.iirPrecisionOk`.
- `filmFormatMm` dibawa `FrameParams` (`RenderGraph.run(..., { frame })`),
  bukan `CoreParams` — `CoreParams` dijaga sebagai cermin persis 26 field
  push-constant OFX.
- `Arena.values(name)` (salinan host, sekitar 1,6 MB) — tahap menghitung
  sigma di host dari nilai stock — memori host kecil.
- `GaussianBlur.shared(device)` — kompilasi shader df64 1–3 s per instance.
- Blur halation/DIR dibatasi **active rect** tahap — di bawah
  `shrinkApron`, input hanya sah di dalam active rect.
- Apron IIR = **10σ**; radius halation/DIR murni dari sigma (tanpa lantai
  OFX 256) — ekor maju-mundur YvV eksponensial dan berosilasi (5,5σ
  menyisakan ~6e-4) — apron DIR sekitar 886 px di 6 µm/px, jadi tiling lebih
  mahal di device ber-limit kecil.
- Gerbang tile rezim IIR: `cmy_film` ≤ 1e-6 (terukur 2,4e-7), `rgb_out` ≤ 2e-6
  (terukur 1,55e-6). Didiagnosis per tap sebagai derau f32 1–2 ulp yang
  diperkuat kurva print/scan, bukan jahitan. Rezim FIR tetap bit-identik.

## Minor yang ditunda

- `Session.graphFor` bisa membuat graf duplikat (tak di-dispose) bila dua
  graf baru diminta bersamaan — simpan `Promise<RenderGraph>` di map.
- `exportCube` tidak lewat antrean render; aman karena encode `graph.run`
  sinkron, tapi tidak ada batasan konkurensi eksplisit.
- `GaussianBlur.pass` membuat buffer bobot dummy per pass tanpa FIR.
- Graf varian rantai baru butuh 2–9 s kompilasi shader pertama —
  *prewarm* di `Session.create` saat UI dikerjakan. Pratinjau hangat 1024 px
  ~0,3 s; render penuh 2048 px ~1,8 s.

## Menyiapkan mesin baru

```bash
gh auth login
gh repo clone nathanaellbc/DICHROIC
cd DICHROIC && git checkout claude/admiring-galileo-1vwlrk   # atau main setelah 2B digabung
npm ci
npm test
```

Butuh GPU yang didukung WebGPU lewat paket `webgpu` (Dawn); test berjalan
satu proses per berkas (lih. `vitest.config.ts`). Untuk membangkitkan fixture
baru, siapkan toolchain Python hulu sesuai `tools/setup_envs.md`
(`spektrafilm`, `spektrafilm-ofx`, `.venv-ref`, `.venv-bake`); sesuaikan
jalur `D:/Projects/upstream/` bila berbeda. Tanpa toolchain itu seluruh test
tetap jalan karena fixture sudah di-commit.

Prompt untuk melanjutkan di Claude Code (mesin ber-GPU, toolchain hulu siap):

> Lanjutkan Fase 2 DICHROIC. Baca `docs/HANDOFF.md` dan spec
> `docs/superpowers/specs/2026-09-28-dichroic-phase2-core-design.md` (§5.1,
> §6). Pastikan suite penuh hijau dua kali di mesin ini, lalu tulis rencana
> 2C (batch parameter 1) dan eksekusi, berhenti sebelum UI. Pakai skill yang
> relevan.
