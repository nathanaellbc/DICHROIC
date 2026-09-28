"""Tabel kasus keluarga fixture `param/` (Fase 2C).

Setiap kasus menggerbangi satu atau beberapa field `RenderParams` pada nilai
non-default. `case.json` yang ditulis `gen_reference.py --param-case` mencatat
KEDUA sisi pemetaan:

- `renderParams`: patch `RenderParams` (nama OFX) yang dibaca test TS dan
  diteruskan ke `buildRenderPlan` -- jalur produksi `Session`;
- `pythonOverrides`: teks override Python yang menjadi padanannya, untuk
  dibaca manusia. Yang benar-benar dijalankan adalah fungsi `pre`/`post` di
  bawah.

`pre` dipanggil pada params mentah SEBELUM `digest_params` (setelan
pengguna; `lut_mode` dan saklar debug masih bisa menimpanya), `post` SESUDAH
(untuk field yang ditimpa `digest_params`, mis. filter netral dari
database).

Keluarga:
  deterministic  `debug.deactivate_stochastic_effects = True` (grain dan
                 glare mati) -- padanan `<case>`. Gerbang per piksel.
  stochastic     setelan default (grain dan glare hidup) -- padanan
                 `<case>_stochastic`. Gerbang statistik.
  lut            `debug.lut_mode = True` -- padanan `<case>_lut`.

Hanya stdlib + callable; tidak mengimpor spektrafilm, supaya tabel ini bisa
dibaca tanpa venv hulu.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

Override = Callable[[Any], None]


@dataclass(frozen=True)
class ParamCase:
    image: str
    family: str
    render_params: dict[str, Any] = field(default_factory=dict)
    python_overrides: tuple[str, ...] = ()
    pre: Override | None = None
    post: Override | None = None
    film: str = "kodak_portra_400"
    print_stock: str = "kodak_portra_endura"
    film_format_mm: float | None = None
    # Keluarga stochastic: jumlah realisasi Python yang momennya dicatat di
    # case.json (`pythonStats`), untuk gerbang statistik terhadap PUSAT
    # distribusi Python dengan ambang kelipatan sebarannya (spec §6.5.1).
    realizations: int = 0
    stat_taps: tuple[str, ...] = ("rgb_out",)
    stat_bins: int = 8
    # `grainAmount` OFX tidak punya padanan Python: oracle-nya `cmy_film`
    # grain-mati dan grain-hidup yang dicampur `base + (grained - base) *
    # amount` (`SpektraGrain.comp::applyGrainControls`), lalu tap hilir
    # dijalankan dengan `inject = cmy_film`.
    grain_amount: float | None = None


def film_push_pull_gamma(stops: float) -> float:
    """`SpektraVulkanRenderer.cpp::filmPushPullGamma` (OFX, mode Standard):
    rasio waktu develop ECN-2. Padanan Python-nya `density_curve_gamma`."""
    import math

    s = min(max(stops, -2.0), 2.0)
    if s < 0:
        return (150.0 / 180.0) ** -s
    if s <= 1:
        return math.exp(math.log(220.0 / 180.0) * s)
    return math.exp(math.log(220.0 / 180.0) + math.log(280.0 / 220.0) * (s - 1.0))


def _push_pull(stops: float) -> Override:
    return lambda p: setattr(p.film_render, "density_curve_gamma", film_push_pull_gamma(stops))


PARAM_CASES: dict[str, ParamCase] = {
    # Task 1: kasus kendali harness. Patch kosong; keluarannya harus
    # bit-identik dengan fixture lama yang setara (`gray_ramp`,
    # `gray_ramp_lut`, `hard_edge_px6um`), yang membuktikan generator dan
    # jalur `buildRenderPlan` di test sama-sama tidak menggeser apa pun.
    "baseline_gray_ramp": ParamCase(image="gray_ramp", family="deterministic"),
    "baseline_gray_ramp_lut": ParamCase(image="gray_ramp", family="lut"),
    "baseline_hard_edge_px6um": ParamCase(
        image="hard_edge", family="deterministic", render_params={}, film_format_mm=0.4,
    ),
    # Task 2: exposure. `filmExposureEv` -> `camera.exposure_compensation_ev`
    # (menyeret midgray `_comp` print, `print_exposure_compensation=True`
    # default); `autoExposure` -> `camera.auto_exposure`; `printExposureEv`
    # -> `enlarger.print_exposure = 2**ev`.
    "exposure_film_plus2": ParamCase(
        image="color_patches", family="deterministic",
        render_params={"filmExposureEv": 2.0},
        python_overrides=("camera.exposure_compensation_ev = 2.0",),
        pre=lambda p: setattr(p.camera, "exposure_compensation_ev", 2.0),
    ),
    "exposure_film_minus1_5": ParamCase(
        image="gray_ramp", family="deterministic",
        render_params={"filmExposureEv": -1.5},
        python_overrides=("camera.exposure_compensation_ev = -1.5",),
        pre=lambda p: setattr(p.camera, "exposure_compensation_ev", -1.5),
    ),
    "exposure_auto_off": ParamCase(
        image="gray_ramp", family="deterministic",
        render_params={"autoExposure": False},
        python_overrides=("camera.auto_exposure = False",),
        pre=lambda p: setattr(p.camera, "auto_exposure", False),
    ),
    "exposure_auto_off_film_plus1": ParamCase(
        image="log_gray_ramp", family="deterministic",
        render_params={"autoExposure": False, "filmExposureEv": 1.0},
        python_overrides=("camera.auto_exposure = False", "camera.exposure_compensation_ev = 1.0"),
        pre=lambda p: (setattr(p.camera, "auto_exposure", False), setattr(p.camera, "exposure_compensation_ev", 1.0)),
    ),
    "exposure_print_minus1": ParamCase(
        image="color_patches", family="deterministic",
        render_params={"printExposureEv": -1.0},
        python_overrides=("enlarger.print_exposure = 2**-1.0",),
        pre=lambda p: setattr(p.enlarger, "print_exposure", 2 ** -1.0),
    ),
    "exposure_print_plus0_7": ParamCase(
        image="gray_ramp", family="deterministic",
        render_params={"printExposureEv": 0.7},
        python_overrides=("enlarger.print_exposure = 2**0.7",),
        pre=lambda p: setattr(p.enlarger, "print_exposure", 2 ** 0.7),
    ),
    # `lut_mode` memaksa exposure_compensation_ev=0 dan print_exposure=1: kubus
    # mengabaikan kedua EV (header `.cube` mencatatnya).
    "exposure_lut_ignored": ParamCase(
        image="color_patches", family="lut",
        render_params={"filmExposureEv": 2.0, "printExposureEv": 1.0},
        python_overrides=("camera.exposure_compensation_ev = 2.0", "enlarger.print_exposure = 2**1.0",
                          "(lut_mode menimpa keduanya)"),
        pre=lambda p: (setattr(p.camera, "exposure_compensation_ev", 2.0), setattr(p.enlarger, "print_exposure", 2.0)),
    ),
    # Task 3: filter enlarger. M/Y -> `*_filter_shift`; `filterC` OFX
    # (`neutral[c] + cFilter`) -> `c_filter_neutral += filterC` SETELAH
    # digest (digest menimpa netral dari database).
    "enlarger_m_plus20_y_minus10": ParamCase(
        image="gray_ramp", family="deterministic",
        render_params={"filterMShift": 20.0, "filterYShift": -10.0},
        python_overrides=("enlarger.m_filter_shift = 20.0", "enlarger.y_filter_shift = -10.0"),
        pre=lambda p: (setattr(p.enlarger, "m_filter_shift", 20.0), setattr(p.enlarger, "y_filter_shift", -10.0)),
    ),
    "enlarger_c15": ParamCase(
        image="color_patches", family="deterministic",
        render_params={"filterC": 15.0},
        python_overrides=("enlarger.c_filter_neutral += 15.0 (setelah digest_params)",),
        post=lambda p: setattr(p.enlarger, "c_filter_neutral", p.enlarger.c_filter_neutral + 15.0),
    ),
    # netral M ~51.6: shift -58 memberi cc negatif. Python tidak meng-clamp
    # (OFX meng-clamp di 0); gerbang ini mengunci perilaku Python.
    "enlarger_m_minus58_lut": ParamCase(
        image="color_patches", family="lut",
        render_params={"filterMShift": -58.0},
        python_overrides=("enlarger.m_filter_shift = -58.0",),
        pre=lambda p: setattr(p.enlarger, "m_filter_shift", -58.0),
    ),
    "enlarger_y_plus40_c30_lut": ParamCase(
        image="log_gray_ramp", family="lut",
        render_params={"filterYShift": 40.0, "filterC": 30.0},
        python_overrides=("enlarger.y_filter_shift = 40.0", "enlarger.c_filter_neutral += 30.0 (setelah digest_params)"),
        pre=lambda p: setattr(p.enlarger, "y_filter_shift", 40.0),
        post=lambda p: setattr(p.enlarger, "c_filter_neutral", p.enlarger.c_filter_neutral + 30.0),
    ),
    # Task 4: push/pull `Standard` -> `film_render.density_curve_gamma =
    # film_push_pull_gamma(stops)` (kurva film, DIR, midgray print).
    "pushpull_minus1": ParamCase(
        image="log_gray_ramp", family="deterministic",
        render_params={"filmPushPullStops": -1.0},
        python_overrides=("film_render.density_curve_gamma = film_push_pull_gamma(-1.0)",),
        pre=_push_pull(-1.0),
    ),
    "pushpull_plus0_5": ParamCase(
        image="color_patches", family="deterministic",
        render_params={"filmPushPullStops": 0.5},
        python_overrides=("film_render.density_curve_gamma = film_push_pull_gamma(0.5)",),
        pre=_push_pull(0.5),
    ),
    "pushpull_plus2": ParamCase(
        image="gray_ramp", family="deterministic",
        render_params={"filmPushPullStops": 2.0},
        python_overrides=("film_render.density_curve_gamma = film_push_pull_gamma(2.0)",),
        pre=_push_pull(2.0),
    ),
    "pushpull_plus1_5_lut": ParamCase(
        image="color_patches", family="lut",
        render_params={"filmPushPullStops": 1.5},
        python_overrides=("film_render.density_curve_gamma = film_push_pull_gamma(1.5)",),
        pre=_push_pull(1.5),
    ),
    # push/pull bersama EV kompensasi: midgray print `_comp` memakai gamma yang sama.
    "pushpull_minus2_film_plus1": ParamCase(
        image="log_gray_ramp", family="deterministic",
        render_params={"filmPushPullStops": -2.0, "filmExposureEv": 1.0},
        python_overrides=("film_render.density_curve_gamma = film_push_pull_gamma(-2.0)",
                          "camera.exposure_compensation_ev = 1.0"),
        pre=lambda p: (_push_pull(-2.0)(p), setattr(p.camera, "exposure_compensation_ev", 1.0)),
    ),
    # Task 5: halation. `halationAmount` -> `halation.halation_amount`
    # (mengalikan a_tot); `halationEnabled` -> `halation.active`. Rezim FIR
    # (35 mm/64 px, ~550 um/px) dan IIR (px6um, 6.25 um/px) sama-sama diuji.
    "halation_amount2_5": ParamCase(
        image="impulse_highlight", family="deterministic",
        render_params={"halationAmount": 2.5},
        python_overrides=("film_render.halation.halation_amount = 2.5",),
        pre=lambda p: setattr(p.film_render.halation, "halation_amount", 2.5),
    ),
    "halation_amount0_4_px6um": ParamCase(
        image="impulse_highlight", family="deterministic",
        render_params={"halationAmount": 0.4}, film_format_mm=0.4,
        python_overrides=("film_render.halation.halation_amount = 0.4", "camera.film_format_mm = 0.4"),
        pre=lambda p: setattr(p.film_render.halation, "halation_amount", 0.4),
    ),
    "halation_amount0_px6um": ParamCase(
        image="hard_edge", family="deterministic",
        render_params={"halationAmount": 0.0}, film_format_mm=0.4,
        python_overrides=("film_render.halation.halation_amount = 0.0", "camera.film_format_mm = 0.4"),
        pre=lambda p: setattr(p.film_render.halation, "halation_amount", 0.0),
    ),
    "halation_off": ParamCase(
        image="impulse_highlight", family="deterministic",
        render_params={"halationEnabled": False},
        python_overrides=("film_render.halation.active = False",),
        pre=lambda p: setattr(p.film_render.halation, "active", False),
    ),
    "halation_off_px6um": ParamCase(
        image="hard_edge", family="deterministic",
        render_params={"halationEnabled": False}, film_format_mm=0.4,
        python_overrides=("film_render.halation.active = False", "camera.film_format_mm = 0.4"),
        pre=lambda p: setattr(p.film_render.halation, "active", False),
    ),
    # Task 6: unsharp scanner. `scannerUnsharpAmount` -> `scanner.unsharp_mask
    # = (0.7, amount)`; amount 0 dilewati Python (`sigma > 0 and amount > 0`).
    "unsharp_amount0": ParamCase(
        image="hard_edge", family="deterministic",
        render_params={"scannerUnsharpAmount": 0.0},
        python_overrides=("scanner.unsharp_mask = (0.7, 0.0)",),
        pre=lambda p: setattr(p.scanner, "unsharp_mask", (0.7, 0.0)),
    ),
    "unsharp_amount1_5": ParamCase(
        image="hard_edge", family="deterministic",
        render_params={"scannerUnsharpAmount": 1.5},
        python_overrides=("scanner.unsharp_mask = (0.7, 1.5)",),
        pre=lambda p: setattr(p.scanner, "unsharp_mask", (0.7, 1.5)),
    ),
    # Amount besar memperkuat derau f32: galat maks rgb_out pada color_patches
    # naik linear ~2.9e-6 per unit amount (8.3e-7 di 0 -> 8.3e-6 di 2.5 ->
    # 1.14e-5 di 3.5, diukur 2026-09-28). Gerbang 1e-5 di 2.5; 3.5 dicatat
    # sebagai temuan, ambang tidak dilonggarkan.
    # Task 6b: glare. `glarePercent` -> `print_render.glare.percent` (mean
    # lognormal); percent 0 dilewati `add_glare`. Kombinasi grain x glare
    # diuji terpisah di citra datar, dengan momen 16 realisasi Python.
    "glare_only_flat": ParamCase(
        image="flat_patch", family="stochastic",
        render_params={"grainEnabled": False, "glareEnabled": True},
        python_overrides=("film_render.grain.active = False",),
        pre=lambda p: setattr(p.film_render.grain, "active", False),
        realizations=16,
    ),
    "glare_only_p0_15_flat": ParamCase(
        image="flat_patch", family="stochastic",
        render_params={"grainEnabled": False, "glareEnabled": True, "glarePercent": 0.15},
        python_overrides=("film_render.grain.active = False", "print_render.glare.percent = 0.15"),
        pre=lambda p: (setattr(p.film_render.grain, "active", False), setattr(p.print_render.glare, "percent", 0.15)),
        realizations=16,
    ),
    "grain_glare_p0_1_flat": ParamCase(
        image="flat_patch", family="stochastic",
        render_params={"glarePercent": 0.1},
        python_overrides=("print_render.glare.percent = 0.1",),
        pre=lambda p: setattr(p.print_render.glare, "percent", 0.1),
        realizations=16,
    ),
    "grain_only_flat": ParamCase(
        image="flat_patch", family="stochastic",
        render_params={"glarePercent": 0.0},
        python_overrides=("print_render.glare.percent = 0.0",),
        pre=lambda p: setattr(p.print_render.glare, "percent", 0.0),
        realizations=16,
    ),
    "grain_glare_default_flat": ParamCase(
        image="flat_patch", family="stochastic",
        realizations=16,
    ),
    # Task 7: grain. `grainAmount` lewat oracle campuran (lih. `grain_amount`),
    # glare dimatikan (percent 0) supaya momen murni grain. `grainSeed`: Python
    # memakai seed tetap, jadi oracle-nya sama dengan grain_only_flat -- yang
    # diuji adalah realisasi engine berbeda dengan statistik yang sama.
    "grain_amount0_5_flat": ParamCase(
        image="flat_patch", family="stochastic",
        render_params={"grainAmount": 0.5, "glarePercent": 0.0},
        python_overrides=("print_render.glare.percent = 0.0",),
        pre=lambda p: setattr(p.print_render.glare, "percent", 0.0),
        realizations=4, stat_taps=("cmy_film", "rgb_out"), grain_amount=0.5,
    ),
    "grain_amount1_8_flat": ParamCase(
        image="flat_patch", family="stochastic",
        render_params={"grainAmount": 1.8, "glarePercent": 0.0},
        python_overrides=("print_render.glare.percent = 0.0",),
        pre=lambda p: setattr(p.print_render.glare, "percent", 0.0),
        realizations=4, stat_taps=("cmy_film", "rgb_out"), grain_amount=1.8,
    ),
    "grain_amount0_flat": ParamCase(
        image="flat_patch", family="stochastic",
        render_params={"grainAmount": 0.0, "glarePercent": 0.0},
        python_overrides=("print_render.glare.percent = 0.0",),
        pre=lambda p: setattr(p.print_render.glare, "percent", 0.0),
        realizations=4, stat_taps=("cmy_film", "rgb_out"), grain_amount=0.0,
    ),
    "grain_seed42_flat": ParamCase(
        image="flat_patch", family="stochastic",
        render_params={"grainSeed": 42, "glarePercent": 0.0},
        python_overrides=("print_render.glare.percent = 0.0", "(Python: seed grain tetap, tanpa padanan grainSeed)"),
        pre=lambda p: setattr(p.print_render.glare, "percent", 0.0),
        realizations=4, stat_taps=("cmy_film", "rgb_out"),
    ),
    # `filmFormat` -> `camera.film_format_mm` (sisi panjang OFX,
    # `FILM_FORMAT_LONG_EDGE_MM`): ukuran piksel menggeser halation/DIR.
    "format_super8": ParamCase(
        image="impulse_highlight", family="deterministic",
        render_params={"filmFormat": "super8"},
        python_overrides=("camera.film_format_mm = 5.79",),
        pre=lambda p: setattr(p.camera, "film_format_mm", 5.79),
    ),
    "format_standard16": ParamCase(
        image="hard_edge", family="deterministic",
        render_params={"filmFormat": "standard16"},
        python_overrides=("camera.film_format_mm = 10.26",),
        pre=lambda p: setattr(p.camera, "film_format_mm", 10.26),
    ),
    "format_imax70": ParamCase(
        image="impulse_highlight", family="deterministic",
        render_params={"filmFormat": "imax70"},
        python_overrides=("camera.film_format_mm = 70.41",),
        pre=lambda p: setattr(p.camera, "film_format_mm", 70.41),
    ),
    "format_super16_grain_flat": ParamCase(
        image="flat_patch", family="stochastic",
        render_params={"filmFormat": "super16", "glarePercent": 0.0},
        python_overrides=("camera.film_format_mm = 12.52", "print_render.glare.percent = 0.0"),
        pre=lambda p: (setattr(p.camera, "film_format_mm", 12.52), setattr(p.print_render.glare, "percent", 0.0)),
        realizations=4, stat_taps=("cmy_film", "rgb_out"),
    ),
    # percent 0 tanpa grain: deterministik (glare dilewati) -- per piksel.
    "glare_p0_no_grain": ParamCase(
        image="color_patches", family="deterministic",
        render_params={"glareEnabled": True, "glarePercent": 0.0},
        python_overrides=("print_render.glare.percent = 0.0 (glare.active dimatikan keluarga deterministic;"
                          " add_glare melewati keduanya)",),
    ),
    "unsharp_amount2_5": ParamCase(
        image="color_patches", family="deterministic",
        render_params={"scannerUnsharpAmount": 2.5},
        python_overrides=("scanner.unsharp_mask = (0.7, 2.5)",),
        pre=lambda p: setattr(p.scanner, "unsharp_mask", (0.7, 2.5)),
    ),
}

# Task 8: stock. `film`/`paper` -> argumen `init_params(film, print)`; filter
# netral dari database Python per pasangan. Film negatif saja (reversal ikut
# batch 2). Daftar dari `manifest.neutralPrintFilters` (database Python).
NEGATIVE_FILMS = (
    "kodak_ektar_100", "kodak_portra_160", "kodak_portra_400", "kodak_portra_800",
    "kodak_portra_800_push1", "kodak_portra_800_push2", "kodak_gold_200", "kodak_ultramax_400",
    "kodak_vision3_50d", "kodak_vision3_250d", "kodak_verita_200d", "kodak_vision3_200t",
    "kodak_vision3_500t", "fujifilm_pro_400h", "fujifilm_c200", "fujifilm_xtra_400",
)
PAPERS = (
    "kodak_endura_premier", "kodak_ultra_endura", "kodak_ektacolor_edge", "kodak_supra_endura",
    "kodak_portra_endura", "fujifilm_crystal_archive_typeii", "kodak_2383", "kodak_2393",
)


def _stock_pairs():
    pairs = [(film, "kodak_portra_endura") for film in NEGATIVE_FILMS]
    pairs += [("kodak_portra_400", paper) for paper in PAPERS if paper != "kodak_portra_endura"]
    return pairs


for _film, _paper in _stock_pairs():
    _patch = {"film": _film, "paper": _paper}
    PARAM_CASES[f"stock_{_film}__{_paper}_lut"] = ParamCase(
        image="color_patches", family="lut", film=_film, print_stock=_paper,
        render_params=_patch, python_overrides=(f"init_params({_film!r}, {_paper!r})",),
    )
    PARAM_CASES[f"stock_{_film}__{_paper}"] = ParamCase(
        image="hard_edge", family="deterministic", film=_film, print_stock=_paper,
        render_params=_patch, python_overrides=(f"init_params({_film!r}, {_paper!r})",),
    )
