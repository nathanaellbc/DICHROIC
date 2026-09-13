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


def _generate_diffusion_camera_case(image: np.ndarray, case_dir: Path, name: str) -> None:
    """Keluarga fixture KEEMPAT, terpisah dari <case>/<case>_stochastic/
    <case>_lut yang _generate_case() bangkitkan -- `name` di sini SUDAH
    memuat akhiran `_diffusion_camera` (mis. `hard_edge_diffusion_camera`),
    jadi ia adalah grup kasus BARU dengan `input.f32` miliknya sendiri,
    bukan varian dari grup `hard_edge` yang sudah ada. TIDAK menyentuh
    `hard_edge`/`hard_edge_stochastic`/`hard_edge_lut` sama sekali.
    """
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "input.f32").write_bytes(
        np.ascontiguousarray(image, dtype="<f4").tobytes()
    )

    written = []
    for tap in TAPS:
        params = _build_params_diffusion_camera()
        result = SimulationPipeline(params).process(image, collect=tap)
        arr = np.ascontiguousarray(result, dtype="<f4")
        (case_dir / f"{tap}.f32").write_bytes(arr.tobytes())
        written.append({"tap": tap, "channels": int(arr.shape[2])})

    meta = {
        "name": name,
        "height": int(image.shape[0]),
        "width": int(image.shape[1]),
        "stochastic": False,
        "diffusionSite": "camera",
        "taps": written,
    }
    _write_json_lf(case_dir / "case.json", meta)
    print(f"Wrote {case_dir} ({len(written)} taps, diffusion_site=camera)")


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
        "--manifest", action="store_true",
        help="Also (re)write <out>/manifest.json: a sha256 of every file "
             "currently under --out, checked by fixtures.test.ts. Scans "
             "the whole --out directory, so it stays accurate even after "
             "a --case-filtered partial run.",
    )
    args = parser.parse_args()

    ran_anything_case_specific = bool(args.case or args.diffusion_case)

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

    if args.manifest:
        _write_manifest(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
