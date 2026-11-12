# Export OCSRGlyph to two ONNX graphs (encoder with cross-attention keys and values, one decoder step with a cache),
# then check greedy decoding through ONNX Runtime against the original predictor.
import sys, os, json, math, time, warnings
warnings.filterwarnings("ignore")
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F, onnxruntime as ort
from glyph.ocsr.predict import OCSRPredictor, _preprocess_image, _greedy_batch

OUT = sys.argv[1]; imgs = sys.argv[2:]
os.makedirs(OUT, exist_ok=True)
P = OCSRPredictor(os.environ.get("GLYPH_WEIGHTS", "models/model.pth"), device="cpu")
model = P.model.float().eval().requires_grad_(False)
dec = model.decoder; layers = dec.decoder.layers
L = len(layers); D = dec.cfg.embed_dim; H = layers[0].self_attn.num_heads; dh = D // H

def heads(x): return x.view(1, -1, H, dh).transpose(1, 2)
def proj(w, b, x, i):  # slice i of a packed in_proj (q, k, v)
    return F.linear(x, w[i*D:(i+1)*D], b[i*D:(i+1)*D])
def attend(q, k, v):
    a = torch.softmax(torch.matmul(q / math.sqrt(dh), k.transpose(2, 3)), dim=-1)
    return torch.matmul(a, v).transpose(1, 2).contiguous().view(1, -1, D)

class EncoderWrap(nn.Module):
    def __init__(self): super().__init__(); self.m = model
    def forward(self, image):
        mem = model.encoder(image)
        ks = torch.stack([heads(proj(l.multihead_attn.in_proj_weight, l.multihead_attn.in_proj_bias, mem, 1)) for l in layers])
        vs = torch.stack([heads(proj(l.multihead_attn.in_proj_weight, l.multihead_attn.in_proj_bias, mem, 2)) for l in layers])
        return ks, vs

class StepWrap(nn.Module):
    def __init__(self): super().__init__(); self.m = model
    def forward(self, token, pos, past_k, past_v, mem_k, mem_v):
        x = dec.tok_embed(token.view(1, 1)) + dec.pos_embed(pos.view(1, 1))
        nk, nv = [], []
        for i, l in enumerate(layers):
            sa = l.self_attn; w, b = sa.in_proj_weight, sa.in_proj_bias
            xn = l.norm1(x)
            k = torch.cat([past_k[i], heads(proj(w, b, xn, 1))], dim=2)
            v = torch.cat([past_v[i], heads(proj(w, b, xn, 2))], dim=2)
            nk.append(k); nv.append(v)
            x = x + sa.out_proj(attend(heads(proj(w, b, xn, 0)), k, v))
            ca = l.multihead_attn
            x = x + ca.out_proj(attend(heads(proj(ca.in_proj_weight, ca.in_proj_bias, l.norm2(x), 0)), mem_k[i], mem_v[i]))
            x = x + l.linear2(l.activation(l.linear1(l.norm3(x))))
        logp = F.log_softmax(dec.head(x).view(1, -1), dim=-1)
        return logp, torch.stack(nk), torch.stack(nv)

ew, sw = EncoderWrap().eval(), StepWrap().eval()
img = torch.randn(1, 3, 384, 384)
with torch.no_grad():
    mk, mv = ew(img); pk = torch.zeros(L, 1, H, 0, dh)
    torch.onnx.export(ew, (img,), f"{OUT}/encoder.onnx", input_names=["image"], output_names=["mem_k", "mem_v"], opset_version=17, dynamo=False)
    torch.onnx.export(sw, (torch.tensor([1]), torch.tensor([0]), pk, pk, mk, mv), f"{OUT}/step.onnx",
        input_names=["token", "pos", "past_k", "past_v", "mem_k", "mem_v"], output_names=["logp", "k", "v"],
        dynamic_axes={"past_k": {3: "t"}, "past_v": {3: "t"}, "k": {3: "t1"}, "v": {3: "t1"}}, opset_version=17, dynamo=False)
json.dump({"itos": [P.tokenizer.itos[i] for i in range(len(P.tokenizer.itos))], "max_len": P.max_len, "layers": L, "heads": H, "dh": dh,
           "activation": str(layers[0].activation)}, open(f"{OUT}/vocab.json", "w"))
print("exported", L, H, D, "act", layers[0].activation, "max_len", P.max_len)

so = ort.SessionOptions(); so.intra_op_num_threads = 4
E = ort.InferenceSession(f"{OUT}/encoder.onnx", so); S = ort.InferenceSession(f"{OUT}/step.onnx", so)
for p in imgs:
    x = _preprocess_image(p, 384).unsqueeze(0)
    ref = _greedy_batch(model, x, P.tokenizer, P.max_len)[0]
    t0 = time.time(); mk, mv = E.run(None, {"image": x.numpy()}); t1 = time.time()
    pk = np.zeros((L, 1, H, 0, dh), np.float32); pv = pk; t = 1; ids = [1]
    for pos in range(P.max_len - 1):
        logp, pk, pv = S.run(None, {"token": np.array([t], np.int64), "pos": np.array([pos], np.int64), "past_k": pk, "past_v": pv, "mem_k": mk, "mem_v": mv})
        t = int(logp[0].argmax()); ids.append(t)
        if t == 2: break
    t2 = time.time(); got = P.tokenizer.decode(ids)
    print(json.dumps({"image": p, "same": got == ref, "smiles": got, "encoder_s": round(t1-t0, 2), "decoder_s": round(t2-t1, 2)}))
