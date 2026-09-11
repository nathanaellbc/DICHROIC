#!/usr/bin/env python3
"""Prove both upstream toolchains run. Exit 0 on success.

Adapted from the task-1 brief's assumed API. The real upstream API differs
from the brief's assumption in two ways (see tools/README.md for details):

1. ``init_params()`` returns a params object that must be passed through
   ``digest_params()`` before it is valid to use in the runtime pipeline
   (this is documented in ``params_builder.py``'s docstrings).
2. ``SimulationPipeline`` has no ``.run()`` method. The run entry point is
   ``SimulationPipeline(params).process(image, collect=...)``.
"""
import sys
import numpy as np

from spektrafilm.runtime.params_builder import init_params, digest_params
from spektrafilm.runtime.pipeline import SimulationPipeline
from spektrafilm.runtime.topology import Tap

EXPECTED_TAPS = (
    "rgb_in", "rgb_pre", "log_e_film", "cmy_film",
    "log_e_print", "cmy_print", "rgb_out",
)


def main() -> int:
    actual = tuple(
        getattr(Tap, name)
        for name in dir(Tap)
        if name.isupper() and not name.startswith("_")
    )
    missing = set(EXPECTED_TAPS) - set(actual)
    if missing:
        print(f"FAIL: tap hilang dari referensi hulu: {sorted(missing)}")
        return 1

    ramp = np.repeat(
        np.linspace(0.01, 1.0, 32, dtype=np.float64)[None, :, None], 16, axis=0
    ).repeat(3, axis=2)

    params = digest_params(init_params())
    out = SimulationPipeline(params).process(ramp, collect=Tap.CMY_FILM)

    if out.shape[:2] != ramp.shape[:2]:
        print(f"FAIL: bentuk keluaran {out.shape} tidak cocok dengan input {ramp.shape}")
        return 1
    if not np.all(np.isfinite(out)):
        print("FAIL: keluaran memuat nilai tak hingga")
        return 1

    print(f"OK: cmy_film shape={out.shape} min={out.min():.6f} max={out.max():.6f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
