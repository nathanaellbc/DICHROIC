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
}
