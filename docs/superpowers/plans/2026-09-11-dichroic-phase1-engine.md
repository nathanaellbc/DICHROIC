# DICHROIC Fase 1 — Engine Terverifikasi: Rencana Implementasi

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membangun engine WebGPU headless di `spektra/` yang menjalankan sembilan tahap pipeline film spektral SpektraFilm dan cocok dengan implementasi referensi Python pada setiap tap kanonis, dalam ambang yang ditetapkan.

**Architecture:** Transliterasi bertahap. Setiap tahap GPU di-port dari dua pandangan atas matematika yang sama — Python NumPy (`andreavolpato/spektrafilm`) untuk *apa* yang dihitung, GLSL Vulkan (`chaert-s/spektrafilm-ofx`) untuk *bagaimana* ia disusun di GPU — lalu digerbangi terhadap keluaran Python pada tap-nya sebelum tahap berikutnya disentuh. Math host yang statis di-bake sekali dengan skrip Python hulu; hanya math yang berubah saat parameter berubah yang ditulis ulang di TypeScript.

**Tech Stack:** TypeScript (strict), WebGPU (WGSL), Vite, Vitest, Node 20+, paket `webgpu` (Dawn) untuk WebGPU di Node. Python 3.11+ untuk bake dan pembangkitan referensi (waktu pengembangan saja).

**Spec:** `docs/superpowers/specs/2026-09-11-dichroic-design.md`

## Global Constraints

Setiap tugas di bawah ini secara implisit tunduk pada seluruh butir berikut.

- **Kualitas gambar di atas performa.** Kapan pun ada dua opsi dan salah satunya menghasilkan gambar lebih baik, ambil yang lebih baik. Ukuran unduhan, VRAM, dan waktu render boleh dikorbankan.
- **"Lebih baik" berarti lebih setia pada REFERENSI PYTHON**, bukan lebih halus secara teori DAN BUKAN lebih mirip shader OFX. Ketika Python memakai aproksimasi, tiru aproksimasinya persis — itu yang terjadi di Halation, di mana Python sendiri memanggil `fast_exponential_filter` yang men-dispatch ekor eksponensial ke campuran Gaussian. Ketika Python TIDAK memakai aproksimasi, jangan memperkenalkan satu pun, sekalipun shader OFX memakainya.
  > **KOREKSI (Task 15).** Butir ini dulu berbunyi "(blur piramida di Diffusion), tiru persis". Itu SALAH dan diangkat oleh implementer Task 15, benar: `apply_diffusion_filter_um` (`model/diffusion.py:585-640`) melakukan `scipy.signal.fftconvolve` EKSAK per kanal terhadap PSF multi-eksponensial analitik dari `diffusion_filter_psf`, dengan padding `reflect` dan radius `ceil(max(8*lambda_max*scale/pixel_size_um, 5))`. Tidak ada piramida di sisi Python. Klaim "piramida" digeneralisasi dari Halation tanpa diverifikasi ulang — kesalahan yang sama bentuknya dengan mengasumsikan literal C++ hulu adalah oracle (spec §6.3.1), hanya pada sumbu lain: **hulu punya DUA implementasi dan yang mengikat kita adalah Python.**
- **f32 di seluruh rantai.** Fitur WebGPU `shader-f16` tidak dipakai — ia menciptakan dua jalur numerik berbeda tergantung perangkat. Transport f16 diperbolehkan hanya untuk LUT spektral, yang sumbernya memang f16, dan diekspansi ke f32 saat muat.
- **WebGPU saja.** Tidak ada fallback WebGL2. Perangkat tanpa WebGPU mendapat pesan jelas, bukan jalur render kedua.
- **Maksimum 8 storage buffer per stage.** Itu jaminan WebGPU. Jangan menegosiasikan limit adapter yang lebih tinggi; pak tabel read-only ke dalam arena.
- **Lisensi GPL-3.0.** Tidak ada satu pun impor yang menyeberang antara `spektra/` dan `web/`, ke arah mana pun. Dijaga aturan ESLint; pelanggaran menggagalkan build.
- **Nama tap kanonis**, persis seperti referensi Python: `rgb_in`, `rgb_pre`, `log_e_film`, `cmy_film`, `log_e_print`, `cmy_print`, `rgb_out`.
- **Ambang verifikasi:** max abs error ≤ `1e-5` untuk tap pra-grain, ≤ `1e-4` untuk statistik pasca-grain. **Ambang tidak boleh dilonggarkan untuk membuat test lulus.** Meleset di orde 1e-3 berarti ada perbedaan struktural yang harus ditemukan.
- **Keluarga fixture per gerbang** (dikoreksi setelah Task 11 — lih. spec §6.3.2/§6.3.3). Satu tap Python BUKAN satu tahap GPU: `FilmingStage.expose()` menjalankan empat konvolusi spasial di dalam satu fungsi sebelum `log10` yang menghasilkan `log_e_film`, sementara hulu memisahkan halation ke `SpektraHalation.comp` tersendiri. `deactivate_stochastic_effects` — satu-satunya saklar yang Task 3 pakai — hanya mematikan `grain` dan `glare`, TIDAK halation. Karena itu:
  - Gerbang **per-piksel** (Task 11, 12, 13, 17, 18) diukur terhadap keluarga **`_lut`** (`debug.lut_mode = True`): efek spasial, stokastik, auto-exposure, `boost_ev`, dan koreksi scanner semuanya mati.
  - Gerbang **spasial** (Task 14 Halation, Task 15 Diffusion) dan **stokastik** (Task 16 Grain) diukur di tapnya sendiri terhadap keluarga yang efeknya HIDUP.
  - Tidak ada yang dilewatkan: halation tetap diverifikasi, hanya tidak di gerbang yang tidak mengimplementasikannya. `lut_mode` juga bukan konsesi — ia regime yang ekspor `.cube` DICHROIC kapalkan.
- **Peta tap → tahap di bawah `lut_mode`** (diaudit sekali, setelah Task 12 terhalang oleh hal yang sudah tertulis di spec §6.3.2 tapi tidak saya terapkan). Setiap gerbang di bawah ini HANYA boleh dipasang setelah SEMUA tahap di kolom kanannya ada:

  | Tap | Tahap yang dibutuhkan | Catatan |
  |---|---|---|
  | `rgb_in` | Task 9 materializeActiveRegion | ✅ lulus |
  | `log_e_film` | Task 11 FilmExposure | ✅ lulus 3.3e-7..5.7e-7. `boost_ev`, diffusion, lens blur, halation SEMUA mati di `lut_mode`, jadi satu tahap cukup |
  | `cmy_film` | Task 12 CurveDevelop **+ Task 13 Dir** | `develop()` = normalisasi + `develop_simple` + `apply_density_correction_dir_couplers` + `apply_grain`. Grain mati di `lut_mode`; DIR **TIDAK** — `lut_mode` hanya menolkan `diffusion_size_um`, sementara `DirCouplersParams.active` tetap `True` (params_schema.py:131). Gerbangnya milik Task 13, bukan Task 12 |
  | `log_e_print` | Task 17 PrintScan (paruh expose) | `print_exposure=1.0` dan diffusion enlarger mati di `lut_mode`, jadi satu tahap cukup |
  | `cmy_print` | Task 17 PrintScan (paruh develop) | `develop_print_morph`, per-piksel |
  | `rgb_out` | Task 18 ScannerPost | glare (stokastik), lens blur, unsharp SEMUA mati di `lut_mode`, jadi satu tahap cukup |

  Halation (Task 14), Diffusion (Task 15) dan Grain (Task 16) TIDAK punya tap sendiri di daftar kanonis — mereka diverifikasi terhadap keluarga fixture yang efeknya HIDUP di tap tetangganya, bukan di gerbang `lut_mode`.
- **Sumber data profil: repo PYTHON, bukan repo OFX** (ditemukan Task 12). Kedua repo hulu membundel `Resources/data/profiles/{stock}.json` masing-masing, dan `density_curves`/`density_curves_layers` di dalamnya BERBEDA pada ke-28 stok — 0.034 (kodak_ektachrome_100) sampai 0.597 (kodak_2393) max abs, tiga sampai lima orde di atas ambang 1e-5. `log_exposure` identik persis (selisih 0 di ke-28 stok), begitu pula setiap field spektral/matriks lain yang baker ini pancarkan. Fixture kita datang dari `SimulationPipeline` repo PY, jadi kurva PY yang harus dibakar; kalau tidak, setiap gerbang `cmy_film`/`cmy_print` (Task 12-18) gagal *by construction* sebaik apa pun shadernya ditransliterasi. Ini contoh kedua dari aturan spec §6.3.1 setelah `inputToReferenceXyz`/CAT02 — dan kedua kalinya pemeriksaan terhadap literal C++ hulu justru yang MENYEMBUNYIKANNYA.
- **Kerja CPU berat WAJIB selesai sebelum `acquireDevice()`** (dikoreksi di 550e39d; catatan "racy" sebelumnya SALAH). Kerja float CPU panjang setelah `GPUDevice` hidup men-segfault proses Node di titik sinkronisasi queue berikutnya, 100% deterministik. `buildArenas()` sudah DIHAPUS dan digantikan `precomputeArenaData()` (murni CPU) + `uploadArenas()` (hanya buffer). Urutan: muat aset → pra-hitung → akuisisi device → unggah. Lih. CATATAN LINGKUNGAN di `src/host/spectral.ts`.
- **Cakupan stock:** 28 profil — 20 film, 8 kertas/print film. `Resources/data/profiles/archive/` di luar cakupan.
- **TypeScript strict.** `strict: true`, `noUncheckedIndexedAccess: true`. Tidak ada `any` di kode produksi.
- **Commit sesering mungkin**, satu commit per tugas minimum.

## Repositori hulu

Dua repo hulu di-clone **di luar** repo EMULSION (keduanya besar dan GPL; jangan di-vendor). Lokasinya diberitahukan lewat variabel lingkungan:

| Variabel | Repo | Dipakai untuk |
|---|---|---|
| `SPEKTRAFILM_PY` | `https://github.com/andreavolpato/spektrafilm` | Implementasi referensi, oracle verifikasi, pembacaan model |
| `SPEKTRAFILM_OFX` | `https://github.com/chaert-s/spektrafilm-ofx` | Struktur kernel GPU (GLSL Vulkan), skrip bake, kontrak parameter |

---

## Struktur Berkas

```
spektra/
├── LICENSE                          GPL-3.0, teks penuh
├── README.md                        atribusi hulu, batas lisensi, cara build
├── package.json                     mandiri; BUKAN workspace bersama web/
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── eslint.config.js                 aturan batas impor
│
├── tools/                           Python, waktu pengembangan saja
│   ├── README.md                    perintah persis yang terbukti jalan
│   ├── setup_envs.md                langkah pemasangan dua venv
│   ├── bake_web_assets.py           emitter web untuk generate_profile_curves.py
│   └── gen_reference.py             bangkitkan .f32 referensi dari SimulationPipeline
│
├── public/data/                     aset ter-bake (hasil bake_web_assets.py)
│   ├── manifest.json                daftar stock, offset, dimensi
│   ├── stocks.f32                   kurva 28 stock, biner
│   ├── hanatos.f16                  LUT spektral 192×192×81
│   └── static.f32                   CMF, illuminant, matriks, LUT transfer
│
├── src/
│   ├── profiles/
│   │   ├── types.ts                 tipe Profile, Manifest
│   │   └── load.ts                  fetch + parse aset biner
│   ├── host/                        TS murni: tanpa GPU, tanpa DOM
│   │   ├── types.ts                 RenderParams
│   │   └── (diisi per tahap saat dibutuhkan)
│   ├── engine/
│   │   ├── device.ts                akuisisi adapter/device, laporan limit
│   │   ├── params.ts                struct CoreParams: WGSL + writer TS
│   │   ├── arena.ts                 packing tabel read-only ke buffer arena
│   │   ├── taps.ts                  nama tap kanonis
│   │   ├── graph.ts                 urutan tahap, ping-pong, collect di tap
│   │   └── stages/                  satu modul TS per tahap
│   └── shaders/                     satu .wgsl per tahap
│
└── test/
    ├── fixtures/                    .f32 referensi + params.json (di-commit)
    └── parity/
        ├── compare.ts               pembanding + ambang
        └── <tahap>.test.ts          satu berkas uji per tahap
```

---

## Task 1: Toolchain hulu terverifikasi

Tugas ini tidak menghasilkan kode aplikasi. Ia membuktikan bahwa kedua toolchain Python berjalan sebelum apa pun dibangun di atasnya. Jika ia gagal, seluruh rencana harus dipikirkan ulang — dan itu harus diketahui hari ini.

**Files:**
- Create: `spektra/tools/setup_envs.md`
- Create: `spektra/tools/smoke_upstream.py`
- Create: `spektra/tools/README.md`

**Interfaces:**
- Consumes: tidak ada
- Produces: variabel lingkungan `SPEKTRAFILM_PY` dan `SPEKTRAFILM_OFX`; dua venv yang berfungsi; `smoke_upstream.py` yang keluar dengan kode 0

- [ ] **Step 1: Clone kedua repo hulu di luar repo EMULSION**

```bash
mkdir -p ~/src/upstream
git clone https://github.com/andreavolpato/spektrafilm.git ~/src/upstream/spektrafilm
git clone https://github.com/chaert-s/spektrafilm-ofx.git ~/src/upstream/spektrafilm-ofx
```

Catat kedua path. Di PowerShell, setel untuk sesi ini:

```bash
export SPEKTRAFILM_PY=~/src/upstream/spektrafilm
export SPEKTRAFILM_OFX=~/src/upstream/spektrafilm-ofx
```

- [ ] **Step 2: Buat venv bake dan pasang dependensinya**

```bash
python -m venv ~/.venvs/spektra-bake && ~/.venvs/spektra-bake/Scripts/pip install numpy scipy colour-science
```

- [ ] **Step 3: Jalankan skrip bake hulu apa adanya**

```bash
~/.venvs/spektra-bake/Scripts/python "$SPEKTRAFILM_OFX/tools/generate_profile_curves.py" --output /tmp/spektra-probe/SpektraGeneratedProfileCurves.cpp --hanatos-output /tmp/spektra-probe/SpektraHanatos2025Spectra.f32 --output-gamut-compression-output /tmp/spektra-probe/SpektraOutputGamutCompression.f32
```

Harapan: tiga berkas tertulis. `SpektraHanatos2025Spectra.f32` berukuran tepat `2985984 * 4 = 11943936` byte. Jika skrip gagal, catat galat persisnya di `tools/README.md` dan **berhenti** — laporkan ke pemilik proyek sebelum melanjutkan.

- [ ] **Step 4: Buat venv referensi dan pasang paket spektrafilm**

Jangan pakai `pip install -e` polos. `pyproject.toml` hulu menaruh `qtpy`,
`pyside6`, `napari`, `Pillow`, `pyconify`, dan `markdown` di daftar dependensi
utama, padahal komentar penulisnya sendiri menyatakan runtime inti tidak
mengimpornya — ia terpasang hanya karena paket itu juga mengapalkan aplikasi
GUI. Menariknya berarti ratusan megabyte dan dua paket paling rapuh di Windows,
untuk kode yang tidak akan pernah kita panggil.

```bash
python -m venv D:/Projects/upstream/.venv-ref
D:/Projects/upstream/.venv-ref/Scripts/pip install --no-deps -e "$SPEKTRAFILM_PY"
D:/Projects/upstream/.venv-ref/Scripts/pip install numpy scipy colour-science scikit-image matplotlib opt-einsum numba OpenImageIO pyfftw rawpy exiv2 lensfunpy
```

Jika `SimulationPipeline` ternyata mengimpor sesuatu dari daftar GUI secara
transitif, `smoke_upstream.py` akan menangkapnya seketika — pasang paket itu
saja, jangan kembali memasang seluruh stack GUI.

Jika `OpenImageIO` atau `pyfftw` gagal dibangun di Windows, ulangi langkah ini
di WSL atau Docker dan catat itu di `tools/README.md`. Ini konsekuensi yang
sudah diantisipasi, bukan kegagalan rencana.

- [ ] **Step 5: Tulis smoke test hulu**

Buat `spektra/tools/smoke_upstream.py`:

```python
#!/usr/bin/env python3
"""Buktikan kedua toolchain hulu berjalan. Keluar 0 jika ya."""
import sys
import numpy as np

from spektrafilm.runtime.params_builder import digest_params, init_params
from spektrafilm.runtime.pipeline import SimulationPipeline
from spektrafilm.runtime.topology import Tap

EXPECTED_TAPS = (
    "rgb_in", "rgb_pre", "log_e_film", "cmy_film",
    "log_e_print", "cmy_print", "rgb_out",
)


def main() -> int:
    actual = tuple(
        getattr(Tap, name)
        for name in dir(Tap)
        if name.isupper() and not name.startswith("_")
    )
    missing = set(EXPECTED_TAPS) - set(actual)
    if missing:
        print(f"FAIL: tap hilang dari referensi hulu: {sorted(missing)}")
        return 1

    ramp = np.repeat(
        np.linspace(0.01, 1.0, 32, dtype=np.float64)[None, :, None], 16, axis=0
    ).repeat(3, axis=2)

    params = digest_params(init_params())
    out = SimulationPipeline(params).process(ramp, collect=Tap.CMY_FILM)

    if out.shape[:2] != ramp.shape[:2]:
        print(f"FAIL: bentuk keluaran {out.shape} tidak cocok dengan input {ramp.shape}")
        return 1
    if not np.all(np.isfinite(out)):
        print("FAIL: keluaran memuat nilai tak hingga")
        return 1

    print(f"OK: cmy_film shape={out.shape} min={out.min():.6f} max={out.max():.6f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 6: Jalankan smoke test**

```bash
~/.venvs/spektra-ref/Scripts/python spektra/tools/smoke_upstream.py
```

Harapan: `OK: cmy_film shape=(16, 32, 3) min=... max=...` dan keluar 0.

Jika `init_params()` atau `SimulationPipeline(...).run(...)` memiliki tanda tangan berbeda dari yang diasumsikan di sini, baca `$SPEKTRAFILM_PY/src/spektrafilm/runtime/api.py` dan `params_builder.py`, sesuaikan skrip, lalu **perbarui tugas-tugas berikutnya di rencana ini** yang memakai tanda tangan itu (Task 3).

- [ ] **Step 7: Tulis tools/README.md**

Catat: path kedua repo hulu, commit hash keduanya (`git -C $SPEKTRAFILM_PY rev-parse HEAD`), perintah persis yang berhasil, dan setiap penyimpangan yang diperlukan (WSL, conda, versi paket yang dipaksa).

- [ ] **Step 8: Commit**

```bash
git add spektra/tools/
git commit -m "chore(spektra): verify upstream Python toolchains and record exact commands"
```

---

## Task 2: Scaffold proyek spektra/

**Files:**
- Create: `spektra/package.json`, `spektra/tsconfig.json`, `spektra/vite.config.ts`, `spektra/vitest.config.ts`, `spektra/eslint.config.js`, `spektra/LICENSE`, `spektra/README.md`
- Create: `spektra/test/boundary.test.ts`

**Interfaces:**
- Consumes: tidak ada
- Produces: `npm test`, `npm run typecheck`, `npm run lint` yang berjalan di dalam `spektra/`

- [ ] **Step 1: Tulis package.json**

```json
{
  "name": "dichroic",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "license": "GPL-3.0-or-later",
  "description": "DICHROIC — spectral film simulation in the browser, on WebGPU.",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "typecheck": "tsc -b --noEmit",
    "lint": "eslint src test",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^26.3.0",
    "@webgpu/types": "^0.1.60",
    "eslint": "^9.18.0",
    "typescript": "^5.7.2",
    "typescript-eslint": "^8.20.0",
    "vite": "^6.0.5",
    "vitest": "^2.1.8",
    "webgpu": "^0.3.4"
  }
}
```

- [ ] **Step 2: Tulis tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "types": ["@webgpu/types", "node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src", "test", "*.config.ts"]
}
```

- [ ] **Step 3: Tulis eslint.config.js dengan aturan batas**

```javascript
import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/web/**', '../../web/*', '../../../web/*'],
          message:
            'DICHROIC berlisensi GPL-3.0 dan EMULSION tidak. Impor menyeberang ' +
            'antara spektra/ dan web/ dilarang ke arah mana pun.',
        }],
      }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
```

- [ ] **Step 4: Salin teks LICENSE GPL-3.0**

```bash
cp "$SPEKTRAFILM_OFX/LICENSE.txt" spektra/LICENSE
```

- [ ] **Step 5: Tulis README.md dengan atribusi**

Wajib memuat: bahwa DICHROIC adalah karya turunan dari SpektraFilm oleh Andrea Volpato; tautan ke `andreavolpato/spektrafilm` dan `chaert-s/spektrafilm-ofx`; bahwa ia GPL-3.0; bahwa `web/` (EMULSION) adalah proyek terpisah yang tidak tercakup lisensi ini; dan salinan `THIRD_PARTY_NOTICES.txt` hulu.

- [ ] **Step 6: Tulis test batas yang gagal**

Buat `spektra/test/boundary.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function allSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) allSourceFiles(full, acc);
    else if (/\.(ts|tsx|wgsl)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe('batas lisensi', () => {
  it('tidak ada berkas sumber yang menyebut web/ EMULSION', () => {
    const offenders = allSourceFiles('src').filter((f) =>
      /from\s+['"][^'"]*\/web\//.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 7: Jalankan test — harus gagal karena `src` belum ada**

```bash
cd spektra && npm install && npm test
```

Harapan: FAIL dengan `ENOENT` pada direktori `src`.

- [ ] **Step 8: Buat direktori src dan satu berkas placeholder yang sah**

Buat `spektra/src/engine/taps.ts`:

```typescript
/** Nama tap kanonis, persis seperti implementasi referensi Python. */
export const Tap = {
  RGB_IN: 'rgb_in',
  RGB_PRE: 'rgb_pre',
  LOG_E_FILM: 'log_e_film',
  CMY_FILM: 'cmy_film',
  LOG_E_PRINT: 'log_e_print',
  CMY_PRINT: 'cmy_print',
  RGB_OUT: 'rgb_out',
} as const;

export type TapName = (typeof Tap)[keyof typeof Tap];

/** Urutan tap sepanjang pipeline, dari masukan ke keluaran. */
export const TAP_ORDER: readonly TapName[] = [
  Tap.RGB_IN,
  Tap.RGB_PRE,
  Tap.LOG_E_FILM,
  Tap.CMY_FILM,
  Tap.LOG_E_PRINT,
  Tap.CMY_PRINT,
  Tap.RGB_OUT,
];
```

- [ ] **Step 9: Jalankan test — harus lulus**

```bash
cd spektra && npm test && npm run typecheck && npm run lint
```

Harapan: ketiganya PASS.

- [ ] **Step 10: Commit**

```bash
git add spektra/
git commit -m "feat(spektra): scaffold DICHROIC project with GPL-3.0 boundary enforcement"
```

---

## Task 3: Pembangkit referensi

**Files:**
- Create: `spektra/tools/gen_reference.py`
- Create: `spektra/test/fixtures/` (diisi oleh skrip)

**Interfaces:**
- Consumes: `SPEKTRAFILM_PY`, venv referensi dari Task 1 (`D:/Projects/upstream/.venv-ref`)
- API hulu yang sudah diverifikasi di Task 1 — pakai persis ini, bukan tebakan:
  - `init_params(film_profile="kodak_portra_400", print_profile="kodak_portra_endura") -> RuntimePhotoParams`
  - `digest_params(params, apply_stocks_specifics=True) -> RuntimePhotoParams` — **wajib** dipanggil sebelum params dipakai pipeline
  - `SimulationPipeline(params).process(image, *, inject=None, collect=None)` — **tidak ada** metode `.run()`
- Produces: untuk tiap kasus, `test/fixtures/<case>/<tap>.f32` (little-endian f32, RGB interleaved, row-major) dan `test/fixtures/<case>/case.json` berisi `{name, width, height, stochastic, taps}` — `taps` adalah daftar `{tap, channels}`, dan `stochastic` menandai keluarga mana kasus itu

**Dua keluarga fixture, dan alasannya.**

Uji determinisme di tugas ini menemukan bahwa `rgb_out` **tidak** stabil antar-run: `add_glare` (`spektrafilm/model/glare.py`) menarik medan derau lognormal lewat kernel numba `@njit(parallel=True)` yang memanggil `np.random.randn()` di dalam `prange`. Keadaan RNG paralel numba terpisah dari `numpy.random` dan tidak dapat di-seed lewat field params mana pun — tidak seperti `film_render.grain`, yang mengekspos `seed=`.

Tetapi ini bukan hambatan yang harus diakali; ia mengungkap cacat perencanaan. **Gerbang `rgb_out` pixel-exact dengan glare aktif tidak pernah mungkin**, karena RNG WGSL kita akan selalu algoritma yang berbeda dari milik Python, ter-seed atau tidak. Perbandingan piksel-demi-piksel atas efek stokastik lintas dua implementasi RNG tidak punya arti.

Maka fixture dibangkitkan dalam dua keluarga:

| Keluarga | Setelan | Dipakai oleh | Metode gerbang |
|---|---|---|---|
| **Deterministik** | `debug.deactivate_stochastic_effects = True` | Task 11–15, 17, 18 | per piksel, ≤ 1e-5 |
| **Stokastik** | default hulu (glare dan grain aktif) | Task 16 (grain), Task 18 (glare) | statistik: mean, varians, spektrum daya |

Saklar `deactivate_stochastic_effects` adalah milik hulu dan mematikan tepat dua hal — `film_render.grain.active` dan `print_render.glare.active` — sehingga garis yang ia tarik persis garis antara kedua keluarga ini. Ini bukan pelonggaran toleransi: gerbang deterministik tetap 1e-5, dan gerbang statistik memang statistik menurut sifat efeknya, bukan menurut kompromi.

Kasus keluarga stokastik diberi akhiran `_stochastic` pada namanya.

- [ ] **Step 1: Tulis gen_reference.py**

```python
#!/usr/bin/env python3
"""Bangkitkan .f32 referensi dari SimulationPipeline pada tiap tap kanonis.

Dijalankan sekali; keluarannya di-commit. Pengembangan harian dan CI tidak
memerlukan Python.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from spektrafilm.runtime.params_builder import digest_params, init_params
from spektrafilm.runtime.pipeline import SimulationPipeline
from spektrafilm.runtime.topology import Tap

TAPS = [
    Tap.RGB_PRE, Tap.LOG_E_FILM, Tap.CMY_FILM,
    Tap.LOG_E_PRINT, Tap.CMY_PRINT, Tap.RGB_OUT,
]


def gray_ramp(width: int = 32, height: int = 16) -> np.ndarray:
    ramp = np.linspace(0.01, 1.0, width, dtype=np.float64)
    return np.repeat(ramp[None, :, None], height, axis=0).repeat(3, axis=2)


def log_gray_ramp(width: int = 32, height: int = 16) -> np.ndarray:
    ramp = np.logspace(-3.0, 1.0, width, dtype=np.float64)
    return np.repeat(ramp[None, :, None], height, axis=0).repeat(3, axis=2)


def hard_edge(width: int = 64, height: int = 64) -> np.ndarray:
    img = np.full((height, width, 3), 0.02, dtype=np.float64)
    img[:, width // 2:, :] = 0.9
    return img


def impulse_highlight(width: int = 64, height: int = 64) -> np.ndarray:
    img = np.full((height, width, 3), 0.02, dtype=np.float64)
    img[height // 2, width // 2, :] = 50.0
    return img


def color_patches() -> np.ndarray:
    colors = np.array([
        [0.184, 0.184, 0.184], [0.5, 0.05, 0.05], [0.05, 0.5, 0.05],
        [0.05, 0.05, 0.5], [0.8, 0.7, 0.45], [0.02, 0.02, 0.02],
        [2.0, 2.0, 2.0], [0.9, 0.4, 0.1],
    ], dtype=np.float64)
    return np.repeat(colors[None, :, :], 8, axis=0)


CASES = {
    "gray_ramp": gray_ramp,
    "log_gray_ramp": log_gray_ramp,
    "hard_edge": hard_edge,
    "impulse_highlight": impulse_highlight,
    "color_patches": color_patches,
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--case", choices=sorted(CASES), action="append")
    args = parser.parse_args()

    names = args.case or sorted(CASES)
    for name in names:
        image = CASES[name]()
        case_dir = args.out / name
        case_dir.mkdir(parents=True, exist_ok=True)

        (case_dir / "input.f32").write_bytes(
            np.ascontiguousarray(image, dtype="<f4").tobytes()
        )

        written = []
        for tap in TAPS:
            # init_params() membangun objek mentah; digest_params() WAJIB
            # sebelum dipakai pipeline (lihat docstring hulu). Verifikasi
            # params.settings.preview_mode bernilai False — digest_params
            # menolkan enlarger.lens_blur saat mode itu aktif, dan referensi
            # kita harus mode produksi.
            raw = init_params()
            # Efek stokastik dimatikan untuk keluarga deterministik. Saklar ini
            # milik hulu dan mematikan tepat dua hal: film_render.grain.active
            # dan print_render.glare.active (params_builder.py:140-142).
            raw.debug.deactivate_stochastic_effects = True
            params = digest_params(raw)
            assert not params.settings.preview_mode, "referensi tidak boleh preview_mode"
            assert not params.print_render.glare.active, "glare harus mati di keluarga deterministik"
            assert not params.film_render.grain.active, "grain harus mati di keluarga deterministik"
            result = SimulationPipeline(params).process(image, collect=tap)
            arr = np.ascontiguousarray(result, dtype="<f4")
            (case_dir / f"{tap}.f32").write_bytes(arr.tobytes())
            written.append({"tap": tap, "channels": int(arr.shape[2])})

        (case_dir / "case.json").write_text(
            json.dumps({
                "name": name,
                "height": int(image.shape[0]),
                "width": int(image.shape[1]),
                "stochastic": stochastic,
                "taps": written,
            }, indent=2),
            encoding="utf-8",
        )
        print(f"Wrote {case_dir} ({len(written)} taps)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Jalankan untuk satu kasus**

```bash
~/.venvs/spektra-ref/Scripts/python spektra/tools/gen_reference.py --out spektra/test/fixtures --case gray_ramp
```

Harapan: `spektra/test/fixtures/gray_ramp/` memuat `input.f32`, `case.json`, dan enam berkas `<tap>.f32`.

- [ ] **Step 3: Tulis test determinisme**

Buat `spektra/test/fixtures.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CASE_DIR = join('test', 'fixtures', 'gray_ramp');

describe('fixture referensi', () => {
  it('case.json cocok dengan ukuran berkas f32', () => {
    const meta = JSON.parse(readFileSync(join(CASE_DIR, 'case.json'), 'utf8'));
    for (const { tap, channels } of meta.taps) {
      const bytes = readFileSync(join(CASE_DIR, `${tap}.f32`)).byteLength;
      expect(bytes, `${tap} byte length`).toBe(
        meta.width * meta.height * channels * 4,
      );
    }
  });

  it('tidak ada nilai tak hingga di tap mana pun', () => {
    const meta = JSON.parse(readFileSync(join(CASE_DIR, 'case.json'), 'utf8'));
    for (const { tap } of meta.taps) {
      const buf = readFileSync(join(CASE_DIR, `${tap}.f32`));
      const values = new Float32Array(
        buf.buffer, buf.byteOffset, buf.byteLength / 4,
      );
      expect(values.every(Number.isFinite), `${tap} finite`).toBe(true);
    }
  });
});
```

- [ ] **Step 4: Jalankan test**

```bash
cd spektra && npm test -- fixtures
```

Harapan: PASS. Jika jumlah kanal pada tap densitas ternyata bukan 3, itu informasi penting — perbarui ekspektasi di Task 13 dan Task 18 sesuai temuan.

- [ ] **Step 5: Bangkitkan seluruh kasus**

```bash
~/.venvs/spektra-ref/Scripts/python spektra/tools/gen_reference.py --out spektra/test/fixtures
```

- [ ] **Step 6: Commit**

```bash
git add spektra/tools/gen_reference.py spektra/test/fixtures spektra/test/fixtures.test.ts
git commit -m "feat(spektra): generate reference fixtures from Python SimulationPipeline"
```

---

## Task 4: Emitter aset web

**Files:**
- Create: `spektra/tools/bake_web_assets.py`
- Create: `spektra/public/data/` (diisi oleh skrip)
- Create: `spektra/test/assets.test.ts`

**Interfaces:**
- Consumes: `SPEKTRAFILM_OFX`, venv `spektra-bake` dari Task 1
- Produces: `public/data/manifest.json`, `stocks.f32`, `hanatos.f16`, `static.f32`.

**Cakupan sebenarnya, dikoreksi setelah Task 4 dijalankan.** Daftar definitif apa yang harus dipancarkan bukan tebakan: `$SPEKTRAFILM_OFX/src/SpektraProfileCurves.h` adalah kontrak yang dikonsumsi GPU. Ia mendeklarasikan `struct ProfileCurveSet` dengan **30 member per-stock** (23 larik float, 4 string, 2 hitungan, 1 skalar) dan **16 fungsi akses tabel global**. Versi pertama tugas ini hanya memancarkan dua field per-stock (`logExposure`, `densityCurves`) dan satu tabel global — jauh dari cukup, dan Task 11 akan buntu seketika tanpa sisanya.

Per-stock yang harus ikut: `wavelengths`, `logSensitivity`, `bandpassHanatos2025`, `hanatos2026WindowParams`, `referenceIlluminantSpectrum`, `inputToReferenceXyz`, `inputToSrgb`, `mallettBasisIlluminant`, `mallettRawMidgrayGreen`, `channelDensity`, `baseDensity`, `densityCurveMinimum`, `densityCurveLayers`, `densityCurveLayerMaxima`, `halationStrength`, `halationFirstSigmaUm`, `dirGammaSameLayerRgb`, `dirGammaRToGb`, `dirGammaGToRb`, `dirGammaBToRg`, `scanIlluminant`, `scanToOutputRgb`, beserta `wavelengthCount` dan `exposureCount`.

Di luar kontrak header, empat field tambahan sah dan memang diperlukan: `license`, `citation`, dan `datasource` diwajibkan §3 spec untuk atribusi GPL, dan `viewingIlluminant` dipakai tahap scanning Python (`self._print.info.viewing_illuminant`) sehingga Task 18 membutuhkannya.

Global yang harus ikut: `inputMeterXyzMatrices`, `colorTransferKinds`, `colorTransferParams`, `colorDecodeLuts`, `colorEncodeLuts`, `standardObserverCmfs`, `thKg3Illuminant`, `customEnlargerFilters`, `neutralPrintFilters`, `academyPrinterDensityResponsivities`, `academyPrinterDensityNeutralOffsets`, `academyPrinterDensityData`, `academyPrinterDensityInfluxSpectrum`, batas `colorDecodeLutMin/Max` dan `colorEncodeLutMin/Max`, label ke-26 colour space, serta konstanta `kSpektraColorSpaceCount = 26`, `kSpektraColorTransferLutSize = 4096`, dan `kSpektraOutputGamutCompressionStride = 18`.

Perkiraan ukuran di §5.2 spec (stocks ≈0,45 MB, total ≈6,3 MB) diturunkan sebelum daftar ini diketahui dan akan direvisi dari angka sebenarnya setelah bake lengkap berjalan. `colorDecodeLuts` dan `colorEncodeLuts` saja masing-masing 26 × 4096 float. Bentuk manifest: `{ hanatos: {width, height, bands}, stocks: [{id, name, type, offsetFloats, lengthFloats, curvePoints, license, citation, datasource}], static: {<tableName>: {offsetFloats, lengthFloats}} }`

- [ ] **Step 1: Tulis bake_web_assets.py**

Skrip ini mengimpor modul hulu dan memakai fungsinya kembali — **jangan salin logika spektralnya**.

```python
#!/usr/bin/env python3
"""Pancarkan aset web dari generate_profile_curves.py hulu.

Mewarisi seluruh derivasi colour-science hulu; yang berbeda hanya pintu
keluarnya: biner + JSON, bukan literal C++.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np

OFX_ROOT = Path(os.environ["SPEKTRAFILM_OFX"])
sys.path.insert(0, str(OFX_ROOT / "tools"))

import generate_profile_curves as gpc  # noqa: E402
import ofx_stock_lists as stocks  # noqa: E402


def pack_stocks(out_dir: Path) -> tuple[list[dict], np.ndarray]:
    entries: list[dict] = []
    blob: list[np.ndarray] = []
    cursor = 0

    for stock_id in stocks.film_stock_order() + stocks.paper_stock_order():
        profile = gpc._load_profile(stock_id)
        curves = np.asarray(gpc._density_curves(profile), dtype="<f4").ravel()
        log_e = np.asarray(profile["data"]["log_exposure"], dtype="<f4")
        payload = np.concatenate([log_e, curves])

        entries.append({
            "id": stock_id,
            "name": profile["info"]["name"],
            "type": profile["info"]["type"],
            "offsetFloats": cursor,
            "lengthFloats": int(payload.size),
            "curvePoints": int(log_e.size),
            "license": profile["metadata"]["license"],
            "citation": profile["metadata"]["citation"],
            "datasource": profile["metadata"]["datasource"],
        })
        blob.append(payload)
        cursor += int(payload.size)

    return entries, np.concatenate(blob)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    entries, stock_blob = pack_stocks(args.out)
    (args.out / "stocks.f32").write_bytes(stock_blob.tobytes())

    lut = np.load(gpc.HANATOS_LUT_PATH)
    assert lut.dtype == np.float16, f"LUT hulu bukan f16: {lut.dtype}"
    (args.out / "hanatos.f16").write_bytes(
        np.ascontiguousarray(lut, dtype="<f2").tobytes()
    )

    gamut = np.asarray(gpc._output_gamut_compression_data(), dtype="<f4")
    (args.out / "static.f32").write_bytes(gamut.tobytes())

    manifest = {
        "hanatos": {
            "width": int(lut.shape[0]),
            "height": int(lut.shape[1]),
            "bands": int(lut.shape[2]),
        },
        "stocks": entries,
        "static": {
            "outputGamutCompression": {
                "offsetFloats": 0,
                "lengthFloats": int(gamut.size),
            },
        },
    }
    (args.out / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(f"Wrote {len(entries)} stocks, LUT {lut.shape}, gamut {gamut.size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

Catatan: `stocks.film_stock_order()` dan `paper_stock_order()` adalah nama yang diasumsikan. Baca `$SPEKTRAFILM_OFX/tools/ofx_stock_lists.py` dan pakai nama yang sebenarnya; berkas itu memuat `_LEGACY_FILM_ORDER` (20 entri) dan `_LEGACY_PAPER_ORDER` (8 entri) serta fungsi pembungkusnya.

- [ ] **Step 2: Jalankan emitter**

```bash
~/.venvs/spektra-bake/Scripts/python spektra/tools/bake_web_assets.py --out spektra/public/data
```

Harapan: `Wrote 28 stocks, LUT (192, 192, 81), gamut <n>`.

- [ ] **Step 3: Tulis test aset**

Buat `spektra/test/assets.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA = join('public', 'data');
const manifest = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8'));

describe('aset ter-bake', () => {
  it('memuat tepat 20 film dan 8 kertas yang diharapkan', () => {
    // Daftar ini adalah _LEGACY_FILM_ORDER dan _LEGACY_PAPER_ORDER hulu.
    // Verifikasi terhadap $SPEKTRAFILM_OFX/tools/ofx_stock_lists.py sebelum
    // mengubahnya; kalau daftar hulu berbeda, hulu yang benar.
    const FILM = [
      'kodak_ektar_100', 'kodak_portra_160', 'kodak_portra_400',
      'kodak_portra_800', 'kodak_portra_800_push1', 'kodak_portra_800_push2',
      'kodak_gold_200', 'kodak_ultramax_400', 'kodak_vision3_50d',
      'kodak_vision3_250d', 'kodak_verita_200d', 'kodak_vision3_200t',
      'kodak_vision3_500t', 'fujifilm_pro_400h', 'fujifilm_c200',
      'fujifilm_xtra_400', 'kodak_ektachrome_100', 'kodak_kodachrome_64',
      'fujifilm_velvia_100', 'fujifilm_provia_100f',
    ];
    const PAPER = [
      'kodak_endura_premier', 'kodak_ultra_endura', 'kodak_ektacolor_edge',
      'kodak_supra_endura', 'kodak_portra_endura',
      'fujifilm_crystal_archive_typeii', 'kodak_2383', 'kodak_2393',
    ];

    const ids = new Set(manifest.stocks.map((s: { id: string }) => s.id));
    expect(FILM).toHaveLength(20);
    expect(PAPER).toHaveLength(8);
    for (const id of [...FILM, ...PAPER]) {
      expect(ids.has(id), `stock hilang: ${id}`).toBe(true);
    }
    expect(manifest.stocks).toHaveLength(28);
  });

  it('LUT Hanatos berdimensi 192x192x81 dan f16', () => {
    expect(manifest.hanatos).toEqual({ width: 192, height: 192, bands: 81 });
    const bytes = readFileSync(join(DATA, 'hanatos.f16')).byteLength;
    expect(bytes).toBe(192 * 192 * 81 * 2);
  });

  it('offset stock bersambung tanpa celah dan menutupi seluruh blob', () => {
    let cursor = 0;
    for (const s of manifest.stocks) {
      expect(s.offsetFloats, s.id).toBe(cursor);
      cursor += s.lengthFloats;
    }
    const bytes = readFileSync(join(DATA, 'stocks.f32')).byteLength;
    expect(bytes).toBe(cursor * 4);
  });

  it('tiap stock membawa metadata lisensi hulu', () => {
    for (const s of manifest.stocks) {
      expect(s.license, s.id).toBeTruthy();
      expect(s.citation, s.id).toBeTruthy();
    }
  });
});
```

- [ ] **Step 4: Jalankan test**

```bash
cd spektra && npm test -- assets
```

Harapan: PASS.

- [ ] **Step 5: Bandingkan nilai yang dipancarkan dengan literal C++ hulu**

Jalankan `generate_profile_curves.py` hulu untuk menghasilkan `SpektraGeneratedProfileCurves.cpp`, lalu bandingkan sampel: ambil 20 nilai kurva pertama Kodak Portra 400 dari `stocks.f32` dan cari angka yang sama di berkas `.cpp`. Keduanya harus identik sampai presisi f32. Catat hasil perbandingan ini di `tools/README.md`.

Ini adalah satu-satunya pemeriksaan bahwa emitter kita tidak menyimpang dari jalur hulu. Jangan lewati.

- [ ] **Step 6: Commit**

```bash
git add spektra/tools/bake_web_assets.py spektra/public/data spektra/test/assets.test.ts
git commit -m "feat(spektra): bake web assets by reusing upstream profile-curve derivation"
```

---

## Task 5: Pemuat profil

> **Peringatan: tipe dan kode di tugas ini ditulis sebelum Task 4 dijalankan, dan bentuk manifesnya kini berbeda.** Perlakukan seluruh `interface` dan kode di bawah sebagai ilustrasi maksud, bukan spesifikasi. Bentuk sebenarnya, dari `spektra/public/data/manifest.json` yang dipancarkan Task 4:
>
> - Tiap entri `stocks` memuat skalar dan string di tingkat atas — `id`, `name`, `type`, `referenceIlluminant`, `viewingIlluminant`, `wavelengthCount`, `exposureCount`, `mallettRawMidgrayGreen`, `license`, `citation`, `datasource` — dan **23 larik di bawah `fields`**, masing-masing berbentuk `{ offsetFloats, lengthFloats }` (sebagian juga membawa `nullCount`).
> - `manifest.static` memuat 14 tabel global dengan bentuk offset yang sama.
> - `manifest.colorSpaces` memuat `count` (26), `transferLutSize` (4096), `outputGamutCompressionStride` (18), 26 `labels`, dan batas `decodeLutMin/Max`, `encodeLutMin/Max`.
> - `manifest.counts` memuat `filmCount`, `paperCount`, `defaultFilmIndex`, `defaultPaperIndex`, `academyPrinterDensityEnabled`.
>
> Turunkan tipe TypeScript dari manifes yang benar-benar ada di disk, bukan dari ilustrasi ini. Asumsi `StockEntry` yang datar dengan `curvePoints` sudah tidak berlaku.
>
> Satu hal yang tetap berlaku dan penting: `hanatos.f16` dikirim sebagai f16 dan **wajib diekspansi ke f32 saat muat**. Itu satu-satunya tempat presisi transport berbeda dari presisi komputasi, dan spec §5.2 melarang jalur f16 di shader.

**Files:**
- Create: `spektra/src/profiles/types.ts`, `spektra/src/profiles/load.ts`
- Test: `spektra/test/profiles.test.ts`

**Interfaces:**
- Consumes: `public/data/manifest.json`, `stocks.f32`, `hanatos.f16`
- Produces:
  - `interface StockEntry { id: string; name: string; type: string; offsetFloats: number; lengthFloats: number; curvePoints: number; license: string; citation: string; datasource: string }`
  - `interface Manifest { hanatos: { width: number; height: number; bands: number }; stocks: StockEntry[]; static: Record<string, { offsetFloats: number; lengthFloats: number }> }`
  - `interface Stock { entry: StockEntry; logExposure: Float32Array; densityCurves: Float32Array }`
  - `async function loadAssets(baseUrl: string): Promise<AssetBundle>`
  - `interface AssetBundle { manifest: Manifest; stocks: Float32Array; hanatos: Float32Array; static: Float32Array; stock(id: string): Stock }`
  - `hanatos` dikembalikan sebagai `Float32Array` — ekspansi f16→f32 terjadi di dalam `loadAssets`

- [ ] **Step 1: Tulis test yang gagal**

Buat `spektra/test/profiles.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { loadAssets } from '../src/profiles/load';
import type { AssetBundle } from '../src/profiles/load';

let bundle: AssetBundle;

beforeAll(async () => {
  bundle = await loadAssets('public/data');
});

describe('loadAssets', () => {
  it('memuat 28 stock', () => {
    expect(bundle.manifest.stocks).toHaveLength(28);
  });

  it('mengembalikan kurva Portra 400 dengan 256 titik', () => {
    const stock = bundle.stock('kodak_portra_400');
    expect(stock.logExposure).toHaveLength(256);
    expect(stock.densityCurves).toHaveLength(256 * 3);
  });

  it('log exposure menaik monoton', () => {
    const { logExposure } = bundle.stock('kodak_portra_400');
    for (let i = 1; i < logExposure.length; i += 1) {
      expect(logExposure[i]!).toBeGreaterThan(logExposure[i - 1]!);
    }
  });

  it('mengekspansi LUT Hanatos ke f32 dengan jumlah elemen yang benar', () => {
    const { width, height, bands } = bundle.manifest.hanatos;
    expect(bundle.hanatos).toBeInstanceOf(Float32Array);
    expect(bundle.hanatos).toHaveLength(width * height * bands);
    expect(bundle.hanatos.every(Number.isFinite)).toBe(true);
  });

  it('melempar galat yang jelas untuk id stock yang tidak dikenal', () => {
    expect(() => bundle.stock('tidak_ada')).toThrow(/tidak dikenal|unknown/i);
  });
});
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

```bash
cd spektra && npm test -- profiles
```

Harapan: FAIL dengan `Cannot find module '../src/profiles/load'`.

- [ ] **Step 3: Tulis types.ts**

```typescript
export interface StockEntry {
  id: string;
  name: string;
  type: string;
  offsetFloats: number;
  lengthFloats: number;
  curvePoints: number;
  license: string;
  citation: string;
  datasource: string;
}

export interface Manifest {
  hanatos: { width: number; height: number; bands: number };
  stocks: StockEntry[];
  static: Record<string, { offsetFloats: number; lengthFloats: number }>;
}

export interface Stock {
  entry: StockEntry;
  logExposure: Float32Array;
  densityCurves: Float32Array;
}
```

- [ ] **Step 4: Tulis load.ts**

```typescript
import type { Manifest, Stock, StockEntry } from './types';

export type { Manifest, Stock, StockEntry };

export interface AssetBundle {
  manifest: Manifest;
  stocks: Float32Array;
  hanatos: Float32Array;
  static: Float32Array;
  stock(id: string): Stock;
}

/** Ekspansi half-float IEEE 754 ke f32. Sumber LUT memang f16; komputasi f32. */
function expandF16(src: Uint16Array): Float32Array {
  const out = new Float32Array(src.length);
  const view = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < src.length; i += 1) {
    const h = src[i]!;
    const sign = (h & 0x8000) << 16;
    const exponent = (h & 0x7c00) >> 10;
    const mantissa = h & 0x03ff;

    let bits: number;
    if (exponent === 0) {
      bits = mantissa === 0 ? sign : sign | (0x38800000 + mantissa * 8192);
    } else if (exponent === 0x1f) {
      bits = sign | 0x7f800000 | (mantissa << 13);
    } else {
      bits = sign | ((exponent + 112) << 23) | (mantissa << 13);
    }
    view.setUint32(0, bits >>> 0);
    out[i] = view.getFloat32(0);
  }
  return out;
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  if (typeof fetch === 'function' && /^https?:/.test(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Gagal memuat ${url}: ${response.status}`);
    return response.arrayBuffer();
  }
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(url);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export async function loadAssets(baseUrl: string): Promise<AssetBundle> {
  const join = (name: string) => `${baseUrl.replace(/\/$/, '')}/${name}`;

  const manifest = JSON.parse(
    new TextDecoder().decode(await fetchBytes(join('manifest.json'))),
  ) as Manifest;

  const stocks = new Float32Array(await fetchBytes(join('stocks.f32')));
  const hanatos = expandF16(new Uint16Array(await fetchBytes(join('hanatos.f16'))));
  const staticTables = new Float32Array(await fetchBytes(join('static.f32')));

  const byId = new Map(manifest.stocks.map((s) => [s.id, s]));

  return {
    manifest,
    stocks,
    hanatos,
    static: staticTables,
    stock(id: string): Stock {
      const entry = byId.get(id);
      if (!entry) {
        throw new Error(
          `Stock tidak dikenal: ${id}. Tersedia: ${[...byId.keys()].join(', ')}`,
        );
      }
      const base = entry.offsetFloats;
      const n = entry.curvePoints;
      return {
        entry,
        logExposure: stocks.subarray(base, base + n),
        densityCurves: stocks.subarray(base + n, base + n + n * 3),
      };
    },
  };
}
```

- [ ] **Step 5: Jalankan test — harus lulus**

```bash
cd spektra && npm test -- profiles && npm run typecheck
```

Harapan: PASS.

- [ ] **Step 6: Commit**

```bash
git add spektra/src/profiles spektra/test/profiles.test.ts
git commit -m "feat(spektra): load baked stock curves and expand Hanatos LUT to f32"
```

---

## Task 6: Akuisisi device WebGPU

**Files:**
- Create: `spektra/src/engine/device.ts`
- Test: `spektra/test/device.test.ts`

**Interfaces:**
- Consumes: tidak ada
- Produces:
  - `interface EngineDevice { device: GPUDevice; limits: GPUSupportedLimits; maxStorageBufferBindingSize: number }`
  - `async function acquireDevice(): Promise<EngineDevice>` — melempar `WebGPUUnavailableError` dengan pesan yang dapat ditampilkan ke pengguna
  - `class WebGPUUnavailableError extends Error`

- [ ] **Step 1: Tulis test yang gagal**

Buat `spektra/test/device.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { acquireDevice } from '../src/engine/device';

describe('acquireDevice', () => {
  it('memperoleh device dengan limit yang dilaporkan', async () => {
    const engine = await acquireDevice();
    expect(engine.device).toBeDefined();
    expect(engine.maxStorageBufferBindingSize).toBeGreaterThan(0);
  });

  it('menyediakan minimal 8 storage buffer per stage', async () => {
    const engine = await acquireDevice();
    expect(engine.limits.maxStorageBuffersPerShaderStage).toBeGreaterThanOrEqual(8);
  });
});
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

```bash
cd spektra && npm test -- device
```

Harapan: FAIL, modul tidak ditemukan.

- [ ] **Step 3: Tulis device.ts**

```typescript
export class WebGPUUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `DICHROIC memerlukan WebGPU, yang tidak tersedia di sini: ${reason}. ` +
        'Dukungan tersedia di Chrome 113+, Edge 113+, Safari 26+, dan Firefox 141+. ' +
        'Tidak ada jalur render alternatif — seluruh pipeline berjalan sebagai compute shader.',
    );
    this.name = 'WebGPUUnavailableError';
  }
}

export interface EngineDevice {
  device: GPUDevice;
  limits: GPUSupportedLimits;
  maxStorageBufferBindingSize: number;
}

async function getNavigatorGpu(): Promise<GPU> {
  if (typeof navigator !== 'undefined' && navigator.gpu) return navigator.gpu;
  const mod = (await import('webgpu')) as { create(flags: string[]): GPU };
  return mod.create([]);
}

export async function acquireDevice(): Promise<EngineDevice> {
  let gpu: GPU;
  try {
    gpu = await getNavigatorGpu();
  } catch (cause) {
    throw new WebGPUUnavailableError(`navigator.gpu tidak ada (${String(cause)})`);
  }

  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new WebGPUUnavailableError('tidak ada adapter yang cocok');

  // Kualitas di atas performa: minta ukuran binding sebesar yang diizinkan
  // adapter, agar render full-frame tidak perlu di-tile lebih awal dari
  // yang diperlukan. Jumlah storage buffer sengaja TIDAK dinaikkan — arena
  // dirancang untuk muat di batas terjamin 8.
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });

  device.lost.then((info) => {
    console.error(`Device WebGPU hilang: ${info.reason} — ${info.message}`);
  });

  return {
    device,
    limits: device.limits,
    maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
  };
}
```

- [ ] **Step 4: Jalankan test — harus lulus**

```bash
cd spektra && npm test -- device
```

Harapan: PASS. Jika paket `webgpu` gagal memuat di Windows, beralih ke harness Playwright seperti dicatat di spec §6.6, dan perbarui `vitest.config.ts` untuk menjalankan berkas parity di lingkungan browser.

- [ ] **Step 5: Commit**

```bash
git add spektra/src/engine/device.ts spektra/test/device.test.ts
git commit -m "feat(spektra): acquire WebGPU device with clear unavailability error"
```

---

## Task 7: Struct CoreParams

> **KOREKSI PENTING — versi pertama tugas ini salah, dan salahnya mahal.**
>
> Tugas ini semula menyatakan blok `CoreParams` punya 26 skalar dengan "tiga field padding yang dipakai sebagai bitfield flag", lalu meleburkan ketiganya menjadi satu field `flags` — menghasilkan 24 field. Itu keliru di tiga tingkat.
>
> **Ketiga field itu bukan padding.** Mereka slot serbaguna yang maknanya berbeda per tahap, dan host mengisinya berbeda tiap dispatch (`SpektraVulkanRenderer.cpp:6272-6274`: `_pad0 = operation; _pad1 = sigmaMode; _pad2 = component`). Yang terukur dari shader hulu:
>
>
> | Shader | slot0 (pos 14) | slot1 (pos 15) | slot2 (pos 16) |
> |---|---|---|---|
> | CurveDevelop | `_pad0` | `_pad1` (bitfield colour-adaptation) | `_pad2` |
> | Diffusion | `operation` | `componentIndex` | `_pad2` (packed: groupCount + downsampleScale) |
> | Dir | `operation` | `component` | `_pad2` |
> | FilmExposure | `_pad0` (flag `== 1u`) | `_pad1` (bitfield colour-adaptation) | `_pad2` (selektor source-index) |
> | Grain | `operation` | `_pad1` | `_pad2` |
> | Halation | `operation` | `sigmaMode` | `component` |
> | PrintScan | `_pad0` | `_pad1` | `_pad2` |
> | ScannerPost | `operation` | `_pad1` | `_pad2` |
>
> Tabel di atas diukur dari kedelapan shader yang berbagi blok ini, bukan tiga.
> Perhatikan bahwa **hulu sendiri tidak sepakat dengan dirinya soal nama slot ini**
> — slot0 disebut `operation` di lima shader dan dibiarkan `_pad0` di tiga, dan
> slot1 berganti nama empat kali. Itu justru alasan struct kita memakai nama
> netral: nama semantik apa pun akan benar di sebagian tahap dan menyesatkan di
> sisanya.
>
> Koreksi atas koreksi: versi sebelumnya dokumen ini mengatribusikan `sigmaMode`
> ke Diffusion. Itu salah — `sigmaMode` adalah nama slot1 milik **Halation**, dan
> baris `SpektraVulkanRenderer.cpp:6271-6274` yang dikutip berada di dalam lambda
> `dispatchHalation`. Diffusion menamai slot1-nya `componentIndex`.

**Files:**
- Create: `spektra/src/engine/params.ts`
- Test: `spektra/test/params.test.ts`

**Interfaces:**
- Consumes: tidak ada
- Produces:
  - `interface CoreParams { width: number; height: number; filmExposureEv: number; filmGamma: number; exposureCount: number; inputColorSpace: number; rgbToRawMethod: number; colorSpaceCount: number; transferLutSize: number; colorDecodeMin: number; colorDecodeMax: number; hanatosWidth: number; hanatosHeight: number; flags: number; filmPushPullMode: number; filmPushPullStops: number; fullWidth: number; fullHeight: number; tileOriginX: number; tileOriginY: number; activeOriginX: number; activeOriginY: number; activeWidth: number; activeHeight: number }`
  - `const CORE_PARAMS_WGSL: string` — deklarasi struct WGSL
  - `const CORE_PARAMS_BYTES: number`
  - `function writeCoreParams(params: CoreParams, target: ArrayBuffer): void`
  - `const FLAG_COLOR_ADAPTATION_CURVE_SMOOTHING = 1 << 1`

- [ ] **Step 1: Baca blok push-constant hulu dan catat urutan field persis**

```bash
sed -n '/layout(push_constant)/,/} params;/p' "$SPEKTRAFILM_OFX/shaders/vulkan/SpektraCurveDevelop.comp"
```

Urutan field dalam struct WGSL **harus sama persis** dengan urutan di blok itu. Sisi Vulkan memakai `std430` untuk push constant; WGSL uniform memakai aturan tata letak yang lebih ketat, tetapi karena setiap field adalah skalar 4-byte (`uint`, `int`, `float`) dan seluruh blok berjumlah 26 skalar, tata letaknya identik: offset berurutan 4 byte, total 104 byte, dibulatkan ke 112 untuk penyelarasan uniform 16-byte.

- [ ] **Step 2: Tulis test yang gagal**

Buat `spektra/test/params.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  CORE_PARAMS_BYTES,
  CORE_PARAMS_WGSL,
  writeCoreParams,
  FLAG_COLOR_ADAPTATION_CURVE_SMOOTHING,
} from '../src/engine/params';
import type { CoreParams } from '../src/engine/params';

const sample: CoreParams = {
  width: 1920, height: 1080,
  filmExposureEv: 0.5, filmGamma: 1.0,
  exposureCount: 256, inputColorSpace: 15, rgbToRawMethod: 2,
  colorSpaceCount: 26, transferLutSize: 4096,
  colorDecodeMin: -0.25, colorDecodeMax: 16.0,
  hanatosWidth: 192, hanatosHeight: 192,
  slot0: 0, slot1: FLAG_COLOR_ADAPTATION_CURVE_SMOOTHING, slot2: 0,
  filmPushPullMode: 0, filmPushPullStops: -1.0,
  fullWidth: 1920, fullHeight: 1080,
  tileOriginX: 0, tileOriginY: 0,
  activeOriginX: 0, activeOriginY: 0,
  activeWidth: 1920, activeHeight: 1080,
};

describe('CoreParams', () => {
  it('berukuran kelipatan 16 byte agar sah sebagai uniform', () => {
    expect(CORE_PARAMS_BYTES % 16).toBe(0);
    expect(CORE_PARAMS_BYTES).toBe(112); // ceil(26*4/16)*16
  });

  it('menulis width dan height pada dua slot pertama', () => {
    const buffer = new ArrayBuffer(CORE_PARAMS_BYTES);
    writeCoreParams(sample, buffer);
    const u32 = new Uint32Array(buffer);
    expect(u32[0]).toBe(1920);
    expect(u32[1]).toBe(1080);
  });

  it('menulis float sebagai float, bukan integer', () => {
    const buffer = new ArrayBuffer(CORE_PARAMS_BYTES);
    writeCoreParams(sample, buffer);
    const f32 = new Float32Array(buffer);
    expect(f32[2]).toBeCloseTo(0.5, 6);
  });

  it('membawa flag colour adaptation di bit 1', () => {
    expect(FLAG_COLOR_ADAPTATION_CURVE_SMOOTHING).toBe(2);
  });

  it('WGSL mendeklarasikan struct dengan jumlah field yang sama', () => {
    const fields = CORE_PARAMS_WGSL.match(/^\s+\w+\s*:/gm) ?? [];
    expect(fields).toHaveLength(26);
  });
});
```

- [ ] **Step 3: Jalankan test untuk memastikan gagal**

```bash
cd spektra && npm test -- params
```

Harapan: FAIL, modul tidak ditemukan.

- [ ] **Step 4: Tulis params.ts**

```typescript
/**
 * Cerminan blok push-constant CoreParams dari shader Vulkan hulu.
 *
 * WebGPU tidak memiliki push constant, jadi blok ini menjadi uniform buffer.
 * Urutan field harus sama persis dengan hulu; tiga field padding hulu dipakai
 * sebagai bitfield dan di sini dinamai `flags` (hanya namanya yang berubah,
 * letak bitnya tidak).
 */

export const FLAG_COLOR_ADAPTATION_CURVE_SMOOTHING = 1 << 1;

export interface CoreParams {
  width: number;
  height: number;
  filmExposureEv: number;
  filmGamma: number;
  exposureCount: number;
  inputColorSpace: number;
  rgbToRawMethod: number;
  colorSpaceCount: number;
  transferLutSize: number;
  colorDecodeMin: number;
  colorDecodeMax: number;
  hanatosWidth: number;
  hanatosHeight: number;
  /** Slot serbaguna; arti berbeda per tahap — lihat koreksi di awal tugas ini. */
  slot0: number;
  /** Bitfield colour-adaptation pada CurveDevelop/FilmExposure; sigmaMode pada Diffusion. */
  slot1: number;
  /** Nilai ter-pack pada Diffusion; selektor source-index pada FilmExposure. */
  slot2: number;
  filmPushPullMode: number;
  filmPushPullStops: number;
  fullWidth: number;
  fullHeight: number;
  tileOriginX: number;
  tileOriginY: number;
  activeOriginX: number;
  activeOriginY: number;
  activeWidth: number;
  activeHeight: number;
}

type Kind = 'u32' | 'i32' | 'f32';

const FIELDS: ReadonlyArray<readonly [keyof CoreParams, Kind]> = [
  ['width', 'u32'],
  ['height', 'u32'],
  ['filmExposureEv', 'f32'],
  ['filmGamma', 'f32'],
  ['exposureCount', 'u32'],
  ['inputColorSpace', 'i32'],
  ['rgbToRawMethod', 'i32'],
  ['colorSpaceCount', 'u32'],
  ['transferLutSize', 'u32'],
  ['colorDecodeMin', 'f32'],
  ['colorDecodeMax', 'f32'],
  ['hanatosWidth', 'u32'],
  ['hanatosHeight', 'u32'],
  ['slot0', 'u32'],
  ['slot1', 'u32'],
  ['slot2', 'u32'],
  ['filmPushPullMode', 'i32'],
  ['filmPushPullStops', 'f32'],
  ['fullWidth', 'u32'],
  ['fullHeight', 'u32'],
  ['tileOriginX', 'u32'],
  ['tileOriginY', 'u32'],
  ['activeOriginX', 'u32'],
  ['activeOriginY', 'u32'],
  ['activeWidth', 'u32'],
  ['activeHeight', 'u32'],
];

export const CORE_PARAMS_BYTES = Math.ceil((FIELDS.length * 4) / 16) * 16;

export const CORE_PARAMS_WGSL = `struct CoreParams {
${FIELDS.map(([name, kind]) => `  ${String(name)}: ${kind},`).join('\n')}
}`;

export function writeCoreParams(params: CoreParams, target: ArrayBuffer): void {
  if (target.byteLength < CORE_PARAMS_BYTES) {
    throw new Error(
      `Buffer CoreParams terlalu kecil: ${target.byteLength} < ${CORE_PARAMS_BYTES}`,
    );
  }
  const view = new DataView(target);
  FIELDS.forEach(([name, kind], index) => {
    const offset = index * 4;
    const value = params[name];
    if (kind === 'f32') view.setFloat32(offset, value, true);
    else if (kind === 'i32') view.setInt32(offset, value, true);
    else view.setUint32(offset, value, true);
  });
}
```

- [ ] **Step 5: Jalankan test — harus lulus**

```bash
cd spektra && npm test -- params && npm run typecheck
```

Harapan: PASS.

- [ ] **Step 6: Commit**

```bash
git add spektra/src/engine/params.ts spektra/test/params.test.ts
git commit -m "feat(spektra): port CoreParams push-constant block to a WebGPU uniform struct"
```

---

## Task 8: Arena buffer

**Files:**
- Create: `spektra/src/engine/arena.ts`
- Test: `spektra/test/arena.test.ts`

**Interfaces:**
- Consumes: `EngineDevice` dari Task 6
- Produces:
  - `interface ArenaEntry { name: string; offsetFloats: number; lengthFloats: number }`
  - `class ArenaBuilder { add(name: string, data: Float32Array): void; build(device: GPUDevice, label: string): Arena }`
  - `interface Arena { buffer: GPUBuffer; entries: Record<string, ArenaEntry>; wgslConstants(): string; destroy(): void }`
  - `interface Arenas { static: Arena; stock: Arena; dynamic: Arena; frameState: Arena }` — kumpulan arena yang dipakai seluruh tahap mulai Task 11
  - `wgslConstants()` memancarkan satu baris `const ARENA_<NAME>_OFFSET: u32 = <n>u;` per entri, untuk disambung ke sumber shader

- [ ] **Step 1: Tulis test yang gagal**

Buat `spektra/test/arena.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ArenaBuilder } from '../src/engine/arena';
import { acquireDevice } from '../src/engine/device';

describe('ArenaBuilder', () => {
  it('menempatkan entri berurutan tanpa celah', async () => {
    const { device } = await acquireDevice();
    const builder = new ArenaBuilder();
    builder.add('cmfs', new Float32Array(81 * 3));
    builder.add('illuminant', new Float32Array(81));
    const arena = builder.build(device, 'static');

    expect(arena.entries.cmfs!.offsetFloats).toBe(0);
    expect(arena.entries.cmfs!.lengthFloats).toBe(243);
    expect(arena.entries.illuminant!.offsetFloats).toBe(243);
    expect(arena.entries.illuminant!.lengthFloats).toBe(81);
    arena.destroy();
  });

  it('memancarkan konstanta offset WGSL', async () => {
    const { device } = await acquireDevice();
    const builder = new ArenaBuilder();
    builder.add('cmfs', new Float32Array(12));
    const arena = builder.build(device, 'static');

    expect(arena.wgslConstants()).toContain('const ARENA_CMFS_OFFSET: u32 = 0u;');
    arena.destroy();
  });

  it('menolak nama entri yang sama dua kali', () => {
    const builder = new ArenaBuilder();
    builder.add('cmfs', new Float32Array(4));
    expect(() => builder.add('cmfs', new Float32Array(4))).toThrow(/sudah ada/i);
  });
});
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

```bash
cd spektra && npm test -- arena
```

Harapan: FAIL, modul tidak ditemukan.

- [ ] **Step 3: Tulis arena.ts**

```typescript
export interface ArenaEntry {
  name: string;
  offsetFloats: number;
  lengthFloats: number;
}

export interface Arena {
  buffer: GPUBuffer;
  entries: Record<string, ArenaEntry>;
  wgslConstants(): string;
  destroy(): void;
}

/**
 * Kumpulan arena yang dipakai bersama seluruh tahap, dikelompokkan menurut
 * kapan isinya berubah. Lihat spec §4.3.
 */
export interface Arenas {
  static: Arena;
  stock: Arena;
  dynamic: Arena;
  frameState: Arena;
}

/**
 * Mengumpulkan tabel read-only kecil ke dalam satu storage buffer.
 *
 * WebGPU hanya menjamin 8 storage buffer per stage, sedangkan SpektraPrintScan
 * hulu mengikat 30. Sebagian besar di antaranya adalah tabel lookup kecil, jadi
 * dikelompokkan menurut kapan isinya berubah (static / stock / dynamic) dan
 * diakses lewat konstanta offset.
 */
export class ArenaBuilder {
  private readonly chunks: Array<{ entry: ArenaEntry; data: Float32Array }> = [];
  private cursor = 0;

  add(name: string, data: Float32Array): void {
    if (this.chunks.some((c) => c.entry.name === name)) {
      throw new Error(`Entri arena '${name}' sudah ada`);
    }
    this.chunks.push({
      entry: { name, offsetFloats: this.cursor, lengthFloats: data.length },
      data,
    });
    this.cursor += data.length;
  }

  build(device: GPUDevice, label: string): Arena {
    const combined = new Float32Array(this.cursor);
    for (const { entry, data } of this.chunks) {
      combined.set(data, entry.offsetFloats);
    }

    const buffer = device.createBuffer({
      label: `arena:${label}`,
      size: Math.max(combined.byteLength, 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(buffer.getMappedRange()).set(combined);
    buffer.unmap();

    const entries: Record<string, ArenaEntry> = {};
    for (const { entry } of this.chunks) entries[entry.name] = entry;

    return {
      buffer,
      entries,
      wgslConstants(): string {
        return Object.values(entries)
          .map(
            (e) =>
              `const ARENA_${e.name.toUpperCase()}_OFFSET: u32 = ${e.offsetFloats}u;`,
          )
          .join('\n');
      },
      destroy(): void {
        buffer.destroy();
      },
    };
  }
}
```

- [ ] **Step 4: Jalankan test — harus lulus**

```bash
cd spektra && npm test -- arena && npm run typecheck
```

Harapan: PASS.

- [ ] **Step 5: Commit**

```bash
git add spektra/src/engine/arena.ts spektra/test/arena.test.ts
git commit -m "feat(spektra): pack read-only tables into arena buffers under the 8-binding limit"
```

---

## Task 9: Graf, ping-pong, dan tahap FormatConvert

> **Kendala lingkungan yang terukur di Task 8, berlaku untuk Task 9 sampai 19.**
>
> Binding `webgpu` (Dawn) **menjatuhkan proses worker Vitest** pada alokasi buffer berukuran ratusan megabyte (`Worker exited unexpectedly`). Task 8 mereproduksinya tiga kali, termasuk dengan total yang sama dipecah menjadi 129 alokasi kecil, sehingga ini bukan batas satu-alokasi melainkan ketidakstabilan binding di bawah model forked-worker Vitest. Logika yang sama berjalan mulus lewat `vite-node` standalone, jadi bukan cacat kode kita.
>
> Konsekuensinya untuk tugas-tugas berikutnya: **jaga gambar uji tetap kecil.** Fixture Task 3 berukuran 32×16 sampai 64×64 dan aman. Jangan mencoba render full-frame atau gambar berukuran produksi di dalam Vitest — kalau suatu tahap perlu diuji pada ukuran besar, jalankan di luar suite lewat skrip terpisah dan laporkan hasilnya, jangan jadikan ia bagian dari `npm test`.

> **Catatan penamaan (pasca-eksekusi Task 9).** Nama `formatConvert` di bawah ini adalah nama RENCANA.
> Implementasinya diganti nama menjadi `materializeActiveRegion` karena `SpektraFormatConvert.comp` hulu
> tidak diport — lih. `task-9-report.md`, "Ruling penamaan". Bagian Task 9 ini dibiarkan apa adanya sebagai
> catatan sejarah; Task 11 dan seterusnya sudah memakai nama sebenarnya.

**Files:**
- Create: `spektra/src/engine/graph.ts`, `spektra/src/engine/stages/formatConvert.ts`, `spektra/src/shaders/formatConvert.wgsl`
- Test: `spektra/test/graph.test.ts`

**Interfaces:**
- Consumes: `EngineDevice` (Task 6), `CoreParams` + `CORE_PARAMS_WGSL` (Task 7), `TapName` (Task 2)
- Produces:
  - `interface StageContext { device: GPUDevice; params: CoreParams; paramsBuffer: GPUBuffer; source: GPUBuffer; dest: GPUBuffer; scratch(label: string, bytes: number): GPUBuffer }`
  - `interface Stage { name: string; writesTaps: readonly TapName[]; encode(encoder: GPUCommandEncoder, ctx: StageContext): void }`
  - `class RenderGraph { constructor(engine: EngineDevice); addStage(stage: Stage): void; async run(input: Float32Array, params: CoreParams, collect: TapName): Promise<Float32Array> }`
  - `function createFormatConvertStage(device: GPUDevice): Stage`

**Dua keputusan yang mengikat seluruh tahap berikutnya** (hasil pemindaian pra-terbang; lihat ledger):

1. **Sebuah tahap menyatakan setiap tap yang ditulisnya, dan beberapa tahap menulis tap yang sama.** Ini mencerminkan topologi Python: sebuah node *membaca dan menulis* tap bernama. `CurveDevelop`, `Dir`, `Halation`, `Grain`, dan `Diffusion['camera']` semuanya menulis `cmy_film` — masing-masing menyempurnakan keadaan yang sama. Karena itu `RenderGraph.run` mencari tahap **terakhir** yang menulis tap yang diminta (`findLastIndex`), bukan yang pertama. Memakai `findIndex` akan menghentikan graf di `CurveDevelop` dan membuat Task 13–16 lulus tanpa pernah menjalankan tahap yang sedang diuji.
2. **Tahap multi-pass memperoleh buffer antara dari `ctx.scratch()`,** bukan dengan mengalokasikan sendiri. `RenderGraph` memiliki kolamnya dan memakai ulang buffer berlabel sama, sehingga render ter-tile di Task 19 tidak meledakkan VRAM.

- [ ] **Step 1: Tulis test yang gagal**

Buat `spektra/test/graph.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { acquireDevice } from '../src/engine/device';
import { RenderGraph } from '../src/engine/graph';
import { createFormatConvertStage } from '../src/engine/stages/formatConvert';
import { Tap } from '../src/engine/taps';
import type { CoreParams } from '../src/engine/params';

function paramsFor(width: number, height: number): CoreParams {
  return {
    width, height,
    filmExposureEv: 0, filmGamma: 1,
    exposureCount: 0, inputColorSpace: 0, rgbToRawMethod: 0,
    colorSpaceCount: 0, transferLutSize: 0,
    colorDecodeMin: 0, colorDecodeMax: 1,
    hanatosWidth: 192, hanatosHeight: 192,
    flags: 0, filmPushPullMode: 0, filmPushPullStops: 0,
    fullWidth: width, fullHeight: height,
    tileOriginX: 0, tileOriginY: 0,
    activeOriginX: 0, activeOriginY: 0,
    activeWidth: width, activeHeight: height,
  };
}

describe('RenderGraph', () => {
  it('membawa piksel utuh melalui FormatConvert', async () => {
    const engine = await acquireDevice();
    const graph = new RenderGraph(engine);
    graph.addStage(createFormatConvertStage(engine.device));

    const width = 4;
    const height = 2;
    const input = new Float32Array(width * height * 4);
    for (let i = 0; i < input.length; i += 1) input[i] = i / input.length;

    const output = await graph.run(input, paramsFor(width, height), Tap.RGB_IN);

    expect(output).toHaveLength(input.length);
    for (let i = 0; i < input.length; i += 1) {
      expect(output[i]!, `elemen ${i}`).toBeCloseTo(input[i]!, 6);
    }
  });

  it('melempar galat untuk tap yang tidak ditulis tahap mana pun', async () => {
    const engine = await acquireDevice();
    const graph = new RenderGraph(engine);
    graph.addStage(createFormatConvertStage(engine.device));

    await expect(
      graph.run(new Float32Array(16), paramsFor(2, 2), Tap.CMY_FILM),
    ).rejects.toThrow(/cmy_film/);
  });
});
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

```bash
cd spektra && npm test -- graph
```

Harapan: FAIL, modul tidak ditemukan.

- [ ] **Step 3: Tulis formatConvert.wgsl**

Transliterasi dari `$SPEKTRAFILM_OFX/shaders/vulkan/SpektraFormatConvert.comp` (90 baris). Aturan mekanis untuk setiap transliterasi shader dalam rencana ini:

| GLSL Vulkan | WGSL |
|---|---|
| `layout(std430, binding = N) readonly buffer X { T x[]; }` | `@group(0) @binding(N) var<storage, read> x: array<T>;` |
| `layout(std430, binding = N) buffer X { T x[]; }` | `@group(0) @binding(N) var<storage, read_write> x: array<T>;` |
| `layout(push_constant) uniform CoreParams {...} params;` | `@group(0) @binding(<n>) var<uniform> params: CoreParams;` |
| `layout(local_size_x = 32, local_size_y = 8) in;` | `@workgroup_size(32, 8, 1)` |
| `gl_GlobalInvocationID` | `global_id: vec3<u32>` sebagai `@builtin(global_invocation_id)` |
| `vec4` / `uvec4` / `ivec4` | `vec4<f32>` / `vec4<u32>` / `vec4<i32>` |
| `mix(a, b, t)` | `mix(a, b, t)` — identik |
| `inversesqrt(x)` | `inverseSqrt(x)` |
| `mod(a, b)` | `a % b` untuk integer; `a - b * floor(a / b)` untuk float (semantik GLSL) |
| `matN * vec` | `matN * vec` — WGSL juga column-major; **verifikasi ini pada tap pertama yang melibatkan matriks** |

**Dua dari sepuluh shader hulu tidak di-port**, masing-masing dengan alasannya,
dan satu primitif baru ditambahkan yang port ini butuhkan sendiri. Keduanya
ditemukan dengan membaca shader-nya, bukan diasumsikan dari namanya.

`SpektraCopy.comp` (24 baris) tidak di-port: ia hanya menyalin satu buffer ke
buffer lain, dan `GPUCommandEncoder.copyBufferToBuffer` melakukan hal yang sama
tanpa shader.

`SpektraFormatConvert.comp` (90 baris) tidak di-port — **temuan Task 9, dan
koreksi atas dugaan rencana ini.** Ia bukan salinan `vec4` per-piksel: ia membawa
blok push-constant sendiri (`FormatConvertParams { pixelCount; mode; }`),
men-dispatch 1D atas array kata mentah, dan melakukan konversi fp16↔fp32 dengan
dithering TPDF. Perannya — mengonversi buffer host OFX yang bisa berformat
half-float ke format kerja internal — **tidak ada di port browser ini**: setiap
sumber piksel DICHROIC adalah `Float32Array` dari ujung ke ujung, jadi tidak ada
batas half-float untuk dikonversi. Mem-port-nya apa adanya akan mengubah rasio
ukuran buffer sumber/tujuan (2 kata per piksel versus 4) dan kehilangan presisi
lewat dithering — keduanya bertentangan dengan buffer ping-pong berukuran tetap
dan dengan aturan kualitas di Global Constraints.

Menggantinya, port ini menambahkan satu primitif yang memang dibutuhkannya:
**materialisasi region aktif** — menyalin sub-rektangel (`activeOriginX/Y`,
`activeWidth/Height`) dari buffer sumber penuh (`fullWidth/Height`) ke buffer
tujuan, `vec4<f32>` demi `vec4<f32>`, tanpa konversi bit apa pun. Ia **tidak**
dapat digantikan `copyBufferToBuffer`, karena sub-rektangel dari buffer yang
tertata 2D bukan rentang kontigu — jadi jangan menghapusnya sebagai redundan.
Field `activeOrigin`/`activeWidth`/`activeHeight` memang ada di `CoreParams`
untuk pemakaian per-tile ini (Task 19), sehingga workgroup 2D `32×8×1` lebih
tepat di sini daripada `256×1×1` hulu, yang cocok untuk dispatch 1D atas kata.

Delapan shader hulu yang di-port plus satu primitif ini adalah seluruh pipeline.

```wgsl
// Transliterasi dari SpektraFormatConvert.comp hulu.
// CORE_PARAMS_WGSL disisipkan di sini saat pembuatan modul.

@group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: CoreParams;

@compute @workgroup_size(32, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.activeWidth || gid.y >= params.activeHeight) {
    return;
  }
  let index = (gid.y + params.activeOriginY) * params.width
            + (gid.x + params.activeOriginX);
  dst[index] = src[index];
}
```

Baca berkas hulu dan pastikan tidak ada konversi format tambahan yang terlewat; jika ada (misalnya penanganan `source_format` non-float), tambahkan dan perluas test di Step 1 untuk menutupinya.

- [ ] **Step 4: Tulis formatConvert.ts**

```typescript
import { CORE_PARAMS_WGSL } from '../params';
import { Tap } from '../taps';
import type { Stage, StageContext } from '../graph';
import source from '../../shaders/formatConvert.wgsl?raw';

export function createFormatConvertStage(device: GPUDevice): Stage {
  const module = device.createShaderModule({
    label: 'formatConvert',
    code: `${CORE_PARAMS_WGSL}\n\n${source}`,
  });

  const pipeline = device.createComputePipeline({
    label: 'formatConvert',
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  return {
    name: 'formatConvert',
    writesTaps: [Tap.RGB_IN],
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const bindGroup = ctx.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 1, resource: { buffer: ctx.dest } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
        ],
      });
      const pass = encoder.beginComputePass({ label: 'formatConvert' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(ctx.params.activeWidth / 32),
        Math.ceil(ctx.params.activeHeight / 8),
        1,
      );
      pass.end();
    },
  };
}
```

- [ ] **Step 5: Tulis graph.ts**

```typescript
import { CORE_PARAMS_BYTES, writeCoreParams } from './params';
import type { CoreParams } from './params';
import type { EngineDevice } from './device';
import type { TapName } from './taps';

export interface StageContext {
  device: GPUDevice;
  params: CoreParams;
  paramsBuffer: GPUBuffer;
  source: GPUBuffer;
  dest: GPUBuffer;
  /** Buffer antara milik graf, dipakai ulang antar dispatch berlabel sama. */
  scratch(label: string, bytes: number): GPUBuffer;
}

export interface Stage {
  name: string;
  /** Setiap tap kanonis yang ditulis tahap ini. Kosong untuk tahap murni internal. */
  writesTaps: readonly TapName[];
  encode(encoder: GPUCommandEncoder, ctx: StageContext): void;
}

export class RenderGraph {
  private readonly stages: Stage[] = [];
  private readonly pool = new Map<string, GPUBuffer>();

  constructor(private readonly engine: EngineDevice) {}

  addStage(stage: Stage): void {
    this.stages.push(stage);
  }

  private scratch(label: string, bytes: number): GPUBuffer {
    const existing = this.pool.get(label);
    if (existing && existing.size >= bytes) return existing;
    existing?.destroy();

    const buffer = this.engine.device.createBuffer({
      label: `scratch:${label}`,
      size: bytes,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    });
    this.pool.set(label, buffer);
    return buffer;
  }

  async run(
    input: Float32Array,
    params: CoreParams,
    collect: TapName,
  ): Promise<Float32Array> {
    // Beberapa tahap menyempurnakan tap yang sama (cmy_film ditulis oleh
    // CurveDevelop, Dir, Halation, Grain, dan Diffusion kamera). Yang diminta
    // adalah keadaan SETELAH semuanya, jadi cari yang terakhir.
    const stopAt = this.stages.findLastIndex((s) =>
      s.writesTaps.includes(collect),
    );
    if (stopAt === -1) {
      throw new Error(
        `Tidak ada tahap yang menulis tap '${collect}'. ` +
          `Tahap terdaftar: ${this.stages
            .map((s) => `${s.name}→[${s.writesTaps.join('|')}]`)
            .join(', ')}`,
      );
    }

    const { device } = this.engine;
    const bytes = input.byteLength;
    const usage =
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;

    let front = device.createBuffer({ label: 'ping', size: bytes, usage });
    let back = device.createBuffer({ label: 'pong', size: bytes, usage });
    device.queue.writeBuffer(front, 0, input);

    const paramsBuffer = device.createBuffer({
      label: 'coreParams',
      size: CORE_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const staging = new ArrayBuffer(CORE_PARAMS_BYTES);
    writeCoreParams(params, staging);
    device.queue.writeBuffer(paramsBuffer, 0, staging);

    const encoder = device.createCommandEncoder({ label: 'graph' });
    for (let i = 0; i <= stopAt; i += 1) {
      this.stages[i]!.encode(encoder, {
        device, params, paramsBuffer, source: front, dest: back,
        scratch: (label, bytes) => this.scratch(label, bytes),
      });
      [front, back] = [back, front];
    }

    const readback = device.createBuffer({
      label: 'readback',
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyBufferToBuffer(front, 0, readback, 0, bytes);
    device.queue.submit([encoder.finish()]);

    await readback.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();

    readback.destroy();
    paramsBuffer.destroy();
    front.destroy();
    back.destroy();
    for (const buffer of this.pool.values()) buffer.destroy();
    this.pool.clear();
    return result;
  }
}
```

- [ ] **Step 6: Jalankan test — harus lulus**

```bash
cd spektra && npm test -- graph && npm run typecheck
```

Harapan: PASS.

- [ ] **Step 7: Commit**

```bash
git add spektra/src/engine/graph.ts spektra/src/engine/stages spektra/src/shaders spektra/test/graph.test.ts
git commit -m "feat(spektra): render graph with tap collection and FormatConvert stage"
```

---

## Task 10: Harness perbandingan parity

**Files:**
- Create: `spektra/test/parity/compare.ts`
- Test: `spektra/test/parity/compare.test.ts`

**Interfaces:**
- Consumes: fixture dari Task 3
- Produces:
  - `interface CaseMeta { name: string; width: number; height: number; taps: Array<{ tap: string; channels: number }> }`
  - `function loadCase(name: string): CaseMeta`
  - `function loadTap(name: string, tap: string): Float32Array`
  - `function loadInputAsRgba(name: string): Float32Array` — memperluas RGB f32 menjadi RGBA dengan alpha 1
  - `interface Comparison { maxAbsError: number; meanAbsError: number; worstIndex: number }`
  - `function compareRgb(actualRgba: Float32Array, expectedRgb: Float32Array): Comparison`
  - `function expectWithinTolerance(comparison: Comparison, tolerance: number, label: string): void`

`run.ts` dan `params.ts` **tidak** dibuat di sini: keduanya mengimpor `buildArenas` dari `src/host/spectral.ts`, yang baru lahir di Task 11, dan menulisnya sekarang akan membuat `npm run typecheck` merah di akhir tugas ini. Keduanya dibuat di Task 11 (hasil pemindaian pra-terbang; lihat ledger).

- [ ] **Step 1: Tulis test yang gagal**

Buat `spektra/test/parity/compare.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  compareRgb,
  expectWithinTolerance,
  loadCase,
  loadTap,
} from './compare';

describe('harness perbandingan', () => {
  it('melaporkan nol galat untuk data yang identik', () => {
    const expected = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const actual = new Float32Array([0.1, 0.2, 0.3, 1, 0.4, 0.5, 0.6, 1]);
    const result = compareRgb(actual, expected);
    expect(result.maxAbsError).toBe(0);
  });

  it('menemukan indeks terburuk', () => {
    const expected = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const actual = new Float32Array([0.1, 0.2, 0.3, 1, 0.4, 0.5, 0.9, 1]);
    const result = compareRgb(actual, expected);
    expect(result.maxAbsError).toBeCloseTo(0.3, 6);
    expect(result.worstIndex).toBe(5);
  });

  it('gagal keras ketika di luar ambang', () => {
    const comparison = { maxAbsError: 1e-3, meanAbsError: 1e-4, worstIndex: 7 };
    expect(() => expectWithinTolerance(comparison, 1e-5, 'cmy_film')).toThrow(
      /cmy_film/,
    );
  });

  it('memuat fixture gray_ramp', () => {
    const meta = loadCase('gray_ramp');
    expect(meta.width).toBe(32);
    const tap = loadTap('gray_ramp', 'cmy_film');
    expect(tap).toHaveLength(meta.width * meta.height * 3);
  });
});
```

- [ ] **Step 2: Jalankan test untuk memastikan gagal**

```bash
cd spektra && npm test -- parity/compare
```

Harapan: FAIL, modul tidak ditemukan.

- [ ] **Step 3: Tulis compare.ts**

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join('test', 'fixtures');

export interface CaseMeta {
  name: string;
  width: number;
  height: number;
  taps: Array<{ tap: string; channels: number }>;
}

export function loadCase(name: string): CaseMeta {
  return JSON.parse(
    readFileSync(join(FIXTURES, name, 'case.json'), 'utf8'),
  ) as CaseMeta;
}

function readF32(path: string): Float32Array {
  const buf = readFileSync(path);
  return new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
}

export function loadTap(name: string, tap: string): Float32Array {
  return readF32(join(FIXTURES, name, `${tap}.f32`));
}

/** Fixture menyimpan RGB rapat; engine bekerja dengan RGBA. */
export function loadInputAsRgba(name: string): Float32Array {
  const rgb = readF32(join(FIXTURES, name, 'input.f32'));
  const pixels = rgb.length / 3;
  const rgba = new Float32Array(pixels * 4);
  for (let p = 0; p < pixels; p += 1) {
    rgba[p * 4] = rgb[p * 3]!;
    rgba[p * 4 + 1] = rgb[p * 3 + 1]!;
    rgba[p * 4 + 2] = rgb[p * 3 + 2]!;
    rgba[p * 4 + 3] = 1;
  }
  return rgba;
}

export interface Comparison {
  maxAbsError: number;
  meanAbsError: number;
  worstIndex: number;
}

export function compareRgb(
  actualRgba: Float32Array,
  expectedRgb: Float32Array,
): Comparison {
  const pixels = expectedRgb.length / 3;
  if (actualRgba.length < pixels * 4) {
    throw new Error(
      `Keluaran terlalu pendek: ${actualRgba.length} < ${pixels * 4}`,
    );
  }

  let maxAbsError = 0;
  let sum = 0;
  let worstIndex = 0;

  for (let p = 0; p < pixels; p += 1) {
    for (let c = 0; c < 3; c += 1) {
      const error = Math.abs(actualRgba[p * 4 + c]! - expectedRgb[p * 3 + c]!);
      sum += error;
      if (error > maxAbsError) {
        maxAbsError = error;
        worstIndex = p * 3 + c;
      }
    }
  }

  return { maxAbsError, meanAbsError: sum / (pixels * 3), worstIndex };
}

export function expectWithinTolerance(
  comparison: Comparison,
  tolerance: number,
  label: string,
): void {
  if (comparison.maxAbsError <= tolerance) return;

  throw new Error(
    `${label}: max abs error ${comparison.maxAbsError.toExponential(3)} ` +
      `melebihi ambang ${tolerance.toExponential(3)} ` +
      `(mean ${comparison.meanAbsError.toExponential(3)}, ` +
      `terburuk di elemen ${comparison.worstIndex}).\n` +
      'JANGAN longgarkan ambang ini. Python menghitung f64 dan kita f32, jadi ' +
      'selisih wajar berada di orde 1e-7. Meleset sebesar ini berarti ada ' +
      'perbedaan struktural: urutan operasi, konvensi matriks baris versus ' +
      'kolom, atau interpolasi yang keliru. Temukan penyebabnya.',
  );
}
```

- [ ] **Step 4: Jalankan test — harus lulus**

```bash
cd spektra && npm test -- parity/compare
```

Harapan: PASS.

- [ ] **Step 5: Commit**

```bash
git add spektra/test/parity
git commit -m "test(spektra): parity comparison harness with non-negotiable tolerance"
```

---

## Task 11: Tahap FilmExposure — gerbang `log_e_film`

**Files:**
- Create: `spektra/src/shaders/filmExposure.wgsl`, `spektra/src/engine/stages/filmExposure.ts`, `spektra/src/host/spectral.ts`
- Create: `spektra/test/parity/run.ts`, `spektra/test/parity/params.ts` — dipindahkan ke sini dari Task 10 karena keduanya mengimpor `buildArenas`
- Test: `spektra/test/parity/filmExposure.test.ts`

**Interfaces:**
- Consumes: `ArenaBuilder` (Task 8), `RenderGraph`/`Stage` (Task 9), `AssetBundle` (Task 5), harness (Task 10)
- Produces:
  - `function buildArenas(device: GPUDevice, bundle: AssetBundle, stockId: string): Arenas`
  - `function createFilmExposureStage(device: GPUDevice, arenas: Arenas): Stage` dengan `writesTaps = [Tap.LOG_E_FILM]`
  - `function defaultCoreParams(width: number, height: number, bundle: AssetBundle): CoreParams` — cerminan `init_params()` Python, di `test/parity/params.ts`
  - `async function runTapParity(opts: { case: string; tap: TapName; tolerance: number; stages: (device: GPUDevice, arenas: Arenas) => Stage[]; stockId?: string }): Promise<void>` — di `test/parity/run.ts`; setiap uji parity tahap memakainya, sehingga tidak ada test yang disalin-tempel

**Sumber hulu:**
- Python: `$SPEKTRAFILM_PY/src/spektrafilm/runtime/stages/filming.py`, `model/stocks.py`, `model/illuminants.py`
- GLSL: `$SPEKTRAFILM_OFX/shaders/vulkan/SpektraFilmExposure.comp` (263 baris, binding 0,1,4,5,6,7,8,9)

- [ ] **Step 1: Baca kedua sumber dan catat pemetaan binding**

Delapan binding hulu dipetakan ke arena sebagai berikut:

| Binding hulu | Nama | Tujuan |
|---|---|---|
| 0 | `SourcePixels` | binding 0, storage read |
| 1 | `FilmRawPixels` | binding 1, storage read_write |
| 4 | `InputToSrgbMatrices` | arena `static` |
| 5 | `ColorDecodeLuts` | arena `static` |
| 6 | `ColorTransferKinds` | arena `static` |
| 7 | `MallettRawMatrix` | arena `static` |
| 8 | `InputToReferenceXyzMatrices` | arena `static` |
| 9 | `HanatosRawResponse` | arena `dynamic` |

Hasilnya empat binding: source, dest, params, static, dynamic — lima, di bawah batas.

- [ ] **Step 2: Tulis test parity yang gagal**

Buat `spektra/test/parity/filmExposure.test.ts`:

```typescript
import { describe, it } from 'vitest';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { Tap } from '../../src/engine/taps';
import { runTapParity } from './run';

describe('parity: log_e_film', () => {
  for (const name of ['gray_ramp', 'log_gray_ramp', 'color_patches']) {
    it(`cocok dengan referensi Python untuk ${name}`, async () => {
      await runTapParity({
        case: name,
        tap: Tap.LOG_E_FILM,
        tolerance: 1e-5,
        stages: (device, arenas) => [
          createMaterializeActiveRegionStage(device),
          createFilmExposureStage(device, arenas),
        ],
      });
    });
  }
});
```

- [ ] **Step 3: Jalankan test untuk memastikan gagal**

```bash
cd spektra && npm test -- parity/filmExposure
```

Harapan: FAIL, modul tidak ditemukan.

- [ ] **Step 4: Tulis test/parity/run.ts dan test/parity/params.ts**

Buat `spektra/test/parity/run.ts`:

```typescript
import { acquireDevice } from '../../src/engine/device';
import { RenderGraph } from '../../src/engine/graph';
import { buildArenas } from '../../src/host/spectral';
import { loadAssets } from '../../src/profiles/load';
import type { Arenas } from '../../src/engine/arena';
import type { Stage } from '../../src/engine/graph';
import type { TapName } from '../../src/engine/taps';
import {
  compareRgb, expectWithinTolerance, loadCase, loadInputAsRgba, loadTap,
} from './compare';
import { defaultCoreParams } from './params';

export interface TapParityOptions {
  case: string;
  tap: TapName;
  tolerance: number;
  stages: (device: GPUDevice, arenas: Arenas) => Stage[];
  stockId?: string;
}

export async function runTapParity(opts: TapParityOptions): Promise<void> {
  const engine = await acquireDevice();
  const bundle = await loadAssets('public/data');
  const arenas = buildArenas(
    engine.device, bundle, opts.stockId ?? 'kodak_portra_400',
  );

  const graph = new RenderGraph(engine);
  for (const stage of opts.stages(engine.device, arenas)) graph.addStage(stage);

  const meta = loadCase(opts.case);
  const actual = await graph.run(
    loadInputAsRgba(opts.case),
    defaultCoreParams(meta.width, meta.height, bundle),
    opts.tap,
  );

  expectWithinTolerance(
    compareRgb(actual, loadTap(opts.case, opts.tap)),
    opts.tolerance,
    `${opts.tap} / ${opts.case}`,
  );
}
```

Buat juga `spektra/test/parity/params.ts` yang memancarkan `CoreParams` yang
cocok dengan **hasil `digest_params(init_params())`** Python — bukan
`init_params()` mentah. Ini penting: `digest_params` menerapkan filter print
netral dari basis data dan logika khusus stock, sehingga nilai yang benar-benar
dipakai pipeline berbeda dari nilai yang baru dibangun. Baca
`$SPEKTRAFILM_PY/src/spektrafilm/runtime/params_builder.py` dan cocokkan satu
per satu — jangan menebak. Nilai yang salah di sini akan terlihat seperti bug
shader di setiap tugas berikutnya.

Cara termurah memperolehnya: tambahkan flag ke `gen_reference.py` yang
men-dump params ter-digest sebagai JSON di samping fixture, lalu terjemahkan
berkas itu ke `params.ts`. Membaca nilai dari objek yang benar-benar dipakai
mengalahkan membacanya dari sumber.

- [ ] **Step 5: Tulis host/spectral.ts**

Bangun ketiga arena dari `AssetBundle`. Tabel yang bergantung parameter (`HanatosRawResponse`) dihitung di sini — port dari `remapHanatosResponseForInputGamutCompression` di `$SPEKTRAFILM_OFX/src/SpektraVulkanRenderer.cpp` dan padanan Python-nya di `model/stocks.py`. Bandingkan keluaran fungsi TS ini dengan keluaran Python untuk parameter yang sama sebelum menjalankan test GPU — bug di sini akan terlihat seperti bug shader dan jauh lebih mahal dilacak dari sana.

- [ ] **Step 6: Transliterasi filmExposure.wgsl**

Terapkan tabel aturan mekanis dari Task 9 Step 3. Ganti setiap akses buffer terikat menjadi akses arena berbasis offset: `mallettRawMatrix[i]` menjadi `staticArena[ARENA_MALLETTRAWMATRIX_OFFSET + i]`.

**Periksa lebih dulu:** tahap ini adalah yang pertama mengalikan matriks. Konvensi `matN * vec` WGSL adalah column-major, sama seperti GLSL — tetapi *tata letak data* di buffer yang ditulis host mungkin row-major. Jika tap meleset dengan pola yang terlihat seperti transposisi (galat kecil di diagonal, besar di luar diagonal), itu penyebabnya.

- [ ] **Step 7: Tulis filmExposure.ts**

Ikuti bentuk `formatConvert.ts` dari Task 9 Step 4: buat modul shader dengan `CORE_PARAMS_WGSL` dan konstanta arena disambung di depan, buat pipeline, kembalikan `Stage` dengan `writesTaps: [Tap.LOG_E_FILM]`.

- [ ] **Step 8: Jalankan test parity**

```bash
cd spektra && npm test -- parity/filmExposure
```

Harapan: PASS untuk ketiga kasus, max abs error di orde 1e-7.

Jika meleset: jangan naikkan `TOLERANCE`. Periksa berurutan — (1) apakah `defaultCoreParams` benar-benar cocok dengan `init_params()`, (2) apakah arena TS cocok dengan tabel Python, (3) konvensi matriks, (4) urutan operasi di dalam shader.

- [ ] **Step 9: Commit**

```bash
git add spektra/src/shaders/filmExposure.wgsl spektra/src/engine/stages/filmExposure.ts spektra/src/host/spectral.ts spektra/test/parity
git commit -m "feat(spektra): FilmExposure stage matching Python reference at log_e_film"
```

---

## Task 12: Tahap CurveDevelop — gerbang `cmy_film`

**Files:**
- Create: `spektra/src/shaders/curveDevelop.wgsl`, `spektra/src/engine/stages/curveDevelop.ts`
- Test: `spektra/test/parity/curveDevelop.test.ts`

**Interfaces:**
- Consumes: arena `stock` (Task 8), `Stage` (Task 9)
- Produces: `function createCurveDevelopStage(device: GPUDevice, arenas: Arenas): Stage` dengan `writesTaps = [Tap.CMY_FILM]`

**Sumber hulu:** `$SPEKTRAFILM_PY/src/spektrafilm/model/density_curves.py` dan `model/develop.py`; `$SPEKTRAFILM_OFX/shaders/vulkan/SpektraCurveDevelop.comp` (246 baris, binding 0,1,2,3).

- [ ] **Step 1: Tulis test parity yang gagal**

Buat `spektra/test/parity/curveDevelop.test.ts`:

```typescript
import { describe, it } from 'vitest';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createCurveDevelopStage } from '../../src/engine/stages/curveDevelop';
import { Tap } from '../../src/engine/taps';
import { runTapParity } from './run';

describe('parity: cmy_film', () => {
  for (const name of ['gray_ramp', 'log_gray_ramp', 'color_patches']) {
    it(`cocok dengan referensi Python untuk ${name}`, async () => {
      await runTapParity({
        case: name,
        tap: Tap.CMY_FILM,
        tolerance: 1e-5,
        stages: (device, arenas) => [
          createMaterializeActiveRegionStage(device),
          createFilmExposureStage(device, arenas),
          createCurveDevelopStage(device, arenas),
        ],
      });
    });
  }
});
```

- [ ] **Step 2: Jalankan untuk memastikan gagal**

```bash
cd spektra && npm test -- parity/curveDevelop
```

Harapan: FAIL, modul tidak ditemukan.

- [ ] **Step 3: Transliterasi curveDevelop.wgsl**

Inti tahap ini adalah `interpDensityCurve`, yang melakukan pencarian biner pada `curveExposure` lalu interpolasi linear pada `densityCurves`. Salin logikanya persis — termasuk penanganan batas (`lookupRaw <= firstX` mengembalikan `densityCurves[channel]`, `>= lastX` mengembalikan baris terakhir) dan perkalian `filmGamma` sebelum pencarian.

**Jangan** ganti pencarian biner dengan sampling tekstur. Itu akan mempercepat tahap ini dan mengubah hasilnya; aturan kualitas melarangnya.

- [ ] **Step 4: Tulis curveDevelop.ts**

Ikuti bentuk yang sama seperti tahap sebelumnya. `exposureCount` di `CoreParams` harus disetel ke `stock.entry.curvePoints` (256), bukan dibiarkan nol.

- [ ] **Step 5: Jalankan test parity**

```bash
cd spektra && npm test -- parity/curveDevelop
```

Harapan: PASS.

Jika meleset hanya pada piksel paling gelap atau paling terang, penyebabnya penanganan batas kurva. Jika meleset merata, penyebabnya arena `stock` atau `exposureCount`.

- [ ] **Step 6: Commit**

```bash
git add spektra/src/shaders/curveDevelop.wgsl spektra/src/engine/stages/curveDevelop.ts spektra/test/parity/curveDevelop.test.ts
git commit -m "feat(spektra): CurveDevelop stage matching Python reference at cmy_film"
```

---

## Task 13: Tahap Dir (DIR coupler)

**Files:**
- Create: `spektra/src/shaders/dir.wgsl`, `spektra/src/engine/stages/dir.ts`
- Test: `spektra/test/parity/dir.test.ts`

**Interfaces:**
- Consumes: arena `stock` dan `dynamic`
- Produces: `function createDirStage(device: GPUDevice, arenas: Arenas): Stage` dengan `writesTaps = [Tap.CMY_FILM]` — ia membaca dan menyempurnakan tap itu, sama seperti node DIR di topologi Python

**Sumber hulu:** `$SPEKTRAFILM_PY/src/spektrafilm/model/couplers.py`; `$SPEKTRAFILM_OFX/shaders/vulkan/SpektraDir.comp` (329 baris).

Tahap ini tidak menulis tap kanonis, jadi ia digerbangi secara tidak langsung: `cmy_film` dengan `dirCouplersAmount > 0`.

- [ ] **Step 1: Bangkitkan fixture dengan DIR aktif**

Tambahkan varian kasus ke `gen_reference.py` yang menyetel `dir_amount=1.0` sebelum menjalankan pipeline, lalu jalankan:

```bash
~/.venvs/spektra-ref/Scripts/python spektra/tools/gen_reference.py --out spektra/test/fixtures --case hard_edge
```

~~Nama fixture: `hard_edge_dir`.~~ **USANG — tidak pernah dibuat dan tidak dibutuhkan.** Di bawah `lut_mode` suku spasial DIR hilang (`diffusion_size_um = 0`, dan `couplers.py:142` sendiri yang men-short-circuit-nya), jadi koreksi DIR yang perlu diport adalah per-piksel dan keluarga `_lut` yang sudah ada sudah cukup. Task 13 ditutup di situ pada 2.980e-7/3.576e-7/8.047e-7. Suku difusi spasial DIR ditunda untuk diverifikasi terhadap keluarga yang efeknya hidup.

- [ ] **Step 2: Tulis test parity yang gagal**

Buat `spektra/test/parity/dir.test.ts`:

```typescript
import { describe, it } from 'vitest';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createCurveDevelopStage } from '../../src/engine/stages/curveDevelop';
import { createDirStage } from '../../src/engine/stages/dir';
import { Tap } from '../../src/engine/taps';
import { runTapParity } from './run';

describe('parity: DIR coupler', () => {
  it('cocok dengan referensi Python pada tepi keras dengan DIR aktif', async () => {
    await runTapParity({
      case: 'hard_edge_dir',
      tap: Tap.CMY_FILM,
      tolerance: 1e-5,
      stages: (device, arenas) => [
        createMaterializeActiveRegionStage(device),
        createFilmExposureStage(device, arenas),
        createCurveDevelopStage(device, arenas),
        createDirStage(device, arenas),
      ],
    });
  });
});
```

- [ ] **Step 3: Jalankan untuk memastikan gagal**

```bash
cd spektra && npm test -- parity/dir
```

- [ ] **Step 4: Transliterasi dir.wgsl**

Perhatikan dua hal: matriks crosstalk 9-gamma (`dirCouplersGammaSameLayerR/G/B`, `GammaRToG`, `GammaRToB`, `GammaGToR`, `GammaGToB`, `GammaBToR`, `GammaBToG`) dan difusi dua skala (20 µm dengan ekor 200 µm berbobot 0,06). Difusi dijalankan sebagai pass terpisah dengan `binding = 2, 3` sebagai buffer kedua — baca shader hulu untuk urutan pass yang tepat.

- [ ] **Step 5: Tulis dir.ts dan jalankan test**

```bash
cd spektra && npm test -- parity/dir
```

Harapan: PASS.

- [ ] **Step 6: Commit**

```bash
git add spektra/src/shaders/dir.wgsl spektra/src/engine/stages/dir.ts spektra/test/parity/dir.test.ts spektra/test/fixtures/hard_edge_dir spektra/tools/gen_reference.py
git commit -m "feat(spektra): DIR coupler stage with 9-gamma crosstalk and two-scale diffusion"
```

---

## Task 14: Tahap Halation

> **DIKOREKSI sebelum dieksekusi.** Teks Task 14 yang lama menempatkan Halation
> SETELAH Dir dan menulis tap `cmy_film`, dengan sumber hulu `model/glare.py`.
> Ketiganya salah. Python menerapkan halation di dalam `FilmingStage.expose()`
> (`runtime/stages/filming.py:68`), SEBELUM `log10` yang menghasilkan
> `log_e_film` — jadi ia berada sebelum CurveDevelop, bukan setelah Dir, dan
> tap yang ia pengaruhi adalah `log_e_film`. Sumbernya
> `model/diffusion.py::apply_halation_um`, bukan `glare.py` (itu `add_glare`,
> milik Task 16/18). Lih. Global Constraints, peta tap→tahap.
>
> **Tidak ada fixture baru yang perlu dibangkitkan.** Keluarga `<case>` biasa
> SUDAH merupakan "spasial hidup, stokastik mati" — itulah yang
> `deactivate_stochastic_effects` hasilkan, dan itulah kenapa Task 11 mengukur
> 3.415e-5 terhadapnya. Ketiga suku spasial lain di `expose()` adalah no-op pada
> default: `camera.lens_blur_um = 0.0`, `camera.diffusion_filter.active = False`,
> `halation.boost_ev = 0.0` (params_schema.py:53, :16, :118). Dibuktikan bukan
> diasumsikan: A/B Python dengan HANYA halation yang di-toggle memberi 3.397e-5,
> praktis seluruh celahnya — kalau diffusion atau lens blur juga hidup, angka itu
> tidak akan cocok.

**Files:**
- Create: `spektra/src/shaders/halation.wgsl`, `spektra/src/engine/stages/halation.ts`
- Test: gerbang ditambahkan ke `spektra/test/parity/filmExposure.test.ts` (tap yang sama, keluarga berbeda) — bukan berkas baru yang menegaskan tap yang sama

**Interfaces:**
- Produces: `function createHalationStage(device: GPUDevice, arenas: Arenas): Stage`, `writesTaps = [Tap.LOG_E_FILM]`

**Sumber hulu:** `$SPEKTRAFILM_PY/src/spektrafilm/model/diffusion.py` (`apply_halation_um`, plus `fast_exponential_filter` untuk campuran Gaussian+ekor eksponensial); `$SPEKTRAFILM_OFX/shaders/vulkan/SpektraHalation.comp` (322 baris).

- [ ] **Step 1: Tulis gerbang yang gagal**

Rantai: `materializeActiveRegion → filmExposure → halation`, tap `Tap.LOG_E_FILM`, `family: 'measured'`, kasus `gray_ramp` / `log_gray_ramp` / `color_patches` (keluarga biasa, BUKAN `_lut`), ambang `1e-5`.

Angka yang harus dikalahkan sudah diketahui: **3.415e-5** — itu lubang berbentuk-halation yang Task 11 ukur di keluarga ini. Gerbang `_lut` yang sudah hijau TIDAK boleh berubah.

- [ ] **Step 2: Transliterasi halation.wgsl**

Dua bagian yang benar-benar terpisah di `apply_halation_um`, keduanya spasial:
1. **Hamburan dalam emulsi** — campuran hemat-energi: inti Gaussian (`scatter_core_um`) plus ekor eksponensial (`scatter_tail_um`, `scatter_tail_weight`), di mana ekornya di-dispatch ke campuran Gaussian oleh `fast_exponential_filter`. Tiru pendekatan yang SAMA; jangan ganti dengan satu Gaussian "yang lebih benar secara teori".
2. **Halation refleksi-balik** — jumlah aditif N Gaussian dengan lebar `sqrt(k)` (`halation_strength`, `halation_first_sigma_um`).

Tahap ini berjalan sebagai dua pass (scatter lalu resolve) dengan pasangan buffer `binding = 0,1` dan `2,3`. `FrameFloats` di `binding = 27` menjadi arena `dynamic`.

Semua sigma dalam mikron dan harus dikonversi ke piksel lewat `pixel_size_um`, yang bergantung pada `film_format_mm` dan lebar gambar — salah di sini memberi blur dengan bentuk benar tapi skala salah, dan itu terlihat sebagai meleset yang halus bukan kasar. Periksa `pixel_size_um` sebelum menyalahkan kernelnya.

- [ ] **Step 3: Tulis halation.ts dan jalankan gerbang**

Laporkan max abs error PER KASUS. Harapan: ~1e-7.

- [ ] **Step 4: Commit**

```bash
git add spektra/src/shaders/halation.wgsl spektra/src/engine/stages/halation.ts spektra/test/parity/filmExposure.test.ts
git commit -m "feat(spektra): halation closes log_e_film on the spatial family"
```

---

## Task 15: Tahap Diffusion

> **DIKOREKSI sebelum dieksekusi**, kesalahan sekelas Task 14. Teks lama
> menetapkan `writesTaps = [Tap.CMY_FILM]` untuk `site: 'camera'` dan
> `[Tap.CMY_PRINT]` untuk `site: 'print'`, serta merantai diffusion kamera
> SETELAH Halation. Ketiganya salah:
>
> - Diffusion kamera dipakai di dalam `FilmingStage.expose()`
>   (`runtime/stages/filming.py:62`) — SEBELUM `apply_gaussian_blur_um` (:67)
>   dan SEBELUM `apply_halation_um` (:68). Jadi tapnya **`log_e_film`**, bukan
>   `cmy_film`, dan posisinya **sebelum** Halation, bukan sesudah.
> - Diffusion enlarger dipakai di dalam `PrintingStage.expose()` sebelum
>   `log10`-nya. Jadi tapnya **`log_e_print`**, bukan `cmy_print`.
>
> **Ini satu-satunya tugas yang BENAR-BENAR butuh keluarga fixture baru.**
> `DiffusionFilterParams.active` default `False` untuk kamera MAUPUN enlarger
> (`params_schema.py:16`), dan tidak ada preset stok yang menyalakannya
> (diperiksa: satu-satunya penyebutan `diffusion_filter.active` di
> `params_builder.py` adalah baris 135-136, yang MEMATIKANNYA). Jadi tidak ada
> keluarga yang sudah ada — `<case>`, `_stochastic`, maupun `_lut` — yang punya
> diffusion hidup, dan tidak ada angka target yang sudah terukur seperti 3.415e-5
> milik Task 14. Bangkitkan keluarga baru dengan `camera.diffusion_filter.active
> = True` (dan varian enlarger untuk `log_e_print`), ikuti disiplin
> `_write_json_lf()` + manifes sha256, dan PASTIKAN setiap fixture lama keluar
> byte-identik — lih. cara Task 11 melakukannya di `gen_reference.py`.

**Files:**
- Create: `spektra/src/shaders/diffusion.wgsl`, `spektra/src/engine/stages/diffusion.ts`
- Test: `spektra/test/parity/diffusion.test.ts`

**Interfaces:**
- Produces: `function createDiffusionStage(device: GPUDevice, arenas: Arenas, site: 'camera' | 'print'): Stage`, `writesTaps = [Tap.CMY_FILM]` untuk `site: 'camera'` dan `[Tap.CMY_PRINT]` untuk `site: 'print'`

**Sumber hulu:** `$SPEKTRAFILM_PY/src/spektrafilm/model/diffusion.py`; `$SPEKTRAFILM_OFX/shaders/vulkan/SpektraDiffusion.comp` (513 baris).

Satu shader, dua titik sisip. Parameter `site` memilih kumpulan nilai mana yang dibaca dari arena `dynamic`.

- [ ] **Step 1: Bangkitkan fixture `hard_edge_diffusion_camera`**

- [ ] **Step 2: Tulis test parity yang gagal**

Buat `spektra/test/parity/diffusion.test.ts`:

```typescript
import { describe, it } from 'vitest';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createCurveDevelopStage } from '../../src/engine/stages/curveDevelop';
import { createDirStage } from '../../src/engine/stages/dir';
import { createHalationStage } from '../../src/engine/stages/halation';
import { createDiffusionStage } from '../../src/engine/stages/diffusion';
import { Tap } from '../../src/engine/taps';
import { runTapParity } from './run';

describe('parity: diffusion kamera', () => {
  it('cocok dengan referensi Python', async () => {
    await runTapParity({
      case: 'hard_edge_diffusion_camera',
      tap: Tap.CMY_FILM,
      tolerance: 1e-5,
      stages: (device, arenas) => [
          createMaterializeActiveRegionStage(device),
          createFilmExposureStage(device, arenas),
          createCurveDevelopStage(device, arenas),
          createDirStage(device, arenas),
          createHalationStage(device, arenas),
        createDiffusionStage(device, arenas, 'camera'),
      ],
    });
  });
});
```

- [ ] **Step 3: Jalankan untuk memastikan gagal**

```bash
cd spektra && npm test -- parity/diffusion
```

- [ ] **Step 4: Transliterasi diffusion.wgsl**

Shader ini adalah dispatcher operasi: `kOpDownsample` (7), `kOpDownsampleBlurX` (8), `kOpDownsampleBlurY` (9), `kOpDownsampleUpsampleAccumulate` (10), dan varian grup (11–13). Tiap operasi adalah dispatch terpisah dengan nilai op berbeda di `CoreParams`.

**JANGAN port jalur piramida turun-naik OFX.** Itu aproksimasi milik shader GPU OFX, BUKAN milik Python, dan oracle kita Python. Implementer Task 15 mengukurnya: surrogate campuran-Gaussian yang setia pada OFX meleset dari Python sebesar 7.38e-4 (hard_edge) sampai 1.273e-1 (impulse_highlight) pada `glimmerglass` di kekuatan TERLEMAH 0.125 — 70x sampai 12.700x di atas ambang, dan keluarga yang lebih berat 5x-1000x lebih buruk lagi. Rasio maxAbs/p_s konstan per keluarga, jadi tidak ada pilihan `strength` yang memisahkan "efeknya terlihat" dari "lulus gerbang".

**Yang di-port adalah konvolusi hingga yang EKSAK.** `fftconvolve` dengan kernel hingga setara konvolusi spasial langsung dengan kernel yang sama, jadi ini bisa direproduksi tepat di GPU: pra-hitung PSF per-kanal di host (persis seperti `diffusion_filter_psf`), lalu konvolusi 2D langsung di shader dengan padding `reflect`. Ukurannya sama sekali tidak menakutkan pada ukuran fixture — diukur pada 35 mm / lebar 64 px (`pixel_size_um` 546,88):

| Keluarga | lambda_max (um) | radius (px) | kernel |
|---|---|---|---|
| `glimmerglass` | 650 | 10 | 21x21 |
| `black_pro_mist` | 950 | 14 | 29x29 |
| `pro_mist` | 1625 | 24 | 49x49 |
| `cinebloom` | 2500 | 31 | 63x63 |

Radius dibatasi `min(image.shape[:2])//2 - 1` oleh Python sendiri, jadi ia tidak bisa meledak di luar kendali. PSF-nya terbukti simetris persis (`psf == psf[::-1,::-1]`, rtol=atol=0) untuk keempat keluarga, jadi konvolusi-versus-korelasi tidak jadi masalah — tapi verifikasi itu sendiri, jangan percaya kalimat ini. Untuk gambar full-res nanti, FFT di GPU boleh dipertimbangkan sebagai OPTIMASI yang harus diverifikasi terhadap jalur langsung ini; bukan sebagai pengganti yang tidak terverifikasi.

- [ ] **Step 5: Tulis diffusion.ts dan jalankan test**

```bash
cd spektra && npm test -- parity/diffusion
```

Harapan: PASS.

- [ ] **Step 6: Commit**

```bash
git add spektra/src/shaders/diffusion.wgsl spektra/src/engine/stages/diffusion.ts spektra/test/parity/diffusion.test.ts spektra/test/fixtures/hard_edge_diffusion_camera
git commit -m "feat(spektra): diffusion stage with upstream pyramid path preserved"
```

---

## Task 16: Tahap Grain

**Files:**
- Create: `spektra/src/shaders/grain.wgsl`, `spektra/src/engine/stages/grain.ts`, `spektra/test/parity/statistics.ts`
- Test: `spektra/test/parity/grain.test.ts`

**Interfaces:**
- Consumes: buffer scratch tambahan (`AuxPixelsA/B`, `MicroPixelsA/B`, `GrainLayerA/B`)
- Produces:
  - `function createGrainStage(device: GPUDevice, arenas: Arenas): Stage`, `writesTaps = [Tap.CMY_FILM]`
  - `interface Moments { mean: number; variance: number; radialPower: Float32Array }`
  - `function moments(rgba: Float32Array, width: number, height: number): Moments`

**Sumber hulu:** `$SPEKTRAFILM_PY/src/spektrafilm/model/grain.py`; `$SPEKTRAFILM_OFX/shaders/vulkan/SpektraGrain.comp` (1.183 baris).

Grain bersifat stokastik. Ia digerbangi secara statistik, bukan per piksel — tetapi dengan seed identik, bukan dengan ambang yang longgar.

**Catatan dari Task 3:** grain di Python sebenarnya *deterministik* secara default. `model/grain.py:84-87` menyetel `seed = [0, 1, 2]` justru ketika `fixed_seed` bernilai `None` — penamaan yang membingungkan, tetapi akibatnya realisasi grain Python stabil antar-run. Yang benar-benar bervariasi di keluarga stokastik hanyalah glare.

Itu tidak mengubah rancangan gerbang ini. Alasan grain digerbangi secara statistik bukan karena Python-nya acak, melainkan karena RNG WGSL yang kita tulis adalah algoritma yang berbeda. Dua implementasi yang benar akan menghasilkan butir yang berbeda pada piksel yang sama, dengan statistik yang sama. Jangan tergoda menaikkannya menjadi gerbang per piksel karena sisi Python ternyata dapat direproduksi.

`moments()` yang ditulis di sini dipakai ulang oleh Task 18 untuk menggerbangi glare, yang stokastik dengan alasan yang sama. Rancang ia agar berdiri sendiri terhadap kasus uji mana pun, bukan khusus grain.

- [ ] **Step 1: Bangkitkan fixture `gray_ramp_grain` dengan seed tetap**

Setel `grain_enabled=true`, `grain_model=production`, dan seed eksplisit di `gen_reference.py`. Catat seed itu di `case.json`.

- [ ] **Step 2: Tulis statistics.ts**

```typescript
export interface Moments {
  mean: number;
  variance: number;
  radialPower: Float32Array;
}

/** Momen dan spektrum daya radial dari kanal hijau. */
export function moments(
  rgba: Float32Array,
  width: number,
  height: number,
): Moments {
  const pixels = width * height;
  let sum = 0;
  for (let p = 0; p < pixels; p += 1) sum += rgba[p * 4 + 1]!;
  const mean = sum / pixels;

  let sq = 0;
  for (let p = 0; p < pixels; p += 1) {
    const d = rgba[p * 4 + 1]! - mean;
    sq += d * d;
  }

  const bins = Math.min(width, height) >> 1;
  const power = new Float32Array(bins);
  const counts = new Uint32Array(bins);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - width / 2;
      const dy = y - height / 2;
      const r = Math.min(bins - 1, Math.round(Math.hypot(dx, dy)));
      const d = rgba[(y * width + x) * 4 + 1]! - mean;
      power[r] = power[r]! + d * d;
      counts[r] = counts[r]! + 1;
    }
  }
  for (let i = 0; i < bins; i += 1) {
    if (counts[i]! > 0) power[i] = power[i]! / counts[i]!;
  }

  return { mean, variance: sq / pixels, radialPower: power };
}
```

- [ ] **Step 3: Tulis test parity yang gagal**

Grain tidak bisa lewat `runTapParity` karena pembandingnya statistik, bukan
per piksel. Buat `spektra/test/parity/grain.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { acquireDevice } from '../../src/engine/device';
import { RenderGraph } from '../../src/engine/graph';
import { buildArenas } from '../../src/host/spectral';
import { loadAssets } from '../../src/profiles/load';
import { Tap } from '../../src/engine/taps';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createCurveDevelopStage } from '../../src/engine/stages/curveDevelop';
import { createDirStage } from '../../src/engine/stages/dir';
import { createHalationStage } from '../../src/engine/stages/halation';
import { createGrainStage } from '../../src/engine/stages/grain';
import { createDiffusionStage } from '../../src/engine/stages/diffusion';
import { loadCase, loadInputAsRgba, loadTap } from './compare';
import { defaultCoreParams } from './params';
import { moments } from './statistics';

describe('parity: grain (statistik)', () => {
  it('momen dan spektrum daya cocok dengan referensi pada seed yang sama', async () => {
    const engine = await acquireDevice();
    const bundle = await loadAssets('public/data');
    const arenas = buildArenas(engine.device, bundle, 'kodak_portra_400');

    const graph = new RenderGraph(engine);
    for (const stage of [
      createMaterializeActiveRegionStage(device),
      createFilmExposureStage(device, arenas),
      createCurveDevelopStage(device, arenas),
      createDirStage(device, arenas),
      createHalationStage(device, arenas),
      createGrainStage(device, arenas),
      createDiffusionStage(device, arenas, 'camera'),
    ]) graph.addStage(stage);

    const meta = loadCase('gray_ramp_grain');
    const actual = await graph.run(
      loadInputAsRgba('gray_ramp_grain'),
      defaultCoreParams(meta.width, meta.height, bundle),
      Tap.CMY_FILM,
    );

    // Referensi disimpan RGB rapat; perluas ke RGBA agar moments() sebanding.
    const expectedRgb = loadTap('gray_ramp_grain', 'cmy_film');
    const expectedRgba = new Float32Array((expectedRgb.length / 3) * 4);
    for (let p = 0; p < expectedRgb.length / 3; p += 1) {
      expectedRgba[p * 4] = expectedRgb[p * 3]!;
      expectedRgba[p * 4 + 1] = expectedRgb[p * 3 + 1]!;
      expectedRgba[p * 4 + 2] = expectedRgb[p * 3 + 2]!;
      expectedRgba[p * 4 + 3] = 1;
    }

    const got = moments(actual, meta.width, meta.height);
    const want = moments(expectedRgba, meta.width, meta.height);

    expect(got.mean).toBeCloseTo(want.mean, 4);
    expect(Math.abs(got.variance - want.variance) / want.variance).toBeLessThan(0.02);

    for (let bin = 1; bin < want.radialPower.length; bin += 1) {
      const w = want.radialPower[bin]!;
      if (w < 1e-12) continue;
      const relative = Math.abs(got.radialPower[bin]! - w) / w;
      expect(relative, `bin daya radial ${bin}`).toBeLessThan(0.05);
    }
  });
});
```

Rasional ambang: dengan seed identik dan algoritma identik, momen harus cocok
erat — 2% pada varians adalah kelonggaran untuk perbedaan pembulatan f32
versus f64, bukan untuk perbedaan algoritma. Spektrum daya radial adalah
pemeriksaan bahwa *struktur spasial* grain benar, bukan sekadar jumlah
deraunya; dua implementasi bisa punya varians sama dengan ukuran butir yang
sama sekali berbeda.

- [ ] **Step 4: Jalankan untuk memastikan gagal**

```bash
cd spektra && npm test -- parity/grain
```

- [ ] **Step 5: Transliterasi grain.wgsl**

Ini shader terbesar kedua. Dua mode: `kOpPreview` (0) dan `kOpProductionLayers` (1), ditambah jalur grain synthesis dengan parameter dari `FrameFloats` indeks 78–90.

**Default proyek adalah `kOpProductionLayers`,** bukan preview. Lihat Global Constraints.

Perhatikan fungsi hash/PRNG hulu: ia harus direproduksi bit demi bit, atau seed tidak akan berarti apa-apa. Jika GLSL memakai operasi integer yang bergantung pada overflow, WGSL memiliki semantik wrapping yang sama untuk `u32` — tetapi verifikasi ini dengan uji unit kecil atas fungsi hash saja sebelum menguji seluruh tahap.

- [ ] **Step 6: Tulis grain.ts dan jalankan test**

```bash
cd spektra && npm test -- parity/grain
```

Harapan: PASS.

- [ ] **Step 7: Commit**

```bash
git add spektra/src/shaders/grain.wgsl spektra/src/engine/stages/grain.ts spektra/test/parity
git commit -m "feat(spektra): grain stage gated statistically against Python reference"
```

---

## Task 17: Tahap PrintScan — gerbang `log_e_print` dan `cmy_print`

**Files:**
- Create: `spektra/src/shaders/printScan.wgsl`, `spektra/src/engine/stages/printScan.ts`, `spektra/src/host/enlarger.ts`
- Test: `spektra/test/parity/printScan.test.ts`

**Interfaces:**
- Produces:
  - `function createPrintExposureStage(device: GPUDevice, arenas: Arenas): Stage`, `writesTaps = [Tap.LOG_E_PRINT]`
  - `function createPrintDevelopStage(device: GPUDevice, arenas: Arenas): Stage`, `writesTaps = [Tap.CMY_PRINT]`

Satu modul WGSL, dua tahap TS. `log_e_print` adalah keadaan di tengah shader hulu, jadi ia tidak dapat digerbangi jika seluruh 1.488 baris itu menjadi satu tahap tunggal — dan tahap terbesar di rencana ini adalah tahap yang paling butuh checkpoint. Ini pola yang sama dengan `Diffusion`: satu shader, beberapa titik sisip. (Hasil pemindaian pra-terbang; lihat ledger.)
  - `interface EnlargerParams { filterC: number; filterMShift: number; filterYShift: number; printTiming: 'filteredEnlarger' | 'apdPrinterDensity' }`
  - `function filteredEnlargerIlluminant(params: EnlargerParams, bundle: AssetBundle): Float32Array` — port dari `filteredEnlargerIlluminantCpu` hulu

**Sumber hulu:** `$SPEKTRAFILM_PY/src/spektrafilm/runtime/stages/printing.py`, `model/color_filters.py`, `model/illuminants.py`; `$SPEKTRAFILM_OFX/shaders/vulkan/SpektraPrintScan.comp` (1.488 baris, 30 binding).

Tahap terbesar. Ia menulis dua tap, jadi dibutuhkan dua pass yang dapat di-collect terpisah.

- [ ] **Step 1: Tulis uji unit untuk filteredEnlargerIlluminant lebih dulu**

Bandingkan keluaran fungsi TS dengan keluaran Python untuk lima kombinasi `filterC`/`filterMShift`/`filterYShift`. Bangkitkan referensinya dengan skrip Python kecil yang memanggil `model/color_filters.py` langsung.

Ini didahulukan karena 30 binding menjadikan tahap ini tempat terburuk untuk men-debug kesalahan host-side. Pastikan tabel benar sebelum shader-nya dijalankan.

- [ ] **Step 2: Tulis test parity yang gagal untuk kedua tap**

Buat `spektra/test/parity/printScan.test.ts`:

```typescript
import { describe, it } from 'vitest';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createCurveDevelopStage } from '../../src/engine/stages/curveDevelop';
import { createDirStage } from '../../src/engine/stages/dir';
import { createHalationStage } from '../../src/engine/stages/halation';
import { createGrainStage } from '../../src/engine/stages/grain';
import { createDiffusionStage } from '../../src/engine/stages/diffusion';
import {
  createPrintExposureStage, createPrintDevelopStage,
} from '../../src/engine/stages/printScan';
import { Tap } from '../../src/engine/taps';
import { runTapParity } from './run';

const filmSide = (device: GPUDevice, arenas: Arenas) => [
        createMaterializeActiveRegionStage(device),
        createFilmExposureStage(device, arenas),
        createCurveDevelopStage(device, arenas),
        createDirStage(device, arenas),
        createHalationStage(device, arenas),
        createGrainStage(device, arenas),
        createDiffusionStage(device, arenas, 'camera'),
];

describe('parity: PrintScan', () => {
  for (const name of ['gray_ramp', 'color_patches']) {
    it(`log_e_print cocok dengan referensi Python untuk ${name}`, async () => {
      await runTapParity({
        case: name,
        tap: Tap.LOG_E_PRINT,
        tolerance: 1e-5,
        stages: (device, arenas) => [
          ...filmSide(device, arenas),
          createPrintExposureStage(device, arenas),
        ],
      });
    });

    it(`cmy_print cocok dengan referensi Python untuk ${name}`, async () => {
      await runTapParity({
        case: name,
        tap: Tap.CMY_PRINT,
        tolerance: 1e-5,
        stages: (device, arenas) => [
          ...filmSide(device, arenas),
          createPrintExposureStage(device, arenas),
          createPrintDevelopStage(device, arenas),
        ],
      });
    });
  }
});
```

Tambahkan `import type { Arenas } from '../../src/engine/arena';` di atas.

Gerbangi `log_e_print` lebih dulu sampai hijau sebelah menyentuh `cmy_print`.

- [ ] **Step 3: Jalankan untuk memastikan gagal**

```bash
cd spektra && npm test -- parity/printScan
```

- [ ] **Step 4: Petakan 30 binding hulu ke enam**

| Arena | Binding hulu |
|---|---|
| `source` / `dest` | 0, 1 |
| `params` | push constant |
| `static` | 5, 6, 7, 8, 15, 17, 22, 26 |
| `stock` | 2, 3, 10, 11, 12, 13, 18, 19, 21 |
| `dynamic` | 9, 14, 16, 20, 23, 24, 25, 29, 30 |
| `frameState` | 27, 28 |

Catat: binding 14 (`FilteredEnlargerResponse`) dan 27 (`FrameFloats`) adalah read-write di hulu, bukan read-only. Pertahankan sifat itu.

- [ ] **Step 5: Transliterasi printScan.wgsl**

Kerjakan bertahap dan gerbangi `log_e_print` sebelum `cmy_print`. Jika seluruh shader ditransliterasi sebelum ada yang diuji, tahap ini menjadi persis jenis debugging yang dihindari rencana ini.

- [ ] **Step 6: Jalankan test parity**

```bash
cd spektra && npm test -- parity/printScan
```

Harapan: PASS untuk kedua tap.

- [ ] **Step 7: Commit**

```bash
git add spektra/src/shaders/printScan.wgsl spektra/src/engine/stages/printScan.ts spektra/src/host/enlarger.ts spektra/test/parity/printScan.test.ts
git commit -m "feat(spektra): PrintScan stage with 30 upstream bindings packed into six"
```

---

## Task 18: Tahap ScannerPost — gerbang `rgb_out`

**Files:**
- Create: `spektra/src/shaders/scannerPost.wgsl`, `spektra/src/engine/stages/scannerPost.ts`
- Test: `spektra/test/parity/scannerPost.test.ts`

**Interfaces:**
- Produces: `function createScannerPostStage(device: GPUDevice, arenas: Arenas): Stage`, `writesTaps = [Tap.RGB_OUT]`

**Sumber hulu:** `$SPEKTRAFILM_PY/src/spektrafilm/runtime/stages/scanning.py`; `$SPEKTRAFILM_OFX/shaders/vulkan/SpektraScannerPost.comp` (600 baris).

- [ ] **Step 1: Tulis test parity yang gagal**

Buat `spektra/test/parity/scannerPost.test.ts`:

```typescript
import { describe, it } from 'vitest';
import { fullChain } from './chain';
import { Tap } from '../../src/engine/taps';
import { runTapParity } from './run';

const CASES = [
  'gray_ramp', 'log_gray_ramp', 'hard_edge',
  'impulse_highlight', 'color_patches',
];

describe('parity: rgb_out', () => {
  for (const name of CASES) {
    it(`cocok dengan referensi Python untuk ${name}`, async () => {
      await runTapParity({
        case: name,
        tap: Tap.RGB_OUT,
        tolerance: 1e-5,
        stages: fullChain,
      });
    });
  }
});
```

Buat juga `spektra/test/parity/chain.ts` — **dibuat di sini, di tugas ini**,
dan satu-satunya tempat urutan lengkap dirakit. Tugas sebelumnya memakai daftar
tahap eksplisit karena tahap di hilirnya belum ada. Perhatikan kedua titik sisip
Diffusion dan dua tahap sisi print:

```typescript
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createCurveDevelopStage } from '../../src/engine/stages/curveDevelop';
import { createDirStage } from '../../src/engine/stages/dir';
import { createHalationStage } from '../../src/engine/stages/halation';
import { createGrainStage } from '../../src/engine/stages/grain';
import { createDiffusionStage } from '../../src/engine/stages/diffusion';
import {
  createPrintExposureStage, createPrintDevelopStage,
} from '../../src/engine/stages/printScan';
import { createScannerPostStage } from '../../src/engine/stages/scannerPost';
import type { Arenas } from '../../src/engine/arena';
import type { Stage } from '../../src/engine/graph';

export function fullChain(device: GPUDevice, arenas: Arenas): Stage[] {
  return [
    createMaterializeActiveRegionStage(device),
    createFilmExposureStage(device, arenas),
    createCurveDevelopStage(device, arenas),
    createDirStage(device, arenas),
    createHalationStage(device, arenas),
    createGrainStage(device, arenas),
    createDiffusionStage(device, arenas, 'camera'),
    createPrintExposureStage(device, arenas),
    createPrintDevelopStage(device, arenas),
    createDiffusionStage(device, arenas, 'print'),
    createScannerPostStage(device, arenas),
  ];
}
```

- [ ] **Step 2: Jalankan untuk memastikan gagal**

```bash
cd spektra && npm test -- parity/scannerPost
```

- [ ] **Step 3: Transliterasi scannerPost.wgsl**

Unsharp mask (`binding = 2` sebagai `UnsharpPixels`) berjalan sebagai pass terpisah sebelum encode keluaran. `ColorEncodeLuts` (`binding = 25`) masuk arena `static`.

- [ ] **Step 4: Tulis scannerPost.ts dan jalankan test**

```bash
cd spektra && npm test -- parity/scannerPost
```

Harapan: PASS.

- [ ] **Step 5: Tambahkan gerbang statistik untuk glare**

`rgb_out` digerbangi per piksel pada keluarga fixture **deterministik**, di mana glare mati. Glare sendiri masih harus diverifikasi, dan seperti grain ia stokastik — `add_glare` menarik medan lognormal acak, dan RNG WGSL kita bukan RNG numba, jadi perbandingan piksel-demi-piksel tidak punya arti berapa pun toleransinya.

Verifikasi ia dengan cara yang sama seperti grain di Task 16: bangkitkan kasus `_stochastic`, lalu bandingkan `moments()` dari `test/parity/statistics.ts` — mean dalam `1e-4`, varians dalam selisih relatif 2%, spektrum daya radial bin demi bin dalam 5%.

Spektrum daya radial adalah bagian yang penting di sini: `glareBlur` (0,5 default) dan `glareRoughness` (0,7) menentukan skala spasial medan itu. Dua implementasi bisa punya varians identik dengan struktur yang sama sekali berbeda, dan hanya spektrum daya yang membedakannya.

- [ ] **Step 6: Jalankan seluruh rangkaian parity**

```bash
cd spektra && npm test
```

Harapan: seluruh tap lulus untuk seluruh kasus. **Ini tonggak Fase 1:** engine cocok dengan implementasi referensi dari ujung ke ujung.

- [ ] **Step 7: Commit**

```bash
git add spektra/src/shaders/scannerPost.wgsl spektra/src/engine/stages/scannerPost.ts spektra/test/parity/scannerPost.test.ts
git commit -m "feat(spektra): ScannerPost stage completes end-to-end parity at rgb_out"
```

---

## Task 19: Tiling dengan apron

**Files:**
- Create: `spektra/src/engine/tiling.ts`
- Modify: `spektra/src/engine/graph.ts` — tambahkan jalur render ter-tile
- Test: `spektra/test/tiling.test.ts`

**Interfaces:**
- Consumes: `RenderGraph` (Task 9), seluruh tahap
- Produces:
  - `interface TileSpec { tileOriginX: number; tileOriginY: number; activeOriginX: number; activeOriginY: number; activeWidth: number; activeHeight: number; tileWidth: number; tileHeight: number }`
  - `interface SpatialEffectFlags { halationEnabled: boolean; grainEnabled: boolean; cameraDiffusionEnabled: boolean; printDiffusionEnabled: boolean; dirCouplersAmount: number; scannerUnsharpEnabled: boolean }`
  - `function estimateTileOverlap(flags: SpatialEffectFlags): number` — port dari `estimateVulkanTileOverlap` hulu
  - `function planTiles(width: number, height: number, maxBytes: number, overlap: number): TileSpec[]`
  - `RenderGraph.run` menerima opsi `{ maxBufferBytes?: number }` dan melakukan tiling jika perlu

**Sumber hulu:** `$SPEKTRAFILM_OFX/src/SpektraVulkanRenderer.cpp:1190` (`estimateVulkanTileOverlap`).

- [ ] **Step 1: Tulis test yang gagal**

Buat `spektra/test/tiling.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { estimateTileOverlap, planTiles } from '../src/engine/tiling';
import type { SpatialEffectFlags } from '../src/engine/tiling';

describe('perencanaan tile', () => {
  it('tidak memakai apron ketika tidak ada efek spasial aktif', () => {
    expect(estimateTileOverlap({
      halationEnabled: false, grainEnabled: false,
      cameraDiffusionEnabled: false, printDiffusionEnabled: false,
      dirCouplersAmount: 0, scannerUnsharpEnabled: false,
    })).toBe(0);
  });

  it('menjumlahkan apron untuk tiap efek spasial aktif', () => {
    const one = estimateTileOverlap({
      halationEnabled: true, grainEnabled: false,
      cameraDiffusionEnabled: false, printDiffusionEnabled: false,
      dirCouplersAmount: 0, scannerUnsharpEnabled: false,
    });
    const two = estimateTileOverlap({
      halationEnabled: true, grainEnabled: true,
      cameraDiffusionEnabled: false, printDiffusionEnabled: false,
      dirCouplersAmount: 0, scannerUnsharpEnabled: false,
    });
    expect(two).toBeGreaterThan(one);
  });

  it('tile menutupi seluruh gambar tanpa celah', () => {
    const tiles = planTiles(1000, 800, 4_000_000, 32);
    const covered = new Uint8Array(1000 * 800);
    for (const t of tiles) {
      for (let y = t.activeOriginY; y < t.activeOriginY + t.activeHeight; y += 1) {
        for (let x = t.activeOriginX; x < t.activeOriginX + t.activeWidth; x += 1) {
          covered[y * 1000 + x] = 1;
        }
      }
    }
    expect(covered.every((v) => v === 1)).toBe(true);
  });

  it('wilayah aktif tidak tumpang tindih', () => {
    const tiles = planTiles(1000, 800, 4_000_000, 32);
    const counts = new Uint8Array(1000 * 800);
    for (const t of tiles) {
      for (let y = t.activeOriginY; y < t.activeOriginY + t.activeHeight; y += 1) {
        for (let x = t.activeOriginX; x < t.activeOriginX + t.activeWidth; x += 1) {
          counts[y * 1000 + x] = counts[y * 1000 + x]! + 1;
        }
      }
    }
    expect(counts.every((v) => v === 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Jalankan untuk memastikan gagal**

```bash
cd spektra && npm test -- tiling
```

- [ ] **Step 3: Baca estimateVulkanTileOverlap hulu dan port persis**

```bash
sed -n '1185,1250p' "$SPEKTRAFILM_OFX/src/SpektraVulkanRenderer.cpp"
```

Catat nilai `kVulkanSpatialEffectRadiusPx` dan `kVulkanGrainSpatialRadiusPx` dan pakai nilai yang sama.

- [ ] **Step 4: Tulis tiling.ts dan jalankan test**

```bash
cd spektra && npm test -- tiling
```

Harapan: PASS.

- [ ] **Step 5: Tulis test nol-selisih terhadap full-frame**

Ini gerbang sebenarnya untuk tugas ini: render kasus `hard_edge` dengan halation dan grain aktif, sekali full-frame dan sekali dipaksa ter-tile menjadi empat tile, lalu tegaskan keluarannya **identik bit demi bit**. Apron yang benar tidak menghasilkan perbedaan apa pun, bukan perbedaan kecil.

```typescript
expect(tiled).toEqual(fullFrame);
```

- [ ] **Step 6: Jalankan dan commit**

```bash
cd spektra && npm test && git add spektra/src/engine/tiling.ts spektra/src/engine/graph.ts spektra/test/tiling.test.ts
git commit -m "feat(spektra): tiled rendering with apron producing bit-identical output"
```

---

## Selesai Fase 1

Pada titik ini `npm test` di `spektra/` menjalankan: uji batas lisensi, uji aset, uji profil, uji device, uji params, uji arena, uji graf, uji harness, tujuh rangkaian parity, dan uji tiling. Seluruhnya lulus berarti engine cocok dengan implementasi referensi Python di setiap tap, dan render ter-tile identik dengan full-frame.

Fase 2 (`io/`, UI, PWA) direncanakan setelah ini, bukan sebelumnya.
