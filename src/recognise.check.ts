// Run: node src/recognise.check.ts. Fails loudly if Picture to Structure (decision 0023) breaks anywhere that needs no
// model: preparing a picture as each model was trained, finding every structure in every test picture, reading the
// atoms MolScribe writes, building a structure (labels, charges, wedges) from what the models read in the test
// pictures (tests/recognise/readings.json), weighing the two models, placing the structures beside their picture,
// and the model file's format. scripts/recognise-bench.ts runs the models themselves when they are on the computer.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// chem.ts reads the drawing tokens and loads Indigo's wasm as a browser does; these stand in for the browser.
const g = globalThis as Record<string, unknown>;
g.document = { documentElement: {}, createElement: () => ({ getContext: () => ({}) }) };
g.getComputedStyle = () => ({ getPropertyValue: () => "10" });
g.window = globalThis;
g.self = { location: { origin: "file://" } };
g.fetch = async (u: URL | string) => new Response(readFileSync(new URL(String(u))), { headers: { "content-type": "application/wasm" } });
const { ready } = await import("./chem.ts");
const { blank, crop, decodePng, glyphInput, inkBox, molscribeInput, pad, resizeLinear, resizeSmooth } = await import("./recognise-image.ts");
const { findScheme } = await import("./recognise-find.ts");
const { graphMol, readSymbol } = await import("./recognise-build.ts");
const { PACK_MAGIC, readPack, tidyConditions, writePack } = await import("./recognise-models.ts");
const { inchiOf, judge, placeReadings, skeleton } = await import("./recognise.ts");
await ready;

// Pictures: a 2 × 2 picture of black and white, scaled as OpenCV and Pillow scale it.
const px = (w: number, h: number, v: number[]) => ({ width: w, height: h, rgba: new Uint8ClampedArray(v.flatMap((x) => [x, x, x, 255])) });
const two = px(2, 2, [0, 255, 255, 0]);
assert.deepEqual([...resizeLinear(two, 4, 4).rgba.filter((_, i) => i % 4 === 0)], [0, 64, 191, 255, 64, 96, 159, 191, 191, 159, 96, 64, 255, 191, 64, 0]);
// The numbers OpenCV 4.8 and Pillow 12 give.
assert.deepEqual([...resizeSmooth(px(4, 1, [0, 0, 255, 255]), 2, 1).rgba.filter((_, i) => i % 4 === 0)], [36, 219]); // shrinking smooths
assert.deepEqual([...resizeSmooth(px(6, 1, [0, 0, 0, 255, 255, 255]), 2, 1).rgba.filter((_, i) => i % 4 === 0)], [32, 223]);
assert.deepEqual(inkBox(pad(two, 3)), { x: 3, y: 3, w: 2, h: 2 });
assert.equal(inkBox(blank(5, 5)), undefined);
assert.deepEqual(crop(px(3, 1, [1, 2, 3]), { x: 1, y: 0, w: 5, h: 1 }).width, 2); // a box past the edge is cut to it
// MolScribe's input is the ink with 5 white pixels round it; its atom places are fractions of that frame.
const dot = pad(px(1, 1, [0]), 20), ms = molscribeInput(dot);
assert.deepEqual(ms.frame, { x: 15, y: 15, w: 11, h: 11 });
assert.equal(ms.input.length, 3 * 384 * 384);
assert.ok(Math.abs(ms.input[0] - (1 - 0.485) / 0.229) < 1e-5, "white paper is ImageNet-normalised white");
assert.ok(Math.abs(glyphInput(dot)[0] - 1) < 1e-6, "OCSRGlyph's paper is 1");
// A transparent picture is white paper, not black.
assert.equal(inkBox({ width: 2, height: 1, rgba: new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255]) })?.x, 1);

// Every test picture: it decodes, and every structure in it is found, and nothing else (no arrow, caption or number).
// findNow: a picture the finder does not get right yet (crowded old patent pages, a scan's broken bonds), with the
// number it finds now: a later version may come closer, never further away.
const root = new URL("../tests/recognise/", import.meta.url);
let pictures = 0;
for (const set of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
  const at = new URL(`${set}/cases.json`, root);
  if (!existsSync(at)) continue;
  type Case = { file: string; smiles: string | string[]; findNow?: number; arrows?: { above: string[]; below: string[] }[]; arrowsNow?: number };
  for (const c of JSON.parse(readFileSync(at, "utf8")) as Case[]) {
    const picture = await decodePng(new Uint8Array(readFileSync(new URL(`${set}/${c.file}`, root))));
    const scheme = findScheme(picture), want = Array.isArray(c.smiles) ? c.smiles.length : 1, n = scheme.structures.length;
    // Reaction arrows: as many as the figure has (or, for a branched arrow not read yet, as many as now), each with as
    // many lines of conditions above and below as it has.
    if (c.arrows) {
      assert.equal(scheme.arrows.length, c.arrowsNow ?? c.arrows.length, `${set}/${c.file}: arrows`);
      if (c.arrowsNow === undefined) {
        const lines = (xs: { above: unknown[]; below: unknown[] }[]) => xs.map((a) => `${a.above.length}/${a.below.length}`).sort().join(" ");
        assert.equal(lines(scheme.arrows), lines(c.arrows), `${set}/${c.file}: lines of conditions`);
        assert.ok(scheme.arrows.every((a) => a.kind === "reaction" && a.to[0] > a.from[0]), `${set}/${c.file}: reaction arrows, left to right`);
      }
    }
    if (c.findNow === undefined) assert.equal(n, want, `${set}/${c.file}: ${want} structures`);
    else assert.ok(Math.abs(n - want) <= Math.abs(c.findNow - want), `${set}/${c.file}: ${n} structures found, ${c.findNow} before, ${want} there`);
    pictures++;
  }
}
assert.ok(pictures >= 110, "the drawn, new and old sets are there");

// Atoms as MolScribe writes them.
assert.deepEqual(readSymbol("C"), { label: "C" });
assert.deepEqual(readSymbol("c"), { label: "C" });
assert.deepEqual(readSymbol("Cl"), { label: "Cl" });
assert.deepEqual(readSymbol("[NH+]"), { label: "N", charge: 1 });
assert.deepEqual(readSymbol("[O-]"), { label: "O", charge: -1 });
assert.deepEqual(readSymbol("[N+2]"), { label: "N", charge: 2 });
assert.deepEqual(readSymbol("[13CH3]"), { label: "C", isotope: 13 });
assert.deepEqual(readSymbol("[C@@H]"), { label: "C" });
assert.deepEqual(readSymbol("[B-]"), { label: "B", charge: -1 });
assert.deepEqual(readSymbol("[H]"), { label: "H" });
assert.deepEqual(readSymbol("[OMe]"), { label: "C", text: "OMe" }); // a label stays as written
assert.deepEqual(readSymbol("[tBu]"), { label: "C", text: "tBu" });
assert.deepEqual(readSymbol("[R1]"), { label: "C", text: "R1" });
assert.deepEqual(readSymbol("[Xy]"), { label: "C", text: "Xy" }); // not an element: a label Octet shows as written
assert.deepEqual(readSymbol("[OC2H5]"), { label: "C", text: "OEt" }); // a condensed formula as the abbreviation Octet reads
assert.deepEqual(readSymbol("[C6H5]"), { label: "C", text: "Ph" });

// What the models read in seven test pictures, recorded (tools/recognise/record.ts): each becomes the structure the
// picture shows, with its labels (tBu, MeO), charges (lucigenin, BODIPY) and wedges (ibuprofen, penicillin, glucose).
type Recorded = { file: string; graph: Parameters<typeof graphMol>[0]; glyph: { smiles: string; confidence: number } };
const readings: Recorded[] = JSON.parse(readFileSync(new URL("readings.json", root), "utf8"));
const cases = JSON.parse(readFileSync(new URL("drawn/cases.json", root), "utf8")) as { file: string; smiles: string }[];
const wanted = (file: string) => inchiOf(cases.find((c) => `drawn/${c.file}` === file)!.smiles)!;
for (const r of readings) {
  const mol = graphMol(r.graph), want = wanted(r.file);
  assert.equal(inchiOf(mol), want, `${r.file}: MolScribe's reading is the structure`);
  const j = judge(r.graph, r.glyph);
  assert.equal(j.inchi, want, `${r.file}: Octet's answer`);
  if (j.agree) assert.ok(j.sure && j.chosen === "molscribe", "agreeing models keep MolScribe's drawing, and are sure");
  // Bonds are about one bond length (the picture's median bond is 1).
  const ls = mol.bonds.map((b) => Math.hypot(mol.atoms[b.atoms[0]].location[0] - mol.atoms[b.atoms[1]].location[0], mol.atoms[b.atoms[0]].location[1] - mol.atoms[b.atoms[1]].location[1])).sort((a, b) => a - b);
  assert.ok(Math.abs(ls[ls.length >> 1] - 1) < 1e-9, `${r.file}: median bond is one bond length`);
}
// A wedge is drawn from the stereocentre, never from a hydrogen or a label.
const ibuprofen = graphMol(readings.find((r) => r.file === "drawn/drawn-14.png")!.graph);
for (const b of ibuprofen.bonds.filter((b) => b.stereo)) assert.equal(ibuprofen.bonds.filter((x) => x.atoms.includes(b.atoms[0])).length, 3, "the wedge starts at the stereocentre");
// The picture's labels stay labels: Octet's chemistry expands them, the drawing shows them as the author wrote them.
const boc = graphMol(readings.find((r) => r.file === "drawn/drawn-27.png")!.graph);
assert.deepEqual(boc.atoms.flatMap((a) => (a.text ? [a.text] : [])).sort(), ["MeO", "tBu"]);

// Weighing: MolScribe's answer, however confident OCSRGlyph is, and sure only when both agree. When MolScribe reads
// nothing Octet can use, OCSRGlyph's.
const lum = readings[0];
const disagree = judge(lum.graph, { smiles: "c1ccccc1", confidence: 0.99 });
assert.ok(!disagree.agree && !disagree.sure && disagree.chosen === "molscribe");
assert.equal(judge({ ...lum.graph, atoms: [], bonds: [] }, { smiles: "c1ccccc1", confidence: 0.5 }).chosen, "glyph");
assert.equal(judge(lum.graph, { smiles: "not smiles(", confidence: 0.99 }).chosen, "molscribe");
// Conditions as the text reader gives them, in chemistry's spelling.
assert.equal(tidyConditions(" hv "), "hν");
assert.equal(tidyConditions("DMF,  80 oC"), "DMF, 80 °C");
assert.equal(tidyConditions("∆, 2 h"), "Δ, 2 h");
assert.equal(tidyConditions("Hv lamp"), "Hv lamp");
assert.equal(skeleton("InChI=1S/C3H7NO2/c1-2(4)3(5)6/h2H,4H2,1H3,(H,5,6)/t2-/m0/s1"), "InChI=1S/C3H7NO2/c1-2(4)3(5)6/h2H,4H2,1H3,(H,5,6)");

// Placing: each structure beside the picture (right of it, from its top), in the picture's arrangement, scaled so the
// picture's bonds are one bond length; an unsure one's atoms are listed.
const r0 = judge(readings[0].graph, readings[0].glyph), r1 = judge({ ...readings[1].graph, atoms: [], bonds: [] }, { smiles: "C", confidence: 0.99 });
assert.ok(r0.sure && r1.chosen === "glyph" && !r1.sure);
const frame = { left: 0, right: 10, top: 5, bottom: -5, width: 1000, height: 400 };
const placed = placeReadings([{ box: { x: 0, y: 0, w: 200, h: 200 }, reading: r0 }, { box: { x: 600, y: 0, w: 200, h: 200 }, reading: r1 }], frame);
assert.equal(placed.mol.atoms.length, r0.molscribe.mol.atoms.length + 1);
assert.ok(placed.mol.atoms.every((a) => a.location[0] > frame.right), "beside the picture, not on it");
const xs = (from: number, to: number) => placed.mol.atoms.slice(from, to).map((a) => a.location[0]);
assert.ok(Math.min(...xs(r0.molscribe.mol.atoms.length, Infinity)) > Math.max(...xs(0, r0.molscribe.mol.atoms.length)), "left to right as in the picture");
assert.deepEqual(placed.unsure, [[r0.molscribe.mol.atoms.length]]);
// A reaction arrow between them, at the same scale, with its conditions above (two lines, top first) and below, as the
// arrow's own text: Octet keeps it with the arrow and sets it as a formula.
const withArrow = placeReadings([{ box: { x: 0, y: 0, w: 200, h: 200 }, reading: r0 }], frame, [{ from: [300, 100], to: [500, 100], kind: "reaction", above: ["Br2, FeBr3", "CH2Cl2"], below: ["0 °C"] }]);
const [arrow] = withArrow.mol.arrows!;
assert.ok(arrow.kind === "reaction" && arrow.to[0] > arrow.from[0] && arrow.from[0] > frame.right && Math.abs(arrow.from[1] - arrow.to[1]) < 1e-9);
assert.deepEqual(withArrow.mol.captions!.map((c) => [c.text, c.on]), [["Br2, FeBr3\nCH2Cl2", { arrow: arrow.id, side: "above" }], ["0 °C", { arrow: arrow.id, side: "below" }]]);

// Model files: read back as written; a wrong start, a short file or extra bytes are refused.
const packed = writePack({ name: "glyph", version: "t", licence: "MIT", source: "test", vocab: { a: 1 } }, { "a.onnx": new Uint8Array([1, 2, 3]), "b.onnx": new Uint8Array([4]) });
const back = readPack(packed);
assert.deepEqual([...back.files["a.onnx"]], [1, 2, 3]);
assert.deepEqual([...back.files["b.onnx"]], [4]);
assert.deepEqual(back.meta.vocab, { a: 1 });
assert.throws(() => readPack(packed.subarray(0, packed.length - 1)));
assert.throws(() => readPack(new Uint8Array([...packed, 0])));
assert.throws(() => readPack(new TextEncoder().encode("OCTETMODEL2\n....")));
assert.equal(PACK_MAGIC, "OCTETMODEL1\n");

// The command is where the user looks for it: the Structure menu, the command palette, and a picture's actions.
const main = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8"), editor = readFileSync(new URL("Editor.tsx", import.meta.url), "utf8");
assert.match(main, /item\("recognise_structures", "Convert Picture to Structures", ""\)/);
assert.match(main, /recognise::recognise_models, recognise::recognise_model, recognise::recognise_install, recognise::recognise_download/);
assert.match(editor, /recognise_structures: \(\) => void recognisePictures\(\),/);
assert.match(editor, /recognise_structures: \["Convert picture to structures", "", <Scan size=\{18\} \/>\]/);
assert.match(readFileSync(new URL("Actions.tsx", import.meta.url), "utf8"), /context\.shape === "picture"\) items\.push\(\{ \.\.\.it\(<Scan size=\{18\} \/>, "Convert picture to structures", "recognise_structures"\)/);
// The page's rules stay as they are: no network for the models, no fetch of the picture.
const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
assert.doesNotMatch(conf.app.security.csp, /connect-src|https:/);
console.log(`recognise.check: ${pictures} test pictures, ${readings.length} recorded readings, all pass`);
