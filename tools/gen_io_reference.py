"""Oracle decode io/ untuk DICHROIC Fase 2B.

Membangkitkan berkas gambar kecil dalam tiap format yang didukung `src/io/`,
lalu mendecodenya dengan pustaka rujukan:

- JPEG dan PNG 8-bit: Pillow (libjpeg-turbo / zlib);
- PNG 16-bit: OpenImageIO (libpng) -- Pillow tidak bisa menulis atau
  membaca PNG RGB 16-bit tanpa memotongnya ke 8-bit;
- TIFF: tifffile; EXR: OpenImageIO (ditambahkan Task 3-4 rencana 2B).

Keluaran (`test/fixtures/io/<case>/`): `input.<ext>`, `expected.f32` (RGB f32
little-endian, baris-mayor, integer dinormalisasi `v / (2^bits - 1)`,
grayscale disebar ke tiga kanal, alpha dibuang), `case.json`.

    .venv-ref/bin/python tools/gen_io_reference.py --out test/fixtures --manifest
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import OpenImageIO as oiio
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixture_manifest import _write_json_lf, _write_manifest  # noqa: E402

# Ganjil di kedua sumbu supaya tepi blok JPEG 8x8/16x16 dan subsampling
# chroma 4:2:0 ikut teruji.
WIDTH, HEIGHT = 45, 29


def _scene(width: int, height: int) -> np.ndarray:
    """Adegan RGB [0,1] float64: gradien, patch jenuh, tepi tajam, derau."""
    rng = np.random.default_rng(20260928)
    y, x = np.mgrid[0:height, 0:width].astype(np.float64)
    img = np.stack([x / (width - 1), y / (height - 1), 0.5 + 0.4 * np.sin(x / 3.0) * np.cos(y / 4.0)], axis=-1)
    img[3:11, 3:13] = [1.0, 0.0, 0.0]
    img[3:11, 16:26] = [0.0, 1.0, 0.0]
    img[14:24, 28:40] = [0.0, 0.0, 1.0]
    img[:, 21] = 1.0
    img += rng.normal(0.0, 0.02, img.shape)
    return np.clip(img, 0.0, 1.0)


def _alpha(width: int, height: int) -> np.ndarray:
    y, x = np.mgrid[0:height, 0:width].astype(np.float64)
    return (x + y) / (width + height - 2)


def _quant(values: np.ndarray, bits: int) -> np.ndarray:
    dtype = np.uint8 if bits == 8 else np.uint16
    return np.round(values * (2**bits - 1)).astype(dtype)


def _norm(values: np.ndarray, bits: int) -> np.ndarray:
    """Normalisasi integer -> f32 persis seperti decoder TS (bagi di f64)."""
    return (values.astype(np.float64) / (2**bits - 1)).astype(np.float32)


def _to_rgb(array: np.ndarray) -> np.ndarray:
    if array.ndim == 2:
        return np.repeat(array[..., None], 3, axis=-1)
    if array.shape[-1] in (1, 2):
        return np.repeat(array[..., :1], 3, axis=-1)
    return array[..., :3]


def _pillow(path: Path) -> tuple[np.ndarray, int]:
    with Image.open(path) as im:
        if im.mode == "P":
            im = im.convert("RGBA" if "transparency" in im.info else "RGB")
        array = np.asarray(im)
    if array.dtype == np.bool_:  # mode "1": PNG gray 1-bit
        return _to_rgb(array.astype(np.uint8)), 1
    bits = 16 if array.dtype == np.uint16 else 8
    return _to_rgb(array), bits


def _oiio(path: Path) -> tuple[np.ndarray, int]:
    buf = oiio.ImageBuf(str(path))
    spec = buf.spec()
    bits = {oiio.UINT8: 8, oiio.UINT16: 16}[spec.format.basetype]
    array = buf.get_pixels(oiio.UINT8 if bits == 8 else oiio.UINT16)
    return _to_rgb(array), bits


def _oiio_write(path: Path, array: np.ndarray, **attrs) -> None:
    # OIIO membaca array 2D sebagai data tak lengkap (keluaran berubah tiap
    # run); bentuk (h, w, c) eksplisit membuatnya deterministik.
    if array.ndim == 2:
        array = array[..., None]
    array = np.ascontiguousarray(array)
    h, w, channels = array.shape
    fmt = oiio.UINT16 if array.dtype == np.uint16 else oiio.UINT8
    spec = oiio.ImageSpec(w, h, channels, fmt)
    for key, value in attrs.items():
        spec.attribute(key, value)
    out = oiio.ImageOutput.create(str(path))
    if out is None or not out.open(str(path), spec):
        raise RuntimeError(f"OIIO tidak bisa menulis {path}: {oiio.geterror()}")
    out.write_image(array)
    out.close()


def _gray(rgb: np.ndarray) -> np.ndarray:
    return rgb @ np.array([0.2126, 0.7152, 0.0722])


def _cases(scene: np.ndarray):
    """Nama kasus -> (ekstensi, penulis(path), pembaca oracle(path), catatan)."""
    rgb8 = _quant(scene, 8)
    rgba8 = np.concatenate([rgb8, _quant(_alpha(WIDTH, HEIGHT), 8)[..., None]], axis=-1)
    rgb16 = _quant(scene, 16)
    gray16 = _quant(_gray(scene), 16)
    gray8 = _quant(_gray(scene), 8)
    return {
        "jpeg_baseline_q90": ("jpg", lambda p: Image.fromarray(rgb8).save(p, quality=90), _pillow,
                              "Pillow q90, baseline, subsampling 4:2:0"),
        "jpeg_progressive": ("jpg", lambda p: Image.fromarray(rgb8).save(p, quality=85, progressive=True), _pillow,
                             "Pillow q85, progresif"),
        "jpeg_gray": ("jpg", lambda p: Image.fromarray(gray8, "L").save(p, quality=90), _pillow,
                      "Pillow q90, grayscale satu komponen"),
        "jpeg_444": ("jpg", lambda p: Image.fromarray(rgb8).save(p, quality=95, subsampling=0), _pillow,
                     "Pillow q95, tanpa subsampling chroma"),
        "jpeg_422": ("jpg", lambda p: Image.fromarray(rgb8).save(p, quality=90, subsampling=1), _pillow,
                     "Pillow q90, subsampling 4:2:2"),
        "jpeg_restart": ("jpg", lambda p: Image.fromarray(rgb8).save(p, quality=90, restart_marker_blocks=2), _pillow,
                         "Pillow q90, 4:2:0, marker restart tiap 2 MCU"),
        "jpeg_progressive_gray": ("jpg", lambda p: Image.fromarray(gray8, "L").save(p, quality=80, progressive=True),
                                  _pillow, "Pillow q80, progresif grayscale"),
        "png_rgb8": ("png", lambda p: Image.fromarray(rgb8).save(p), _pillow, "Pillow RGB 8-bit"),
        "png_rgba8": ("png", lambda p: Image.fromarray(rgba8, "RGBA").save(p), _pillow, "Pillow RGBA 8-bit"),
        "png_gray8": ("png", lambda p: Image.fromarray(gray8, "L").save(p), _pillow, "Pillow L 8-bit"),
        "png_palette": ("png", lambda p: Image.fromarray(rgb8).quantize(64).save(p), _pillow,
                        "Pillow mode P (palet 64 warna)"),
        "png_palette2": ("png", lambda p: Image.fromarray(rgb8).quantize(4).save(p, bits=2), _pillow,
                         "Pillow mode P, palet 4 warna, indeks 2-bit"),
        "png_gray1": ("png", lambda p: Image.fromarray(gray8 > 127).save(p), _pillow,
                      "Pillow mode 1 (gray 1-bit, baris ber-padding)"),
        "png_rgb16": ("png", lambda p: _oiio_write(p, rgb16), _oiio, "OIIO/libpng RGB 16-bit big-endian"),
        "png_gray16": ("png", lambda p: _oiio_write(p, gray16), _oiio, "OIIO/libpng gray 16-bit"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--manifest", action="store_true")
    args = parser.parse_args()

    scene = _scene(WIDTH, HEIGHT)
    for name, (ext, write, read, note) in _cases(scene).items():
        case_dir = args.out / "io" / name
        case_dir.mkdir(parents=True, exist_ok=True)
        src = case_dir / f"input.{ext}"
        write(src)
        values, bits = read(src)
        expected = _norm(values, bits)
        assert expected.shape == (HEIGHT, WIDTH, 3), (name, expected.shape)
        (case_dir / "expected.f32").write_bytes(np.ascontiguousarray(expected, dtype="<f4").tobytes())
        _write_json_lf(case_dir / "case.json", {
            "name": name,
            "format": {"jpg": "jpeg"}.get(ext, ext),
            "width": WIDTH,
            "height": HEIGHT,
            "bitDepth": bits,
            "oracle": note,
        })
        print(f"Wrote {case_dir}")

    if args.manifest:
        _write_manifest(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
