"""Verifikasi independen profil ICC ekspor (src/io/icc.ts) lewat LittleCMS.

Untuk tiap colour space keluaran: warna uji ter-encode dikonversi ke Lab D50
oleh LittleCMS (Pillow ImageCms) memakai profil kita, dibandingkan dengan
referensi dari definisi manifest (decode CCTF -> matriks RGB->XYZ -> Bradford
ke D50 -> Lab). Pemakaian: python tools/verify_icc.py <dir berisi *.icc>
"""
import io, json, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageCms

D50 = np.array([0.9642, 1.0, 0.8249])
M_BFD = np.array([[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]])

def decode(v, spec):
    e = spec["encoding"]
    if e == "srgb":
        return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)
    if e == "romm":
        return np.where(v < 1 / 32, v / 16, v ** 1.8)
    if e == "gamma":
        return v ** spec["gamma"]
    return v

def lab(xyz):
    t = xyz / D50
    f = np.where(t > (6 / 29) ** 3, np.cbrt(t), t / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)

manifest = json.loads(Path("public/data/manifest.json").read_text())
rng = np.random.default_rng(1)
rgb8 = np.concatenate([rng.integers(0, 256, (250, 3)), np.array([[255, 255, 255], [0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [128, 128, 128]])]).astype(np.uint8)
worst_all = 0.0
for label, spec in manifest["outputColorSpaces"].items():
    name = "".join(c if c.isalnum() else "_" for c in label)
    name = "_".join(filter(None, name.split("_")))
    path = next(p for p in Path(sys.argv[1]).glob("*.icc") if "_".join(filter(None, p.stem.split("_"))) == name)
    prof = ImageCms.ImageCmsProfile(io.BytesIO(path.read_bytes()))
    lab_prof = ImageCms.createProfile("LAB", colorTemp=5000)
    # NOOPTIMIZE: tanpa LUT 8-bit hasil optimasi LittleCMS (kasar di dekat hitam
    # untuk kurva linear) -- menguji profilnya, bukan grid interpolasi CMS.
    t = ImageCms.buildTransform(prof, lab_prof, "RGB", "LAB", renderingIntent=1, flags=ImageCms.Flags.NOOPTIMIZE)
    img = Image.fromarray(rgb8.reshape(1, -1, 3), "RGB")
    out = np.asarray(ImageCms.applyTransform(img, t)).reshape(-1, 3).astype(np.float64)
    # Pillow: L 0..255 -> 0..100, a/b int8 bertanda di dalam uint8.
    signed = lambda c: np.where(c >= 128, c - 256, c)
    got = np.stack([out[:, 0] * 100 / 255, signed(out[:, 1]), signed(out[:, 2])], -1)
    m = np.array(spec["rgbToXyz"]).reshape(3, 3)
    white = m.sum(1)
    s, d = M_BFD @ white, M_BFD @ D50
    chad = np.linalg.inv(M_BFD) @ np.diag(d / s) @ M_BFD
    xyz = (chad @ m @ decode(rgb8 / 255.0, spec).T).T
    ref = lab(xyz)
    de = np.sqrt(((got - ref) ** 2).sum(1))
    # Lab 8-bit Pillow hanya mewakili L 0..100 dan a/b -128..127: warna di luar
    # itu (umum di ACES/ProPhoto/Rec.2020) dijepit oleh FORMAT keluaran, bukan
    # oleh profil -- dibandingkan hanya yang terwakili. Lantai kuantisasi ~0.7.
    ok = (ref[:, 0] <= 100) & (np.abs(ref[:, 1]) <= 126) & (np.abs(ref[:, 2]) <= 126)
    d = de[ok]
    print(f"{label:18s} dE76 maks {d.max():.3f}  rata {d.mean():.3f}  ({ok.sum()}/{len(ok)} warna terwakili)")
    worst_all = max(worst_all, d.max())
print("TERBURUK", round(worst_all, 3))
