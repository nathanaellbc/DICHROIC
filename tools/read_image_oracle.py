"""Pembaca oracle untuk gerbang round-trip encoder io/ (rencana 2B Task 6).

Dipanggil oleh test/io/encode.test.ts lewat berkas sementara:

    python tools/read_image_oracle.py <reader> <image> <out.u16>

Menulis sampel RGB berkas `image` sebagai uint16 little-endian rapat
(baris-mayor) ke `out.u16`, dibaca dengan pustaka pihak lain:

- `pillow`: PNG 8-bit;
- `oiio`: PNG 16-bit (libpng; Pillow tidak bisa membaca PNG RGB 16-bit);
- `tifffile`: TIFF 16-bit.
"""

from __future__ import annotations

import sys

import numpy as np


def main() -> int:
    reader, image, out = sys.argv[1:4]
    if reader == "pillow":
        from PIL import Image

        with Image.open(image) as im:
            array = np.asarray(im)
    elif reader == "oiio":
        import OpenImageIO as oiio

        array = oiio.ImageBuf(image).get_pixels(oiio.UINT16)
    elif reader == "tifffile":
        import tifffile

        array = tifffile.imread(image)
    else:
        raise SystemExit(f"reader tidak dikenal: {reader}")
    with open(out, "wb") as f:
        f.write(np.ascontiguousarray(array, dtype="<u2").tobytes())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
