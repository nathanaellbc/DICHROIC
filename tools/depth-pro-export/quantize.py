"""fp32 ONNX -> q4f16: aktivasi dan I/O fp16, bobot MatMul 4-bit (MatMulNBits, blok 32).

  python quantize.py out q4f16
"""
import os
import sys
import onnx
from onnxconverter_common import float16
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

SRC, DST = sys.argv[1], sys.argv[2]
os.makedirs(DST, exist_ok=True)
for name in ('image', 'patch', 'decoder'):
    m = onnx.load(f'{SRC}/{name}.onnx', load_external_data=True)
    # Cast fp32->fp32 (DINOv2 `pixel_values.to(dtype)`) menjadi fp16->fp32
    # setelah konversi dan memutus tipe Conv: buang Cast yang no-op.
    typed = onnx.shape_inference.infer_shapes(m)
    elem = {v.name: v.type.tensor_type.elem_type for v in [*typed.graph.value_info, *typed.graph.input, *typed.graph.output]}
    noop = {n.output[0]: n.input[0] for n in m.graph.node
            if n.op_type == 'Cast' and any(a.name == 'to' and a.i == onnx.TensorProto.FLOAT for a in n.attribute)
            and elem.get(n.input[0]) == onnx.TensorProto.FLOAT}
    if noop:
        keep = [n for n in m.graph.node if not (n.op_type == 'Cast' and n.output[0] in noop)]
        for n in keep:
            for i, x in enumerate(n.input):
                while x in noop: x = noop[x]
                n.input[i] = x
        for o in m.graph.output:
            assert o.name not in noop
        del m.graph.node[:]
        m.graph.node.extend(keep)
        print(name, 'removed no-op casts', len(noop))
    # I/O fp16 juga: keluaran patch (35x577x1024 x3) separuh ukurannya di memori JS.
    m = float16.convert_float_to_float16(m, keep_io_types=False, disable_shape_infer=False)
    if name != 'decoder':
        q = MatMulNBitsQuantizer(m, block_size=32, is_symmetric=True)
        q.process()
        m = q.model.model
    out = f'{DST}/{name}.onnx'
    onnx.save(m, out)
    print(name, round(os.path.getsize(out) / 1e6, 1), 'MB')
