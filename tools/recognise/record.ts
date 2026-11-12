// Run: node tools/recognise/record.ts <out.json> <picture.png> ... Records what both models read in each picture
// (MolScribe's atoms and bonds, OCSRGlyph's SMILES), so src/recognise.check.ts can test everything after the models
// on every computer, with no model there.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { decodePng } from "../../src/recognise-image.ts";
import { loadGlyph, loadMolScribe, readGlyph, readMolScribe, readPack } from "../../src/recognise-models.ts";

const [out, ...files] = process.argv.slice(2), models = process.env.OCTET_RECOGNISE_MODELS ?? join(homedir(), "octet-research/models");
const ms = await loadMolScribe(readPack(new Uint8Array(readFileSync(join(models, "molscribe.octmodel")))));
const gl = await loadGlyph(readPack(new Uint8Array(readFileSync(join(models, "glyph.octmodel")))));
const round = (v: number) => Math.round(v * 1000) / 1000;
const rows = [];
for (const f of files) {
  const px = await decodePng(new Uint8Array(readFileSync(f)));
  const g = await readMolScribe(ms, px), s = await readGlyph(gl, px);
  rows.push({ file: relative(join(import.meta.dirname, "../../tests/recognise"), f).split("\\").join("/"),
    graph: { ...g, confidence: round(g.confidence), atoms: g.atoms.map((a) => ({ ...a, x: round(a.x), y: round(a.y), score: round(a.score) })), bonds: g.bonds.map((b) => ({ ...b, score: round(b.score) })) },
    glyph: { smiles: s.smiles, confidence: round(s.confidence) } });
}
writeFileSync(out, JSON.stringify(rows, null, 1) + "\n");
