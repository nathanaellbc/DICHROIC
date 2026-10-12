"""Jalankan pipeline terpecah (ORT CPU) pada foto, bandingkan fp32 vs q4f16, simpan peta."""
import sys
import time
import numpy as np
import onnxruntime as ort
from PIL import Image

photo, outdir = sys.argv[1], sys.argv[2]
img = Image.open(photo).convert('RGB').resize((1536, 1536), Image.BILINEAR)
x = ((np.asarray(img, dtype=np.float32) / 255 - 0.5) / 0.5).transpose(2, 0, 1)[None]


def run(folder, dtype):
    so = ort.SessionOptions()
    px = x.astype(dtype)
    t0 = time.time()
    s = ort.InferenceSession(f'{folder}/image.onnx', so, providers=['CPUExecutionProvider'])
    ih = s.run(None, {'pixel_values': px})[0]
    del s
    s = ort.InferenceSession(f'{folder}/patch.onnx', so, providers=['CPUExecutionProvider'])
    last, ia, ib = [], [], []
    for start in range(0, 35, 5):
        o = s.run(None, {'pixel_values': px, 'index': np.arange(start, min(start + 5, 35), dtype=np.int64)})
        last.append(o[0]); ia.append(o[1]); ib.append(o[2])
    del s
    s = ort.InferenceSession(f'{folder}/decoder.onnx', so, providers=['CPUExecutionProvider'])
    d = s.run(None, {'last': np.concatenate(last), 'inter_a': np.concatenate(ia)[:25], 'inter_b': np.concatenate(ib)[:25], 'image_hidden': ih})[0]
    print(folder, 'seconds', round(time.time() - t0, 1), d.dtype, d.shape, float(d.min()), float(d.max()))
    return d[0].astype(np.float32)


ref = run('out', np.float32)
q = run('q4f16', np.float16)
corr = np.corrcoef(ref.ravel(), q.ravel())[0, 1]
rel = np.abs(q - ref).mean() / np.abs(ref).mean()
print('corr', corr, 'mean rel err', rel)
for name, d in (('ref', ref), ('q4f16', q)):
    v = (d - d.min()) / (d.max() - d.min() + 1e-9)
    Image.fromarray((v * 255).astype(np.uint8)).resize((482, 643)).save(f'{outdir}/pro_{name}.png')
