#!/usr/bin/env python3
"""Bandingkan aset yang dipancarkan bake_web_assets.py terhadap literal C++ hulu.

Ini adalah Step 5 dari task-4-brief.md, dijadikan skrip nyata alih-alih
probe sekali pakai yang dibuang: "satu-satunya pemeriksaan bahwa emitter
kita tidak menyimpang dari jalur hulu." Kalau aset dibangkitkan ulang nanti
-- versi paket colour-science berubah, data profil hulu diperbarui, atau
field baru ditambahkan ke bake_web_assets.py -- skrip ini adalah cara
mengulang pemeriksaan itu tanpa menulis ulang dari nol.

Cara pakai:

    # 1. Bangkitkan literal C++ hulu segar (env yang sama dengan bake):
    D:/Projects/upstream/.venv-bake/Scripts/python \\
      "$SPEKTRAFILM_OFX/tools/generate_profile_curves.py" \\
      --output /tmp/SpektraGeneratedProfileCurves.cpp \\
      --hanatos-output /tmp/SpektraHanatos2025Spectra.f32 \\
      --output-gamut-compression-output /tmp/SpektraOutputGamutCompression.f32

    # 2. Bangkitkan (atau pakai yang sudah ada di) spektra/public/data/:
    D:/Projects/upstream/.venv-bake/Scripts/python \\
      spektra/tools/bake_web_assets.py --out spektra/public/data

    # 3. Bandingkan:
    D:/Projects/upstream/.venv-bake/Scripts/python \\
      spektra/tools/compare_cpp.py \\
      --cpp /tmp/SpektraGeneratedProfileCurves.cpp \\
      --gamut-bin /tmp/SpektraOutputGamutCompression.f32

Keluar dengan kode 0 kalau semua tabel cocok sampai presisi float32 ATAU
menyimpang hanya lewat penyimpangan yang SUDAH dideklarasikan di
INTENTIONAL_DEVIATIONS (dicetak sebagai baris DEVIATION(intentional, ...),
bukan PASS/FAIL), kode 1 kalau ada satu saja penyimpangan yang tidak
terdeklarasi -- supaya siapa pun yang menjalankannya tahu hasilnya dari
kode keluar saja, tanpa perlu membaca kode ini, dan tahu langsung mana
penyimpangan yang disengaja (Python menang, spec Sec.6.3.1) versus mana
yang benar-benar regresi.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import struct
import sys
from pathlib import Path

import numpy as np

TOOLS_DIR = Path(__file__).resolve().parent
SPEKTRA_ROOT = TOOLS_DIR.parent

# Field-per-stock -> nama larik C++ (tanpa prefix "{group}_{index}_{stock}_").
# Mengikuti persis urutan _emit_group (generate_profile_curves.py:1005-1098);
# lihat komentar per field di bake_web_assets.py:pack_stock untuk baris
# sumber persisnya.
FIELD_TO_CPP_SUFFIX = {
    "wavelengths": "wavelengths",
    "logSensitivity": "log_sensitivity",
    "bandpassHanatos2025": "bandpass_hanatos2025",
    "hanatos2026WindowParams": "hanatos2026_window_params",
    "referenceIlluminantSpectrum": "reference_illuminant_spectrum",
    "inputToReferenceXyz": "input_to_reference_xyz",
    "mallettBasisIlluminant": "mallett_basis_illuminant",
    "logExposure": "log_exposure",
    "densityCurves": "density_curves",
    "channelDensity": "channel_density",
    "baseDensity": "base_density",
    "densityCurveMinimum": "density_curve_minimum",
    "densityCurveLayers": "density_curve_layers",
    "densityCurveLayerMaxima": "density_curve_layer_maxima",
    "halationStrength": "halation_strength",
    "halationFirstSigmaUm": "halation_first_sigma_um",
    "dirGammaSameLayerRgb": "dir_gamma_same_layer_rgb",
    "dirGammaRToGb": "dir_gamma_r_to_gb",
    "dirGammaGToRb": "dir_gamma_g_to_rb",
    "dirGammaBToRg": "dir_gamma_b_to_rg",
    "scanIlluminant": "scan_illuminant",
    "scanToOutputRgb": "scan_to_output_rgb",
}

# Field per-stock yang SENGAJA menyimpang dari literal C++ hulu (spec
# Sec.6.3.1: kalau C++ bake dan Python runtime hulu tidak sepakat, Python
# menang, karena Python yang menghasilkan fixture parity kita, bukan C++).
# Cocok dengan literal C++ TIDAK berarti benar; ini bukan kegagalan harness,
# ini bukti bahwa penyimpangan itu diukur dan dijelaskan, bukan ditebak atau
# didiamkan. Lihat bake_web_assets.py::_input_to_reference_xyz_matrices_cat16
# untuk pembuktian numerik penuh (Task 11).
INTENTIONAL_DEVIATIONS: dict[str, str] = {
    "inputToReferenceXyz": (
        "CAT02 (generate_profile_curves.py:470, C++ bake) vs CAT16 "
        "(spectral_upsampling.py:_rgb_to_tc_b, Python runtime that produced "
        "our fixtures) chromatic adaptation transform for input-RGB -> "
        "reference-XYZ. Measured divergence at ProPhoto RGB/D55: "
        "1.57e-7 (neutral) to 5.18e-3 (saturated blue), max matrix entry "
        "8.27e-3 -- see task-11-report.md."
    ),
    "densityCurves": (
        "$SPEKTRAFILM_OFX/Resources/data/profiles/{stock}.json (C++ bake "
        "source) vs $SPEKTRAFILM_PY/src/spektrafilm/data/profiles/{stock}.json "
        "(Python runtime that produced our fixtures) density_curves -- two "
        "upstream repos' bundled profile JSON have drifted apart on this "
        "field for all 28 stocks (log_exposure and every other stock field "
        "this baker emits stay byte-identical between the two repos). "
        "Max abs difference ranges 0.034 (kodak_ektachrome_100) to 0.687 "
        "(kodak_2393) -- see task-12-report.md."
    ),
    "densityCurveMinimum": (
        "Derived from density_curves (np.nanmin per channel) -- same PY-vs-OFX "
        "source divergence as densityCurves above; see task-12-report.md."
    ),
    "densityCurveLayers": (
        "$SPEKTRAFILM_OFX vs $SPEKTRAFILM_PY profile JSON density_curves_layers "
        "-- same PY-vs-OFX source divergence as densityCurves above, "
        "independently confirmed to diverge on its own (not merely inherited "
        "from density_curves); see task-12-report.md."
    ),
    "densityCurveLayerMaxima": (
        "Derived from density_curves_layers (np.nanmax per channel/layer) -- "
        "same PY-vs-OFX source divergence as densityCurveLayers above; see "
        "task-12-report.md."
    ),
}

# Tabel di manifest["static"] yang sengaja TIDAK dibandingkan di sini,
# dengan alasan eksplisit -- lihat check_field_coverage(): kelalaian diam-diam
# persis kegagalan yang harness ini ada untuk mencegah, jadi tiap pengecualian
# harus tertulis dan beralasan, bukan sekadar tidak disebut.
STATIC_COMPARISON_EXEMPT = {
    # Tidak ada literal C++ untuk tabel ini -- generate_profile_curves.py
    # tidak pernah memancarkannya sebagai larik bernama (dikonfirmasi: 0
    # kecocokan untuk "gamut" di .cpp). Ia hanya ada lewat berkas biner
    # --output-gamut-compression-output hulu sendiri, dibandingkan terpisah
    # lewat --gamut-bin di main().
    "outputGamutCompression",
}

# Tabel global -> nama larik C++. Semua 13 tabel float dari
# SpektraProfileCurves.h yang benar-benar muncul sebagai literal C++
# (outputGamutCompression sengaja tidak di sini -- lihat STATIC_COMPARISON_EXEMPT).
STATIC_TO_CPP = {
    "inputMeterXyzMatrices": ("float", "input_meter_xyz"),
    "colorTransferKinds": ("uint", "color_transfer_kinds"),
    "colorTransferParams": ("float", "color_transfer_params"),
    "colorDecodeLuts": ("float", "color_decode_luts"),
    "colorEncodeLuts": ("float", "color_encode_luts"),
    "standardObserverCmfs": ("float", "standard_observer_cmfs"),
    "thKg3Illuminant": ("float", "th_kg3_illuminant"),
    "customEnlargerFilters": ("float", "custom_enlarger_filters"),
    "neutralPrintFilters": ("float", "neutral_print_filters"),
    "academyPrinterDensityResponsivities": ("float", "academy_printer_density_responsivities"),
    "academyPrinterDensityNeutralOffsets": ("float", "academy_printer_density_neutral_offsets"),
    "academyPrinterDensityData": ("float", "academy_printer_density_data"),
    "academyPrinterDensityInfluxSpectrum": ("float", "academy_printer_density_influx_spectrum"),
}

# Stock representatif: dipilih untuk mencakup kedua cabang densityCurves
# (film ternormalisasi vs. kertas mentah -- lihat generate_profile_curves.py:1027)
# dan ketiga illuminant referensi yang dipakai hulu di seluruh 28 profil
# (D55, TH-KG3, T -- diverifikasi langsung, bukan diasumsikan).
REPRESENTATIVE_STOCKS = [
    ("film", "kodak_portra_400"),      # reference_illuminant D55, viewing D50
    ("paper", "kodak_2383"),           # reference_illuminant TH-KG3, viewing K75P
    ("film", "kodak_vision3_200t"),    # reference_illuminant T
]

FLOAT_ARRAY_RE = re.compile(r"alignas\(16\) constexpr float (\w+)\[\] = \{(.*?)\};", re.S)
UINT_ARRAY_RE = re.compile(r"alignas\(16\) constexpr uint32_t (\w+)\[\] = \{(.*?)\};", re.S)
LABEL_ARRAY_RE = re.compile(r"constexpr const char \*color_space_labels\[\] = \{(.*?)\};", re.S)


def _parse_float_body(body: str) -> np.ndarray:
    tokens = re.findall(r"-?[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?f|NAN", body)
    out = np.empty(len(tokens), dtype="<f4")
    for i, tok in enumerate(tokens):
        out[i] = np.float32(np.nan) if tok == "NAN" else np.float32(tok[:-1])
    return out


def parse_cpp(cpp_text: str) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray], list[str]]:
    float_arrays = {name: _parse_float_body(body) for name, body in FLOAT_ARRAY_RE.findall(cpp_text)}
    uint_arrays = {
        name: np.asarray([int(t[:-1]) for t in re.findall(r"\d+u", body)], dtype=np.uint32)
        for name, body in UINT_ARRAY_RE.findall(cpp_text)
    }
    label_match = LABEL_ARRAY_RE.search(cpp_text)
    labels = re.findall(r'"([^"]*)"', label_match.group(1)) if label_match else []
    return float_arrays, uint_arrays, labels


def slice_of(blob: np.ndarray, ref: dict) -> np.ndarray:
    off = ref["offsetFloats"]
    n = ref["lengthFloats"]
    return blob[off:off + n]


class Comparison:
    def __init__(self) -> None:
        self.rows: list[tuple[str, int, float | None, str]] = []
        self.all_ok = True

    def compare(self, label: str, ours: np.ndarray, theirs: np.ndarray, *, intentional_deviation: str | None = None) -> None:
        if ours.size != theirs.size:
            self.rows.append((label, ours.size, None, f"FAIL(size {ours.size} vs {theirs.size})"))
            self.all_ok = False
            return
        both_nan = np.isnan(ours) & np.isnan(theirs)
        bad_nan = np.isnan(ours) != np.isnan(theirs)
        diff = np.where(both_nan, 0.0, np.abs(ours.astype(np.float64) - theirs.astype(np.float64)))
        max_diff = float(np.nanmax(diff)) if diff.size else 0.0
        # Combined absolute+relative tolerance (~1 float32 ULP at the
        # observed magnitude): upstream's own literal round-trips every
        # value through 9-significant-digit decimal text
        # (generate_profile_curves._float_literal) before a C++ compiler
        # parses it back to float32, while this emitter goes float64 ->
        # float32 binary directly. Two independently-rounded float32s of
        # the same float64 source can differ by ~1 ULP at large magnitude
        # with neither being wrong (observed: colorDecodeLuts, an ACEScct
        # decode value near 66027, differs by 0.0078125 -- exactly 1 ULP
        # there). 1e-4 absolute covers everything near zero.
        max_abs = float(np.nanmax(np.abs(theirs.astype(np.float64)))) if theirs.size else 0.0
        tolerance = max(1e-4, max_abs * 1.5e-6)
        if bad_nan.any():
            status = "FAIL(NaN mismatch)"
        elif max_diff <= tolerance:
            status = "PASS"
        elif intentional_deviation is not None:
            # Declared, not silenced: still prints the measured magnitude
            # every run, so a *change* in that magnitude (e.g. upstream
            # changing its CAT choice, or a regression riding along with
            # this deviation) is still visible -- it just isn't reported
            # as a harness failure. See INTENTIONAL_DEVIATIONS above.
            status = f"DEVIATION(intentional, maxdiff={max_diff:.6g}): {intentional_deviation}"
        else:
            status = f"FAIL(maxdiff={max_diff:.6g}, tol={tolerance:.6g})"
        self.rows.append((label, ours.size, max_diff, status))
        self.all_ok = self.all_ok and not status.startswith("FAIL")

    def check_coverage(self, label: str, manifest_keys: set, compared_keys: set, exempt: set = frozenset()) -> None:
        """Fail loudly, by name, if the hand-maintained lookup tables above
        (FIELD_TO_CPP_SUFFIX / STATIC_TO_CPP) have drifted out of sync with
        what bake_web_assets.py actually emits.

        The per-field/per-table loops below already fail closed if a field
        is *renamed* or *removed* (the C++-side lookup raises/misses and
        that's reported as a FAIL row). What they can't catch on their own
        is a field *added* to bake_web_assets.py's `fields`/`static` dicts
        and never added here: nothing would iterate over it, so it would
        never be compared against upstream at all, and this harness would
        still print ALL PASS -- silently defeating the one check that's
        supposed to catch exactly this kind of divergence. This assertion
        exists so that gap fails the run instead of passing silently.
        """
        uncovered = sorted(manifest_keys - compared_keys - exempt)
        stale = sorted(compared_keys - manifest_keys)
        if uncovered or stale:
            parts = []
            if uncovered:
                parts.append(f"in manifest but never compared: {', '.join(uncovered)}")
            if stale:
                parts.append(f"compared but no longer in manifest: {', '.join(stale)}")
            self.rows.append((label, len(manifest_keys), None, f"FAIL({'; '.join(parts)})"))
            self.all_ok = False
        else:
            self.rows.append((label, len(manifest_keys), 0.0, "PASS"))

    def print_report(self) -> None:
        print()
        print(f"{'table':<75} {'n':>8} {'maxdiff':>14}  status")
        print("-" * 115)
        for label, n, max_diff, status in self.rows:
            md = f"{max_diff:.3e}" if max_diff is not None else "-"
            print(f"{label:<75} {n:>8} {md:>14}  {status}")
        print()
        print(f"{len(self.rows)} comparisons: {'ALL PASS' if self.all_ok else 'SOME FAILED'}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cpp", type=Path, required=True, help="Path to a freshly regenerated SpektraGeneratedProfileCurves.cpp")
    parser.add_argument("--data", type=Path, default=SPEKTRA_ROOT / "public" / "data", help="Baked asset directory (default: spektra/public/data)")
    parser.add_argument("--gamut-bin", type=Path, default=None, help="Path to upstream's own SpektraOutputGamutCompression.f32 sibling (optional; no C++ literal exists for this table, see main())")
    args = parser.parse_args()

    if "SPEKTRAFILM_OFX" not in os.environ:
        print("SPEKTRAFILM_OFX is not set -- needed to look up FILMS/PAPERS indices for the representative stocks.", file=sys.stderr)
        return 2
    sys.path.insert(0, str(Path(os.environ["SPEKTRAFILM_OFX"]) / "tools"))
    import ofx_stock_lists as stocks  # noqa: E402 (path must be set first)

    cpp_text = args.cpp.read_text(encoding="utf-8")
    float_arrays, uint_arrays, cpp_labels = parse_cpp(cpp_text)
    print(f"Parsed {len(float_arrays)} float arrays, {len(uint_arrays)} uint arrays from {args.cpp}", file=sys.stderr)

    manifest = json.loads((args.data / "manifest.json").read_text(encoding="utf-8"))
    stocks_blob = np.fromfile(args.data / "stocks.f32", dtype="<f4")
    static_blob = np.fromfile(args.data / "static.f32", dtype="<f4")
    stocks_by_id = {s["id"]: s for s in manifest["stocks"]}

    cmp = Comparison()

    # --- per-stock fields ---
    for group, stock_id in REPRESENTATIVE_STOCKS:
        order = stocks.FILMS if group == "film" else stocks.PAPERS
        index = order.index(stock_id)
        prefix = f"{group}_{index}_{stock_id}"
        entry = stocks_by_id[stock_id]

        # See Comparison.check_coverage's docstring: this is what catches a
        # field added to bake_web_assets.py's pack_stock() but never added
        # to FIELD_TO_CPP_SUFFIX above -- without it, that field would
        # simply never be iterated below and this script would still print
        # ALL PASS.
        cmp.check_coverage(
            f"{stock_id}.fields coverage (manifest keys vs. FIELD_TO_CPP_SUFFIX)",
            set(entry["fields"]),
            set(FIELD_TO_CPP_SUFFIX) | {"inputToSrgb"},
        )

        for field, cpp_suffix in FIELD_TO_CPP_SUFFIX.items():
            ref = entry["fields"][field]
            cpp_name = f"{prefix}_{cpp_suffix}"
            if ref is None:
                if cpp_name in float_arrays:
                    cmp.rows.append((f"{stock_id}.{field}", 0, None, "FAIL(we have null, cpp has array)"))
                    cmp.all_ok = False
                continue
            if cpp_name not in float_arrays:
                cmp.rows.append((f"{stock_id}.{field}", ref["lengthFloats"], None, "FAIL(cpp array not found)"))
                cmp.all_ok = False
                continue
            cmp.compare(
                f"{stock_id}.{field}",
                slice_of(stocks_blob, ref),
                float_arrays[cpp_name],
                intentional_deviation=INTENTIONAL_DEVIATIONS.get(field),
            )

        # inputToSrgb: shared per-group array (see bake_web_assets.py:pack_stocks)
        ref = entry["fields"]["inputToSrgb"]
        cpp_name = f"{group}_input_to_srgb"
        if cpp_name not in float_arrays:
            cmp.rows.append((f"{stock_id}.inputToSrgb (shared {cpp_name})", ref["lengthFloats"], None, f"FAIL(cpp array {cpp_name!r} not found)"))
            cmp.all_ok = False
        else:
            cmp.compare(f"{stock_id}.inputToSrgb (shared {cpp_name})", slice_of(stocks_blob, ref), float_arrays[cpp_name])

        # mallettRawMidgrayGreen: scalar embedded inline in the ProfileCurveSet
        # struct literal, not a named array -- pull it out of that record's line.
        record_re = re.compile(re.escape(f'"{stock_id}"') + r".*?,\s*([0-9.eE+-]+f|NAN)\s*,\s*\w+_log_exposure", re.S)
        m = record_re.search(cpp_text)
        if m:
            tok = m.group(1)
            cpp_val = float("nan") if tok == "NAN" else float(tok[:-1])
            ours32 = struct.unpack("f", struct.pack("f", entry["mallettRawMidgrayGreen"]))[0]
            diff = abs(ours32 - cpp_val)
            status = "PASS" if diff < 1e-4 else f"FAIL({diff})"
            cmp.rows.append((f"{stock_id}.mallettRawMidgrayGreen (scalar)", 1, diff, status))
            cmp.all_ok = cmp.all_ok and status == "PASS"
        else:
            cmp.rows.append((f"{stock_id}.mallettRawMidgrayGreen (scalar)", 1, None, "FAIL(pattern not found in record)"))
            cmp.all_ok = False

    # --- global static tables ---
    cmp.check_coverage(
        "static coverage (manifest.static keys vs. STATIC_TO_CPP)",
        set(manifest["static"]),
        set(STATIC_TO_CPP),
        exempt=STATIC_COMPARISON_EXEMPT,
    )
    for key, (kind, cpp_name) in STATIC_TO_CPP.items():
        ref = manifest["static"][key]
        ours = slice_of(static_blob, ref)
        table = uint_arrays if kind == "uint" else float_arrays
        if cpp_name not in table:
            cmp.rows.append((f"static.{key}", ref["lengthFloats"], None, f"FAIL(cpp array {cpp_name!r} not found)"))
            cmp.all_ok = False
            continue
        theirs = table[cpp_name].astype("<f4") if kind == "uint" else table[cpp_name]
        cmp.compare(f"static.{key}", ours, theirs)

    # outputGamutCompression has NO C++ literal (confirmed: generate_profile_curves.py
    # never emits it as a named array -- it only exists via the dedicated
    # --output-gamut-compression-output binary sibling file). Compared against
    # that file directly when provided, since no literal exists to compare against.
    if args.gamut_bin is not None:
        gamut_bin = np.fromfile(args.gamut_bin, dtype="<f4")
        ref = manifest["static"]["outputGamutCompression"]
        cmp.compare("static.outputGamutCompression (vs upstream .f32 sibling, no cpp literal exists)", slice_of(static_blob, ref), gamut_bin)
    else:
        print("(--gamut-bin not given: skipping outputGamutCompression, which has no C++ literal to compare against)", file=sys.stderr)

    # colorSpaces.labels: compared as strings, not floats.
    ours_labels = manifest["colorSpaces"]["labels"]
    labels_ok = ours_labels == cpp_labels
    cmp.rows.append(("colorSpaces.labels (string compare)", len(ours_labels), 0.0 if labels_ok else None, "PASS" if labels_ok else "FAIL(mismatch)"))
    cmp.all_ok = cmp.all_ok and labels_ok

    cmp.print_report()
    return 0 if cmp.all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
