"""Depth Pro (apple/DepthPro-hf) dipecah untuk HP: tanpa FOV, tiga sesi ONNX.

  image.onnx   pixel_values [1,3,1536,1536]            -> image_hidden [1,577,1024]
  patch.onnx   pixel_values [1,3,1536,1536], index [K]  -> last [K,577,1024], inter_a [K,577,1024], inter_b [K,577,1024]
  decoder.onnx last [35,577,1024], inter_a [25,577,1024], inter_b [25,577,1024], image_hidden [1,577,1024]
               -> inverse_depth [1,1536,1536] (canonical inverse depth: makin dekat makin besar)

Patch dipilih lewat `index` supaya 35 potongan bisa dijalankan bertahap
(memori atensi ~K/35). inter_a/inter_b hanya dibutuhkan 25 potongan resolusi
tinggi pertama.
"""
import math
import sys
import glob
import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers import DepthProForDepthEstimation
from transformers.models.depth_pro import modeling_depth_pro as M

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
path = glob.glob('hf/hub/models--apple--DepthPro-hf/snapshots/*')[0]
model = DepthProForDepthEstimation.from_pretrained(path, use_fov_model=False, dtype=torch.float32).eval()
cfg = model.config
pe = model.depth_pro.encoder.patch_encoder
ie = model.depth_pro.encoder.image_encoder
SIZE = 1536
print('ratios', cfg.scaled_images_ratios, 'overlap', cfg.scaled_images_overlap_ratios, 'hooks', cfg.intermediate_hook_ids, 'pad', cfg.merge_padding_value)


def make_patches(x):
    scaled = [F.interpolate(x, scale_factor=r, mode='bilinear', align_corners=False) for r in cfg.scaled_images_ratios]
    scaled = [M.split_to_patches(s, patch_size=cfg.patch_size, overlap_ratio=o) for s, o in zip(scaled, cfg.scaled_images_overlap_ratios)]
    return torch.cat(scaled[::-1], dim=0)  # resolusi tinggi lebih dulu


class PatchStage(nn.Module):
    def __init__(self):
        super().__init__()
        self.m = pe.model

    def forward(self, pixel_values, index):
        p = make_patches(pixel_values)[index]
        enc = self.m(p, output_hidden_states=True, return_dict=True)
        hs = enc.hidden_states
        return enc.last_hidden_state, hs[cfg.intermediate_hook_ids[0] + 1], hs[cfg.intermediate_hook_ids[1] + 1]


class ImageStage(nn.Module):
    def __init__(self):
        super().__init__()
        self.m = ie.model

    def forward(self, pixel_values):
        s = cfg.image_model_config.image_size
        x = F.interpolate(pixel_values, size=(s, s), mode='bilinear', align_corners=False)
        return self.m(pixel_values=x).last_hidden_state


class Decoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.neck = model.depth_pro.neck
        self.fusion = model.fusion_stage
        self.head = model.head

    def forward(self, last, inter_a, inter_b, image_hidden):
        out_size = cfg.image_model_config.image_size // cfg.image_model_config.patch_size
        base = SIZE // 2 ** int(math.log2(SIZE / out_size))
        counts = [25, 9, 1]  # tinggi, sedang, rendah
        per_scale = list(torch.split(last, counts))[::-1]  # rendah lebih dulu
        n = len(cfg.scaled_images_ratios)
        scaled = []
        for i in range(n):
            padding = int(cfg.merge_padding_value * (1 / cfg.scaled_images_ratios[i]))
            o = base * 2 ** i
            scaled.append(M.reconstruct_feature_maps(per_scale[i], batch_size=1, padding=padding, output_size=(o, o)))
        inter = []
        for h in (inter_a, inter_b):
            padding = int(cfg.merge_padding_value * (1 / cfg.scaled_images_ratios[-1]))
            o = base * 2 ** (n - 1)
            inter.append(M.reconstruct_feature_maps(h, batch_size=1, padding=padding, output_size=(o, o)))
        image_features = M.reconstruct_feature_maps(image_hidden, batch_size=1, padding=0, output_size=(base, base))
        features = self.neck([image_features, *scaled, *inter])
        fused = self.fusion(features)
        return self.head(fused[-1])


if __name__ == '__main__':
    import os
    os.makedirs(OUT, exist_ok=True)
    torch.manual_seed(0)
    x = torch.randn(1, 3, SIZE, SIZE) * 0.5
    patch, image, dec = PatchStage().eval(), ImageStage().eval(), Decoder().eval()
    with torch.no_grad():
      if '--export-only' in sys.argv:
        last = torch.randn(35, 577, 1024); ia = torch.randn(25, 577, 1024); ib = torch.randn(25, 577, 1024); ih = torch.randn(1, 577, 1024)
      else:
        ref = model(pixel_values=x).predicted_depth
        chunks = [patch(x, torch.arange(i, min(i + 5, 35))) for i in range(0, 35, 5)]
        last = torch.cat([c[0] for c in chunks])
        ia = torch.cat([c[1] for c in chunks])[:25]
        ib = torch.cat([c[2] for c in chunks])[:25]
        ih = image(x)
        split = dec(last, ia, ib, ih)
        print('split vs full: max abs', (split - ref).abs().max().item(), 'ref range', ref.min().item(), ref.max().item())
    if '--export' in sys.argv or '--export-only' in sys.argv:
        kw = dict(opset_version=18, do_constant_folding=True, dynamo=False)
        torch.onnx.export(image, (x,), f'{OUT}/image.onnx', input_names=['pixel_values'], output_names=['image_hidden'], **kw)
        torch.onnx.export(patch, (x, torch.arange(0, 5)), f'{OUT}/patch.onnx', input_names=['pixel_values', 'index'],
                          output_names=['last', 'inter_a', 'inter_b'], dynamic_axes={'index': {0: 'k'}, 'last': {0: 'k'}, 'inter_a': {0: 'k'}, 'inter_b': {0: 'k'}}, **kw)
        torch.onnx.export(dec, (last, ia, ib, ih), f'{OUT}/decoder.onnx', input_names=['last', 'inter_a', 'inter_b', 'image_hidden'],
                          output_names=['inverse_depth'], **kw)
        print('exported')
