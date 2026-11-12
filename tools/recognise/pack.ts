// Run: node tools/recognise/pack.ts <molscribe|glyph|text> <folder from the export> <out.octmodel>. Packs one exported
// model (its .onnx files and vocab.json) into the one file Octet installs, and prints its SHA-256 for KNOWN_MODELS.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writePack } from "../../src/recognise-models.ts";

const [name, dir, out] = process.argv.slice(2);
const SOURCES = {
  molscribe: { version: "1m680k-q8", licence: "MIT", source: "MolScribe, Yujie Qian et al., https://github.com/thomas0809/MolScribe (swin_base_char_aux_1m680k.pth)" },
  glyph: { version: "2026-q8", licence: "Apache-2.0", source: "OCSRGlyph, Edison Scientific, https://huggingface.co/EdisonScientific/OCSRGlyph (model.pth)" },
  text: { version: "PP-OCRv5-en", licence: "Apache-2.0", source: "PaddleOCR PP-OCRv5 English text line reader, ONNX from https://huggingface.co/monkt/paddleocr-onnx (languages/english/rec.onnx, dict.txt)" },
} as const;
if (!(name in SOURCES) || !dir || !out) throw new Error("node tools/recognise/pack.ts <molscribe|glyph|text> <folder> <out.octmodel>");
const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".onnx")).sort().map((f) => [f, new Uint8Array(readFileSync(join(dir, f)))]));
const vocab = JSON.parse(readFileSync(join(dir, "vocab.json"), "utf8"));
const bytes = writePack({ name: name as "molscribe" | "glyph" | "text", ...SOURCES[name as keyof typeof SOURCES], vocab }, files);
writeFileSync(out, bytes);
console.log(out, bytes.length, createHash("sha256").update(bytes).digest("hex"));
