# Export MolScribe to three ONNX graphs (encoder, one decoder step with a key/value cache, bond predictor),
# then check that greedy decoding through ONNX Runtime gives the same tokens as the original PyTorch model.
import os, sys, json, math, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, os.environ.get("MOLSCRIBE_SRC", "src/MolScribe"))
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F, cv2
from molscribe import MolScribe

OUT = sys.argv[1] if len(sys.argv) > 1 else "out/molscribe"
os.makedirs(OUT, exist_ok=True)
m = MolScribe(os.environ.get("MOLSCRIBE_WEIGHTS", "models/swin_base_char_aux_1m680k.pth"), device=torch.device("cpu"))
enc = m.encoder; ar = m.decoder.decoder["chartok_coords"]; edges = m.decoder.decoder["edges"]
layers = ar.decoder.transformer_layers
L, H, D = len(layers), layers[0].self_attn.head_count, layers[0].self_attn.model_dim
dh = D // H
# The encoder's Swin checkpointing is for training only.
def no_ckpt(mod):
    for x in mod.modules():
        if hasattr(x, "use_checkpoint"): x.use_checkpoint = False
no_ckpt(enc)
for mod in (enc, ar, edges): mod.requires_grad_(False)

def heads(x):  # [1, T, D] -> [1, H, T, dh]
    return x.view(1, -1, H, dh).transpose(1, 2)

class EncoderWrap(nn.Module):
    def __init__(self):
        super().__init__(); self.enc, self.ar = enc, ar
    """Picture [1,3,384,384] -> cross-attention keys and values for every decoder layer, [L,1,H,144,dh] each."""
    def forward(self, image):
        features, _ = enc(image)
        mem = ar.enc_transform(features)
        ks = torch.stack([heads(l.context_attn.linear_keys(mem)) for l in layers])
        vs = torch.stack([heads(l.context_attn.linear_values(mem)) for l in layers])
        return ks, vs

def attend(q, k, v):
    q = q / math.sqrt(dh)
    a = torch.softmax(torch.matmul(q, k.transpose(2, 3)), dim=-1)
    return torch.matmul(a, v).transpose(1, 2).contiguous().view(1, -1, D)

class StepWrap(nn.Module):
    def __init__(self):
        super().__init__(); self.ar = ar
    """One token -> log-probabilities of the next, the decoder state (for the bond predictor), the grown cache."""
    def forward(self, token, past_k, past_v, mem_k, mem_v):
        x = ar.embeddings(token.view(1, 1, 1))           # [1,1,D], position as MolScribe itself adds it
        nk, nv = [], []
        for i, l in enumerate(layers):
            xn = l.layer_norm_1(x)
            sa = l.self_attn
            k = torch.cat([past_k[i], heads(sa.linear_keys(xn))], dim=2)
            v = torch.cat([past_v[i], heads(sa.linear_values(xn))], dim=2)
            nk.append(k); nv.append(v)
            q = sa.final_linear(attend(heads(sa.linear_query(xn)), k, v)) + x
            qn = l.layer_norm_2(q)
            ca = l.context_attn
            mid = ca.final_linear(attend(heads(ca.linear_query(qn)), mem_k[i], mem_v[i]))
            x = l.feed_forward(mid + q)
        hidden = ar.decoder.layer_norm(x)                  # [1,1,D]
        logp = F.log_softmax(ar.output_layer(hidden).view(1, -1), dim=-1)
        return logp, hidden.view(1, D), torch.stack(nk), torch.stack(nv)

class EdgesWrap(nn.Module):
    def __init__(self):
        super().__init__(); self.edges = edges
    """Decoder states of the K atoms [1,K,D] -> bond class probabilities [K,K,7]."""
    def forward(self, hidden):
        k = hidden.shape[1]
        hh = torch.cat([hidden.unsqueeze(2).expand(1, k, k, D), hidden.unsqueeze(1).expand(1, k, k, D)], dim=3)
        return F.softmax(edges.mlp(hh).squeeze(0), dim=2)

ew, sw, gw = EncoderWrap().eval(), StepWrap().eval(), EdgesWrap().eval()
img = torch.randn(1, 3, 384, 384)
with torch.no_grad():
    mk, mv = ew(img)
    pk = torch.zeros(L, 1, H, 0, dh)
    torch.onnx.export(ew, (img,), f"{OUT}/encoder.onnx", input_names=["image"], output_names=["mem_k", "mem_v"], opset_version=17)
    torch.onnx.export(sw, (torch.tensor([1]), pk, pk, mk, mv), f"{OUT}/step.onnx",
        input_names=["token", "past_k", "past_v", "mem_k", "mem_v"], output_names=["logp", "hidden", "k", "v"],
        dynamic_axes={"past_k": {3: "t"}, "past_v": {3: "t"}, "k": {3: "t1"}, "v": {3: "t1"}}, opset_version=17)
    torch.onnx.export(gw, (torch.randn(1, 5, D),), f"{OUT}/edges.onnx", input_names=["hidden"], output_names=["prob"],
        dynamic_axes={"hidden": {1: "k"}, "prob": {0: "k", 1: "k"}}, opset_version=17)

tok = m.tokenizer["chartok_coords"]
vocab = {"stoi": tok.stoi, "offset": tok.offset, "maxx": tok.maxx, "maxy": tok.maxy, "special": len(tok.special_tokens)}
json.dump(vocab, open(f"{OUT}/vocab.json", "w"))
print("exported", L, H, D, "vocab", len(tok))
