#!/usr/bin/env python3
"""Bangkitkan .f32 referensi dari SimulationPipeline pada tiap tap kanonis.

Dijalankan sekali; keluarannya di-commit. Pengembangan harian dan CI tidak
memerlukan Python.

Tiga keluarga fixture per kasus dasar (lihat task-3-brief.md untuk alasan
tentang dua keluarga pertama, dan spec §6.3.3 / task-11-report.md untuk
keluarga ketiga): gerbang rgb_out pixel-exact dengan glare aktif tidak pernah
mungkin, karena RNG WGSL yang akan ditulis selalu berbeda algoritmanya dari
RNG numba milik hulu, ter-seed atau tidak. Jadi:

  <case>             deterministik: debug.deactivate_stochastic_effects
                      = True sebelum digest_params() -- mematikan tepat dua
                      hal, film_render.grain.active dan
                      print_render.glare.active (params_builder.py:140-142).
                      Gerbang: per piksel, <= 1e-5.
  <case>_stochastic   setelan default hulu (grain & glare aktif), satu
                       realisasi. Gerbang: statistik (mean, varians,
                       spektrum daya) -- bukan per piksel.
  <case>_lut          debug.lut_mode = True sebelum digest_params() --
                      mempromosikan deactivate_spatial_effects DAN
                      deactivate_stochastic_effects, plus mematikan
                      auto_exposure, exposure_compensation_ev,
                      halation.boost_ev, dan koreksi white/black/unsharp
                      scanner (params_builder.py:99-118). Ini regime "pipeline
                      sebagai transform per-piksel deterministik yang layak
                      di-sample LUT" yang hulu deskripsikan sendiri di
                      DebugParams.lut_mode (params_schema.py:197-205) -- dan
                      persis regime yang ekspor .cube DICHROIC kapalkan.
                      Gerbang tap per-piksel (log_e_film dkk.) diukur
                      terhadap keluarga ini, bukan <case> biasa, karena
                      <case> biasa TIDAK mematikan halation (halation bukan
                      efek stokastik, jadi deactivate_stochastic_effects
                      tidak menyentuhnya) -- lih. task-11-report.md untuk
                      bukti penuh. Gerbang: per piksel, <= 1e-5.
"""
from __future__ import annotations

import argparse
import hashlib
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


def _write_json_lf(path: Path, obj, *, sort_keys: bool = False) -> None:
    """Write JSON with LF-only line endings, regardless of platform.

    Path.write_text() opens in text mode, which on Windows translates
    every '\\n' to os.linesep ('\\r\\n') -- the file this script produces
    would differ byte-for-byte from the one a Linux/macOS run produces,
    even though the content is identical. That's exactly what the sha256
    manifest is supposed to catch as a *real* difference, so it must
    never be true of a platform quirk. Building the string with '\\n' and
    writing it as bytes bypasses newline translation entirely -- the
    generator now produces the same bytes on every platform, which is
    what the checked-in .gitattributes (text eol=lf for this directory)
    also enforces from git's side of a checkout.
    """
    path.write_bytes(
        (json.dumps(obj, indent=2, sort_keys=sort_keys) + "\n").encode("utf-8")
    )


def _build_params(*, stochastic: bool, lut_mode: bool = False):
    """init_params() membangun objek mentah; digest_params() WAJIB
    dipanggil sebelum dipakai pipeline (lihat docstring hulu).

    Keluarga deterministik mematikan efek stokastik lewat
    debug.deactivate_stochastic_effects SEBELUM digest_params() -- saklar
    ini milik hulu dan mematikan tepat dua hal: film_render.grain.active
    dan print_render.glare.active (params_builder.py:140-142). Garis yang
    ia tarik persis garis antara kedua keluarga fixture. Keluarga
    stokastik memakai setelan default hulu tanpa modifikasi apa pun.

    Keluarga `lut_mode` mempromosikan `debug.lut_mode` SEBELUM
    digest_params() -- satu saklar hulu yang menegakkan
    deactivate_spatial_effects DAN deactivate_stochastic_effects, plus
    mematikan auto_exposure, exposure_compensation_ev, halation.boost_ev,
    dan koreksi white/black/unsharp scanner (params_builder.py:99-118).
    `stochastic` diabaikan ketika `lut_mode=True` (lut_mode tidak pernah
    stokastik oleh definisi hulu) -- dipertahankan sebagai argumen
    terpisah, bukan digabung ke satu enum, supaya pemanggil yang sudah ada
    (`_generate_case(stochastic=...)`) tidak perlu berubah tanda tangan.
    """
    raw = init_params()
    if lut_mode:
        raw.debug.lut_mode = True
    elif not stochastic:
        raw.debug.deactivate_stochastic_effects = True
    params = digest_params(raw)
    assert not params.settings.preview_mode, "referensi tidak boleh preview_mode"
    if lut_mode:
        assert not params.print_render.glare.active, "glare harus mati di lut_mode"
        assert not params.film_render.grain.active, "grain harus mati di lut_mode"
        assert not params.film_render.halation.active, "halation harus mati di lut_mode"
        assert params.camera.auto_exposure is False, "auto_exposure harus mati di lut_mode"
        assert params.camera.exposure_compensation_ev == 0.0, "exposure_compensation_ev harus 0 di lut_mode"
        assert params.film_render.halation.boost_ev == 0.0, "halation.boost_ev harus 0 di lut_mode"
    elif not stochastic:
        assert not params.print_render.glare.active, "glare harus mati di keluarga deterministik"
        assert not params.film_render.grain.active, "grain harus mati di keluarga deterministik"
    return params


def _build_params_diffusion_camera():
    """Task 15 (resumed): keluarga fixture BARU untuk gerbang spasial
    `log_e_film` Diffusion di sisi kamera -- `camera.diffusion_filter.active`
    default `False` (`params_schema.py:16`) dan TIDAK PERNAH disalakan
    preset stock manapun (`params_builder.py:135-136` hanya MEMATIKANNYA),
    jadi tidak ada fixture yang sudah ada yang punya diffusion hidup.

    Sama seperti keluarga `<case>` biasa (Task 11/14): `deactivate_stochastic_
    effects=True` mematikan grain/glare supaya deterministik, TANPA
    `lut_mode` -- lut_mode mempromosikan `deactivate_spatial_effects`, yang
    akan mematikan tepat efek spasial yang ingin diuji gerbang ini (lih.
    task-15-report.md untuk kenapa gerbang spasial Task 14/15/16 SEMUANYA
    diukur terhadap keluarga yang efeknya hidup, bukan `_lut`).

    Family/strength: DEFAULT `DiffusionFilterParams` Python APA ADANYA
    (`filter_family="black_pro_mist"`, `strength=0.5`) -- satu-satunya
    perubahan di sini adalah `active=True`. Dipilih karena defaultnya
    sendiri sudah memberi efek substansial (p_s=0.2625) dengan kernel
    berukuran wajar (radius 14, 29x29 pada pixel_size_um=546.875 fixture
    64px/35mm ini) -- tidak ada alasan memilih family/strength lain hanya
    untuk membuktikan port ini benar.
    """
    raw = init_params()
    raw.debug.deactivate_stochastic_effects = True
    raw.camera.diffusion_filter.active = True
    params = digest_params(raw)
    assert not params.print_render.glare.active, "glare harus mati di keluarga deterministik"
    assert not params.film_render.grain.active, "grain harus mati di keluarga deterministik"
    assert params.camera.diffusion_filter.active, "diffusion_filter kamera harus hidup di keluarga ini"
    assert params.camera.diffusion_filter.filter_family == "black_pro_mist"
    assert params.camera.diffusion_filter.strength == 0.5
    return params


def _build_params_diffusion_print():
    """Task 17 debt: keluarga fixture BARU untuk gerbang spasial `log_e_print`
    Diffusion di sisi ENLARGER -- `enlarger.diffusion_filter.active` default
    `False` (`params_schema.py:72`'s `DiffusionFilterParams` default_factory,
    SAMA dataclass dengan sisi kamera baris 57) dan hanya pernah DIMATIKAN
    oleh `params_builder.py`, baik lewat `deactivate_spatial_effects` (yang
    `lut_mode` mempromosikan, baris 135) MAUPUN oleh `_lut` family manapun --
    jadi tidak ada fixture yang sudah ada (termasuk `<case>` biasa) yang
    punya diffusion enlarger hidup. Task 15 membuktikan pola yang identik
    untuk sisi kamera (`_build_params_diffusion_camera` di atas) dan gerbang
    ini memakai keputusan yang SAMA persis, hanya menukar `camera.` menjadi
    `enlarger.`.

    Family/strength: DEFAULT `DiffusionFilterParams` Python APA ADANYA
    (`filter_family="black_pro_mist"`, `strength=0.5`) -- sama seperti sisi
    kamera, dan untuk alasan yang sama (defaultnya sendiri sudah substansial,
    tidak ada dasar memilih nilai lain hanya untuk membuktikan port ini
    benar). `pixel_size_um` yang `apply_diffusion_filter_um` pakai untuk
    KEDUA situs datang dari `ResizingService` yang SAMA
    (`self._resize_service.pixel_size_um`, `resize.py:18`:
    `film_format_mm*1000/max(image.shape)`) -- BUKAN dihitung ulang per
    situs -- jadi untuk citra 64px/35mm yang sama (`hard_edge`/
    `impulse_highlight`) nilainya PERSIS 546.875, identik dengan konstanta
    kamera yang sudah dibakukan `src/host/spectral.ts`
    (`CAMERA_DIFFUSION_PIXEL_SIZE_UM`).

    DUA PENYIMPANGAN TAMBAHAN dari `_build_params_diffusion_camera`, KEDUANYA
    DIBUTUHKAN supaya gerbang ini mengisolasi HANYA efek diffusion enlarger,
    bukan ikut menyeret dua permukaan lain yang belum (dan tidak perlu)
    diverifikasi Task 17:

    1. `enlarger.print_exposure_compensation = False` -- default Python-nya
       `True` (`params_schema.py:64`), TIDAK disentuh
       `deactivate_stochastic_effects`. Kalau dibiarkan default,
       `_compute_exposure_factor_midgray` (`printing.py:101-113`) mengambil
       cabang `factor_midgray_comp` (butuh `density_spectral_midgray_comp`,
       tabel yang TIDAK PERNAH dibakukan Task 17 -- `addPrintScanDynamicData`
       di `src/host/spectral.ts` hanya mengimplementasikan cabang
       non-`_comp`, DIBUKTIKAN BENAR hanya untuk `_lut` family, lih.
       docstring-nya). Memaksa `False` di sini (PERSIS nilai yang
       `lut_mode` juga paksakan, `params_builder.py:108`) menjaga cabang
       exposure-factor yang SAMA dengan yang sudah diverifikasi ~1e-7,
       supaya galat gerbang ini murni dari diffusion, bukan dari cabang
       exposure-compensation kedua yang belum pernah diuji.
    2. `film_render.dir_couplers.diffusion_size_um = 0` -- default `20.0`
       (SPASIAL, aktif untuk keluarga manapun yang tidak mempromosikan
       `deactivate_spatial_effects`). `dir.wgsl` (Task 13) HANYA
       mengimplementasikan cabang NON-spasial (`dir_couplers.diffusion_size_um
       =0`) -- residual dari cabang spasial yang diabaikan itu TERBUKTI
       BESAR persis untuk `hard_edge`/`impulse_highlight` (task-16-report.md:
       radial_rel 0.0097/1.3128, jauh di atas ambang statistik grain 5%,
       apalagi ambang per-piksel 1e-5 gerbang ini). `cmy_film` adalah
       MASUKAN `PrintingStage.expose()` -- membiarkan residual DIR-spasial
       itu mengalir ke `cmy_film` akan mencemari pengukuran diffusion print
       dengan galat yang sudah diketahui dan TIDAK RELEVAN dengan gerbang
       ini. Dinolkan LANGSUNG di sini (bukan lewat `deactivate_spatial_
       effects`, yang JUGA akan mematikan `enlarger.diffusion_filter.active`
       yang justru ingin diuji) -- pola yang sama dengan bagaimana
       `lut_mode` menonolkan field yang SAMA (`params_builder.py:120`),
       hanya diterapkan berdiri sendiri di sini.
    """
    raw = init_params()
    raw.debug.deactivate_stochastic_effects = True
    raw.enlarger.diffusion_filter.active = True
    raw.enlarger.print_exposure_compensation = False
    raw.film_render.dir_couplers.diffusion_size_um = 0
    params = digest_params(raw)
    assert not params.print_render.glare.active, "glare harus mati di keluarga deterministik"
    assert not params.film_render.grain.active, "grain harus mati di keluarga deterministik"
    assert params.enlarger.diffusion_filter.active, "diffusion_filter enlarger harus hidup di keluarga ini"
    assert params.enlarger.diffusion_filter.filter_family == "black_pro_mist"
    assert params.enlarger.diffusion_filter.strength == 0.5
    assert not params.camera.diffusion_filter.active, "diffusion_filter kamera harus TETAP mati di keluarga ini"
    assert params.enlarger.print_exposure_compensation is False
    assert params.enlarger.print_exposure == 1.0
    assert not params.scanner.white_correction and not params.scanner.black_correction
    assert params.film_render.dir_couplers.diffusion_size_um == 0
    assert params.film_render.dir_couplers.active, "dir_couplers chemistry (non-spasial) harus TETAP hidup"
    return params


_DIFFUSION_SITE_PARAM_BUILDERS = {
    "camera": _build_params_diffusion_camera,
    "print": _build_params_diffusion_print,
}


def grain_dense_patch(width: int = 64, height: int = 64) -> np.ndarray:
    """Task 16b: gambar UNIFORM/flat (bukan ramp) -- SETIAP piksel meminta
    input yang SAMA persis, jadi setiap piksel adalah draw IID dari
    distribusi grain yang SAMA (murni noise stokastik, tidak ada sinyal
    spasial yang ikut ter-blur/tercampur ke dalam pengukuran momen). Pada
    `pixel_size_um` sekecil yang gerbang ini butuh (lih.
    `_build_params_grain_dense`), `n_particles_per_pixel` turun ke orde
    0,03..0,35 partikel/piksel -- jauh dari rezim "banyak partikel" yang
    membuat gerbang `_stochastic` biasa (Task 16) presisi sampai 1e-4/2%/5%.
    64x64 (4096 piksel, 8x `gray_ramp`) dipilih untuk menekan noise sampling
    lewat hukum bilangan besar TANPA melebihi batas ukuran fixture yang
    task ini tetapkan (32x16..64x64) -- lih. task-16b-report.md untuk
    pengukuran sebaran Python-vs-Python SENDIRI pada ukuran ini yang
    mengalibrasi ambang gerbang statistik BARU (spec §6.5.1, "ambang terikat
    sebaran terukur" -- BUKAN ambang 5e-5/2%/5% Task 16 yang diukur pada
    rezim partikel/piksel yang sama sekali berbeda).
    """
    return np.full((height, width, 3), 0.3, dtype=np.float64)


def _build_params_grain_dense():
    """Task 16b: keluarga fixture BARU membuktikan `blur_particle` (dye-cloud
    blur per-sublayer, `grain.blur_dye_clouds_um`) dan `add_micro_structure`
    (clumping lognormal, `grain.micro_structure`) di `model/grain.py` BUKAN
    no-op secara struktural -- task-16-report.md membuktikan keduanya no-op
    HANYA karena `pixel_size_um` fixture yang ADA (546..4375 um, gambar
    8x8..64x64px/35mm) jauh di bawah ambang aktivasi masing-masing. Lih.
    `grain_probe.py`-style perhitungan (scratchpad, tidak dikomit) yang
    memakai `density_curves_layers` SUNGGUHAN `kodak_portra_400` (stock yang
    sama dipakai `grain.test.ts`) untuk memverifikasi angka di bawah, BUKAN
    ditebak dari tabel ilustratif brief (kolom brief memakai rasio
    `param/pixel_size_um` mentah, BUKAN formula aktivasi Python yang
    sebenarnya -- lih. task-16b-report.md untuk perbedaannya).

    HANYA `camera.film_format_mm` yang disimpangkan dari `_build_params`
    (35.0 -> 0.024), atas gambar `grain_dense_patch` 64x64 BARU (BUKAN
    `gray_ramp`, lih. docstring `grain_dense_patch`) --
    `pixel_size_um = film_format_mm*1000/max(image.shape)` (`resize.py:18`)
    turun ke 0.375 um, SAMA seperti perhitungan awal 32x16/0.012 (angka di
    bawah karena itu tidak berubah -- keduanya rasio `film_format_mm/width`
    yang sama). film_format_mm sekecil ini TIDAK merepresentasikan
    kamera fisik apa pun; ia murni tuas matematis untuk mencapai rezim
    pixel_size_um order-mikron TANPA memperbesar gambar (yang costnya jauh
    lebih tinggi untuk Vitest/GPU dibanding satu skalar params). Pada
    pixel_size_um=0.375um, terukur (lih. task-16b-report.md untuk transkrip):
      - sigma blur_particle (per kanal/sublapisan) = blur_dye_clouds_um *
        sqrt(od_particle) berkisar 1.44..4.47 -- radius kernel
        int(3*sigma+0.5) berkisar 4..13, JAUH dari nol (bandingkan fixture
        lama: sigma ~5e-4..3e-3, radius 0, no-op TERBUKTI).
      - grain_micro_structure_sigma = micro_structure[1]*0.001/pixel_size_um
        = 0.08 > ambang aktivasi Python `0.05` (bandingkan fixture lama:
        ~7e-6..5e-5, TIDAK pernah menyalakan clumping sama sekali).
      - grain_micro_structure_blur_pixel = micro_structure[0]/pixel_size_um
        = 0.533 > ambang blur-clumping Python `0.4` -- jadi cabang NESTED
        (blur di atas peta clumping-nya sendiri) JUGA aktif, bukan cuma
        clumping mentah.
    Semua tiga cabang yang task 16 tunda jadi TERUKUR AKTIF pada SATU
    fixture ini -- tidak perlu fixture terpisah per cabang.

    `stochastic=True` semantiknya (grain Python default AKTIF, TIDAK
    `deactivate_stochastic_effects`) -- gerbangnya statistik seperti
    `<case>_stochastic`, BUKAN keluarga `_lut`/deterministik.
    """
    raw = init_params()
    raw.camera.film_format_mm = 0.024
    params = digest_params(raw)
    assert params.film_render.grain.active, "grain harus aktif di keluarga ini"
    assert params.film_render.grain.sublayers_active, "cabang layers harus aktif (default)"
    assert params.camera.film_format_mm == 0.024
    return params


def _generate_grain_dense_case(image: np.ndarray, case_dir: Path, name: str) -> None:
    """Keluarga fixture terpisah Task 16b -- `input.f32` milik sendiri (sama
    isinya dengan `gray_ramp`, tapi grup direktori TERPISAH, mengikuti pola
    `_generate_diffusion_site_case`), TIDAK menyentuh
    `gray_ramp`/`gray_ramp_stochastic`/`gray_ramp_lut` yang sudah dikomit.
    """
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "input.f32").write_bytes(
        np.ascontiguousarray(image, dtype="<f4").tobytes()
    )

    written = []
    for tap in TAPS:
        params = _build_params_grain_dense()
        result = SimulationPipeline(params).process(image, collect=tap)
        arr = np.ascontiguousarray(result, dtype="<f4")
        (case_dir / f"{tap}.f32").write_bytes(arr.tobytes())
        written.append({"tap": tap, "channels": int(arr.shape[2])})

    meta = {
        "name": name,
        "height": int(image.shape[0]),
        "width": int(image.shape[1]),
        "stochastic": True,
        "filmFormatMm": 0.024,
        "taps": written,
    }
    _write_json_lf(case_dir / "case.json", meta)
    print(f"Wrote {case_dir} ({len(written)} taps, film_format_mm=0.024)")


GRAIN_DENSE_CASES = {
    "grain_dense_patch": grain_dense_patch,
}


def _generate_diffusion_site_case(image: np.ndarray, case_dir: Path, name: str, *, site: str) -> None:
    """Keluarga fixture terpisah dari <case>/<case>_stochastic/<case>_lut
    yang _generate_case() bangkitkan -- `name` di sini SUDAH memuat akhiran
    `_diffusion_camera`/`_diffusion_print` (mis. `hard_edge_diffusion_print`),
    jadi ia adalah grup kasus BARU dengan `input.f32` miliknya sendiri, bukan
    varian dari grup `hard_edge` yang sudah ada. TIDAK menyentuh
    `hard_edge`/`hard_edge_stochastic`/`hard_edge_lut` sama sekali.

    Diumumkan (Task 17 debt) dari `_generate_diffusion_camera_case` Task 15
    yang sebelumnya hardcode site='camera' -- disatukan lewat parameter
    `site` (dan `_DIFFUSION_SITE_PARAM_BUILDERS`) supaya kedua situs berbagi
    SATU implementasi, bukan salinan kedua yang bisa menyimpang diam-diam.
    `_generate_diffusion_camera_case` yang lama TETAP ADA sebagai alias
    tipis di bawah supaya pemanggil existing (dan riwayat git) tidak perlu
    berubah.
    """
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "input.f32").write_bytes(
        np.ascontiguousarray(image, dtype="<f4").tobytes()
    )

    build_params = _DIFFUSION_SITE_PARAM_BUILDERS[site]
    written = []
    for tap in TAPS:
        params = build_params()
        result = SimulationPipeline(params).process(image, collect=tap)
        arr = np.ascontiguousarray(result, dtype="<f4")
        (case_dir / f"{tap}.f32").write_bytes(arr.tobytes())
        written.append({"tap": tap, "channels": int(arr.shape[2])})

    meta = {
        "name": name,
        "height": int(image.shape[0]),
        "width": int(image.shape[1]),
        "stochastic": False,
        "diffusionSite": site,
        "taps": written,
    }
    _write_json_lf(case_dir / "case.json", meta)
    print(f"Wrote {case_dir} ({len(written)} taps, diffusion_site={site})")


def _generate_diffusion_camera_case(image: np.ndarray, case_dir: Path, name: str) -> None:
    """Alias tipis Task 15 asli -- lih. `_generate_diffusion_site_case`."""
    _generate_diffusion_site_case(image, case_dir, name, site="camera")


# Task 15 (resumed): keluarga fixture baru khusus gerbang Diffusion kamera.
# `hard_edge` menunjukkan penyebaran titik-sebar di seberang tepi tajam;
# `impulse_highlight` menunjukkan bentuk kernel dekat r=0 secara langsung --
# keduanya diminta brief secara eksplisit ("diffusion adalah operator
# point-spread, jadi hard_edge dan impulse_highlight menunjukkannya di
# tempat yang tidak ditunjukkan ramp"). TIDAK memakai gray_ramp/log_gray_ramp/
# color_patches -- keduanya sudah cukup untuk gerbang ini, dan brief tidak
# meminta cakupan lebih luas dari itu.
DIFFUSION_CAMERA_CASES = {
    "hard_edge_diffusion_camera": hard_edge,
    "impulse_highlight_diffusion_camera": impulse_highlight,
}

# Task 17 debt: keluarga fixture baru khusus gerbang Diffusion enlarger
# (`log_e_print`) -- alasan pemilihan hard_edge/impulse_highlight SAMA
# dengan sisi kamera di atas (operator point-spread, ramp tidak
# menunjukkannya).
DIFFUSION_PRINT_CASES = {
    "hard_edge_diffusion_print": hard_edge,
    "impulse_highlight_diffusion_print": impulse_highlight,
}


def _generate_case(
    image: np.ndarray, case_dir: Path, name: str, *, stochastic: bool, lut_mode: bool = False,
) -> None:
    case_dir.mkdir(parents=True, exist_ok=True)

    # Ketiga keluarga memakai persis citra input yang sama (CASES[name]()
    # dipanggil sekali oleh main() dan dibagikan ke setiap panggilan
    # _generate_case). Menulis input.f32 di semua direktori akan
    # meng-commit salinan identik dari berkas yang sama -- disimpan
    # sekali saja, di direktori kasus dasar (bukan varian _stochastic
    # atau _lut).
    if not stochastic and not lut_mode:
        (case_dir / "input.f32").write_bytes(
            np.ascontiguousarray(image, dtype="<f4").tobytes()
        )

    written = []
    for tap in TAPS:
        params = _build_params(stochastic=stochastic, lut_mode=lut_mode)
        result = SimulationPipeline(params).process(image, collect=tap)
        arr = np.ascontiguousarray(result, dtype="<f4")
        (case_dir / f"{tap}.f32").write_bytes(arr.tobytes())
        written.append({"tap": tap, "channels": int(arr.shape[2])})

    # PENTING: struktur dict di bawah, dan urutan key-nya, harus TETAP
    # SAMA PERSIS dengan sebelum family _lut ditambahkan ketika
    # lut_mode=False -- manifest.json mengunci sha256 case.json yang
    # SUDAH dikomit untuk <case> dan <case>_stochastic, dan
    # json.dumps(sort_keys=False) serialisasi berurutan sesuai insertion
    # order. Menambah "lutMode" tanpa syarat di sini akan mengubah byte
    # case.json kedua family lama itu -- persis "mengubah oracle" yang
    # dilarang. "lutMode" hanya disisipkan untuk family _lut (berkas
    # BARU, tidak ada hash lama untuk dicocoki).
    meta = {
        "name": name,
        "height": int(image.shape[0]),
        "width": int(image.shape[1]),
        "stochastic": stochastic,
        "taps": written,
    }
    if lut_mode:
        meta["lutMode"] = True
    _write_json_lf(case_dir / "case.json", meta)
    print(f"Wrote {case_dir} ({len(written)} taps, stochastic={stochastic}, lut_mode={lut_mode})")


def identity_lattice_17(size: int = 17) -> np.ndarray:
    """Fase 2A Task 7: lattice identitas `size^3` sebagai citra `size x size^2`
    (tinggi x lebar), titik ke-i = (r, g, b) dengan i = r + g*size + b*size^2
    -- R tercepat, urutan data `.cube`, identik dengan
    `src/io/cube.ts::identityLattice`. Piksel baris-mayor ke-i adalah titik
    ke-i, jadi `rgb_out` Python langsung berurutan `.cube`."""
    step = np.linspace(0.0, 1.0, size, dtype=np.float64)
    b, g, r = np.meshgrid(step, step, step, indexing="ij")
    return np.stack([r, g, b], axis=-1).reshape(size, size * size, 3)


LATTICE_CASES = {
    "identity_lattice_17": identity_lattice_17,
}


def _generate_lattice_case(image: np.ndarray, case_dir: Path, name: str) -> None:
    """Keluarga ketujuh, HANYA `lut_mode` (kubus tidak pernah dirender dengan
    efek spasial/stokastik atau auto-exposure, spec Fase 2 §4.6). Tidak ada
    direktori kasus dasar, jadi input.f32 ditulis di direktori _lut ini."""
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "input.f32").write_bytes(np.ascontiguousarray(image, dtype="<f4").tobytes())
    _generate_case(image, case_dir, name, stochastic=False, lut_mode=True)


def _write_manifest(out_dir: Path) -> None:
    """Write test/fixtures/manifest.json: sha256 of every fixture file
    currently on disk under ``out_dir``.

    Scans the actual filesystem rather than just the files this
    invocation wrote, so the manifest always reflects reality -- a
    partial run (--case) still produces a manifest that matches disk
    exactly, and fixtures.test.ts can check every entry, not just the
    ones most recently regenerated. This is what turns the one-off manual
    determinism proof into something a regression can't silently pass:
    anyone who regenerates and gets a different hash knows immediately
    that something changed upstream, in the venv, or in this script.
    """
    manifest = {
        f.relative_to(out_dir).as_posix(): hashlib.sha256(f.read_bytes()).hexdigest()
        for f in sorted(out_dir.rglob("*"))
        if f.is_file() and f.name != "manifest.json"
    }
    _write_json_lf(out_dir / "manifest.json", manifest, sort_keys=True)
    print(f"Wrote {out_dir / 'manifest.json'} ({len(manifest)} files)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--case", choices=sorted(CASES), action="append")
    parser.add_argument(
        "--diffusion-case", choices=sorted(DIFFUSION_CAMERA_CASES), action="append",
        help="Regenerate one (or more) Task 15 diffusion-camera fixtures "
             "(hard_edge_diffusion_camera, impulse_highlight_diffusion_camera). "
             "These are a fourth, separate fixture family (own input.f32, "
             "camera.diffusion_filter.active=True) -- NOT a variant of the "
             "--case loop above, and not regenerated by it.",
    )
    parser.add_argument(
        "--diffusion-print-case", choices=sorted(DIFFUSION_PRINT_CASES), action="append",
        help="Regenerate one (or more) Task 17 debt diffusion-print fixtures "
             "(hard_edge_diffusion_print, impulse_highlight_diffusion_print). "
             "A fifth, separate fixture family (own input.f32, "
             "enlarger.diffusion_filter.active=True) -- NOT a variant of the "
             "--case loop above, and not regenerated by it.",
    )
    parser.add_argument(
        "--grain-dense-case", choices=sorted(GRAIN_DENSE_CASES), action="append",
        help="Regenerate the Task 16b grain-dense fixture (grain_dense_patch): "
             "a new flat/uniform 64x64 image (every pixel IID, for a clean "
             "statistical gate), camera.film_format_mm overridden from 35.0 to "
             "0.024 so pixel_size_um drops to 0.375um, activating grain.py's "
             "blur_particle and add_micro_structure terms (no-op at every other "
             "committed fixture's pixel_size_um). A sixth, separate fixture "
             "family (own input.f32) -- NOT a variant of the --case loop above, "
             "and not regenerated by it.",
    )
    parser.add_argument(
        "--lattice-case", choices=sorted(LATTICE_CASES), action="append",
        help="Regenerate the Fase 2A .cube lattice fixture (identity_lattice_17, "
             "lut_mode only, written to <name>_lut with its own input.f32).",
    )
    parser.add_argument(
        "--manifest", action="store_true",
        help="Also (re)write <out>/manifest.json: a sha256 of every file "
             "currently under --out, checked by fixtures.test.ts. Scans "
             "the whole --out directory, so it stays accurate even after "
             "a --case-filtered partial run.",
    )
    args = parser.parse_args()

    ran_anything_case_specific = bool(
        args.case or args.diffusion_case or args.diffusion_print_case or args.grain_dense_case
        or args.lattice_case
    )

    names = args.case or (sorted(CASES) if not ran_anything_case_specific else [])
    for name in names:
        image = CASES[name]()
        _generate_case(image, args.out / name, name, stochastic=False)
        _generate_case(image, args.out / f"{name}_stochastic", name, stochastic=True)
        _generate_case(image, args.out / f"{name}_lut", name, stochastic=False, lut_mode=True)

    diffusion_names = args.diffusion_case or (
        sorted(DIFFUSION_CAMERA_CASES) if not ran_anything_case_specific else []
    )
    for name in diffusion_names:
        image = DIFFUSION_CAMERA_CASES[name]()
        _generate_diffusion_camera_case(image, args.out / name, name)

    diffusion_print_names = args.diffusion_print_case or (
        sorted(DIFFUSION_PRINT_CASES) if not ran_anything_case_specific else []
    )
    for name in diffusion_print_names:
        image = DIFFUSION_PRINT_CASES[name]()
        _generate_diffusion_site_case(image, args.out / name, name, site="print")

    grain_dense_names = args.grain_dense_case or (
        sorted(GRAIN_DENSE_CASES) if not ran_anything_case_specific else []
    )
    for name in grain_dense_names:
        image = GRAIN_DENSE_CASES[name]()
        _generate_grain_dense_case(image, args.out / name, name)

    lattice_names = args.lattice_case or (
        sorted(LATTICE_CASES) if not ran_anything_case_specific else []
    )
    for name in lattice_names:
        image = LATTICE_CASES[name]()
        _generate_lattice_case(image, args.out / f"{name}_lut", name)

    if args.manifest:
        _write_manifest(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
