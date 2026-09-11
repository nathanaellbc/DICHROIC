#!/usr/bin/env python3
"""Pancarkan aset web dari generate_profile_curves.py hulu.

Mewarisi seluruh derivasi colour-science hulu; yang berbeda hanya pintu
keluarnya: biner + JSON, bukan literal C++.

Catatan penyimpangan dari draf awal task brief: brief mengasumsikan
`ofx_stock_lists.film_stock_order()` dan `.paper_stock_order()` sebagai
nama fungsi. Berkas hulu yang sebenarnya
($SPEKTRAFILM_OFX/tools/ofx_stock_lists.py) tidak mengekspor fungsi
apa pun dengan nama itu -- ia mengekspor daftar modul-level `FILMS` (20
entri, dari `_LEGACY_FILM_ORDER`) dan `PAPERS` (8 entri, dari
`_LEGACY_PAPER_ORDER`). Skrip ini memakai `stocks.FILMS` dan
`stocks.PAPERS` langsung.
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


def _write_json_lf(path: Path, obj, *, sort_keys: bool = False) -> None:
    """Write JSON with LF-only line endings, regardless of platform.

    Path.write_text() opens in text mode, which on Windows translates every
    '\\n' to os.linesep ('\\r\\n') -- manifest.json would then differ
    byte-for-byte between a Windows bake and a Linux/macOS bake even though
    the content is identical. Building the string with '\\n' and writing it
    as bytes bypasses newline translation entirely, matching the discipline
    already established in tools/gen_reference.py for Task 3's fixture
    manifest, and enforced from git's side by spektra/.gitattributes
    (`text eol=lf` over public/data/*.json).
    """
    path.write_bytes(
        (json.dumps(obj, indent=2, sort_keys=sort_keys) + "\n").encode("utf-8")
    )


def pack_stocks(out_dir: Path) -> tuple[list[dict], np.ndarray]:
    entries: list[dict] = []
    blob: list[np.ndarray] = []
    cursor = 0

    # generate_profile_curves._emit_group (tools/generate_profile_curves.py:1027)
    # branches on group: film stocks get _normalized_density_curves (each
    # channel's floor subtracted to zero), paper stocks get raw
    # _density_curves. A first draft of this emitter used _density_curves
    # uniformly for every stock, matching the task brief's stub -- Step 5's
    # C++-literal comparison caught that it silently diverged from upstream
    # for all 20 film stocks (kodak_portra_400's first density row is
    # [-0.000678, -0.000717, -0.000734] raw, but upstream's own C++ literal
    # emits [0.0, 0.0, 0.0] for that row). Mirroring upstream's own
    # group-dependent function choice here -- not reimplementing their
    # spectral maths, just calling the same functions the same way they do.
    film_ids = set(stocks.FILMS)
    for stock_id in stocks.FILMS + stocks.PAPERS:
        profile = gpc._load_profile(stock_id)
        if stock_id in film_ids:
            curves = np.asarray(gpc._normalized_density_curves(profile), dtype="<f4").ravel()
        else:
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

    # Ship the Hanatos LUT at its native source precision (float16). Upstream's
    # own C++ bake (write_hanatos_lut) widens this same .npy to float32 for a
    # literal array in generated C++; we widen at load time in the browser
    # instead, which loses nothing since float16 *is* the source precision.
    lut = np.load(gpc.HANATOS_LUT_PATH)
    assert lut.dtype == np.float16, f"LUT hulu bukan f16: {lut.dtype}"
    assert lut.shape == (192, 192, 81), f"Bentuk LUT hulu tak terduga: {lut.shape}"
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
    _write_json_lf(args.out / "manifest.json", manifest)
    print(f"Wrote {len(entries)} stocks, LUT {lut.shape}, gamut {gamut.size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
