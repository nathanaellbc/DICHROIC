# DICHROIC Fase 2A.5 — Rezim Resolusi Produksi: Rencana Implementasi

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Halation dan DIR benar di ukuran piksel foto sungguhan (σ ≥ 3 px), sehingga `Session` bisa merender gambar ribuan piksel, termasuk lewat tiling, tetap sesuai parity dengan Python.

**Architecture:** Satu modul Gaussian WGSL bersama mencerminkan `fast_gaussian_filter.py`: FIR (reflect, `radius = int(truncate·σ + 0.5)`) untuk σ < 3, dan IIR Young-van Vliet (replikasi sampel, maju lalu mundur, horizontal lalu vertikal) untuk σ ≥ 3, dipilih per kanal. Modul ini digerbangi langsung terhadap Python. Halation dan DIR memakai modul ini sebagai ganti FIR sendiri. `filmFormatMm` masuk `CoreParams`, sehingga fixture 64 px bisa mensimulasikan ukuran piksel 6 µm. Apron tiling dihitung dari σ sebenarnya.

**Tech Stack:** TypeScript, WGSL, Vitest, Python `.venv-ref` (numba `fast_gaussian_filter`).

**Spec:** `docs/superpowers/specs/2026-09-28-dichroic-phase2-core-design.md` §2.8 dan §6a.

## Global Constraints

- Parity Python di atas segalanya; ambang parity yang ada tidak dilonggarkan.
- Satu jalur numerik f32.
- Fixture dibangkitkan `.venv-ref`, dicatat di `tools/README.md`, dan manifest hanya bertambah (tidak ada hash lama yang berubah).
- Pra-hitung float panjang di host tidak boleh terjadi setelah device hidup di Node (CATATAN LINGKUNGAN `src/host/spectral.ts`).
- Glare (σ 0,5 px), unsharp (σ 0,7 px), dan blur grain bersatuan piksel dan tetap kecil. Ketiganya TIDAK diubah di rencana ini.
- Filter difusi (konvolusi FFT hulu) di luar lingkup; masih `locked`, masuk 2C.

## Review Focus

1. **σ campuran antar kanal** (mis. halation core 2,2/2,0/1,6 µm, sehingga sebagian kanal < 3 px dan sebagian ≥ 3 px). Diharapkan tiap kanal memakai jalurnya sendiri seperti Python. Dipin di Task 2 (kasus `mixed`).
2. **Gambar lebih sempit dari radius FIR** (`2·radius ≥ lebar`). Python memakai reflect berulang (`_reflect` periodik). Dipin di Task 2 (kasus gambar 5×4).
3. **Tile di tepi gambar vs tile interior** dengan IIR. Diharapkan tile di tepi identik dengan full-frame, dan tile interior berselisih di bawah 1e-6. Dipin di Task 6.
4. **Gambar besar nyata** (≥ 2048 px) yang dulu melempar di `dir.ts`. Diharapkan render tanpa galat. Dipin di Task 7.
5. **σ = 0 / efek dimatikan.** Diharapkan identitas persis, bukan blur kecil. Dipin di Task 2.

---

## Struktur Berkas

| Berkas | Tanggung jawab |
|---|---|
| `tools/gen_gaussian_reference.py` (baru) | Oracle primitif: `fast_gaussian_filter`/`fast_exponential_filter` pada citra acak ber-seed |
| `test/fixtures/gaussian/` (baru) | Keluaran oracle primitif |
| `src/shaders/gaussian.wgsl` (baru) | FIR reflect + IIR YvV, per kanal |
| `src/engine/gaussian.ts` (baru) | `GaussianBlur`: pipeline, koefisien host, encode per kanal |
| `src/engine/params.ts` (ubah) | `CoreParams.filmFormatMm` |
| `src/engine/spatialRadius.ts` (baru) | Radius apron per tahap dari σ sebenarnya |
| `src/engine/stages/halation.ts`, `src/shaders/halation.wgsl` (ubah) | Blur lewat `GaussianBlur` |
| `src/engine/stages/dir.ts`, `src/shaders/dir.wgsl` (ubah) | Blur lewat `GaussianBlur` |
| `src/engine/stages/grain.ts` (ubah) | Ukuran piksel dari `CoreParams.filmFormatMm` |
| `src/params/plan.ts` (ubah) | `filmFormatMm` dan apron dari σ |
| `tools/gen_reference.py` (ubah) | Keluarga fixture `<case>_px6um`, `<case>_px31um` |

---

### Task 1: Oracle primitif Gaussian

**Files:** Create `tools/gen_gaussian_reference.py`, `test/fixtures/gaussian/*`; Modify `tools/README.md`, `test/fixtures/manifest.json`.

**Interfaces:** Produces fixture `test/fixtures/gaussian/<case>/{input.f32, output.f32, case.json}` dengan `case.json = {width, height, kind: 'gaussian'|'exponential', sigma: [r,g,b], truncate}`.

Kasus (citra acak `np.random.default_rng(seed).random((h, w, 3))`, 64×40 kecuali disebut lain):

| case | kind | σ / λ |
|---|---|---|
| `zero` | gaussian | [0, 0, 0] |
| `small` | gaussian | [0.3, 1.2, 2.9] |
| `threshold` | gaussian | [3.0, 3.0, 3.0] |
| `large` | gaussian | [5, 8, 13] |
| `mixed` | gaussian | [2.5, 3.0, 20] |
| `narrow` (5×4) | gaussian | [2.0, 2.9, 4.0] |
| `exponential` | exponential | λ [4, 10, 30] |

- [ ] **Step 1:** Tulis skrip, jalankan dengan `.venv-ref`, tulis manifest, lalu periksa `git diff test/fixtures/manifest.json` hanya menambah entri.
- [ ] **Step 2:** Commit `test(fixtures): oracle primitif fast_gaussian_filter`.

### Task 2: Modul `GaussianBlur` (FIR + IIR)

**Files:** Create `src/shaders/gaussian.wgsl`, `src/engine/gaussian.ts`, `test/parity/gaussian.test.ts`.

**Interfaces:**
```ts
export interface BlurRect { x: number; y: number; width: number; height: number }
export class GaussianBlur {
  constructor(device: GPUDevice);
  /** Blur per kanal RGB dari `src` ke `dst` (alpha disalin), di dalam `rect` buffer ber-lebar `bufferWidth`. */
  encode(encoder: GPUCommandEncoder, args: {
    src: GPUBuffer; dst: GPUBuffer; scratch: GPUBuffer;
    bufferWidth: number; bufferHeight: number; rect: BlurRect;
    sigma: [number, number, number]; truncate?: number; // default 3
  }): void;
  /** Campuran 3 Gaussian (`_EXPONENTIAL_GAUSSIAN_FITS[3]`), hasil di `dst`. */
  encodeExponential(encoder: GPUCommandEncoder, args: { ...sama, decay: [number, number, number]; accum: GPUBuffer }): void;
  dispose(): void;
}
export const SMALL_SIGMA_MAX = 3;
export function yvvCoefficients(sigma: number): [number, number, number, number]; // B, b1/b0, b2/b0, b3/b0
export function gaussianKernel1d(sigma: number, truncate: number): { weights: Float64Array; radius: number };
```
- Per kanal: σ ≤ 0 berarti salin; σ < 3 berarti FIR (vertikal lalu horizontal, reflect periodik persis `_reflect`); σ ≥ 3 berarti IIR (horizontal: satu thread per baris; vertikal: satu thread per kolom; inisialisasi w1=w2=w3=x0 maju, dan nilai terakhir untuk arah mundur).
- Koefisien dan bobot kernel dihitung host (f64) lalu diunggah sebagai f32 per dispatch.
- Semua operasi hanya di dalam `rect`; indeks batas relatif ke `rect`.

- [ ] **Step 1:** Test unit tanpa GPU: `yvvCoefficients(5)` cocok rumus Python (`q = 0.98711σ − 0.96330`) dan `B + b1 + b2 + b3 = 1` dalam 1e-12; `gaussianKernel1d(1.2, 3)` punya radius 4 dan jumlah bobot 1.
- [ ] **Step 2:** Test GPU per kasus Task 1: `encode` pada `input.f32` dibandingkan `output.f32`. Ambang awal **1e-6 absolut** (input di [0,1]); angka terukur dicatat. `zero` harus bit-identik dengan input.
- [ ] **Step 3:** Jalankan → FAIL; implementasi; → PASS.
- [ ] **Step 4:** Commit `feat(engine): modul GaussianBlur FIR+IIR, parity terhadap fast_gaussian_filter`.

### Task 3: `filmFormatMm` di `CoreParams` dan fixture rezim produksi

**Files:** Modify `src/engine/params.ts`, `src/params/plan.ts`, `src/engine/stages/{halation,dir,grain}.ts`, `test/parity/grain.test.ts`, `test/parity/params.ts`, `tools/gen_reference.py`, `tools/README.md`; Create fixture `hard_edge_px6um`, `impulse_highlight_px6um`, `hard_edge_px31um`, `impulse_highlight_px31um` (deterministik: `deactivate_stochastic_effects=True`, `camera.film_format_mm` = 0.4 dan 2.0).

**Interfaces:** `CoreParams.filmFormatMm: number` (f32, ditambah di akhir `FIELDS`); `RenderParams.filmFormat` dipetakan ke mm (`standard35` → 35, satu-satunya nilai terverifikasi). Tahap membaca `ctx.params.filmFormatMm`, bukan konstanta 35. Opsi `filmFormatMm` di `createGrainStage` dihapus; `grain.test.ts` menyetelnya lewat `CoreParams`.

- [ ] **Step 1:** Test: `buildRenderPlan(...).core.filmFormatMm === 35`; snapshot `test/plan.test.ts` diperbarui dengan field baru.
- [ ] **Step 2:** Implementasi dan plumbing; suite penuh tetap hijau (361+ gerbang lama).
- [ ] **Step 3:** Bangkitkan fixture rezim (`--pixel-regime-case`), semua tap. Catat σ px terkait (halation, DIR, ekor DIR) per ukuran piksel di README.
- [ ] **Step 4:** Commit `feat(engine): filmFormatMm di CoreParams; fixture rezim resolusi produksi`.

### Task 4: Halation lewat `GaussianBlur`

**Files:** Modify `src/engine/stages/halation.ts`, `src/shaders/halation.wgsl`; Test `test/parity/regime.test.ts` (baru).

- Urutan Python (`apply_halation_um`): `core = G(σ_c)`, `tail = Exp(λ_t)`, `scattered = (1−w_s)·core + w_s·tail`, `raw = (1−s)·raw + s·scattered`; lalu `Σ_k a_k·G(σ_h·√k)` dan normalisasi. Operasi kombinasi tetap di `halation.wgsl`; semua blur memakai `GaussianBlur` (hapus `gaussianSampleX/Y`).
- σ (µm → px) dihitung host per run dari `filmFormatMm` dan `fullWidth/Height`.

- [ ] **Step 1:** Test gerbang `log_e_film` untuk keempat fixture rezim (keluarga measured deterministik, rantai sampai halation), ambang **sama dengan gerbang `log_e_film` measured yang ada**. Jalankan → FAIL (FIR lama menyimpang dari IIR, atau melempar).
- [ ] **Step 2:** Implementasi → PASS; gerbang `log_e_film` lama tetap hijau.
- [ ] **Step 3:** Commit `feat(engine): halation memakai GaussianBlur (rezim produksi)`.

### Task 5: DIR lewat `GaussianBlur`

**Files:** Modify `src/engine/stages/dir.ts`, `src/shaders/dir.wgsl`; Test `test/parity/regime.test.ts`.

- `couplers.py:104`: `(1−w)·G(diffusion_size_px) + w·Exp(diffusion_tail_px)` pada `log_raw_correction`. Buang `MAX_KERNEL_RADIUS` dan lemparan radius > 16.

- [ ] **Step 1:** Gerbang `cmy_film` (rantai measured tanpa grain) untuk keempat fixture rezim, ambang sama dengan `measuredChain.test.ts` → FAIL.
- [ ] **Step 2:** Implementasi → PASS; gerbang DIR lama tetap hijau.
- [ ] **Step 3:** Gerbang `rgb_out` penuh untuk fixture rezim (rantai `buildChain` measured, grain mati) → PASS.
- [ ] **Step 4:** Commit `feat(engine): DIR memakai GaussianBlur (rezim produksi)`.

### Task 6: Apron dari σ sebenarnya

**Files:** Create `src/engine/spatialRadius.ts`; Modify `src/engine/graph.ts` (`Stage.spatialRadiusPx` boleh fungsi dari `CoreParams`), `src/engine/stages/{halation,dir}.ts`, `src/params/plan.ts`; Test `test/tiling.test.ts` (tambahan).

**Interfaces:** `spatialRadiusPx(stage: 'halation'|'dir', params: CoreParams): number` = `ceil(APRON_SIGMAS · σ_max)` dengan `APRON_SIGMAS = 5.5` untuk komponen IIR, dan radius FIR (`int(3σ+0.5)`) untuk komponen FIR; tidak pernah di bawah konstanta OFX lama bila efek aktif. `estimateTileOverlap` menerima radius dari fungsi ini.

- IIR membaca seluruh baris, jadi blur dalam tahap memakai `rect` = active rect tahap itu yang digelembungkan radiusnya sendiri, supaya data basi di luar rect tidak ikut rekursi.

- [ ] **Step 1:** Test: render ter-tile (`maxBufferBytes` kecil, memaksa ≥ 4 tile) vs full-frame untuk gambar sintetis 512×384 pada ukuran piksel 6 µm (`filmFormatMm = 3.1`): selisih maks ≤ **1e-6**; tile yang menyentuh tepi gambar di bagian yang tidak bersebelahan dengan tile lain identik. Gerbang bit-identik lama (rezim FIR) tetap berlaku apa adanya.
- [ ] **Step 2:** FAIL → implementasi → PASS.
- [ ] **Step 3:** Commit `feat(engine): apron tiling dihitung dari sigma sebenarnya`.

### Task 7: Penerimaan di `Session`

**Files:** Modify `test/session.test.ts`.

- [ ] **Step 1:** Kembalikan test pratinjau ke batas bawaan: gambar 2048×1365 → pratinjau 1024×683, tanpa galat.
- [ ] **Step 2:** Render penuh 2048×1365 dan render ter-tile paksa dari gambar yang sama (lewat `Session` dengan device limit kecil tidak mungkin, jadi lewat `RenderGraph` langsung dengan plan `Session`) → selisih ≤ 1e-6.
- [ ] **Step 3:** Commit `test(session): penerimaan rezim produksi`.

### Task 8: Penutup

- [ ] **Step 1:** Perbarui spec Fase 2 §6a dengan angka terukur (galat primitif, galat tile) dan status. `npm run typecheck && npm run lint && npm test` dua kali.
- [ ] **Step 2:** Commit `plan: Fase 2A.5 selesai`.

## Status 2A.5

**Selesai 2026-09-28** (branch `phase2/core`, 098c80b..HEAD). tsc dan eslint
bersih; suite 519 lulus + 1 dilewati (520) di 29 berkas. Angka terukur dan
invarian tiling yang baru ada di spec Fase 2 §6a.1.

| Task | Commit |
|---|---|
| 1 oracle primitif | 8bb417e |
| 2 `GaussianBlur` df64 | ce5750b, da0c6c3 |
| 3 `FrameParams` + fixture rezim | 9510bfa |
| 4 halation | 0ec463f |
| 5 DIR | 9fd9d56 |
| 6 apron dari σ | 80f76b4 |
| 7 penerimaan `Session` | 0e80574 |

Penyimpangan dari rencana (lihat ledger): `filmFormatMm` lewat `FrameParams`,
bukan `CoreParams`; apron IIR 10σ, bukan 5,5σ; gerbang tile `rgb_out` 2e-6.
