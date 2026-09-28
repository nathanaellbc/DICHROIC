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

# Task 17 (PrintScan, log_e_print/cmy_print gates): `density_curves_model`
# and `densitySpectralMidgray` both need the REAL Python runtime, not just
# OFX's `generate_profile_curves` module -- see `_py_density_curves_model`
# and `_py_density_spectral_midgray` docstrings below for why each needs it.
# Imported lazily (module scope, but after OFX's sys.path insert above) so
# `--out`-only invocations that never call these two functions still work
# even if a caller's PYTHONPATH doesn't have `spektrafilm` installed --
# but every stock this script bakes DOES need it now, so import eagerly and
# fail fast with a clear message rather than a deep traceback later.
try:
    from spektrafilm.runtime.params_builder import digest_params, init_params
    from spektrafilm.runtime.pipeline import SimulationPipeline
except ImportError as exc:  # pragma: no cover - environment guard
    raise SystemExit(
        "bake_web_assets.py butuh paket 'spektrafilm' terpasang (Task 17 "
        "menambah field yang sumbernya runtime Python, bukan cuma bake OFX) "
        "-- jalankan dengan venv yang punya 'spektrafilm' (mis. .venv-ref), "
        f"bukan .venv-bake. ImportError asli: {exc}"
    ) from exc


def _input_to_reference_xyz_matrices_cat16(reference_illuminant: str) -> list[list[float]]:
    """CAT16 counterpart of gpc._input_to_reference_xyz_matrices.

    Task 11 (log_e_film gate): spec Sec.6.3.1 -- where upstream's C++ bake
    (generate_profile_curves.py, which emits the literal we'd otherwise
    match byte-for-byte) and upstream's Python runtime (spektrafilm, which
    produced our parity fixtures) disagree, Python wins. Matching the C++
    literal is not proof of correctness; matching the fixture is.

    generate_profile_curves._color_space_to_xyz_matrix (:470) hard-codes
    chromatic_adaptation_transform="CAT02" for exactly this conversion:
    input RGB, white-balanced at the profile's reference_illuminant,
    projected to XYZ. The Python runtime performs the SAME physical
    conversion in spectral_upsampling._rgb_to_tc_b (used by
    rgb_to_raw_hanatos2025 -- the only rgb_to_raw_method our current parity
    fixtures exercise) with chromatic_adaptation_transform='CAT16' instead,
    explicitly, with a comment there explaining CAT16 (Li et al. 2017) was
    chosen over CAT02 for better-behaved blue/violet cone primaries.

    Measured divergence (Task 11, ProPhoto RGB at D55 -- this function's
    exact configuration, the log_e_film gate's color_patches case):
    neutral 0.5 grey 1.57e-7, saturated skin-tone yellow 1.98e-4, saturated
    red 1.33e-3, saturated green 1.87e-3, saturated blue 5.18e-3, max single
    matrix entry 8.27e-3. A CAT maps source white to target white by
    definition, so it leaves white/near-white untouched and only moves
    saturated colours -- exactly the four-orders-of-magnitude achromatic-
    vs-chromatic split the log_e_film gate measured (gray_ramp/
    log_gray_ramp within ~3.4x of the 1e-5 tolerance; color_patches ~2700x
    over, before this fix).

    Audited at the same time: every OTHER field bake_web_assets.py emits
    was checked for the same CAT02-vs-CAT16 pattern and found NOT to
    diverge --
      - scanToOutputRgb (gpc._scan_to_output_rgb_matrices) also hard-codes
        CAT02 in the C++ bake, but the Python runtime's equivalent
        conversion (spektrafilm/runtime/stages/scanning.py, colour.XYZ_to_RGB
        with no chromatic_adaptation_transform argument at all) relies on
        colour-science's own default -- confirmed directly against the
        pinned version (colour-science==0.4.6, colour/models/rgb/
        rgb_colourspace.py: XYZ_to_RGB(..., chromatic_adaptation_transform
        = "CAT02")) -- which IS "CAT02". Both sides agree; no fix needed.
      - inputToSrgb (gpc._input_to_srgb_matrices) is colour.RGB_to_RGB with
        no explicit CAT, i.e. also colour-science's CAT02 default. Its
        Python runtime counterpart for the same input-RGB-to-working-RGB
        step, spectral_upsampling.rgb_to_raw_mallett2019, calls
        colour.RGB_to_RGB the same way, with no override either. Both
        sides agree; no fix needed (also moot for THIS gate: the shader
        only reaches multiplyInputToSrgb on the rgbToRawMethod==1/mallett
        branch, not the rgbToRawMethod==0/hanatos2025 branch these fixtures
        exercise -- but it will matter once a mallett2019 gate exists).
      - inputMeterXyzMatrices (gpc._input_to_meter_xyz_matrices) never
        passes an `illuminant` argument, so source and target white are
        identical and any CAT choice is a no-op regardless.
    inputToReferenceXyz is the only emitted table this pattern affects.
    """
    matrices: list[list[float]] = []
    reference_xy = gpc._illuminant_to_xy(reference_illuminant)
    for space in gpc.COLOR_SPACES:
        columns = []
        for rgb in np.eye(3):
            columns.append(
                gpc.colour.RGB_to_XYZ(
                    rgb,
                    colourspace=space["matrix_space"],
                    apply_cctf_decoding=False,
                    illuminant=reference_xy,
                    chromatic_adaptation_transform="CAT16",
                )
            )
        matrices.extend(gpc._matrix_to_rows(np.stack(columns, axis=1)))
    return matrices


def _py_density_curve_data(stock_id: str) -> tuple[list, list]:
    """`density_curves` and `density_curves_layers` from the PYTHON repo's own
    profile JSON, not the OFX repo's copy `gpc._load_profile` reads.

    Task 12 (cmy_film gate): spec Sec.6.3.1, same rule Task 11 already
    established for inputToReferenceXyz (see
    `_input_to_reference_xyz_matrices_cat16` above) -- where upstream's C++
    bake and upstream's Python runtime disagree, Python wins, because Python
    produced the parity fixtures.

    Proven by direct comparison, not assumed: `$SPEKTRAFILM_OFX/Resources/data/
    profiles/{stock}.json` and `$SPEKTRAFILM_PY/src/spektrafilm/data/profiles/
    {stock}.json` share an identical `log_exposure` axis and every spectral/
    matrix field this baker already emits (log_sensitivity, hanatos window
    params, illuminant spectra -- confirmed byte-identical across all 28
    stocks), but their `density_curves` arrays diverge on ALL 28 stocks,
    from 0.033 (kodak_ektachrome_100) to 0.687 (kodak_2393) max abs
    difference -- three to five orders of magnitude above the 1e-5 parity
    tolerance, and `density_curves_layers` diverges similarly. This is a
    genuine data drift between the two upstream repos' bundled profile
    JSON (the two repos' commit metadata for the same stock even differ:
    OFX's `metadata.created` is one Python `git log` commit older than PY's
    for kodak_portra_400), not a bug in either repo's own code -- but our
    fixtures come from the PY repo's `SimulationPipeline`, so PY's density
    curves are the ones that must be baked, or every downstream `cmy_film`/
    `cmy_print` gate (Task 12-18) fails by construction, no matter how
    faithfully the shader itself is transliterated. Confirmed directly:
    `curveDevelop.wgsl`'s `interpDensityCurve`, run host-side in JS against
    the OFX-sourced (uncorrected) `densityCurves` field, missed Python's
    develop_simple() oracle (DIR-coupler-free) by 1.4e-2 to 1.6e-2 across
    all three lut-family fixtures -- switching only this data source (no
    shader/host-math change) is expected to close that gap to the same
    ~1e-7 f32-noise floor Task 11 reached, since every other stock field
    was already proven to agree.

    Declared here, not silenced -- see also `compare_cpp.py`'s
    `INTENTIONAL_DEVIATIONS`, where the resulting divergence from the OFX
    C++ literal is recorded with this same reasoning for every stock.
    """
    py_root = Path(os.environ["SPEKTRAFILM_PY"])
    path = py_root / "src" / "spektrafilm" / "data" / "profiles" / f"{stock_id}.json"
    py_profile = json.loads(path.read_text(encoding="utf-8"))
    return py_profile["data"]["density_curves"], py_profile["data"]["density_curves_layers"]


def _py_density_curves_model(stock_id: str) -> tuple[list, list, list] | None:
    """`density_curves_model.{centers,amplitudes,sigmas}` from the PYTHON
    repo's own profile JSON.

    Task 17 (log_e_print/cmy_print gates): `PrintingStage.develop()` calls
    `develop_print_morph`, which evaluates this PARAMETRIC model (sum of
    per-layer normal-CDF terms, `morph_curves.py::_evaluate_fitted_density`)
    at the print stock's own `log_exposure` grid -- NOT the raw tabulated
    `density_curves` field `develop_simple` (film's `develop()`) uses. This
    project is the FIRST task to consume this field, so per the hard
    constraint (profile data comes from Python, not OFX, and this field
    specifically needs checking): confirmed directly
    (`scratchpad/probe_static_divergence.py`, this session) that
    `$SPEKTRAFILM_OFX/Resources/data/profiles/{stock}.json` has NO
    `density_curves_model` key AT ALL for `kodak_portra_endura` (or, by
    inspection, any stock) -- unlike `density_curves` (Task 12), which
    exists on BOTH sides and merely disagrees numerically, this field only
    exists on the Python side. There is nothing to compare against on the
    OFX side; Python is the only source, not merely the winning one.

    Returns None for stocks whose JSON lacks the key entirely (none observed
    among the 28 current stocks, but checked rather than assumed -- see
    `pack_stock` for how a None here is surfaced as manifest `null`,
    mirroring `bandpassHanatos2025`'s existing null-for-paper convention).
    """
    py_root = Path(os.environ["SPEKTRAFILM_PY"])
    path = py_root / "src" / "spektrafilm" / "data" / "profiles" / f"{stock_id}.json"
    py_profile = json.loads(path.read_text(encoding="utf-8"))
    model = py_profile["data"].get("density_curves_model")
    if model is None:
        return None
    return model["centers"], model["amplitudes"], model["sigmas"]


# Cache: building a full `SimulationPipeline` per film stock (needed for
# `_py_density_spectral_midgray` below) recomputes the Hanatos spectral
# upsampling LUT for that stock's sensitivity -- not free, but a one-time
# bake cost, and "quality over performance" (project rule) makes reusing the
# REAL runtime object preferable to reimplementing
# `_simple_rgb_to_density_spectral`'s dependency chain (band-pass filter,
# `get_filming_tc_lut`, `rgb_to_raw_hanatos2025`) a second time here just to
# save a few seconds of bake time.
_PIPELINE_CACHE: dict[str, object] = {}


def _py_density_spectral_midgray(stock_id: str, *, is_film: bool) -> list | None:
    """Bake `density_spectral_midgray` -- the FILM-stock-only, mid-gray
    spectral-density reference `PrintingStage._compute_exposure_factor_midgray`
    combines (at TS runtime, with the runtime-tunable enlarger-filtered
    illuminant) to normalize print exposure.

    WHY BAKE THIS INSTEAD OF PORTING IT TO TypeScript: unlike
    `enlarger_filtered_illuminant` (genuinely runtime-tunable -- the enlarger
    C/M/Y filter shifts are live UI controls, ported to
    `src/host/enlarger.ts`), `density_spectral_midgray`
    (`runtime/stages/filming.py::_compute_density_spectral_midgray_to_balance_print`,
    the non-`_comp` branch this project's `lut_mode`/`family: 'measured'`
    fixtures always take -- `print_exposure_compensation` is forced `False`
    under `lut_mode` and `exposure_compensation_ev` is forced `0.0`, so the
    `_comp` variant is provably never read, see task-17-report.md) is a pure
    function of ONLY the film stock and camera/settings defaults this project
    never varies (`rgb_to_raw_method="hanatos2025"`, `filter_uv`/`filter_ir`
    band-pass off, sRGB midgray `[0.184]*3` with no CCTF decode -- all fixed
    inside `_simple_rgb_to_density_spectral` itself, not read from any
    per-run `CoreParams`). Reproducing it in TS would mean porting Hanatos
    raw sampling AND `develop_simple`'s curve lookup a second time solely to
    recompute a per-stock constant Python itself only computes once (cached
    on `FilmingStage.__init__`) -- baking it here is the same "static since
    load" classification `mallettRawMidgrayGreen` (an existing per-stock
    baked scalar) already uses for an analogous midgray-reference value.

    Film stocks only (mirrors `bandpassHanatos2025`'s null-for-paper
    convention) -- print/paper stocks are never used as `self._film` in
    `PrintingStage`, so this value is meaningless for them.
    """
    if not is_film:
        return None
    pipeline = _PIPELINE_CACHE.get(stock_id)
    if pipeline is None:
        raw_params = init_params(film_profile=stock_id)
        pipeline = SimulationPipeline(digest_params(raw_params))
        _PIPELINE_CACHE[stock_id] = pipeline
    density_spectral_midgray = pipeline._filming_stage._simple_rgb_to_density_spectral(  # noqa: SLF001
        np.array([[[0.184, 0.184, 0.184]]])
    )
    # Shape (1, 1, wavelengthCount) -- squeeze to a flat per-wavelength vector.
    return [float(v) for v in np.asarray(density_spectral_midgray).reshape(-1)]


def _python_output_color_spaces() -> dict:
    """Fase 2C Task 9: spesifikasi colour space KELUARAN per label manifest,
    langsung dari colour-science (yang `ScanningStage` Python pakai):
    kunci colour (label itu sendiri bila ada, selain itu `matrix_space` OFX),
    `matrix_RGB_to_XYZ`/`matrix_XYZ_to_RGB` APA ADANYA (untuk sRGB keduanya
    konstanta terbit yang dibulatkan independen -- `RGB_to_RGB(cs, cs)` dan
    `compress_rgb` memakainya, bukan invers numerik), whitepoint XYZ (Y=1,
    `_output_cs_whitepoint_xyz`), dan jenis `cctf_encoding` yang dideteksi
    NUMERIK: `srgb` (IEC 61966-2-1), `gamma` (v**(1/g)), `romm` (ProPhoto),
    `linear`. Label yang encode-nya bukan salah satu itu (log kamera, OETF
    BT.709, ACEScc/ACEScct) tidak dimasukkan -- keluaran SDR saja.
    """
    import colour

    keys = set(colour.RGB_COLOURSPACES.keys())
    v = np.linspace(0.0, 1.0, 4001)

    def srgb(x):
        return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)

    def romm(x):
        return np.where(x < 1 / 512, 16 * x, np.power(x, 1 / 1.8))

    candidates = [("linear", None, lambda x: x), ("srgb", None, srgb), ("romm", None, romm)]
    candidates += [("gamma", g, (lambda g: lambda x: np.power(x, 1 / g))(g)) for g in (2.19921875, 2.2, 2.4, 2.6)]

    out: dict[str, dict] = {}
    for space in gpc.COLOR_SPACES:
        label, matrix_space = space["label"], space["matrix_space"]
        key = label if label in keys else matrix_space
        cs = colour.RGB_COLOURSPACES[key]
        encoded = np.asarray(cs.cctf_encoding(v), dtype=np.float64)
        match = next(
            ((kind, g) for kind, g, fn in candidates if np.max(np.abs(fn(v) - encoded)) < 1e-12),
            None,
        )
        if match is None:
            continue
        # Label harus BERARTI encode yang sama: encode OFX label (transfer 0 =
        # identitas) identik dengan cctf_encoding colour. Menyingkirkan mis.
        # "Canon Log2 CinemaGamut D55" (colour 'Cinema Gamut' linear) dan
        # "P3-D65 Gamma 2.2" (colour 'P3-D65' gamma 2.6).
        ofx_encoded = v if space["transfer"] == 0 else np.array([space["encode"](x) for x in v], dtype=np.float64)
        if np.max(np.abs(ofx_encoded - encoded)) > 1e-9:
            continue
        kind, gamma = match
        wp = np.asarray(cs.whitepoint, dtype=np.float64)
        out[label] = {
            "key": key,
            "rgbToXyz": [float(x) for x in np.asarray(cs.matrix_RGB_to_XYZ, dtype=np.float64).reshape(-1)],
            "xyzToRgb": [float(x) for x in np.asarray(cs.matrix_XYZ_to_RGB, dtype=np.float64).reshape(-1)],
            "whitepointXyz": [float(wp[0] / wp[1]), 1.0, float((1 - wp[0] - wp[1]) / wp[1])],
            "encoding": kind,
            "gamma": gamma,
        }
    return out


def _python_neutral_print_filters() -> dict:
    """Fase 2C Task 8: tabel filter netral enlarger (Kodak CC, C/M/Y) SEMUA
    pasangan (print, film) untuk illuminant `TH-KG3`, persis database yang
    `digest_params()` -> `apply_database_neutral_print_filters()` baca
    (`spektrafilm.utils.io.read_neutral_print_filters`).

    BUKAN `static.neutralPrintFilters` (tabel OFX dari
    `generate_profile_curves.py::_neutral_print_filter_table`): OFX membaca
    salinan `neutral_print_filters.json` MILIKNYA SENDIRI, yang terbukti
    berbeda dari database Python sampai 77 CC (`kodak_2383`/`fujifilm_c200`)
    dan 3.3 CC pada pasangan baseline portra_400/portra_endura (Y 55.84 vs
    52.53). Python oracle proyek ini, jadi tabel ini yang dipakai
    `resolveEnlargerFilters`. Hanya pasangan yang ADA di database; pasangan
    lain ditolak di TS (Python akan memakai default dataclass dengan
    peringatan -- konfigurasi yang tidak pernah kita gerbangi).
    """
    from spektrafilm.utils.io import read_neutral_print_filters

    database = read_neutral_print_filters()
    table: dict[str, dict[str, list[float]]] = {}
    for paper in sorted(database):
        films = database[paper].get("TH-KG3", {})
        if films:
            table[paper] = {film: [float(v) for v in films[film]] for film in sorted(films)}
    return {"illuminant": "TH-KG3", "table": table}


def _default_enlarger_neutral_filters() -> dict:
    """Resolved enlarger C/M/Y "neutral" filter values for the default film
    (`kodak_portra_400`) + print (`kodak_portra_endura`) + illuminant
    (`TH-KG3`) combination -- Task 17 (PrintScan).

    NOT the raw `EnlargerParams` dataclass literals (`c_filter_neutral=0`,
    `m_filter_neutral=65`, `y_filter_neutral=55`) -- `digest_params()`
    unconditionally calls `apply_database_neutral_print_filters()`
    (`runtime/params_builder.py:80`), which OVERWRITES all three from a
    database keyed by `(print_stock, illuminant, film_stock)`
    (`settings.neutral_print_filters_from_database` defaults `True`, never
    turned off by any fixture family this project's `gen_reference.py`
    generates). Confirmed directly, not assumed: for the default triple,
    `digest_params(init_params())` resolves to `c=0.0`,
    `m=51.56801468495496`, `y=52.53400422349596` -- NOT `(0, 65, 55)`. Every
    fixture in `test/fixtures/` (all of which come from `init_params()` with
    no film/print override) uses this exact resolved triple, so baking it
    here (instead of shipping the raw defaults, or re-deriving the whole
    filter database in TypeScript) is what makes `src/host/enlarger.ts`'s
    output match Python.

    Scope-limited to the one (film, print, illuminant) combination every
    current fixture uses, exactly like `_apply_halation_preset`'s resolved
    per-stock halation numbers are baked rather than the general preset
    lookup logic -- see `pack_stock`'s `halationStrength`/
    `halationFirstSigmaUm` for the established precedent. A future task that
    needs a different pairing must extend this, not assume it generalizes.
    """
    raw_params = init_params()
    params = digest_params(raw_params)
    return {
        "filmStock": params.film.info.stock,
        "printStock": params.print.info.stock,
        "illuminant": params.enlarger.illuminant,
        "neutralFilterC": float(params.enlarger.c_filter_neutral),
        "neutralFilterM": float(params.enlarger.m_filter_neutral),
        "neutralFilterY": float(params.enlarger.y_filter_neutral),
    }


def _write_json_lf(path: Path, obj, *, sort_keys: bool = False) -> None:
    """Write JSON with LF-only line endings, regardless of platform.

    Path.write_text() opens in text mode, which on Windows translates every
    '\\n' to os.linesep ('\\r\\n') -- manifest.json would then differ
    byte-for-byte between a Windows bake and a Linux/macOS bake even though
    the content is identical. Building the string with '\\n' and writing it
    as bytes bypasses newline translation entirely, matching the discipline
    already established in tools/gen_reference.py for Task 3's fixture
    manifest, and enforced from git's side by .gitattributes
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
    # Python wins over the OFX C++ bake for density_curves/density_curves_layers
    # -- see _py_density_curve_data docstring above for the full proof. This
    # mutates only these two keys of the OFX profile dict in place; every
    # other field below (spectral response, matrices, illuminants) still
    # comes from `profile` as loaded, since those were verified to agree.
    py_density_curves, py_density_curves_layers = _py_density_curve_data(stock_id)
    profile["data"]["density_curves"] = py_density_curves
    profile["data"]["density_curves_layers"] = py_density_curves_layers
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
    # _input_to_reference_xyz_matrices(reference_illuminant) -- :1022.
    # NOT gpc._input_to_reference_xyz_matrices: spec Sec.6.3.1, Python wins
    # over C++ where they disagree. See _input_to_reference_xyz_matrices_cat16
    # docstring above for the full CAT02-vs-CAT16 proof.
    fields["inputToReferenceXyz"] = writer.write(_input_to_reference_xyz_matrices_cat16(reference_illuminant))
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
    # halation_preset["strength"] / ["sigma_h"] -- :1050-1051. OFX-sourced
    # (`halation_preset` derives from `info` above, which is `profile["info"]`
    # as loaded from OFX's own JSON) -- review seluruh-branch agenda #2:
    # `tools/verify_profile_agreement.py` re-verifies this against Python's
    # own `_apply_halation_preset` runtime resolution on every run, closing
    # the "verified once, by hand" gap task-14-report.md left open.
    fields["halationStrength"] = writer.write([float(v) for v in halation_preset["strength"]])
    fields["halationFirstSigmaUm"] = writer.write([float(v) for v in halation_preset["sigma_h"]])
    # dir_couplers[...] -- :1052-1055. Also OFX-sourced and also re-verified
    # by `tools/verify_profile_agreement.py` (same script, same reasoning).
    fields["dirGammaSameLayerRgb"] = writer.write([float(v) for v in dir_couplers["same_layer_rgb"]])
    fields["dirGammaRToGb"] = writer.write([float(v) for v in dir_couplers["r_to_gb"]])
    fields["dirGammaGToRb"] = writer.write([float(v) for v in dir_couplers["g_to_rb"]])
    fields["dirGammaBToRg"] = writer.write([float(v) for v in dir_couplers["b_to_rg"]])
    # standard_illuminant(viewing_illuminant) -- :1056 (via `scan_illuminant` local)
    scan_illuminant = [float(v) for v in gpc.standard_illuminant(viewing_illuminant)]
    fields["scanIlluminant"] = writer.write(scan_illuminant)
    # _scan_to_output_rgb_matrices(viewing_illuminant) -- :1057
    fields["scanToOutputRgb"] = writer.write(gpc._scan_to_output_rgb_matrices(viewing_illuminant))

    # --- Task 17 (PrintScan): four NEW fields, appended here (after every
    # field the SpektraProfileCurves.h contract above already emits) so
    # every existing field keeps its exact byte offset -- see
    # `_py_density_curves_model`/`_py_density_spectral_midgray` docstrings
    # for why each needs the Python runtime specifically, not OFX's bake.
    # Flat layout [channel*3 + layer], channel/layer order exactly as
    # `density_curves_model.{centers,amplitudes,sigmas}` (both (3,3)
    # row=channel, col=layer arrays) -- read back the same way in
    # `src/host/spectral.ts`.
    density_curves_model = _py_density_curves_model(stock_id)
    if density_curves_model is None:
        fields["densityCurvesModelCenters"] = None
        fields["densityCurvesModelAmplitudes"] = None
        fields["densityCurvesModelSigmas"] = None
    else:
        centers, amplitudes, sigmas = density_curves_model
        fields["densityCurvesModelCenters"] = writer.write(centers)
        fields["densityCurvesModelAmplitudes"] = writer.write(amplitudes)
        fields["densityCurvesModelSigmas"] = writer.write(sigmas)
    density_spectral_midgray = _py_density_spectral_midgray(stock_id, is_film=is_film)
    fields["densitySpectralMidgray"] = (
        writer.write(density_spectral_midgray) if density_spectral_midgray is not None else None
    )

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
        # Task 17 (PrintScan) -- see `_default_enlarger_neutral_filters`
        # docstring for why this is resolved (database-backed), not the raw
        # `EnlargerParams` dataclass defaults.
        "printScan": _default_enlarger_neutral_filters(),
        # Fase 2C Task 8 -- see `_python_neutral_print_filters`.
        "neutralPrintFilters": _python_neutral_print_filters(),
        # Fase 2C Task 9 -- see `_python_output_color_spaces`.
        "outputColorSpaces": _python_output_color_spaces(),
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
