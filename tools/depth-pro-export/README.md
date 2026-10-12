# Depth Pro for mobile (lens blur `pro` model)

Rebuilds the files at https://huggingface.co/nathanaellbc/depth-pro-mobile-onnx
from `apple/DepthPro-hf`: no field-of-view head, split into `image` / `patch` /
`decoder` ONNX sessions (see `src/depth/depthProSplit.ts`), then q4f16.

```
python -m venv venv && venv/Scripts/pip install torch --index-url https://download.pytorch.org/whl/cpu
venv/Scripts/pip install numpy transformers safetensors pillow onnx onnxruntime onnxscript onnxconverter-common huggingface_hub
HF_HOME=./hf venv/Scripts/python -c "from huggingface_hub import snapshot_download; snapshot_download('apple/DepthPro-hf', revision='de816c8ce7168afcb231f96d501d72b869d0beda')"
venv/Scripts/python export.py out            # split vs full: must print max abs 0.0
venv/Scripts/python export.py out --export-only
venv/Scripts/python quantize.py out q4f16
venv/Scripts/python verify.py photo.png .    # fp32 vs q4f16 correlation (0.99988 on the reference photo)
```

`export.py` loads the checkpoint as fp32 (it is stored fp16); `quantize.py` drops
no-op fp32 casts before the fp16 conversion so the patch-embedding Conv stays fp16.
