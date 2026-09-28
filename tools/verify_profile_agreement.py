#!/usr/bin/env python3
"""Bandingkan setiap tabel OFX-sourced yang dibake terhadap PYTHON, bukan hanya OFX.

Review seluruh-branch, agenda #2 (`docs/superpowers/plans/2026-09-11-
dichroic-phase1-engine.md`, "Agenda review seluruh-branch"). `compare_cpp.py`
sudah membuktikan "bake kita == literal C++ OFX" -- tapi itu SATU SISI: ia
tidak pernah membuktikan "dan literal OFX itu == Python", yang justru asumsi
diam-diam yang ditumpangi 17 dari 22 field per-stock (`FIELD_TO_CPP_SUFFIX`
`compare_cpp.py` yang TIDAK ada di `INTENTIONAL_DEVIATIONS`-nya).

Asumsi itu sudah SALAH dua kali sebelumnya -- CAT02 (`inputToReferenceXyz`,
Task 11) dan `density_curves` (Task 12), keduanya ditemukan lewat audit manual
terpisah, bukan lewat harness yang berjalan tiap bake. `halationStrength`/
`halationFirstSigmaUm` diverifikasi byte-identik terhadap Python TEPAT SEKALI,
dengan tangan (task-14-report.md) -- skrip ini menjadikan verifikasi itu
sesuatu yang berjalan LAGI setiap kali skrip ini dipanggil, bukan sesuatu yang
harus diingat siapa pun sudah pernah dilakukan.

Inventaris OFX-sourced (dari `profile = gpc._load_profile(stock_id)`, BUKAN
dari JSON repo Python) untuk tiap field per-stock yang `bake_web_assets.py::
pack_stock` pancarkan -- lihat komentar per baris `pack_stock` untuk rujukan
persis:

    OFX-sourced, DIVERIFIKASI DI SINI (dua kategori):
      1. Field JSON MENTAH (dibandingkan character-oleh-character terhadap
         copy Python, lewat CHECKED_RAW_JSON_KEYS di bawah): wavelengths,
         logSensitivity, logExposure, channelDensity, baseDensity,
         bandpassHanatos2025 (`hanatos2025_adaptation_surface_params`),
         hanatos2026WindowParams (`hanatos2025_adaptation_window_params`),
         plus SETIAP field `info` (reference_illuminant, viewing_illuminant,
         use, antihalation, type, dst.) yang derivasi manapun di bawah
         BERGANTUNG padanya secara transitif.
      2. Field yang DIDERIVASI dari preset/tabel default hulu, dan hulu punya
         DUA implementasi independen dari resolusi yang SAMA (persis pola
         CAT02-vs-CAT16): halationStrength/halationFirstSigmaUm
         (`_HALATION_PRESETS` OFX vs `_apply_halation_preset` Python) dan
         dirGammaSameLayerRgb/RToGb/GToRb/BToRg (`_dir_coupler_defaults` OFX
         vs `_apply_film_specifics` Python). Diverifikasi lewat RUNTIME
         Python sungguhan (`digest_params(init_params(film_profile=...))`),
         bukan reimplementasi kedua rumus preset itu di sini -- mirip pola
         `_py_density_spectral_midgray` di `bake_web_assets.py`.

    OFX-sourced, TIDAK diverifikasi di sini, dengan alasan tertulis
    (lihat EXEMPT_FIELDS di bawah):
      - inputToSrgb, scanToOutputRgb: fungsi murni dari NAMA illuminant
        lewat colour-science (bukan data JSON per-stock), sudah diaudit
        untuk pola CAT02-vs-CAT16 yang SAMA (task-11-report.md, lihat
        docstring `_input_to_reference_xyz_matrices_cat16` di
        `bake_web_assets.py`) dan ditemukan SEPAKAT. Tidak diulang di sini
        karena butuh mereplikasi rantai `colour.RGB_to_RGB`/`XYZ_to_RGB`
        Python secara independen -- di luar anggaran skrip mekanis ini;
        dicatat sebagai audit manual yang MASIH berdiri, bukan diam-diam.
      - referenceIlluminantSpectrum, mallettBasisIlluminant, scanIlluminant:
        fungsi murni dari nama illuminant + CMF standar (`standard_illuminant`/
        `_mallett_basis_illuminant`), SAMA modul `generate_profile_curves`
        yang dipakai KEDUA sisi (OFX bake ATAU Python runtime memanggil
        colour-science yang sama) -- tidak ada DUA implementasi independen
        untuk didua-bandingkan.
      - mallettRawMidgrayGreen: skalar, sudah dibandingkan `compare_cpp.py`
        terhadap literal C++ OFX; tidak ada jalur Python-runtime independen
        yang murah untuk mengekstraknya (`_mallett_midgray_green` memanggil
        fungsi OFX, tidak ada rekan Python).

Sudah DIPERBAIKI (jadi TIDAK diverifikasi di sini lagi -- lihat
`bake_web_assets.py`): inputToReferenceXyz (CAT16, Task 11), densityCurves/
densityCurveLayers/densityCurveMinimum/densityCurveLayerMaxima (Python's own
JSON, Task 12). Keempatnya sudah Python-sourced, bukan OFX-sourced lagi --
tidak ada apa pun untuk didua-bandingkan.

Keluar 0 kalau semua cocok, 1 kalau ada satu saja drift yang tidak
terdeklarasi -- kontrak keluar-kode yang sama dengan `compare_cpp.py`.

Cara pakai:

    D:/Projects/upstream/.venv-ref/Scripts/python.exe \\
      spektra/tools/verify_profile_agreement.py

Butuh venv REFERENSI (`.venv-ref`), bukan `.venv-bake` -- pemeriksaan
halation/DIR-coupler memanggil `digest_params`/`init_params` sungguhan dari
paket `spektrafilm` (persis kebutuhan `bake_web_assets.py` sendiri, lihat
docstring impornya).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent

# Field `profile["data"]` yang genuinely OFX-sourced (tidak dipatch ke JSON
# Python oleh `bake_web_assets.py::pack_stock`) dan karena itu berhak
# dibandingkan langsung di sini. `density_curves`/`density_curves_layers`
# SENGAJA tidak di sini -- itu sudah Python-sourced (Task 12), membandingkan
# copy OFX-nya terhadap Python-nya akan SELALU "gagal" dengan cara yang
# sudah dijelaskan panjang di tempat lain, bukan drift baru.
CHECKED_RAW_DATA_KEYS = {
    "wavelengths",
    "log_sensitivity",
    "log_exposure",
    "channel_density",
    "base_density",
    "midscale_neutral_density",
    "hanatos2025_adaptation_surface_params",
    "hanatos2025_adaptation_window_params",
}

# `profile["info"]` diperiksa UTUH (bukan daftar allow-list per-key) --
# setiap key di sana memberi masukan ke SETIAP derivasi (halation,
# dir_couplers, illuminant, dll.), jadi tidak ada key "aman untuk
# diabaikan" seperti pada `data` (yang beberapa key murni informatif).

# OFX-sourced tapi TIDAK diverifikasi di sini -- lihat blok komentar modul
# untuk alasan tertulis masing-masing. Dicatat eksplisit (bukan absen tanpa
# penjelasan) supaya siapa pun yang membaca skrip ini tahu cakupannya PERSIS,
# bukan menebak dari apa yang tidak disebut.
EXEMPT_FIELDS = {
    "inputToSrgb",
    "scanToOutputRgb",
    "referenceIlluminantSpectrum",
    "mallettBasisIlluminant",
    "scanIlluminant",
    "mallettRawMidgrayGreen",
}


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str]] = []
        self.all_ok = True

    def ok(self, label: str) -> None:
        self.rows.append((label, "PASS"))

    def fail(self, label: str, detail: str) -> None:
        self.rows.append((label, f"FAIL({detail})"))
        self.all_ok = False

    def print_report(self) -> None:
        print()
        print(f"{'check':<70} status")
        print("-" * 90)
        for label, status in self.rows:
            print(f"{label:<70} {status}")
        print()
        print(f"{len(self.rows)} checks: {'ALL PASS' if self.all_ok else 'SOME FAILED'}")


def _load_ofx_profile(gpc, stock_id: str) -> dict:
    return gpc._load_profile(stock_id)  # noqa: SLF001


def _load_py_profile(py_root: Path, stock_id: str) -> dict:
    path = py_root / "src" / "spektrafilm" / "data" / "profiles" / f"{stock_id}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def check_raw_json_agreement(report: Report, gpc, stocks, py_root: Path) -> None:
    """Kategori 1 (lihat docstring modul): field JSON mentah, karakter demi
    karakter, untuk ke-28 stock. Ini menjadikan klaim "field lain sudah
    dikonfirmasi byte-identik" (`bake_web_assets.py::_py_density_curve_data`
    docstring) sesuatu yang skrip ini BUKTIKAN ULANG setiap dipanggil, bukan
    sesuatu yang harus dipercaya dari prosa.
    """
    for stock_id in list(stocks.FILMS) + list(stocks.PAPERS):
        ofx_profile = _load_ofx_profile(gpc, stock_id)
        py_profile = _load_py_profile(py_root, stock_id)

        for key in CHECKED_RAW_DATA_KEYS:
            label = f"{stock_id}.data.{key} (OFX JSON vs Python JSON)"
            if key not in ofx_profile["data"]:
                # Tidak semua stock punya semua key (mis. bandpass hanya
                # film) -- absen di KEDUA sisi bukan drift.
                if key in py_profile.get("data", {}):
                    report.fail(label, "hilang di OFX, ADA di Python")
                continue
            ov = ofx_profile["data"][key]
            pv = py_profile["data"].get(key)
            if ov != pv:
                report.fail(label, "nilai berbeda -- lihat stdout skrip ini untuk detail")
                print(f"    {stock_id}.data.{key}: OFX={ov!r} != PY={pv!r}", file=sys.stderr)
            else:
                report.ok(label)

        label_info = f"{stock_id}.info (OFX JSON vs Python JSON, seluruh dict)"
        if ofx_profile["info"] != py_profile["info"]:
            diffs = {
                k: (ofx_profile["info"].get(k), py_profile["info"].get(k))
                for k in set(ofx_profile["info"]) | set(py_profile["info"])
                if ofx_profile["info"].get(k) != py_profile["info"].get(k)
            }
            report.fail(label_info, f"key berbeda: {sorted(diffs)}")
            print(f"    {stock_id}.info diffs: {diffs}", file=sys.stderr)
        else:
            report.ok(label_info)


def check_halation_preset_agreement(report: Report, gpc, stocks, digest_params, init_params) -> None:
    """Kategori 2a: `halationStrength`/`halationFirstSigmaUm`. OFX
    (`_halation_preset`, tabel `HALATION_PRESETS`) vs Python (RUNTIME
    sungguhan -- `digest_params(init_params(film_profile=stock))`, BUKAN
    reimplementasi `_HALATION_PRESETS` Python di sini, yang akan mengulang
    "dua tabel yang bisa drift diam-diam" persis masalah yang sedang
    diperiksa).

    Hanya 20 stock FILM -- `_apply_halation_preset` Python `return` lebih
    awal untuk stock yang bukan film (`if not params.film.is_film: return`),
    jadi tidak ada nilai runtime Python untuk dibandingkan pada 8 stock
    PAPER. `bake_web_assets.py` tetap membake `halationStrength`/
    `halationFirstSigmaUm` untuk paper (lewat `_halation_preset(info)` OFX
    apa adanya) -- itu bukan diverifikasi di sini, sama seperti
    `densitySpectralMidgray`'s null-untuk-paper documented di
    `bake_web_assets.py`.
    """
    for stock_id in stocks.FILMS:
        ofx_profile = _load_ofx_profile(gpc, stock_id)
        ofx_preset = gpc._halation_preset(ofx_profile["info"])  # noqa: SLF001
        ofx_strength = tuple(float(v) for v in ofx_preset["strength"])
        ofx_sigma = tuple(float(v) for v in ofx_preset["sigma_h"])

        params = digest_params(init_params(film_profile=stock_id))
        py_strength = tuple(float(v) for v in params.film_render.halation.halation_strength)
        py_sigma = tuple(float(v) for v in params.film_render.halation.halation_first_sigma_um)

        label = f"{stock_id}.halationStrength/halationFirstSigmaUm (OFX preset vs Python runtime)"
        if ofx_strength != py_strength or ofx_sigma != py_sigma:
            report.fail(label, f"OFX strength={ofx_strength} sigma={ofx_sigma} != PY strength={py_strength} sigma={py_sigma}")
        else:
            report.ok(label)


def check_dir_coupler_agreement(report: Report, gpc, stocks, digest_params, init_params) -> None:
    """Kategori 2b: dirGammaSameLayerRgb/RToGb/GToRb/BToRg. OFX
    (`_dir_coupler_defaults`) vs Python (RUNTIME sungguhan, `params.
    film_render.dir_couplers.*` setelah `_apply_film_specifics`, yang
    mencakup DUA lapis: cabang is_positive/is_negative DAN override
    per-stock untuk fujifilm_velvia_100/fujifilm_provia_100f).

    Hanya 20 stock FILM -- DIR couplers adalah kimia PENGEMBANGAN FILM,
    tidak berlaku untuk kertas/print; `_dir_coupler_defaults` OFX tetap
    dipanggil untuk 8 stock PAPER (lewat cabang else `info["type"] !=
    "positive"`, TIDAK bermakna untuk paper) -- tidak diverifikasi di sini
    dengan alasan yang SAMA seperti halation di atas.
    """
    for stock_id in stocks.FILMS:
        ofx_profile = _load_ofx_profile(gpc, stock_id)
        ofx = gpc._dir_coupler_defaults(ofx_profile["info"])  # noqa: SLF001

        params = digest_params(init_params(film_profile=stock_id))
        dc = params.film_render.dir_couplers
        py = {
            "same_layer_rgb": tuple(float(v) for v in dc.gamma_samelayer_rgb),
            "r_to_gb": tuple(float(v) for v in dc.gamma_interlayer_r_to_gb),
            "g_to_rb": tuple(float(v) for v in dc.gamma_interlayer_g_to_rb),
            "b_to_rg": tuple(float(v) for v in dc.gamma_interlayer_b_to_rg),
        }
        for key in ofx:
            ov = tuple(float(v) for v in ofx[key])
            pv = py[key]
            label = f"{stock_id}.dirGamma[{key}] (OFX defaults vs Python runtime)"
            if ov != pv:
                report.fail(label, f"OFX={ov} != PY={pv}")
            else:
                report.ok(label)


def main() -> int:
    if "SPEKTRAFILM_OFX" not in os.environ:
        print("SPEKTRAFILM_OFX is not set.", file=sys.stderr)
        return 2
    if "SPEKTRAFILM_PY" not in os.environ:
        print("SPEKTRAFILM_PY is not set.", file=sys.stderr)
        return 2

    ofx_root = Path(os.environ["SPEKTRAFILM_OFX"])
    py_root = Path(os.environ["SPEKTRAFILM_PY"])

    sys.path.insert(0, str(ofx_root / "tools"))
    import generate_profile_curves as gpc  # noqa: E402
    import ofx_stock_lists as stocks  # noqa: E402

    try:
        from spektrafilm.runtime.params_builder import digest_params, init_params
    except ImportError as exc:
        print(
            "Butuh paket 'spektrafilm' terpasang (venv referensi, mis. .venv-ref) -- "
            f"pemeriksaan halation/DIR-coupler memanggil runtime sungguhan. ImportError: {exc}",
            file=sys.stderr,
        )
        return 2

    report = Report()
    check_raw_json_agreement(report, gpc, stocks, py_root)
    check_halation_preset_agreement(report, gpc, stocks, digest_params, init_params)
    check_dir_coupler_agreement(report, gpc, stocks, digest_params, init_params)
    report.print_report()
    return 0 if report.all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
