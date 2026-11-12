# Greedy decoding through the ONNX graphs, compared token for token with the original MolScribe.
import os, sys, json, time, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, os.environ.get("MOLSCRIBE_SRC", "src/MolScribe"))
import numpy as np, torch, cv2, onnxruntime as ort
from molscribe import MolScribe
D = sys.argv[1]; imgs = sys.argv[2:]
m = MolScribe(os.environ.get("MOLSCRIBE_WEIGHTS", "models/swin_base_char_aux_1m680k.pth"), device=torch.device("cpu"))
tok = m.tokenizer["chartok_coords"]
so = ort.SessionOptions(); so.intra_op_num_threads = 4
E = ort.InferenceSession(f"{D}/encoder.onnx", so); S = ort.InferenceSession(f"{D}/step.onnx", so); G = ort.InferenceSession(f"{D}/edges.onnx", so)
V = len(tok)
def mask_for(t):
    return np.array(tok.get_output_mask(t), dtype=bool) if tok.output_constraint else np.zeros(V, bool)
for p in imgs:
    image = cv2.cvtColor(cv2.imread(p), cv2.COLOR_BGR2RGB)
    x = m.transform(image=image, keypoints=[])["image"].unsqueeze(0)
    with torch.no_grad():
        f, h = m.encoder(x); ref = m.decoder.decode(f, h)[0]
    t0 = time.time()
    mk, mv = E.run(None, {"image": x.numpy()})
    t1 = time.time()
    pk = np.zeros((6, 1, 8, 0, 32), np.float32); pv = pk
    t = 1; out = []; hid = []
    for step in range(480):
        logp, hidden, pk, pv = S.run(None, {"token": np.array([t], np.int64), "past_k": pk, "past_v": pv, "mem_k": mk, "mem_v": mv})
        logp = logp[0].copy(); logp[mask_for(t)] = -10000
        t = int(logp.argmax()); out.append(t); hid.append(hidden[0])
        if t == 2: break
    t2 = time.time()
    r = tok.sequence_to_smiles(out)
    hh = np.stack(hid)[None, np.array(r["indices"])] if r["indices"] else None
    prob = G.run(None, {"hidden": hh.astype(np.float32)})[0] if hh is not None else None
    from molscribe.model import get_edge_prediction
    e, _ = get_edge_prediction(prob.tolist()) if prob is not None else ([], [])
    R = ref["chartok_coords"]
    if 0: print("DIFF sym", r["symbols"]==R["symbols"], "coords", np.abs(np.array(r["coords"])-np.array(R["coords"])).max() if len(r["coords"])==len(R["coords"]) else "len", "edges", "same" if e == ref["edges"] else "DIFFERENT", "ref", R["smiles"][:60])
    same = r["symbols"] == R["symbols"] and np.allclose(np.array(r["coords"]).reshape(-1), np.array(R["coords"]).reshape(-1)) and e == ref["edges"]
    print(json.dumps({"image": p, "same": same, "smiles": r["smiles"], "steps": len(out), "encoder_s": round(t1-t0, 2), "decoder_s": round(t2-t1, 2)}))
