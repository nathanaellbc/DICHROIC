# DICHROIC — Handoff Fase 2

Ditulis 2026-09-28, diperbarui 2026-09-29 di akhir 2C. Ledger
kerja (`.superpowers/`) sengaja di-ignore git, jadi isinya yang penting
dipindah ke sini. Sumber otoritatif tetap di spec dan rencana; dokumen ini
peta jalan untuk melanjutkan.

## Posisi sekarang (diperbarui 2026-09-29, UI versi pertama)

- **Branch:** `claude/admiring-galileo-1vwlrk`, dari `main` setelah PR #4 (2C).
- **UI selesai versi pertama** (`src/ui/`): React 19 + Motion 12, iPhone-first
  sesuai DESIGN.md (Apple HIG / Liquid Glass) yang diberikan pemilik proyek;
  desain kanvas di Claude Design ("DICHROIC UI"). Jalankan: `npm run dev`
  (tambahkan `-- --host` untuk membuka dari HP di jaringan yang sama).
- **Perbaikan engine penting:** `printScan.wgsl` dan `scannerPost.wgsl`
  mendeteksi NaN dengan `x != x`, yang dilipat jadi `false` oleh compiler
  fast-math (lavapipe, SwiftShader; Metal di iPhone juga berisiko) -- gambar
  keluar hitam di semua GPU kecuali D3D12/NVIDIA. Kini lewat pola bit
  (`isNanBits`). Di lavapipe suite turun dari 226 gagal ke 1 (tile vs full
  2,09e-6 terhadap 2e-6, derau f32 backend perangkat lunak; ambang tidak
  diubah). **Konfirmasi suite hijau dua kali di mesin NVIDIA** -- aritmetika
  untuk wavelength non-NaN identik, jadi harus tetap bit-identik.
- **Diverifikasi** di Chromium headless (WebGPU SwiftShader): viewport iPhone
  14 potret/lanskap dan 1440x900; buka JPEG dan DNG, semua alat, sheet stok,
  ekspor PNG resolusi penuh (unduhan), discard, alert format tak didukung;
  `vite build` dan `vite preview` bersih. **Belum** dicoba di iPhone fisik.

| Sub-proyek | Status | Rencana |
|---|---|---|
| 2A, 2A.5, 2B, 2C | selesai | lihat rencana masing-masing |
| UI versi pertama | **selesai** (compact + regular) | DESIGN.md pemilik proyek; kanvas Claude Design |
| PWA (manifest, ikon, precache, hosting COOP/COEP) | belum | spec induk |
| Batch parameter 2, difusi FFT | belum | spec Fase 2 §8 |

## UI: peta cepat

- `src/ui/engine/engine.ts` -- jembatan ke `SessionClient` di worker (decode
  sebelum `init` lewat `SessionClient.attach`, render pratinjau dikoalesikan,
  pembanding asli, ekspor). Bebas React; diamati lewat `useSyncExternalStore`.
- `src/ui/model/` -- katalog stok dan definisi alat (field, rentang yang
  digerbangi 2C, format nilai); dijaga `test/ui/model.test.ts` agar sama
  dengan manifest, registri, dan plan.
- `src/ui/components/` -- kontrol iOS (slider seret relatif, switch,
  segmented, stepper), Sheet (detent, seret), ActionSheet, Alert, PhotoView.
- `src/ui/screens/` -- Start, Editor (compact/regular), Stocks, Export,
  ToolControls.
- Keputusan UI (bisa dibalik): tampilan (film, kertas, penyesuaian) dibawa
  ke foto berikutnya, hanya colour space input yang milik berkas; pilihan
  stok di sheet langsung dipratinjau, Cancel mengembalikan, seret-tutup =
  Done; ekspor di HP lewat lembar Bagikan, di desktop unduhan.

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

## Lingkungan sesi 2C (Windows, ber-GPU)

- Toolchain hulu di `../upstream/`: `spektrafilm` `3bb2c2d`, `spektrafilm-ofx`
  `86476af`, `.venv-ref` dan `.venv-bake` Python 3.13.15 dengan versi paket
  persis `tools/README.md`. `gen_reference.py` membangkitkan ulang 181/190
  berkas parity lama bit-identik (semua deterministik; 9 sisanya tap stokastik
  yang memang berubah antar-run).
- Menjalankan generator: set `SPEKTRAFILM_PY`/`SPEKTRAFILM_OFX` ke
  `../upstream/...`, lalu `../upstream/.venv-ref/Scripts/python.exe
  tools/gen_reference.py --out test/fixtures --param-case <nama> --manifest`.
- Di Windows `python3` adalah stub Microsoft Store yang menggantung; selalu
  panggil Python venv secara eksplisit.

## Ringkasan 2C (detail di spec §6.1 dan status rencana 2C)

- Harness `param/` menggerbangi setiap field lewat jalur produksi
  (`buildRenderPlan`), dari `tools/param_cases.py` (patch `RenderParams` +
  padanan Python). Gerbang stokastik baru: pusat K realisasi Python, sebaran
  grain dari 8 `grainSeed` engine.
- `verified`: stock (16 negatif x 8 print), colour space input (26 label; 20
  dengan decode CCTF) dan keluaran (10 ruang SDR), exposure film/print/auto,
  push/pull Standard, filter C/M/Y, halation, grain (amount/seed/format),
  glare (percent, kombinasi grain x glare), unsharp.
- Ruling atas nama pemilik proyek (Python mengalahkan OFX; semuanya bisa
  dibalik): `filmExposureEv` me-retime print; filter enlarger tanpa clamp di
  0; database filter netral Python (OFX berbeda sampai 77 CC); auto-exposure
  di ruang ter-encode saat decode; `.cube` mengabaikan kedua EV; unsharp
  digerbangi sampai amount 2.5 (derau f32 di atasnya).
- `locked`: enam field difusi (butuh konvolusi FFT 2D frame-penuh di GPU,
  kernel 94 ribu..16 juta tap), `rgbToRawMethod`.

## Temuan untuk UI dan batch 2

- `DecodedImage` 2B membawa `suggestedColorSpace` dan `encoding`. Kini
  `inputColorSpace`/`inputCctfDecoding` terverifikasi: JPEG/PNG/TIFF int ->
  `sRGB` + decode, TIFF float/EXR -> linear tanpa decode, RAW -> `ACES2065-1`
  tanpa decode. Enam label tanpa oracle decode ditolak bila decode.
- Default OFX `Rec.709 Gamma 2.4` untuk keluaran TIDAK tersedia (colour BT.709
  memakai OETF); baseline tetap sRGB.
- Mengubah filter enlarger (C/M/Y) memra-hitung ulang arena termasuk tabel
  Hanatos (beberapa ratus ms). Kandidat optimasi saat UI: pindahkan
  `printFilteredIlluminant` ke nilai per render. Graf varian rantai baru tetap
  butuh 2..9 s kompilasi shader pertama -- *prewarm* saat UI.
- Stock reversal ikut batch 2 bersama `ProcessMode`. `grainModel` hanya
  `Production`.
- `.cube` pada input linear meleset 9e-3 bila diinterpolasi trilinear; UI
  sebaiknya menyarankan input log (kini tersedia, mis. ACEScct) saat ekspor
  kubus.
- Difusi: sub-proyek FFT 2D di GPU (reflect pad, PSF ternormalisasi pada grid
  terpotong, radius `min(8 lambda_max, min(h, w)//2 - 1)` persis Python).

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
cd DICHROIC && git checkout phase2c/params-batch1   # atau main setelah 2B dan 2C digabung
npm ci
npm test
```

Butuh GPU yang didukung WebGPU lewat paket `webgpu` (Dawn); test berjalan
satu proses per berkas (lih. `vitest.config.ts`). Suite penuh sekitar 4,5
menit di RTX 3060 Ti. Untuk membangkitkan fixture baru, siapkan toolchain
Python hulu sesuai `tools/setup_envs.md` dan "Lingkungan sesi 2C" di atas
(`../upstream/` sejajar repositori). Tanpa toolchain itu seluruh test tetap
jalan karena fixture sudah di-commit.

**Langkah berikutnya adalah UI, dan itu menunggu pemilik proyek**: dokumen
desain dan panduan visual. Setelah itu tersedia, prompt untuk melanjutkan:

> Lanjutkan DICHROIC ke UI. Baca `docs/HANDOFF.md`, spec Fase 2 §6.1, dan
> dokumen desain + panduan visual yang saya berikan. `Session`/`SessionClient`
> adalah satu-satunya antarmuka engine; hanya field `verified` di
> `src/params/registry.ts` yang boleh diekspos. Pakai skill yang relevan.
