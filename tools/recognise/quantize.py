# 8-bit weights for every MatMul and Gemm: about a quarter of the size.
import sys, onnx
from onnxruntime.quantization import quantize_dynamic, QuantType
from onnxruntime.quantization.shape_inference import quant_pre_process
src, dst = sys.argv[1], sys.argv[2]
import os; os.makedirs(dst, exist_ok=True)
for f in os.listdir(src):
    if f.endswith(".onnx"):
        quantize_dynamic(f"{src}/{f}", f"{dst}/{f}", weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul", "Gemm"], per_channel=False)
    else:
        open(f"{dst}/{f}", "wb").write(open(f"{src}/{f}", "rb").read())
    print(f, os.path.getsize(f"{dst}/{f}"))
