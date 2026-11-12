// Picture to structure (decision 0023): from a picture to editable structures. The worker (recognise.worker.ts) finds
// each structure in the picture and reads it with both models; here, on the page, where Indigo is, each reading
// becomes a structure and the two models' answers are weighed against each other.
//
// The answer is MolScribe's drawing, which keeps the picture's layout. OCSRGlyph is the second opinion: when it reads
// the same structure (the same standard InChI) the answer is sure, and when it differs the structure is selected for
// the user to check. On the bench (scripts/recognise-bench.ts, 205 structures in four sets) the two agree on 56% of
// the structures and are then right 98% of the time; where they differ MolScribe is right three times as often as
// OCSRGlyph, and neither model's own confidence tells right from wrong.
import { importStructure, toInchi } from "./chem.ts";
import { graphMol } from "./recognise-build.ts";
import { type Box, MAX_PIXELS, type Pixels } from "./recognise-image.ts";
import type { Graph, ReadArrow } from "./recognise-models.ts";
import type { FromWorker, ToWorker } from "./recognise.worker.ts";
import type { Mol } from "./render.ts";

export const inchiOf = (m: Mol | string | undefined): string | undefined => {
  if (!m || (typeof m !== "string" && !m.atoms.length)) return undefined;
  const i = toInchi(m);
  return i && i !== "InChI=1S//" ? i : undefined;
};
// The InChI without its stereo layers (double bonds, tetrahedral centres, their parity and kind).
export const skeleton = (inchi: string) => inchi.split("/").filter((l) => !/^[btms]/.test(l)).join("/");

export type Reading = {
  molscribe: Graph & { inchi?: string; mol: Mol };
  glyph: { smiles: string; confidence: number; inchi?: string };
  chosen: "molscribe" | "glyph";
  agree: boolean; // both models read the same structure
  sure: boolean; // the answer is likely right: both models read it
  inchi?: string;
};

// MolScribe's answer, unless it read no structure Octet can make sense of; sure when both models agree.
export function judge(ms: Graph, gl: { smiles: string; confidence: number }): Reading {
  const mol = graphMol(ms), msInchi = inchiOf(mol), glInchi = inchiOf(gl.smiles);
  const molscribe = { ...ms, mol, inchi: msInchi }, glyph = { ...gl, inchi: glInchi };
  const agree = !!msInchi && msInchi === glInchi, chosen = msInchi || !glInchi ? "molscribe" : "glyph";
  return { molscribe, glyph, chosen, agree, sure: agree, inchi: chosen === "molscribe" ? msInchi : glInchi };
}

// The structure to place: MolScribe's drawing as the picture had it, or OCSRGlyph's structure laid out by Indigo.
export function structureOf(r: Reading): Mol | undefined {
  if (r.chosen === "molscribe") return r.molscribe.mol.atoms.length ? r.molscribe.mol : undefined;
  try { return importStructure(r.glyph.smiles); } catch { return undefined; }
}

// Where the structures go: beside the picture, in the picture's own arrangement, scaled so the median bond the
// picture shows is one bond length. A structure OCSRGlyph gave (laid out by Indigo) goes where its box was. Each
// reaction arrow goes where it was, with its conditions as the arrow's own text above and below it (Octet sets them
// as formulas and keeps them with the arrow).
// picture: the picture's box in the drawing (bond lengths, y up) and its size in pixels.
export type PictureFrame = { left: number; right: number; top: number; bottom: number; width: number; height: number };
export type Placed = { mol: Mol; unsure: number[][] };
export function placeReadings(found: { box: Box; reading: Reading }[], frame: PictureFrame, arrows: ReadArrow[] = []): Placed {
  const units = found.flatMap(({ reading: r }) => {
    const g = r.molscribe, ls = g.bonds.map((b) => Math.hypot(g.atoms[b.a].x - g.atoms[b.b].x, g.atoms[b.a].y - g.atoms[b.b].y)).sort((a, b) => a - b);
    return ls.length ? [ls[ls.length >> 1]] : [];
  }).sort((a, b) => a - b);
  const k = 1 / (units.length ? units[units.length >> 1] : 30), x0 = frame.right + 1.5, y0 = frame.top;
  const out: Mol = { atoms: [], bonds: [] }, unsure: number[][] = [];
  for (const { box, reading } of found) {
    const m = structureOf(reading);
    if (!m?.atoms.length) continue;
    const xs = m.atoms.map((a) => a.location[0]), ys = m.atoms.map((a) => a.location[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const tx = x0 + (box.x + box.w / 2) * k, ty = y0 - (box.y + box.h / 2) * k, base = out.atoms.length;
    out.atoms.push(...m.atoms.map((a) => ({ ...a, location: [a.location[0] - cx + tx, a.location[1] - cy + ty, 0] as [number, number, number] })));
    out.bonds.push(...m.bonds.map((b) => ({ ...b, atoms: [b.atoms[0] + base, b.atoms[1] + base] as [number, number] })));
    if (!reading.sure) unsure.push(m.atoms.map((_, i) => base + i));
  }
  const at = (q: [number, number]): [number, number] => [x0 + q[0] * k, y0 - q[1] * k];
  let id = 1;
  for (const a of arrows) {
    const arrow = { id: id++, kind: a.kind, from: at(a.from), to: at(a.to) }, mx = (arrow.from[0] + arrow.to[0]) / 2, my = (arrow.from[1] + arrow.to[1]) / 2;
    (out.arrows ??= []).push(arrow);
    for (const side of ["above", "below"] as const)
      if (a[side].length) (out.captions ??= []).push({ id: id++, text: a[side].join("\n"), x: mx, y: my + (side === "above" ? 0.5 : -0.9), on: { arrow: arrow.id, side } });
  }
  return { mol: out, unsure };
}

// The app's side of the worker: the models go to it once, then each picture.
export type ModelSource = (name: "molscribe" | "glyph" | "text") => Promise<Uint8Array>;
let worker: Worker | undefined, loading: Promise<void> | undefined, nextRead = 1;
const waiting = new Map<number, (m: FromWorker) => void>();

export function startReader(source: ModelSource): Promise<void> {
  if (loading) return loading;
  const w = (worker = new Worker(new URL("./recognise.worker.ts", import.meta.url), { type: "module" }));
  loading = new Promise<void>((resolve, reject) => {
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === "loaded") return resolve();
      if (m.type === "error" && m.id === undefined) { loading = undefined; worker = undefined; w.terminate(); return reject(new Error(m.message)); }
      if ("id" in m && m.id !== undefined) waiting.get(m.id)?.(m);
    };
    Promise.all([source("molscribe"), source("glyph"), source("text")]).then(([molscribe, glyph, text]) => w.postMessage({ type: "load", molscribe, glyph, text } satisfies ToWorker, [molscribe.buffer, glyph.buffer, text.buffer]),
      (err) => { loading = undefined; worker = undefined; w.terminate(); reject(err); });
  });
  return loading;
}

// Every structure in a picture, read by both models and weighed (judge), and the reaction arrows with their
// conditions. onStep: how many structures are read, of how many.
export type PictureRead = { structures: { box: Box; reading: Reading }[]; arrows: ReadArrow[] };
export async function readStructures(picture: Pixels, onStep?: (done: number, of: number) => void): Promise<PictureRead> {
  if (!worker || !loading) throw new Error("The models are not loaded.");
  await loading;
  const id = nextRead++, out: { box: Box; reading: Reading }[] = [];
  let boxes: Box[] = [], arrows: ReadArrow[] = [];
  return new Promise((resolve, reject) => {
    waiting.set(id, (m) => {
      if (m.type === "found") { boxes = m.boxes; onStep?.(0, boxes.length); }
      else if (m.type === "read") { out.push({ box: boxes[m.index], reading: judge(m.graph, m.glyph) }); onStep?.(out.length, boxes.length); }
      else if (m.type === "arrows") arrows = m.arrows;
      else if (m.type === "done") { waiting.delete(id); resolve({ structures: out, arrows }); }
      else if (m.type === "error") { waiting.delete(id); reject(new Error(m.message)); }
    });
    worker!.postMessage({ type: "read", id, picture } satisfies ToWorker, [picture.rgba.buffer]);
  });
}

// A picture's pixels, by the webview's own decoder (any format it reads), within MAX_PIXELS. Through an image
// element: the page's rules let it show a data: address but not fetch one.
export async function decodePicture(url: string): Promise<Pixels> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const bitmap = await createImageBitmap(img);
  if (bitmap.width * bitmap.height > MAX_PIXELS) throw new RangeError("The picture has too many pixels to read.");
  const c = new OffscreenCanvas(bitmap.width, bitmap.height), g = c.getContext("2d")!;
  g.drawImage(bitmap, 0, 0);
  const data = g.getImageData(0, 0, bitmap.width, bitmap.height);
  return { width: data.width, height: data.height, rgba: data.data };
}
