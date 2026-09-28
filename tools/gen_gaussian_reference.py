"""Oracle primitif Gaussian untuk DICHROIC Fase 2A.5.

Membangkitkan pasangan input/output untuk `fast_gaussian_filter` dan
`fast_exponential_filter` spektrafilm (utils/fast_gaussian_filter.py) pada
citra acak ber-seed, supaya modul WGSL `GaussianBlur` bisa diadu langsung
dengan primitif hulu -- terpisah dari tahap mana pun yang memakainya.

Pemakaian (dari root repo, .venv-ref):

    D:/Projects/upstream/.venv-ref/Scripts/python tools/gen_gaussian_reference.py \
        --out test/fixtures --manifest
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from spektrafilm.utils.fast_gaussian_filter import fast_exponential_filter, fast_gaussian_filter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixture_manifest import _write_json_lf, _write_manifest  # noqa: E402

# (nama, kind, sigma/decay per kanal, (tinggi, lebar), seed)
CASES = [
    ("zero", "gaussian", [0.0, 0.0, 0.0], (40, 64), 1),
    ("small", "gaussian", [0.3, 1.2, 2.9], (40, 64), 2),
    ("threshold", "gaussian", [3.0, 3.0, 3.0], (40, 64), 3),
    ("large", "gaussian", [5.0, 8.0, 13.0], (40, 64), 4),
    ("mixed", "gaussian", [2.5, 3.0, 20.0], (40, 64), 5),
    ("narrow", "gaussian", [2.0, 2.9, 4.0], (4, 5), 6),
    ("exponential", "exponential", [4.0, 10.0, 30.0], (40, 64), 7),
]
TRUNCATE = 3.0


def _generate(out: Path, name: str, kind: str, sigma: list[float], shape: tuple[int, int], seed: int) -> None:
    case_dir = out / "gaussian" / name
    case_dir.mkdir(parents=True, exist_ok=True)
    image = np.random.default_rng(seed).random((shape[0], shape[1], 3))
    if kind == "gaussian":
        if all(s == 0.0 for s in sigma):
            # fast_gaussian_filter dengan sigma 0 memanggil jalur FIR dengan
            # sigma <= 0 -> salinan. Dipanggil apa adanya supaya oracle tetap
            # keluaran hulu, bukan asumsi kita.
            result = np.stack(
                [fast_gaussian_filter(image[:, :, c], 0.0, truncate=TRUNCATE) for c in range(3)], axis=-1
            )
        else:
            result = fast_gaussian_filter(image, np.asarray(sigma, dtype=np.float64), truncate=TRUNCATE)
    else:
        result = fast_exponential_filter(image, np.asarray(sigma, dtype=np.float64), truncate=TRUNCATE)
    (case_dir / "input.f32").write_bytes(np.ascontiguousarray(image, dtype="<f4").tobytes())
    (case_dir / "output.f32").write_bytes(np.ascontiguousarray(result, dtype="<f4").tobytes())
    _write_json_lf(
        case_dir / "case.json",
        {"name": name, "kind": kind, "sigma": sigma, "truncate": TRUNCATE, "height": shape[0], "width": shape[1]},
    )
    print(f"Wrote {case_dir}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--manifest", action="store_true")
    args = parser.parse_args()
    for name, kind, sigma, shape, seed in CASES:
        _generate(args.out, name, kind, sigma, shape, seed)
    if args.manifest:
        _write_manifest(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
