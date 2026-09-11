#!/usr/bin/env python3
"""Bangkitkan .f32 referensi dari SimulationPipeline pada tiap tap kanonis.

Dijalankan sekali; keluarannya di-commit. Pengembangan harian dan CI tidak
memerlukan Python.

Dua keluarga fixture per kasus dasar (lihat task-3-brief.md untuk alasan
lengkap): gerbang rgb_out pixel-exact dengan glare aktif tidak pernah
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


def _build_params(*, stochastic: bool):
    """init_params() membangun objek mentah; digest_params() WAJIB
    dipanggil sebelum dipakai pipeline (lihat docstring hulu).

    Keluarga deterministik mematikan efek stokastik lewat
    debug.deactivate_stochastic_effects SEBELUM digest_params() -- saklar
    ini milik hulu dan mematikan tepat dua hal: film_render.grain.active
    dan print_render.glare.active (params_builder.py:140-142). Garis yang
    ia tarik persis garis antara kedua keluarga fixture. Keluarga
    stokastik memakai setelan default hulu tanpa modifikasi apa pun.
    """
    raw = init_params()
    if not stochastic:
        raw.debug.deactivate_stochastic_effects = True
    params = digest_params(raw)
    assert not params.settings.preview_mode, "referensi tidak boleh preview_mode"
    if not stochastic:
        assert not params.print_render.glare.active, "glare harus mati di keluarga deterministik"
        assert not params.film_render.grain.active, "grain harus mati di keluarga deterministik"
    return params


def _generate_case(image: np.ndarray, case_dir: Path, name: str, *, stochastic: bool) -> None:
    case_dir.mkdir(parents=True, exist_ok=True)

    # Kedua keluarga memakai persis citra input yang sama (CASES[name]()
    # dipanggil sekali oleh main() dan dibagikan ke kedua panggilan
    # _generate_case). Menulis input.f32 di kedua direktori akan
    # meng-commit dua salinan identik dari berkas yang sama -- disimpan
    # sekali saja, di direktori kasus dasar (bukan varian _stochastic).
    if not stochastic:
        (case_dir / "input.f32").write_bytes(
            np.ascontiguousarray(image, dtype="<f4").tobytes()
        )

    written = []
    for tap in TAPS:
        params = _build_params(stochastic=stochastic)
        result = SimulationPipeline(params).process(image, collect=tap)
        arr = np.ascontiguousarray(result, dtype="<f4")
        (case_dir / f"{tap}.f32").write_bytes(arr.tobytes())
        written.append({"tap": tap, "channels": int(arr.shape[2])})

    _write_json_lf(case_dir / "case.json", {
        "name": name,
        "height": int(image.shape[0]),
        "width": int(image.shape[1]),
        "stochastic": stochastic,
        "taps": written,
    })
    print(f"Wrote {case_dir} ({len(written)} taps, stochastic={stochastic})")


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
        "--manifest", action="store_true",
        help="Also (re)write <out>/manifest.json: a sha256 of every file "
             "currently under --out, checked by fixtures.test.ts. Scans "
             "the whole --out directory, so it stays accurate even after "
             "a --case-filtered partial run.",
    )
    args = parser.parse_args()

    names = args.case or sorted(CASES)
    for name in names:
        image = CASES[name]()
        _generate_case(image, args.out / name, name, stochastic=False)
        _generate_case(image, args.out / f"{name}_stochastic", name, stochastic=True)

    if args.manifest:
        _write_manifest(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
