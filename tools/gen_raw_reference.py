"""Oracle decode RAW untuk DICHROIC Fase 2B.

Membuat DNG sintetis (mosaik Bayer RGGB 16-bit tak terkompresi, ColorMatrix1
D65, AsShotNeutral) -- bebas lisensi, kecil, dan dibaca LibRaw persis seperti
RAW kamera -- lalu mendecodenya dengan rawpy memakai setelan hulu
`spektrafilm/utils/raw_file_processor.py::_postprocess_params('as_shot')`:

    output_color=ACES, output_bps=16, no_auto_bright=True, gamma=(1, 1),
    use_camera_wb=True, dibagi 65535.

Dua kasus: tanpa tag Orientation dan dengan Orientation 6 (putar 90°), untuk
mengunci bahwa orientasi berkas dipakai seperti rawpy.

Keluaran (`test/fixtures/raw/<case>/`): `input.dng`, `output.f32` (RGB f32
ACES2065-1 linear, seperti hulu), `case.json`.

    D:/Projects/upstream/.venv-ref/Scripts/python tools/gen_raw_reference.py --out test/fixtures --manifest
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

import numpy as np
import rawpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixture_manifest import _write_json_lf, _write_manifest  # noqa: E402

WIDTH, HEIGHT = 96, 64
BLACK, WHITE = 512, 16383


def _scene(width: int, height: int) -> np.ndarray:
    """Adegan linear RGB: gradien, patch jenuh, tepi tajam, dan sorotan."""
    y, x = np.mgrid[0:height, 0:width].astype(np.float64)
    r = 0.05 + 0.8 * x / width
    g = 0.05 + 0.8 * y / height
    b = 0.3 + 0.3 * np.sin(x / 7.0) * np.cos(y / 5.0)
    img = np.stack([r, g, b], axis=-1)
    img[8:24, 8:24] = [0.9, 0.1, 0.1]
    img[8:24, 30:46] = [0.1, 0.8, 0.2]
    img[40:56, 60:90] = [0.95, 0.95, 0.95]
    img[:, 48:50] = 0.02
    return np.clip(img, 0.0, 1.0)


def _mosaic(scene: np.ndarray) -> np.ndarray:
    """RGGB: (0,0)=R, (0,1)=G, (1,0)=G, (1,1)=B; skala ke [BLACK, WHITE]."""
    h, w, _ = scene.shape
    cfa = np.empty((h, w), dtype=np.float64)
    cfa[0::2, 0::2] = scene[0::2, 0::2, 0]
    cfa[0::2, 1::2] = scene[0::2, 1::2, 1]
    cfa[1::2, 0::2] = scene[1::2, 0::2, 1]
    cfa[1::2, 1::2] = scene[1::2, 1::2, 2]
    # White balance "kamera": kanal R dan B lebih redup, dikoreksi AsShotNeutral.
    cfa[0::2, 0::2] *= 0.55
    cfa[1::2, 1::2] *= 0.70
    return np.round(BLACK + cfa * (WHITE - BLACK) * 0.9).astype("<u2")


def _write_dng(path: Path, raw: np.ndarray, orientation: int | None = None) -> None:
    h, w = raw.shape
    data = raw.tobytes()
    # (tag, type, values). Type: 1 BYTE, 2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL, 10 SRATIONAL.
    color_matrix = [  # XYZ(D65) -> camera, cukup realistis untuk matriks kamera
        (8000, 10000), (-2000, 10000), (-800, 10000),
        (-3500, 10000), (11500, 10000), (2200, 10000),
        (-500, 10000), (1500, 10000), (6000, 10000),
    ]
    entries = [
        (254, 4, [0]),                      # NewSubFileType
        (256, 4, [w]),                      # ImageWidth
        (257, 4, [h]),                      # ImageLength
        (258, 3, [16]),                     # BitsPerSample
        (259, 3, [1]),                      # Compression: none
        (262, 3, [32803]),                  # PhotometricInterpretation: CFA
        (271, 2, b"DICHROIC\0"),            # Make
        (272, 2, b"Synthetic Bayer\0"),     # Model
        (273, 4, [0]),                      # StripOffsets (diisi di bawah)
        (277, 3, [1]),                      # SamplesPerPixel
        (278, 4, [h]),                      # RowsPerStrip
        (279, 4, [len(data)]),              # StripByteCounts
        (284, 3, [1]),                      # PlanarConfiguration
        (33421, 3, [2, 2]),                 # CFARepeatPatternDim
        (33422, 1, [0, 1, 1, 2]),           # CFAPattern RGGB
        (50706, 1, [1, 4, 0, 0]),           # DNGVersion
        (50707, 1, [1, 1, 0, 0]),           # DNGBackwardVersion
        (50708, 2, b"DICHROIC Synthetic Bayer\0"),  # UniqueCameraModel
        (50714, 3, [BLACK]),                # BlackLevel
        (50717, 3, [WHITE]),                # WhiteLevel
        (50721, 10, color_matrix),          # ColorMatrix1
        (50728, 5, [(55, 100), (1, 1), (70, 100)]),  # AsShotNeutral
        (50778, 3, [21]),                   # CalibrationIlluminant1 = D65
    ]
    if orientation is not None:
        entries.append((274, 3, [orientation]))  # Orientation (EXIF/TIFF)
    entries.sort(key=lambda e: e[0])
    sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8}

    ifd_offset = 8
    ifd_size = 2 + 12 * len(entries) + 4
    extra_offset = ifd_offset + ifd_size
    extra = bytearray()
    ifd = bytearray(struct.pack("<H", len(entries)))
    strip_entry_index = None
    for i, (tag, typ, vals) in enumerate(entries):
        if typ == 2:
            payload = bytes(vals)
            count = len(payload)
        elif typ in (5, 10):
            fmt = "<ii" if typ == 10 else "<II"
            payload = b"".join(struct.pack(fmt, n, d) for n, d in vals)
            count = len(vals)
        else:
            fmt = {1: "<B", 3: "<H", 4: "<I"}[typ]
            payload = b"".join(struct.pack(fmt, v) for v in vals)
            count = len(vals)
        if tag == 273:
            strip_entry_index = i
        if len(payload) <= 4:
            value = payload.ljust(4, b"\0")
        else:
            value = struct.pack("<I", extra_offset + len(extra))
            extra += payload
            if len(extra) % 2:
                extra += b"\0"
        ifd += struct.pack("<HHI", tag, typ, count) + value
    ifd += struct.pack("<I", 0)
    data_offset = extra_offset + len(extra)
    # Tulis ulang StripOffsets dengan offset data yang sebenarnya.
    pos = 2 + 12 * strip_entry_index + 8
    ifd[pos:pos + 4] = struct.pack("<I", data_offset)
    path.write_bytes(b"II*\0" + struct.pack("<I", ifd_offset) + bytes(ifd) + bytes(extra) + data)
    assert len(bytes(ifd)) == ifd_size


# Kasus: nama -> Orientation TIFF (None = tag tidak ditulis). 6 = putar 90°
# searah jarum jam; rawpy (user_flip bawaan) dan LibRaw sama-sama memakainya.
CASES = {"synthetic_rggb": None, "synthetic_rggb_rot90": 6}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--manifest", action="store_true")
    args = parser.parse_args()

    for name, orientation in CASES.items():
        case_dir = args.out / "raw" / name
        case_dir.mkdir(parents=True, exist_ok=True)
        dng = case_dir / "input.dng"
        _write_dng(dng, _mosaic(_scene(WIDTH, HEIGHT)), orientation)

        with rawpy.imread(str(dng)) as raw:
            rgb = raw.postprocess(
                output_color=rawpy.ColorSpace.ACES,
                output_bps=16,
                no_auto_bright=True,
                gamma=(1, 1),
                use_camera_wb=True,
            ).astype(np.float32) / np.float32(65535.0)
            libraw_version = rawpy.libraw_version

        (case_dir / "output.f32").write_bytes(np.ascontiguousarray(rgb, dtype="<f4").tobytes())
        meta = {
            "name": name,
            "width": int(rgb.shape[1]),
            "height": int(rgb.shape[0]),
            "libraw": ".".join(str(v) for v in libraw_version),
            "rawpy": rawpy.__version__,
            "settings": "output_color=ACES, output_bps=16, no_auto_bright=True, gamma=(1,1), use_camera_wb=True",
        }
        if orientation is not None:
            meta["orientation"] = orientation
        _write_json_lf(case_dir / "case.json", meta)
        print(f"Wrote {case_dir} ({rgb.shape[1]}x{rgb.shape[0]}, LibRaw {libraw_version})")
    if args.manifest:
        _write_manifest(args.out)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
