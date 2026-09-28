# DICHROIC — Handoff Fase 2

Ditulis 2026-09-28, saat pekerjaan dijeda untuk dipindah ke mesin lain. Ledger
kerja (`.superpowers/`) sengaja di-ignore git, jadi isinya yang penting
dipindah ke sini. Sumber otoritatif tetap di spec dan rencana; dokumen ini
peta jalan untuk melanjutkan.

## Posisi sekarang

- **Branch:** `phase2/core` (belum digabung ke `main`).
- **Suite:** 529 lulus + 1 dilewati (530) di 31 berkas; `tsc` dan `eslint`
  bersih. Yang dilewati adalah cek batas lisensi arah balik ke `../web/src`,
  yang memang tidak ada di repositori mandiri.

| Sub-proyek | Status | Rencana |
|---|---|---|
| 2A tulang punggung (`Session`, `RenderParams`, `RenderPlan`, rantai produksi, `.cube`, RPC worker) | selesai | `docs/superpowers/plans/2026-09-28-dichroic-phase2a-backbone.md` |
| 2A.5 rezim resolusi produksi (blur IIR, apron dari sigma, self-test df64) | selesai | `docs/superpowers/plans/2026-09-28-dichroic-phase2a5-production-regime.md` |
| 2B `io/` (decode JPEG/PNG/TIFF/EXR/RAW, encode PNG/TIFF 16-bit) | **rencana selesai, Task 1 belum dimulai** | `docs/superpowers/plans/2026-09-28-dichroic-phase2b-io.md` |
| 2C batch parameter 1 | belum direncanakan (dirinci setelah 2B) | spec Fase 2 §6 |
| UI | **titik henti**: minta dokumen desain dan panduan visual dari pemilik proyek dulu | — |

Spec Fase 2: `docs/superpowers/specs/2026-09-28-dichroic-phase2-core-design.md`
(§6a.1 berisi angka terukur 2A.5 dan invarian tiling yang baru).

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

## Lanjut di 2B: temuan yang sudah diketahui

- **Fixture RAW sudah ada:** `test/fixtures/raw/synthetic_rggb/` (DNG
  sintetis 96×64 RGGB dari `tools/gen_raw_reference.py`, didecode rawpy
  dengan setelan hulu; LibRaw 0.22.1). Tidak perlu mengunduh RAW apa pun.
- **`libraw-wasm` 1.6.0 mengabaikan `gamm`** dalam semua bentuk. Keluaran
  selalu melewati kurva gamma dcraw bawaan (0,45; 4,5). Nilai linear
  dipulihkan dengan membalik tabel `gamma_curve` dcraw yang sama persis.
  Terukur 1,5e-5 (1 LSB 16-bit) terhadap rawpy; ambang rencana 2 LSB. Port
  yang sudah diuji di probe:

  ```js
  function gammaCurve(pwr, ts, mode, imax) {
    const g = [pwr, ts, 0, 0, 0, 0]; const bnd = [0, 0];
    bnd[g[1] >= 1 ? 1 : 0] = 1;
    if (g[1] && (g[1] - 1) * (g[0] - 1) <= 0) {
      for (let i = 0; i < 48; i++) { g[2] = (bnd[0] + bnd[1]) / 2;
        if (g[0]) bnd[((Math.pow(g[2] / g[1], -g[0]) - 1) / g[0] - 1 / g[2] > -1) ? 1 : 0] = g[2];
        else bnd[(g[2] / Math.exp(1 - 1 / g[2]) < g[1]) ? 1 : 0] = g[2]; }
      g[3] = g[2] / g[1]; if (g[0]) g[4] = g[2] * (1 / g[0] - 1);
    }
    const curve = new Uint16Array(0x10000); mode--;
    for (let i = 0; i < 0x10000; i++) { curve[i] = 0xffff; const r = i / imax;
      if (r < 1) curve[i] = Math.min(0xffff, Math.trunc(0x10000 * (mode
        ? (r < g[3] ? r * g[1] : (g[0] ? Math.pow(r, g[0]) * (1 + g[4]) - g[4] : Math.log(r) * g[2] + 1))
        : 0))); }
    return curve;
  }
  // curve = gammaCurve(0.45, 4.5, 2, 0x10000); invers: untuk tiap nilai e,
  // ambil tengah rentang L dengan curve[L] === e; linear = L / 65535.
  ```

- **Setelan LibRaw** yang cocok dengan rawpy hulu: `{ outputColor: 6,
  outputBps: 16, noAutoBright: true, useCameraWb: true }`. `noAutoBright` dan
  `useCameraWb` terbukti dipatuhi.
- **Node:** muat `node_modules/libraw-wasm/dist/libraw.js` langsung,
  `(await factory({ wasmBinary })).LibRaw`, `new LibRaw()`, `open(bytes,
  settings)`, `imageData()`. Wrapper `index.js` butuh Web Worker global dan
  tidak jalan di Node.
- **Browser:** modul memakai memori WASM `shared` (pthread), sehingga
  halaman harus **cross-origin isolated** (header COOP/COEP). Ini perlu
  diatur di dev server dan hosting (fase PWA).
- Oracle tersedia di `.venv-ref`: Pillow 12.3, OpenImageIO 3.1.17 (termasuk
  EXR), tifffile 2026.9.9, rawpy.

## Temuan yang harus dibawa ke 2C

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
cd DICHROIC && git checkout phase2/core
npm ci
npm test
```

Butuh GPU yang didukung WebGPU lewat paket `webgpu` (Dawn); test berjalan
satu proses per berkas (lih. `vitest.config.ts`). Untuk membangkitkan fixture
baru, siapkan toolchain Python hulu sesuai `tools/setup_envs.md`
(`spektrafilm`, `spektrafilm-ofx`, `.venv-ref`, `.venv-bake`); sesuaikan
jalur `D:/Projects/upstream/` bila berbeda. Tanpa toolchain itu seluruh test
tetap jalan karena fixture sudah di-commit.

Prompt untuk melanjutkan di Claude Code:

> Lanjutkan Fase 2 DICHROIC di branch `phase2/core`. Baca `docs/HANDOFF.md`,
> spec `docs/superpowers/specs/2026-09-28-dichroic-phase2-core-design.md`, dan
> rencana `docs/superpowers/plans/2026-09-28-dichroic-phase2b-io.md`. Mulai
> dari Task 1 rencana 2B, lanjut 2C, dan berhenti sebelum UI. Pakai skill yang
> relevan.
