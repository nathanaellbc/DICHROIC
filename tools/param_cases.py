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
}
