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

Cakupan diperluas (fix round 1): draf pertama tugas ini hanya memancarkan
2 dari 27 field per-stock dan 1 dari 16 tabel global yang dideklarasikan
`$SPEKTRAFILM_OFX/src/SpektraProfileCurves.h` -- kontrak definitif yang
dikonsumsi GPU hulu (lihat `struct ProfileCurveSet` dan fungsi akses tabel
globalnya di sana). Skrip ini sekarang memancarkan kontrak penuh: setiap
field per-stock dan setiap tabel global itu, masing-masing lewat fungsi
hulu yang sama yang sudah `generate_profile_curves.py` panggil untuk
literal C++-nya sendiri (`_emit_group`, `_emit_color_transforms`, dan
`generate()`) -- tidak ada matematika spektral yang ditulis ulang di sini,
hanya pintu keluarnya yang berbeda.
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


def _flat_f32(nested) -> tuple[np.ndarray, int]:
    """Flatten a nested list to float32, mirroring upstream's own NAN convention.

    generate_profile_curves._float_literal (tools/generate_profile_curves.py:429)
    treats `None` *and* any non-finite float identically: both become the C++
    literal `NAN`. Several profile fields (`channel_density`, `base_density`)
    genuinely contain `None` at scattered positions in every one of the 28
    upstream JSON profiles -- confirmed by direct inspection, not assumed --
    and upstream's own C++ output already encodes that as NAN, not as a
    silent 0.0. This function reproduces exactly that convention for our
    binary blob: any non-finite value (None already becomes NaN when numpy
    casts an object array to float64) is written as an explicit float32 NaN,
    and the count is returned so the caller can record it in the manifest
    instead of leaving it undiscoverable inside the buffer.
    """
    arr = np.asarray(nested, dtype=np.float64).ravel()
    non_finite = ~np.isfinite(arr)
    null_count = int(non_finite.sum())
    out = arr.astype("<f4")
    if null_count:
        out[non_finite] = np.float32(np.nan)
    return out, null_count


class _BlobWriter:
    """Accumulates float32 arrays and hands back {offsetFloats, lengthFloats}."""

    def __init__(self) -> None:
        self._chunks: list[np.ndarray] = []
        self._cursor = 0

    def write(self, nested) -> dict:
        arr, null_count = _flat_f32(nested)
        entry = {"offsetFloats": self._cursor, "lengthFloats": int(arr.size)}
        if null_count:
            entry["nullCount"] = null_count
        self._chunks.append(arr)
        self._cursor += int(arr.size)
        return entry

    def concat(self) -> np.ndarray:
        if not self._chunks:
            return np.zeros(0, dtype="<f4")
        return np.concatenate(self._chunks)


# ProfileCurveSet field order, from $SPEKTRAFILM_OFX/src/SpektraProfileCurves.h.
# Everything here is produced by calling the exact same upstream functions
# generate_profile_curves._emit_group (tools/generate_profile_curves.py:1005-1098)
# calls for its own C++ struct literal -- see the comment on each field below
# for the precise upstream call it mirrors.
def pack_stock(writer: _BlobWriter, stock_id: str, *, is_film: bool, shared_input_to_srgb: dict) -> dict:
    profile = gpc._load_profile(stock_id)
    info = profile["info"]
    reference_illuminant = info["reference_illuminant"]
    viewing_illuminant = info["viewing_illuminant"]
    halation_preset = gpc._halation_preset(info)
    dir_couplers = gpc._dir_coupler_defaults(info)

    fields: dict[str, dict | None] = {}

    # _numeric_vector(profile, "wavelengths") -- generate_profile_curves.py:1017
    fields["wavelengths"] = writer.write(gpc._numeric_vector(profile, "wavelengths"))
    # _numeric_matrix(profile, "log_sensitivity") -- :1018
    fields["logSensitivity"] = writer.write(gpc._numeric_matrix(profile, "log_sensitivity"))
    # _archived_bandpass_hanatos2025(stock) -- :1019. None for every paper stock
    # (verified: present for all 20 film stocks, absent for all 8 paper stocks),
    # matching upstream's own `nullptr` for this pointer in that case (:1058-1059).
    bandpass = gpc._archived_bandpass_hanatos2025(stock_id)
    fields["bandpassHanatos2025"] = writer.write(bandpass) if bandpass is not None else None
    # _hanatos2026_window_params(profile) -- :1020
    fields["hanatos2026WindowParams"] = writer.write(gpc._hanatos2026_window_params(profile))
    # standard_illuminant(reference_illuminant) -- :1021
    fields["referenceIlluminantSpectrum"] = writer.write(
        [float(v) for v in gpc.standard_illuminant(reference_illuminant)]
    )
    # _input_to_reference_xyz_matrices(reference_illuminant) -- :1022
    fields["inputToReferenceXyz"] = writer.write(gpc._input_to_reference_xyz_matrices(reference_illuminant))
    # {group_name}_input_to_srgb -- :1023,1075. _input_to_srgb_matrices() takes no
    # per-profile argument, so upstream's own per-group array is identical film vs.
    # paper (verified: same values either way). Written once, shared by reference.
    fields["inputToSrgb"] = shared_input_to_srgb
    # _mallett_basis_illuminant(reference_illuminant) -- :1024
    fields["mallettBasisIlluminant"] = writer.write(gpc._mallett_basis_illuminant(reference_illuminant))
    # _mallett_midgray_green(profile, reference_illuminant) -- :1025. Scalar, so it
    # lives directly on the stock's manifest entry rather than in the float blob.
    mallett_raw_midgray_green = gpc._mallett_midgray_green(profile, reference_illuminant)
    # profile["data"]["log_exposure"] -- :1026
    fields["logExposure"] = writer.write(profile["data"]["log_exposure"])
    # _normalized_density_curves for film / _density_curves for paper -- :1027.
    # This is the branch Step 5 caught diverging in the first draft of this
    # emitter; see tools/README.md "Task 4" section for the full comparison.
    density_curves = gpc._normalized_density_curves(profile) if is_film else gpc._density_curves(profile)
    fields["densityCurves"] = writer.write(density_curves)
    # _numeric_matrix(profile, "channel_density") -- :1029. Contains scattered
    # None in every one of the 28 profiles (confirmed by direct inspection);
    # _flat_f32 turns each into an explicit NaN and reports nullCount.
    fields["channelDensity"] = writer.write(gpc._numeric_matrix(profile, "channel_density"))
    # _numeric_vector(profile, "base_density") -- :1030. Also has scattered None.
    fields["baseDensity"] = writer.write(gpc._numeric_vector(profile, "base_density"))
    # _density_curve_minimum(profile) -- :1031
    fields["densityCurveMinimum"] = writer.write(gpc._density_curve_minimum(profile))
    # _numeric_layers(profile, "density_curves_layers") -- :1032
    fields["densityCurveLayers"] = writer.write(gpc._numeric_layers(profile, "density_curves_layers"))
    # _density_curve_layer_maxima(profile) -- :1033
    fields["densityCurveLayerMaxima"] = writer.write(gpc._density_curve_layer_maxima(profile))
    # halation_preset["strength"] / ["sigma_h"] -- :1050-1051
    fields["halationStrength"] = writer.write([float(v) for v in halation_preset["strength"]])
    fields["halationFirstSigmaUm"] = writer.write([float(v) for v in halation_preset["sigma_h"]])
    # dir_couplers[...] -- :1052-1055
    fields["dirGammaSameLayerRgb"] = writer.write([float(v) for v in dir_couplers["same_layer_rgb"]])
    fields["dirGammaRToGb"] = writer.write([float(v) for v in dir_couplers["r_to_gb"]])
    fields["dirGammaGToRb"] = writer.write([float(v) for v in dir_couplers["g_to_rb"]])
    fields["dirGammaBToRg"] = writer.write([float(v) for v in dir_couplers["b_to_rg"]])
    # standard_illuminant(viewing_illuminant) -- :1056 (via `scan_illuminant` local)
    scan_illuminant = [float(v) for v in gpc.standard_illuminant(viewing_illuminant)]
    fields["scanIlluminant"] = writer.write(scan_illuminant)
    # _scan_to_output_rgb_matrices(viewing_illuminant) -- :1057
    fields["scanToOutputRgb"] = writer.write(gpc._scan_to_output_rgb_matrices(viewing_illuminant))

    return {
        "id": stock_id,
        "name": info["name"],
        "type": info["type"],
        "referenceIlluminant": reference_illuminant,
        "viewingIlluminant": viewing_illuminant,
        "wavelengthCount": len(profile["data"]["wavelengths"]),
        "exposureCount": len(profile["data"]["log_exposure"]),
        "mallettRawMidgrayGreen": float(mallett_raw_midgray_green),
        "license": profile["metadata"]["license"],
        "citation": profile["metadata"]["citation"],
        "datasource": profile["metadata"]["datasource"],
        "fields": fields,
    }


def pack_stocks(writer: _BlobWriter) -> list[dict]:
    # inputToSrgb (see pack_stock above) is identical for every stock in both
    # groups -- write it once up front and every stock references the same
    # {offsetFloats, lengthFloats} rather than duplicating 234 floats 28 times.
    shared_input_to_srgb = writer.write(gpc._input_to_srgb_matrices())

    entries: list[dict] = []
    for stock_id in stocks.FILMS:
        entries.append(pack_stock(writer, stock_id, is_film=True, shared_input_to_srgb=shared_input_to_srgb))
    for stock_id in stocks.PAPERS:
        entries.append(pack_stock(writer, stock_id, is_film=False, shared_input_to_srgb=shared_input_to_srgb))
    return entries


def pack_static(writer: _BlobWriter) -> dict:
    """The 16 global table accessors declared in SpektraProfileCurves.h.

    Each call below mirrors exactly what generate()/_emit_color_transforms()
    (generate_profile_curves.py:713-740, 1101-1235) already compute for their
    own C++ literals -- reused directly, not recomputed.
    """
    static: dict[str, dict] = {}

    # outputGamutCompression: kept from the original (narrower) Task 4 scope;
    # not one of the 16 header accessors, but still real runtime data
    # (Metal/OkLab gamut-compression matrices) with its own gate below.
    static["outputGamutCompression"] = writer.write(gpc._output_gamut_compression_data())

    # inputMeterXyzMatrices() -- generate_profile_curves.py:730, 1157-1159
    static["inputMeterXyzMatrices"] = writer.write(gpc._input_to_meter_xyz_matrices())

    # colorTransferKinds() -- :722, 1161-1163. Small integer enum values
    # (0-4), exactly representable as float32; stored in the same f32 blob
    # as everything else for a single uniform loader path.
    static["colorTransferKinds"] = writer.write([int(space["transfer"]) for space in gpc.COLOR_SPACES])

    # colorTransferParams() -- :723, 1165-1167
    static["colorTransferParams"] = writer.write([float(space.get("transfer_param", 0.0)) for space in gpc.COLOR_SPACES])

    # colorDecodeLuts() / colorEncodeLuts() -- :720-721, 1176-1182. The single
    # biggest static tables: 26 spaces x 4096 samples each.
    decode_luts: list[float] = []
    encode_luts: list[float] = []
    for space in gpc.COLOR_SPACES:
        decode_luts.extend(gpc._lut_values(space, "decode", gpc.COLOR_DECODE_MIN, gpc.COLOR_DECODE_MAX))
        encode_luts.extend(gpc._lut_values(space, "encode", gpc.COLOR_ENCODE_MIN, gpc.COLOR_ENCODE_MAX))
    static["colorDecodeLuts"] = writer.write(decode_luts)
    static["colorEncodeLuts"] = writer.write(encode_luts)

    # standardObserverCmfs() -- :1117, 1184-1186
    static["standardObserverCmfs"] = writer.write(
        gpc._matrix_to_rows(np.asarray(gpc.STANDARD_OBSERVER_CMFS[:], dtype=float))
    )

    # thKg3Illuminant() -- :1119, 1188-1190
    static["thKg3Illuminant"] = writer.write([float(v) for v in gpc.standard_illuminant("TH-KG3")])

    # customEnlargerFilters() -- :1121, 1192-1194
    static["customEnlargerFilters"] = writer.write(
        gpc._matrix_to_rows(np.asarray(gpc.custom_dichroic_filters.filters, dtype=float))
    )

    # neutralPrintFilters() -- :1123, 1196-1198
    static["neutralPrintFilters"] = writer.write(gpc._neutral_print_filter_table())

    # academyPrinterDensity{Responsivities,NeutralOffsets,Data,InfluxSpectrum} --
    # :1125-1131, 1200-1214. academy_printer_density_available() is False in
    # this checkout (the SMPTE ST 2065-2 CSVs are licensed standards data, not
    # redistributed upstream -- see tools/README.md, Task 1) so these four
    # tables legitimately come back as upstream's own _zero_* fallbacks, not
    # as missing data. That is a real, upstream-sanctioned zero (a disabled
    # feature), not the "silent zero standing in for unknown data" pattern
    # this emitter otherwise avoids via NaN -- flagged explicitly below via
    # academyPrinterDensityEnabled so it is never mistaken for the other kind.
    static["academyPrinterDensityResponsivities"] = writer.write(gpc._st2065_2_apd_responsivities())
    static["academyPrinterDensityNeutralOffsets"] = writer.write(gpc._academy_printer_density_neutral_offset_table())
    static["academyPrinterDensityData"] = writer.write(gpc._academy_printer_density_data())
    static["academyPrinterDensityInfluxSpectrum"] = writer.write(gpc._st2065_2_influx_spectrum())

    return static


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    stock_writer = _BlobWriter()
    stock_entries = pack_stocks(stock_writer)
    stock_blob = stock_writer.concat()
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

    static_writer = _BlobWriter()
    static_entries = pack_static(static_writer)
    static_blob = static_writer.concat()
    (args.out / "static.f32").write_bytes(static_blob.tobytes())

    manifest = {
        "hanatos": {
            "width": int(lut.shape[0]),
            "height": int(lut.shape[1]),
            "bands": int(lut.shape[2]),
        },
        # $SPEKTRAFILM_OFX/src/SpektraProfileCurves.h top-level constants.
        "colorSpaces": {
            "count": len(gpc.COLOR_SPACES),
            "transferLutSize": gpc.COLOR_LUT_SIZE,
            # Derived from the data itself (rgb_to_oklab_lms 3x3 + oklab_lms_to_rgb
            # 3x3 = 18 floats per space), not hardcoded, so a change upstream
            # would surface here as a changed number rather than silently drift.
            "outputGamutCompressionStride": len(gpc._output_gamut_compression_data()) // len(gpc.COLOR_SPACES),
            "labels": [space["label"] for space in gpc.COLOR_SPACES],
            "decodeLutMin": gpc.COLOR_DECODE_MIN,
            "decodeLutMax": gpc.COLOR_DECODE_MAX,
            "encodeLutMin": gpc.COLOR_ENCODE_MIN,
            "encodeLutMax": gpc.COLOR_ENCODE_MAX,
        },
        # generate_counts_header() (generate_profile_curves.py:1238-1260) --
        # the real counts, not SpektraProfileCurves.h's stale #ifndef fallback
        # (which still says kSpektraPaperCount = 7u; the real PAPERS list has 8).
        "counts": {
            "filmCount": len(stocks.FILMS),
            "paperCount": len(stocks.PAPERS),
            "defaultFilmIndex": stocks.DEFAULT_FILM_INDEX,
            "defaultPaperIndex": stocks.DEFAULT_PAPER_INDEX,
            "academyPrinterDensityEnabled": gpc.academy_printer_density_available(),
        },
        "stocks": stock_entries,
        "static": static_entries,
    }
    _write_json_lf(args.out / "manifest.json", manifest)
    print(
        f"Wrote {len(stock_entries)} stocks "
        f"({len(stocks.FILMS)} film + {len(stocks.PAPERS)} paper), "
        f"LUT {lut.shape}, "
        f"stocks.f32={stock_blob.size} floats, static.f32={static_blob.size} floats"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
