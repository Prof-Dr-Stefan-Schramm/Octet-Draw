// Picture to structure (decision 0023): the two recognition models, run with ONNX Runtime Web as WebAssembly on
// one thread, in the app's recognition worker and in Node for the bench.
//
// - MolScribe (Qian et al., J. Chem. Inf. Model. 2023; MIT): atoms with their positions in the picture, then the bond
//   between each pair, so the structure keeps the picture's layout.
// - OCSRGlyph (Edison Scientific, 2026; Apache-2.0): a SMILES string, which Octet lays out itself.
// - PP-OCRv5 English (PaddleOCR, 2025; Apache-2.0): the text of a reaction arrow's conditions.
//
// Each model is exported once from its PyTorch release (tools/recognise) to an encoder and one decoder step with a
// key and value cache, so a reading costs one encoder run and one small step per token. Each comes as one .octmodel
// file: a header in JSON and the files after it. Octet reads only the model files whose SHA-256 it knows
// (recognise.ts KNOWN_MODELS), never a model file it was merely given.
import * as ort from "onnxruntime-web/wasm";
import type { FoundArrow } from "./recognise-find.ts";
import { type Box, crop, glyphInput, molscribeInput, onWhite, type Pixels, resizeLinear, tensor } from "./recognise-image.ts";

export const PACK_MAGIC = "OCTETMODEL1\n";
export type PackMeta = { name: "molscribe" | "glyph" | "text"; version: string; licence: string; source: string; files: { name: string; size: number }[]; vocab: unknown };
export type Pack = { meta: PackMeta; files: Record<string, Uint8Array> };

// A model file: the magic line, the header's length (4 bytes, little-endian), the header, then each file in turn.
export function readPack(bytes: Uint8Array): Pack {
  const magic = new TextDecoder().decode(bytes.subarray(0, PACK_MAGIC.length));
  if (magic !== PACK_MAGIC) throw new Error("not an Octet model file");
  const at = PACK_MAGIC.length, len = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
  if (len > 1 << 20 || at + 4 + len > bytes.length) throw new Error("damaged model file");
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(at + 4, at + 4 + len))) as PackMeta;
  const files: Record<string, Uint8Array> = {};
  let o = at + 4 + len;
  for (const f of meta.files) {
    if (!(f.size >= 0) || o + f.size > bytes.length) throw new Error("damaged model file");
    files[f.name] = bytes.subarray(o, o + f.size);
    o += f.size;
  }
  if (o !== bytes.length) throw new Error("damaged model file");
  return { meta, files };
}

export function writePack(meta: Omit<PackMeta, "files">, files: Record<string, Uint8Array>): Uint8Array {
  const full: PackMeta = { ...meta, files: Object.entries(files).map(([name, b]) => ({ name, size: b.length })) } as PackMeta;
  const head = new TextEncoder().encode(JSON.stringify(full)), magic = new TextEncoder().encode(PACK_MAGIC);
  const out = new Uint8Array(magic.length + 4 + head.length + Object.values(files).reduce((s, b) => s + b.length, 0));
  out.set(magic);
  new DataView(out.buffer).setUint32(magic.length, head.length, true);
  out.set(head, magic.length + 4);
  let o = magic.length + 4 + head.length;
  for (const b of Object.values(files)) { out.set(b, o); o += b.length; }
  return out;
}

ort.env.wasm.numThreads = 1; // threads need a cross-origin isolated page; one thread reads a structure in about 2 s
ort.env.logLevel = "error";
// The runtime's WebAssembly file: the app gives its bundled address (recognise.worker.ts); Node finds it itself.
export const setRuntime = (wasm: string) => { ort.env.wasm.wasmPaths = { wasm }; };
const session = (b: Uint8Array) => ort.InferenceSession.create(b, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
const f32 = (data: Float32Array, dims: number[]) => new ort.Tensor("float32", data, dims);
const i64 = (v: number) => new ort.Tensor("int64", BigInt64Array.from([BigInt(v)]), [1]);
const argmax = (a: ArrayLike<number>) => { let k = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i; return k; };

const SOS = 1, EOS = 2;

// What MolScribe read: atoms as written in the picture (an element, [NH+], or a label such as OMe or R1) at their
// place in the picture's pixels, and bonds by MolScribe's classes: 1 to 4 single, double, triple and aromatic, 5 a
// wedge whose narrow end is a, 6 a hashed wedge whose narrow end is a (or the same bond seen from b: see build).
export type Atom = { symbol: string; x: number; y: number; score: number };
export type GraphBond = { a: number; b: number; kind: number; score: number };
export type Graph = { atoms: Atom[]; bonds: GraphBond[]; confidence: number; text: string };

type MolScribeVocab = { stoi: Record<string, number>; offset: number; maxx: number; maxy: number; special: number };
export type MolScribeModel = { encoder: ort.InferenceSession; step: ort.InferenceSession; edges: ort.InferenceSession; vocab: MolScribeVocab; itos: string[]; layers: number; heads: number; dh: number };

export async function loadMolScribe(p: Pack): Promise<MolScribeModel> {
  const vocab = p.meta.vocab as MolScribeVocab, itos: string[] = [];
  for (const [s, i] of Object.entries(vocab.stoi)) itos[i] = s;
  const [encoder, step, edges] = await Promise.all([session(p.files["encoder.onnx"]), session(p.files["step.onnx"]), session(p.files["edges.onnx"])]);
  return { encoder, step, edges, vocab, itos, layers: 6, heads: 8, dh: 32 };
}

export async function readMolScribe(m: MolScribeModel, picture: Pixels): Promise<Graph & { frame: Box }> {
  const { input, frame } = molscribeInput(picture), v = m.vocab;
  const isX = (t: number) => t >= v.offset && t < v.offset + v.maxx, isY = (t: number) => t >= v.offset + v.maxx;
  const isSymbol = (t: number) => (t >= v.special && t < v.offset) || t === 3;
  const { mem_k, mem_v } = await m.encoder.run({ image: f32(input, [1, 3, 384, 384]) });
  let pk: ort.Tensor = f32(new Float32Array(0), [m.layers, 1, m.heads, 0, m.dh]), pv = pk, t = SOS;
  const out: number[] = [], logs: number[] = [], hidden: Float32Array[] = [];
  for (let i = 0; i < 480; i++) {
    const r = await m.step.run({ token: i64(t), past_k: pk, past_v: pv, mem_k, mem_v });
    pk = r.k; pv = r.v;
    const lp = (r.logp.data as Float32Array).slice();
    // MolScribe's own rule: after an x comes its y, and after a y a symbol.
    if (isX(t)) for (let k = 0; k < lp.length; k++) { if (!isY(k)) lp[k] = -1e4; }
    else if (isY(t)) for (let k = v.offset; k < lp.length; k++) lp[k] = -1e4;
    t = argmax(lp);
    out.push(t); logs.push(lp[t]); hidden.push((r.hidden.data as Float32Array).slice());
    if (t === EOS) break;
  }
  // The tokens as SMILES text and atoms: an atom is a letter, Cl, Br or [...], then its x and y.
  const atoms: Atom[] = [], at: number[] = [];
  let text = "";
  for (let i = 0; i < out.length; ) {
    const k = out[i];
    if (k === EOS || k === 0) break;
    if (isX(k) || isY(k)) { i++; continue; }
    const s = m.itos[k] ?? "?";
    if (!(isSymbol(k) && (/^[A-Za-z*]$/.test(s) || s === "[" || k === 3))) { text += s; i++; continue; }
    let j = i + 1;
    if (s === "[") { while (j < out.length && isSymbol(out[j])) { j++; if (m.itos[out[j - 1]] === "]") break; } }
    else if ((s === "C" && m.itos[out[j]] === "l") || (s === "B" && m.itos[out[j]] === "r")) j++;
    const symbol = out.slice(i, j).map((q) => m.itos[q]).join("");
    text += symbol;
    if (j + 2 < out.length && isX(out[j]) && isY(out[j + 1])) {
      const x = (out[j] - v.offset) / (v.maxx - 1), y = (out[j + 1] - v.offset - v.maxx) / (v.maxy - 1);
      const span = logs.slice(i, j);
      atoms.push({ symbol, x: frame.x + x * frame.w, y: frame.y + y * frame.h, score: Math.exp(span.reduce((a, b) => a + b, 0) / span.length) });
      at.push(j + 2);
      i = j + 2;
    } else i = j;
  }
  const n = atoms.length, bonds: GraphBond[] = [];
  let edgeLog = 0;
  if (n) {
    const h = new Float32Array(n * 256);
    at.forEach((k, i) => h.set(hidden[Math.min(k, hidden.length - 1)], i * 256));
    const prob = (await m.edges.run({ hidden: f32(h, [1, n, 256]) })).prob.data as Float32Array;
    const p = (i: number, j: number, c: number) => prob[(i * n + j) * 7 + c];
    // Each pair seen both ways, as MolScribe averages them: a wedge from i is a hashed wedge seen from j.
    for (let i = 0; i < n; i++)
      for (let j = i; j < n; j++) {
        const q = [0, 1, 2, 3, 4].map((c) => (p(i, j, c) + p(j, i, c)) / 2);
        q.push((p(i, j, 5) + p(j, i, 6)) / 2, (p(i, j, 6) + p(j, i, 5)) / 2);
        const kind = argmax(q);
        edgeLog += Math.log(q[kind]) * (i === j ? 1 : 2);
        if (i !== j && kind) bonds.push({ a: i, b: j, kind, score: q[kind] });
      }
  }
  const tokens = Math.exp(logs.reduce((a, b) => a + b, 0) / Math.max(1, logs.length));
  return { atoms, bonds, confidence: tokens * Math.exp(edgeLog / 2), text, frame };
}

type GlyphVocab = { itos: string[]; max_len: number; layers: number; heads: number; dh: number };
export type GlyphModel = { encoder: ort.InferenceSession; step: ort.InferenceSession; vocab: GlyphVocab };

export async function loadGlyph(p: Pack): Promise<GlyphModel> {
  const [encoder, step] = await Promise.all([session(p.files["encoder.onnx"]), session(p.files["step.onnx"])]);
  return { encoder, step, vocab: p.meta.vocab as GlyphVocab };
}

// OCSRGlyph's SMILES, and its confidence: the mean probability of its tokens, as a geometric mean.
export async function readGlyph(m: GlyphModel, picture: Pixels): Promise<{ smiles: string; confidence: number }> {
  const v = m.vocab, { mem_k, mem_v } = await m.encoder.run({ image: f32(glyphInput(picture), [1, 3, 384, 384]) });
  let pk: ort.Tensor = f32(new Float32Array(0), [v.layers, 1, v.heads, 0, v.dh]), pv = pk, t = SOS, smiles = "", sum = 0, n = 0;
  for (let pos = 0; pos < v.max_len - 1; pos++) {
    const r = await m.step.run({ token: i64(t), pos: i64(pos), past_k: pk, past_v: pv, mem_k, mem_v });
    pk = r.k; pv = r.v;
    const lp = r.logp.data as Float32Array;
    t = argmax(lp); sum += lp[t]; n++;
    if (t === EOS) break;
    if (t > 4) smiles += v.itos[t];
  }
  return { smiles, confidence: Math.exp(sum / Math.max(1, n)) };
}

// The text of a line of conditions (nitration, DMF, 80 °C, hν), read by PaddleOCR's PP-OCRv5 English line reader
// (Apache-2.0): the line, 48 pixels high, read as one string (CTC). Its alphabet is ASCII with °, Δ, µ, ² and ³.
type TextVocab = { keys: string[] };
export type TextModel = { rec: ort.InferenceSession; keys: string[] };

export async function loadText(p: Pack): Promise<TextModel> {
  return { rec: await session(p.files["rec.onnx"]), keys: (p.meta.vocab as TextVocab).keys };
}

export async function readText(m: TextModel, picture: Pixels): Promise<{ text: string; confidence: number }> {
  const h = 48, w = Math.max(16, Math.min(48 * 40, Math.ceil((h * picture.width) / Math.max(1, picture.height))));
  const input = tensor(resizeLinear(onWhite(picture), w, h), [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], false);
  const out = (await m.rec.run({ x: f32(input, [1, 3, h, w]) })) as Record<string, ort.Tensor>;
  const probs = Object.values(out)[0], [, steps, classes] = probs.dims, data = probs.data as Float32Array;
  let text = "", last = -1, sum = 0, n = 0;
  for (let t = 0; t < steps; t++) {
    let k = 0;
    for (let c = 1; c < classes; c++) if (data[t * classes + c] > data[t * classes + k]) k = c;
    if (k && k !== last) { text += m.keys[k] ?? ""; sum += data[t * classes + k]; n++; }
    last = k;
  }
  return { text: tidyConditions(text), confidence: n ? sum / n : 0 };
}

// Chemistry in a line the reader reads as text: hv is hν, the increment sign is a Δ, oC after a number is °C.
export const tidyConditions = (t: string) => t.trim().replace(/\s+/g, " ").replace(/\bhv\b/g, "hν").replace(/∆/g, "Δ").replace(/(\d\s?)[oº]C\b/g, "$1°C");

// A reaction arrow as read: its ends in the picture's pixels, its kind, and its conditions as lines of text, top to
// bottom, above and below it. A line the reader is unsure of, or reads as no letter or digit, is left out (a stray
// mark on a scan).
export type ReadArrow = Pick<FoundArrow, "from" | "to" | "kind"> & { above: string[]; below: string[] };
export async function readArrows(m: TextModel, picture: Pixels, arrows: FoundArrow[]): Promise<ReadArrow[]> {
  const lines = async (boxes: Box[]) => {
    const out: string[] = [];
    for (const b of boxes) {
      const r = await readText(m, crop(picture, { x: b.x - 3, y: b.y - 3, w: b.w + 6, h: b.h + 6 }));
      if (r.confidence >= 0.8 && /[\p{L}\p{N}]/u.test(r.text)) out.push(r.text);
    }
    return out;
  };
  const read: ReadArrow[] = [];
  for (const a of arrows) read.push({ from: a.from, to: a.to, kind: a.kind, above: (await lines(a.above)).reverse(), below: await lines(a.below) });
  return read;
}
