// Picture to structure (decision 0023): the worker that finds and reads the structures in a picture, so the canvas
// stays responsive while the models run (about 2 s per structure for each model). It gets the three model files
// once, then pictures as RGBA pixels, and answers with each structure as it is read, then the reaction arrows with
// their conditions.
import wasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { findScheme } from "./recognise-find.ts";
import { crop, type Box, type Pixels } from "./recognise-image.ts";
import { type GlyphModel, loadGlyph, loadMolScribe, loadText, type MolScribeModel, type ReadArrow, readArrows, readGlyph, readMolScribe, readPack, setRuntime, type TextModel } from "./recognise-models.ts";

setRuntime(wasm);
let ms: MolScribeModel | undefined, gl: GlyphModel | undefined, tx: TextModel | undefined;

export type ToWorker =
  | { type: "load"; molscribe: Uint8Array; glyph: Uint8Array; text: Uint8Array }
  | { type: "read"; id: number; picture: Pixels };
export type FromWorker =
  | { type: "loaded" }
  | { type: "found"; id: number; boxes: Box[] }
  | { type: "read"; id: number; index: number; graph: Awaited<ReturnType<typeof readMolScribe>>; glyph: Awaited<ReturnType<typeof readGlyph>> }
  | { type: "arrows"; id: number; arrows: ReadArrow[] }
  | { type: "done"; id: number }
  | { type: "error"; id?: number; message: string };

const post = (m: FromWorker) => postMessage(m);
onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      [ms, gl, tx] = await Promise.all([loadMolScribe(readPack(m.molscribe)), loadGlyph(readPack(m.glyph)), loadText(readPack(m.text))]);
      return post({ type: "loaded" });
    }
    if (!ms || !gl || !tx) return post({ type: "error", id: m.id, message: "The models are not loaded." });
    const scheme = findScheme(m.picture), boxes = scheme.structures.map((f) => f.box);
    post({ type: "found", id: m.id, boxes });
    for (let index = 0; index < boxes.length; index++) {
      const part = crop(m.picture, boxes[index]);
      post({ type: "read", id: m.id, index, graph: await readMolScribe(ms, part), glyph: await readGlyph(gl, part) });
    }
    post({ type: "arrows", id: m.id, arrows: await readArrows(tx, m.picture, scheme.arrows) });
    post({ type: "done", id: m.id });
  } catch (err) {
    post({ type: "error", id: m.type === "read" ? m.id : undefined, message: err instanceof Error ? err.message : String(err) });
  }
};
