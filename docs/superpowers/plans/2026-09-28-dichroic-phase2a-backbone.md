# DICHROIC Fase 2A — Tulang Punggung: Rencana Implementasi

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rantai produksi, model `RenderParams` dengan registri status, `RenderPlan`, facade `Session` (render penuh/pratinjau, antrean, cache), ekspor `.cube` yang digerbangi parity, dan lapisan RPC Worker, semuanya di `src/`.

**Architecture:** Kode yang sekarang hanya hidup di `test/parity/` (rantai 11 tahap, pembangun `CoreParams`, auto-exposure) dipindah ke `src/` dan test lama dialihkan memakainya, sehingga gerbang Fase 1 membuktikan jalur produksi. Di atasnya dibangun `params/` (terjemahan `RenderParams` → `RenderPlan`), `session/` (facade dan RPC), dan `io/cube.ts`.

**Tech Stack:** TypeScript 5.7 (lib ES2022), WebGPU (Dawn lewat paket `webgpu` di Node), Vitest 2, Python `.venv-ref` untuk fixture baru.

**Spec:** `docs/superpowers/specs/2026-09-28-dichroic-phase2-core-design.md` (§3, §4). Spec induk: `docs/superpowers/specs/2026-09-11-dichroic-design.md`.

## Global Constraints

- Kualitas/fidelity di atas performa; "lebih baik" = lebih setia pada referensi Python.
- Ambang parity TIDAK pernah dilonggarkan untuk meloloskan test.
- Satu jalur numerik f32; `shader-f16` tidak dipakai.
- Lib TS `ES2022`: jangan pakai `findLastIndex`, `Array.prototype.at` boleh.
- Test yang tidak butuh GPU tidak boleh mengakuisisi device.
- Tidak ada impor dari EMULSION (`web/`); `test/boundary.test.ts` tetap hijau.
- Komentar dan pesan galat dalam Bahasa Indonesia, mengikuti gaya berkas yang ada.
- Commit diakhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Aset dimuat dari dalam Web Worker.** `fetchBytes` (`src/profiles/load.ts:112`) mendeteksi browser lewat `window`, yang tidak ada di worker, lalu jatuh ke `node:fs` dan gagal. Diharapkan: worker memuat aset lewat `fetch`. Dipin di Task 8.
2. **`setParams` dengan field `locked` bernilai non-baseline.** Diharapkan galat keras yang menyebut field, nilai, dan baseline, dan parameter sebelumnya tidak berubah (atomik). Dipin di Task 2 dan Task 5.
3. **`render()` sebelum `open()`, atau setelah `dispose()`.** Diharapkan galat yang jelas, bukan crash WebGPU. Dipin di Task 5.
4. **Permintaan render yang saling menyusul cepat (slider).** Diharapkan hanya yang terbaru yang dirender; yang tersalip ditolak dengan `RenderSupersededError`, bukan hilang diam-diam. Dipin di Task 6.
5. **Pasangan film/paper yang tidak punya filter netral ter-bake.** Diharapkan galat keras (field `locked`), bukan memakai filter netral pasangan lain. Dipin di Task 3.

---

## Struktur Berkas

| Berkas | Tanggung jawab |
|---|---|
| `src/host/autoExposure.ts` (baru) | `measureAutoExposureEv` + helper, dipindah dari `test/parity/params.ts` |
| `src/params/renderParams.ts` (baru) | Tipe `RenderParams`, enum, `BASELINE_RENDER_PARAMS` |
| `src/params/registry.ts` (baru) | Status field, `validateRenderParams`, `UnverifiedParameterError` |
| `src/params/plan.ts` (baru) | `buildRenderPlan` → `RenderPlan` (CoreParams, input arena, spesifikasi rantai) |
| `src/engine/chain.ts` (baru) | `buildChain(device, arenas, spec)` |
| `src/io/decoded.ts` (baru) | Tipe `DecodedImage` |
| `src/io/cube.ts` (baru) | `identityLattice`, `formatCube`, `parseCube` |
| `src/session/session.ts` (baru) | Facade `Session` |
| `src/session/errors.ts` (baru) | `RenderSupersededError`, `SessionStateError` |
| `src/session/protocol.ts`, `worker.ts`, `client.ts` (baru) | RPC Worker |
| `src/profiles/load.ts` (ubah) | Deteksi lingkungan `fetchBytes` |
| `test/parity/params.ts`, `run.ts`, `chain.ts` (ubah) | Dialihkan ke kode `src/` |
| `tools/gen_reference.py` (ubah) | Kasus `identity_lattice_17_lut` |

---

### Task 1: Auto-exposure pindah ke `src/host/`

**Files:**
- Create: `src/host/autoExposure.ts`
- Modify: `test/parity/params.ts` (hapus `meterY`, `autoExposurePreviewShape`, `measureAutoExposureEv`; impor dari `src/host/autoExposure`)
- Test: `test/autoExposure.test.ts`

**Interfaces:**
- Produces: `measureAutoExposureEv(inputRgba: Float32Array, width: number, height: number, meterMatrix: ArrayLike<number>, colorSpace: number): number`

- [ ] **Step 1: Tulis test yang gagal** (`test/autoExposure.test.ts`, tanpa GPU, memakai `loadAssets('public/data')`):
  - Gambar seragam dengan `Y` terukur = 0.184 (skala RGB netral sehingga `meterY` = 0.184) → EV ≈ 0 (`toBeCloseTo(0, 6)`).
  - `Y` = 0.368 → EV ≈ −1; `Y` = 0.092 → EV ≈ +1.
  - `width = 0` → 0. Gambar hitam penuh → 0 (cabang `!(exposure > 0)`).
  - Gambar seragam 512×300 memberi EV sama dengan 64×37 (jalur preview > 256 px).
  - Untuk menghitung skala netral: `k = 0.184 / (m[o+3]+m[o+4]+m[o+5])` dengan `o = csIndex*9`, `m = bundle.staticTable('inputMeterXyzMatrices')`, `csIndex = labels.indexOf('ProPhoto RGB')`.
- [ ] **Step 2:** `npx vitest run test/autoExposure.test.ts` → FAIL (modul tidak ada).
- [ ] **Step 3:** Pindahkan tiga fungsi dari `test/parity/params.ts` ke `src/host/autoExposure.ts` apa adanya beserta komentar portingnya; ekspor `measureAutoExposureEv`. `test/parity/params.ts` mengimpornya.
- [ ] **Step 4:** Jalankan test baru dan `npx vitest run test/parity/filmExposure.test.ts test/parity/measuredChain.test.ts` → PASS.
- [ ] **Step 5:** `npm run typecheck && npm run lint`, lalu commit `refactor(host): auto-exposure pindah ke src/host`.

---

### Task 2: `RenderParams` dan registri status

**Files:**
- Create: `src/params/renderParams.ts`, `src/params/registry.ts`
- Test: `test/renderParams.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DiffusionFilterFamily = 'glimmerglass' | 'black_pro_mist' | 'pro_mist' | 'cinebloom'; // re-ekspor dari src/host/diffusionFilter
  export type FilmFormat = 'standard8'|'super8'|'standard16'|'super16'|'standard35'|'super35'|'standard65'|'imax70';
  export interface RenderParams {
    film: string; paper: string;
    rgbToRawMethod: 'hanatos2025';
    inputColorSpace: string; inputCctfDecoding: boolean; outputColorSpace: string;
    autoExposure: boolean; filmExposureEv: number; printExposureEv: number;
    filmPushPullStops: number;
    filterC: number; filterMShift: number; filterYShift: number;
    halationEnabled: boolean; halationAmount: number;
    grainEnabled: boolean; grainAmount: number; grainSeed: number; filmFormat: FilmFormat;
    cameraDiffusionEnabled: boolean; cameraDiffusionFamily: DiffusionFilterFamily; cameraDiffusionStrength: number;
    printDiffusionEnabled: boolean; printDiffusionFamily: DiffusionFilterFamily; printDiffusionStrength: number;
    glareEnabled: boolean; glarePercent: number;
    scannerUnsharpAmount: number;
  }
  export const BASELINE_RENDER_PARAMS: Readonly<RenderParams>;
  export type FieldStatus = 'verified' | 'locked';
  export const FIELD_STATUS: Readonly<Record<keyof RenderParams, FieldStatus>>;
  export class UnverifiedParameterError extends Error { field; value; baseline }
  export function validateRenderParams(p: RenderParams): void;
  export function applyParamsPatch(current: RenderParams, patch: Partial<RenderParams>): RenderParams; // validasi, tidak memutasi `current`
  ```
- Baseline = `digest_params(init_params())` Python, nama OFX (komentar per field menyebut padanan Python dan barisnya di `params_schema.py`):
  `film 'kodak_portra_400'`, `paper 'kodak_portra_endura'`, `rgbToRawMethod 'hanatos2025'`, `inputColorSpace 'ProPhoto RGB'`, `inputCctfDecoding false`, `outputColorSpace 'sRGB'`, `autoExposure true`, `filmExposureEv 0`, `printExposureEv 0`, `filmPushPullStops 0`, `filterC 0`, `filterMShift 0`, `filterYShift 0`, `halationEnabled true`, `halationAmount 1`, `grainEnabled true`, `grainAmount 1`, `grainSeed 1`, `filmFormat 'standard35'`, `cameraDiffusionEnabled false`, `cameraDiffusionFamily 'black_pro_mist'`, `cameraDiffusionStrength 0.5`, `printDiffusionEnabled false`, `printDiffusionFamily 'black_pro_mist'`, `printDiffusionStrength 0.5`, `glareEnabled true`, `glarePercent 0.03`, `scannerUnsharpAmount 0.7`.
- Status awal: **`verified`** hanya untuk `grainEnabled` dan `glareEnabled`. Keduanya (true dan false) sudah digerbangi di Fase 1: keluarga `<case>` (keduanya mati, `measuredChain.test.ts`) versus `<case>_stochastic` (keduanya hidup, `grain.test.ts` dan `scannerPostGlare.test.ts`). Kombinasi campuran (satu hidup, satu mati) BELUM digerbangi, jadi `validateRenderParams` menolak `grainEnabled !== glareEnabled` dengan `UnverifiedParameterError` (field `glareEnabled`). Semua field lain `locked`.

- [ ] **Step 1: Tulis test yang gagal:**
  - `validateRenderParams(BASELINE_RENDER_PARAMS)` tidak melempar.
  - `{...BASELINE, filmExposureEv: 1}` melempar `UnverifiedParameterError` dengan `field === 'filmExposureEv'`, `value === 1`, `baseline === 0`, dan pesan memuat ketiganya.
  - `{...BASELINE, grainEnabled: false, glareEnabled: false}` lolos; `{grainEnabled: false, glareEnabled: true}` melempar.
  - `applyParamsPatch(base, {film: 'kodak_gold_200'})` melempar dan `base` tidak berubah (`toEqual` dengan salinan sebelumnya).
  - Setiap kunci `BASELINE_RENDER_PARAMS` punya entri `FIELD_STATUS` dan sebaliknya.
  - Penanda `@verifies`: untuk setiap field `verified`, `grep` rekursif `test/` menemukan `@verifies <field>` (baca berkas dengan `readdirSync`/`readFileSync`, tanpa shell).
- [ ] **Step 2:** Jalankan → FAIL.
- [ ] **Step 3:** Implementasi. Perbandingan baseline memakai `Object.is` untuk angka (sehingga `-0` dan `NaN` tertangkap) dan `===` untuk lainnya. Tambahkan komentar `// @verifies grainEnabled glareEnabled` di `test/parity/measuredChain.test.ts` dan `test/parity/scannerPostGlare.test.ts`.
- [ ] **Step 4:** Jalankan → PASS; typecheck, lint.
- [ ] **Step 5:** Commit `feat(params): RenderParams bernama OFX dengan registri status`.

---

### Task 3: `buildRenderPlan`

**Files:**
- Create: `src/params/plan.ts`
- Modify: `test/parity/run.ts` (pakai `buildRenderPlan`), `test/parity/params.ts` (hapus `defaultCoreParams` setelah kesetaraan terbukti)
- Test: `test/plan.test.ts`

**Interfaces:**
- Consumes: `measureAutoExposureEv` (Task 1), `RenderParams`/`validateRenderParams` (Task 2).
- Produces:
  ```ts
  export type RenderMode = 'image' | 'cube';
  export interface ChainSpec { family: 'measured' | 'lut'; grain: boolean }
  export interface ArenaInputs { stockId: string; printScan: PrintScanArenaOptions }
  export interface RenderPlan {
    core: CoreParams; arenaKey: string; arenaInputs: ArenaInputs;
    chain: ChainSpec; overlap: number; disabledEffects: string[];
  }
  export function buildRenderPlan(
    params: RenderParams, bundle: AssetBundle,
    image: { width: number; height: number; rgba: Float32Array }, mode: RenderMode,
  ): RenderPlan;
  export class MissingNeutralFiltersError extends Error {}
  ```
- Aturan:
  - `mode 'cube'` → `family 'lut'`, `grain false`, glare dan unsharp mati, tanpa auto-exposure. `disabledEffects = ['halation','grain','camera diffusion','print diffusion','DIR diffusion','glare','unsharp mask','auto exposure']`.
  - `mode 'image'` → `family 'measured'`, `grain = params.grainEnabled`, `stochasticEffectsActive = params.grainEnabled && params.glareEnabled`. `disabledEffects = []`.
  - `enlargerFilters` dari `bundle.manifest.printScan` hanya bila `(film, paper)` sama dengan `(printScan.filmStock, printScan.printStock)`; selain itu lempar `MissingNeutralFiltersError`. Shift m/y dari `filterMShift`/`filterYShift`.
  - `arenaKey = \`${film}::print=${paper}::m=${mShift}::y=${yShift}\``.
  - `overlap = estimateTileOverlap(flags)` dengan `flags` dari efek yang aktif (lihat `SpatialEffectFlags` di `src/engine/tiling.ts`); mode `cube` → 0.
  - `buildRenderPlan` memanggil `validateRenderParams` lebih dulu.

- [ ] **Step 1: Tulis test yang gagal** (tanpa GPU): untuk tiap kasus `gray_ramp`, `log_gray_ramp`, `color_patches`, bandingkan `buildRenderPlan(...).core` field per field dengan `defaultCoreParams` lama:
  - `mode 'image'` + baseline ↔ `defaultCoreParams(..., 'measured', true)`
  - `mode 'image'` + `{grainEnabled:false, glareEnabled:false}` ↔ `(..., 'measured', false)`
  - `mode 'cube'` ↔ `(..., 'lut', false)`

  Tambahkan: `(film 'kodak_gold_200')` → `UnverifiedParameterError` (dari validasi). Panggil fungsi internal `resolveEnlargerFilters(bundle, 'kodak_gold_200', 'kodak_portra_endura')` langsung → `MissingNeutralFiltersError`.
- [ ] **Step 2:** Jalankan → FAIL.
- [ ] **Step 3:** Implementasi `plan.ts` dengan memindahkan isi `defaultCoreParams` (beserta komentar penjelasnya) ke sana.
- [ ] **Step 4:** Test → PASS. Alihkan `runTapParity` (`test/parity/run.ts`) supaya membangun `RenderParams` dari `family`/`stochasticEffectsActive` lalu memakai `plan.core`. `sharedResources` tetap. Hapus `defaultCoreParams` dari `test/parity/params.ts`; test kesetaraan di Step 1 diganti snapshot nilai `core` yang diambil dari run sebelum penghapusan (tulis angkanya ke test sebagai literal). Jalankan `npm test` penuh → 361 hijau.
- [ ] **Step 5:** Commit `feat(params): buildRenderPlan menggantikan defaultCoreParams`.

---

### Task 4: Rantai produksi `buildChain`

**Files:**
- Create: `src/engine/chain.ts`
- Modify: `test/parity/chain.ts` (jadi re-ekspor tipis), `test/parity/scannerPost.test.ts` (rantai `_lut` via `buildChain`), `test/parity/measuredChain.test.ts` (gerbang `rgb_out` via `buildChain({family:'measured', grain:false})`), `test/parity/scannerPostGlare.test.ts`
- Test: gerbang parity yang sudah ada

**Interfaces:**
- Consumes: `ChainSpec` (Task 3).
- Produces: `buildChain(device: GPUDevice, arenas: Arenas, spec: ChainSpec): Stage[]`
  - `lut`: `materializeActiveRegion, filmExposure, curveDevelop, dir({spatialDiffusionActive:false}), printExposure, printDevelop, scannerPost`. Persis daftar di `scannerPost.test.ts:60-70`.
  - `measured`: `fullChain` sekarang, tanpa `grain` bila `spec.grain === false`. Persis `measuredChain.test.ts::stagesToRgbOut`.
  - `spec.family === 'lut' && spec.grain` → lempar (kombinasi tidak sah).

- [ ] **Step 1:** Ubah `scannerPost.test.ts` dan gerbang `rgb_out` di `measuredChain.test.ts` untuk memakai `buildChain` (impor yang belum ada → merah). Jalankan dua berkas itu → FAIL (impor gagal).
- [ ] **Step 2:** Buat `src/engine/chain.ts`, pindahkan komentar panjang dari `test/parity/chain.ts`. `test/parity/chain.ts` menjadi `export const fullChain = (d, a) => buildChain(d, a, { family: 'measured', grain: true });`.
- [ ] **Step 3:** `npx vitest run test/parity/scannerPost.test.ts test/parity/measuredChain.test.ts test/parity/scannerPostGlare.test.ts` → PASS.
- [ ] **Step 4:** Commit `feat(engine): rantai produksi buildChain di src/engine`.

---

### Task 5: `Session` inti (render penuh)

**Files:**
- Create: `src/io/decoded.ts`, `src/session/errors.ts`, `src/session/session.ts`
- Test: `test/session.test.ts` (GPU)

**Interfaces:**
- Consumes: `buildRenderPlan`, `buildChain`, `precomputeArenaData`/`uploadArenas`, `acquireDevice`, `loadAssets`, `RenderGraph`.
- Produces:
  ```ts
  // src/io/decoded.ts
  export interface DecodedImage {
    width: number; height: number; rgba: Float32Array;
    suggestedColorSpace: string; encoding: 'encoded' | 'linear';
    source: { format: 'jpeg'|'png'|'tiff'|'exr'|'raw'|'fixture'; bitDepth: number; name?: string };
  }
  // src/session/errors.ts
  export class SessionStateError extends Error {}
  export class RenderSupersededError extends Error {}
  // src/session/session.ts
  export interface RenderResult { width: number; height: number; rgb: Float32Array; quality: 'full'|'preview'; paramsVersion: number }
  export class Session {
    static create(opts: { assetsBaseUrl: string; engine?: EngineDevice; bundle?: AssetBundle }): Promise<Session>;
    get params(): Readonly<RenderParams>;
    open(image: DecodedImage): void;
    setParams(patch: Partial<RenderParams>): void;
    render(quality: 'full' | 'preview'): Promise<RenderResult>;
    dispose(): void;
  }
  ```
- `rgb` berisi 3 kanal rapat (RGBA dari graf dipadatkan) supaya bisa langsung dibandingkan dengan tap fixture dan di-encode.
- Arena di-cache dalam `Map<arenaKey, Arenas>`. `precomputeArenaData` dipanggil SEBELUM `uploadArenas`, sesuai CATATAN LINGKUNGAN `src/host/spectral.ts`.
- `maxBufferBytes` = `engine.device.limits.maxStorageBufferBindingSize`.

- [ ] **Step 1: Tulis test yang gagal** (`test/session.test.ts`):
  - `// @verifies grainEnabled glareEnabled`
  - Untuk `color_patches`, `gray_ramp`, `log_gray_ramp`: `open({width,height,rgba: loadInputAsRgba(name), suggestedColorSpace:'ProPhoto RGB', encoding:'linear', source:{format:'fixture',bitDepth:32}})`, `setParams({grainEnabled:false, glareEnabled:false})`, `render('full')` → `compareRgb(result.rgb, loadTap(name,'rgb_out'))` dalam 1e-5 (ambang `measuredChain.test.ts`).
  - `render('full')` sebelum `open` → `SessionStateError`.
  - `setParams({filmExposureEv: 2})` → `UnverifiedParameterError`, dan `session.params.filmExposureEv` tetap 0.
  - Setelah `dispose()`, `render` → `SessionStateError`.
  - Pakai engine dan bundle bersama dari `sharedResources` (lewat opsi `engine`/`bundle`) supaya satu proses hanya punya satu device.
- [ ] **Step 2:** Jalankan → FAIL.
- [ ] **Step 3:** Implementasi. `compareRgb` menerima RGBA atau RGB? Periksa tanda tangannya di `test/parity/compare.ts:72` dan sesuaikan test, bukan kodenya.
- [ ] **Step 4:** Test → PASS; typecheck; lint.
- [ ] **Step 5:** Commit `feat(session): facade Session dengan render penuh tergerbang parity`.

---

### Task 6: Pratinjau, antrean yang terbaru menang, cache hasil

**Files:**
- Modify: `src/session/session.ts`
- Create: `src/session/downscale.ts`
- Test: `test/downscale.test.ts` (tanpa GPU), `test/session.test.ts` (tambahan)

**Interfaces:**
- Produces: `boxDownscale(rgba: Float32Array, w: number, h: number, maxLongEdge: number): { rgba: Float32Array; width: number; height: number }`. Identitas (tanpa salinan) bila sudah ≤ `maxLongEdge`. `PREVIEW_MAX_LONG_EDGE = 1024`.

- [ ] **Step 1: Tulis test yang gagal:**
  - `boxDownscale`: gambar 4×2 → maks 2 menghasilkan 2×1 dengan rata-rata blok; 3000×10 → 1024×3 (pembulatan `Math.max(1, Math.round(h*scale))`); nilai rata-rata gambar seragam tidak berubah; masukan ≤ batas dikembalikan apa adanya.
  - `Session`: gambar sintetis 2048×32 (gradien) → `render('preview')` menghasilkan `width === 1024`, `quality === 'preview'`.
  - Antrean: tiga `render('preview')` dipanggil sinkron tanpa `await` di antaranya → panggilan ke-1 dan ke-3 resolve, ke-2 reject `RenderSupersededError`.
  - Cache: dua `render('full')` beruntun tanpa perubahan parameter → objek hasil kedua `toBe` objek pertama. Setelah `setParams`, `paramsVersion` naik dan hasil baru berbeda objek.
  - Hasil yang `paramsVersion`-nya basi (parameter diubah saat render berjalan) tetap resolve, dengan `paramsVersion` lama, supaya UI bisa membuangnya.
- [ ] **Step 2:** Jalankan → FAIL.
- [ ] **Step 3:** Implementasi. Antrean: satu `inFlight` dan satu `pending` (slot). Permintaan baru saat ada `pending` → `pending` lama di-reject `RenderSupersededError`, lalu diganti. Cache: satu entri per kualitas, kunci `JSON.stringify(params) + imageId`; `imageId` bertambah tiap `open`.
- [ ] **Step 4:** Test → PASS.
- [ ] **Step 5:** Commit `feat(session): pratinjau terskala, antrean terbaru-menang, cache hasil`.

---

### Task 7: Ekspor `.cube` dengan gerbang parity lattice

**Files:**
- Create: `src/io/cube.ts`
- Modify: `src/session/session.ts` (`exportCube`), `tools/gen_reference.py` (kasus lattice), `tools/README.md`
- Create fixture: `test/fixtures/identity_lattice_17_lut/` (dibangkitkan)
- Test: `test/cube.test.ts` (tanpa GPU), `test/parity/cube.test.ts` (GPU)

**Interfaces:**
- Produces:
  ```ts
  export function identityLattice(size: number): { rgba: Float32Array; width: number; height: number }; // width=size*size, height=size, R tercepat
  export interface CubeMeta { title: string; film: string; paper: string; inputColorSpace: string; outputColorSpace: string; disabledEffects: string[]; version: string }
  export function formatCube(rgb: Float32Array, size: number, meta: CubeMeta): string;
  export function parseCube(text: string): { size: number; data: Float32Array };
  // Session
  exportCube(size: number): Promise<string>; // 2..65, integer; UI menawarkan 33 dan 65
  ```
- Urutan lattice: indeks `i = r + g*size + b*size*size` → piksel `(x = i % (size*size), y = floor(i / (size*size)))`, nilai `r/(size-1)`, dst. Ini urutan data `.cube` (R tercepat).

- [ ] **Step 1: Tulis test yang gagal** (`test/cube.test.ts`): `identityLattice(2)` memberi 8 titik dengan urutan (0,0,0),(1,0,0),(0,1,0),(1,1,0),(0,0,1)…; `formatCube` memuat `LUT_3D_SIZE 2`, baris `# disabled effects: halation, grain, ...`, 8 baris data berformat `%.6f`; `parseCube(formatCube(x))` round-trip dalam 5e-7; ukuran di luar 2..65 atau non-integer → galat.
- [ ] **Step 2:** Jalankan → FAIL; implementasi `cube.ts`; → PASS.
- [ ] **Step 3:** Tambahkan ke `tools/gen_reference.py` kasus `identity_lattice_17` (citra 289×17, lattice R tercepat, sama seperti `identityLattice(17)`), dibangkitkan dengan `lut_mode=True`. Bangkitkan:
  ```bash
  D:/Projects/upstream/.venv-ref/Scripts/python tools/gen_reference.py --out test/fixtures --case identity_lattice_17 --lut-mode
  ```
  (sesuaikan flag dengan `argparse` yang ada di `main()`). Catat di `tools/README.md`.
- [ ] **Step 4: Gerbang GPU** (`test/parity/cube.test.ts`): `session.exportCube(17)` → `parseCube` → bandingkan dengan `rgb_out` fixture `identity_lattice_17_lut` dalam **1e-5** (ambang Gate A `_lut`). Resolusi format 6 desimal (5e-7) jauh di bawah ambang. Tambahkan juga: kubus 65³ diterapkan trilinear ke input `color_patches` → catat galat maks terhadap `rgb_out` `color_patches_lut` sebagai angka informatif di komentar test (bukan gerbang).
- [ ] **Step 5:** Jalankan → PASS. Commit `feat(io): ekspor .cube lewat rantai lut, digerbangi lattice Python`.

---

### Task 8: RPC Worker dan pemuat aset di worker

**Files:**
- Create: `src/session/protocol.ts`, `src/session/worker.ts`, `src/session/client.ts`
- Modify: `src/profiles/load.ts:112-124`
- Test: `test/rpc.test.ts` (tanpa GPU), `test/profiles.test.ts` (tambahan)

**Interfaces:**
- Produces:
  ```ts
  // protocol.ts
  export type SessionMethod = 'open' | 'setParams' | 'render' | 'exportCube' | 'dispose' | 'getParams';
  export interface RpcRequest { id: number; method: SessionMethod; args: unknown[] }
  export type RpcResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: { name: string; message: string; data?: unknown } };
  export function transferablesOf(value: unknown): Transferable[]; // ArrayBuffer dari Float32Array di dalam value
  // worker.ts
  export function serveSession(port: MessagePortLike, factory: () => Promise<SessionLike>): void;
  // client.ts
  export class SessionClient { constructor(port: MessagePortLike); open(...); setParams(...); render(...); exportCube(...); getParams(); dispose(); }
  export function rehydrateError(e: {name; message; data?}): Error; // UnverifiedParameterError, RenderSupersededError, SessionStateError, MissingNeutralFiltersError; lainnya Error biasa
  ```
  `SessionLike` = subset publik `Session`. `MessagePortLike` = `{ postMessage(msg, transfer?): void; addEventListener('message', ...); start?(): void }`.
  Entry browser di bagian bawah `worker.ts`: bila `typeof self !== 'undefined' && typeof (self as any).importScripts === 'function'`, panggil `serveSession(self, () => Session.create({ assetsBaseUrl: '/data' }))`.
- `fetchBytes`: lingkungan dianggap "web" bila `typeof fetch === 'function'` DAN (`typeof window !== 'undefined'` ATAU `typeof importScripts === 'function'` ATAU URL http(s)). Selain itu `node:fs`.

- [ ] **Step 1: Tulis test yang gagal** (`test/rpc.test.ts`, `MessageChannel` dari `node:worker_threads`):
  - `SessionLike` palsu yang merekam panggilan. `client.setParams({filmExposureEv:1})` diteruskan dengan argumen sama.
  - `render` palsu mengembalikan `rgb: Float32Array` → diterima utuh di client; `transferablesOf` memuat buffer-nya.
  - `setParams` palsu melempar `UnverifiedParameterError` → client reject dengan `instanceof UnverifiedParameterError` dan `field` terjaga.
  - Dua permintaan bersamaan dijawab ke `id` yang benar walau urutan jawabannya dibalik.
- [ ] **Step 2:** Test untuk `fetchBytes`: dengan `globalThis.importScripts` dan `fetch` palsu sementara (tanpa `window`), `loadAssets('/data')` memanggil `fetch`, bukan `node:fs`. Kembalikan global setelah test.
- [ ] **Step 3:** Jalankan → FAIL; implementasi; → PASS.
- [ ] **Step 4:** Commit `feat(session): RPC Worker bertipe; aset dimuat via fetch di worker`.

---

### Task 9: Penutup 2A

**Files:**
- Modify: `docs/superpowers/specs/2026-09-11-dichroic-design.md` (§1 "repositori yang sama" → repositori terpisah sejak 2026-09-28), catatan di kepala rencana Fase 1 bahwa `spektra/` = root repo sekarang, bagian status di rencana ini.

- [ ] **Step 1:** Perbaiki rujukan basi (hanya kalimat faktual yang salah; riwayat tidak ditulis ulang).
- [ ] **Step 2:** `npm run typecheck && npm run lint && npm test` dua kali berurutan → semua hijau; catat jumlah test.
- [ ] **Step 3:** Isi bagian "Status 2A" di bawah ini dengan hash commit dan angka, lalu commit `plan: Fase 2A selesai`.

## Status 2A

**Selesai 2026-09-28** di branch `phase2/core` (6a49c2f..HEAD). tsc dan eslint
bersih; suite **429 lulus + 1 dilewati (430) di 26 berkas** pada dua run
berurutan. Yang dilewati adalah cek batas lisensi arah balik ke `../web/src`,
yang memang tidak ada di repositori mandiri.

| Task | Commit |
|---|---|
| 1 auto-exposure ke `src/host` | 3732c16 |
| 2 `RenderParams` + registri | 57c3964 |
| 3 `buildRenderPlan` | 02d0f77 |
| 4 `buildChain` | 100e8cf |
| 5 `Session` render penuh | 1d275cf |
| 6 pratinjau, antrean, cache | 3d01d45 |
| 7 `.cube` + fixture lattice | 09d6785 |
| 8 RPC Worker + `fetchBytes` | 61c46a4 |

Temuan yang mengubah lingkup: rezim resolusi produksi (IIR Young-van Vliet
untuk sigma ≥ 3 px) belum di-port di Fase 1. Dicatat sebagai sub-proyek 2A.5
di spec Fase 2 (§2.8, §6a), dan harus dikerjakan sebelum 2B/2C karena
`Session` belum bisa merender foto berukuran nyata.
