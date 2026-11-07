// Run: node src/photochemistry.check.ts. The library's Photochemistry group
// (tools/library/photochemistry.mjs): the transitions, species and Jablonski diagrams
// photophysics is written in. Each is one integral group that goes where it is placed, takes
// the document's line width, and comes back whole from CDXML and from a .oct file.
//
// The round trip is the point of this file. The species are captions with superscript and
// subscript runs (¹O₂, ³X*), which is exactly what did not survive CDXML before 1.1.1
// (issue 31), and the hν and Δ labels are conditions on an arrow, which have their own
// layout path. A template that loses its superscript on the way to Word is no use to anyone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arialGlyph, fromCdxml, toCdxml } from "./cdxml.ts";
import { DEFAULT_STYLE } from "./docstyle.ts";
import { addRing, addTemplate, EMPTY } from "./edit.ts";
import { readOct, writeOct } from "./oct.ts";
import { plainOf } from "./richtext.ts";
import { arrowShapes, type Arrow, type Caption, type Mol } from "./render.ts";
import { DEFAULT_STYLE as STYLE_SPEC, frameStyle } from "./docstyle.ts";

type Item = { name: string; also?: string; mol: Mol };
const library: { name: string; items: Item[] }[] = JSON.parse(readFileSync(new URL("./library.json", import.meta.url), "utf8"));
const set = library.find((c) => c.name === "Photochemistry") ?? assert.fail("no Photochemistry group in the library");

assert.deepEqual(set.items.map((t) => t.name), [
  "Reaction arrow, hν", "Reaction arrow, Δ",
  "Absorption (hν)", "Fluorescence", "Phosphorescence", "Intersystem crossing", "Internal conversion",
  "Vibrational relaxation", "Energy transfer",
  "Singlet oxygen", "Triplet oxygen", "Excited singlet state", "Excited triplet state", "Excited sensitiser",
  "Jablonski diagram", "Jablonski diagram with vibrational levels",
]);

const near = (a: number, b: number, d = 2e-3) => Math.abs(a - b) <= d;
// A caption's own point, or nothing when it is a condition Octet lays out from its arrow.
const freeCaptions = (m: Mol) => (m.captions ?? []).filter((c) => !c.on);
const box = (m: Mol) => {
  const qs = [...(m.arrows ?? []).flatMap((a) => [a.from, a.to]), ...freeCaptions(m).map((c): [number, number] => [c.x, c.y])];
  return [Math.min(...qs.map((q) => q[0])), Math.min(...qs.map((q) => q[1])), Math.max(...qs.map((q) => q[0])), Math.max(...qs.map((q) => q[1]))];
};
const runsOfText = (c: Caption) => (c.runs ?? []).map((r) => [r.text, r.script ?? ""]);
// For comparing what came back from a file with what went in. Two things differ without
// meaning anything: a key that is absent and a key set to undefined (addTemplate leaves
// angle: undefined on a caption it copies, and a .oct file simply has no such key), and the
// last bits of a coordinate (a .oct file keeps three decimals, so 4.8629999999999995 comes
// back as 4.863). Both are settled here, so the comparison is about what was kept.
const same = (x: unknown) =>
  JSON.parse(JSON.stringify(x ?? null), (_, v) => (typeof v === "number" ? Math.round(v * 1e3) / 1e3 : v));

for (const t of set.items) {
  const m = t.mol, arrows = m.arrows ?? [], captions = m.captions ?? [];
  // Drawn with Octet's own objects, no structure, all in one integral group.
  assert.equal(m.atoms.length + m.bonds.length, 0, t.name);
  assert.ok(arrows.length + captions.length > 0, t.name);
  assert.ok(arrows.every((a) => a.kind === "reaction" || a.kind === "line"), t.name);
  const inside = [...arrows.map((a) => a.id), ...captions.map((c) => c.id)].sort((x, y) => x - y);
  // One integral group holds the whole item — unless the item is a single caption, which
  // groups nothing and which CDXML drops a group around anyway.
  const grouped = inside.length > 1;
  assert.deepEqual(m.groups?.map((g) => [g.atoms.length, [...g.items].sort((x, y) => x - y), g.integral]) ?? [], grouped ? [[0, inside, true]] : [], t.name);
  assert.equal(new Set(inside).size, inside.length, `${t.name}: arrows and captions share one id space, so no id is used twice`);
  // One line width and one size: no object sets its own, so every line takes the document's.
  assert.ok(arrows.every((a) => a.width === undefined && a.scale === undefined && a.colour === undefined), t.name);
  assert.ok(captions.every((c) => c.size === undefined && c.colour === undefined), t.name);
  // A label may name a font, but only the serif hν is set in, so that the Greek nu reads as
  // Greek; everything else takes the document's.
  assert.ok(captions.every((c) => c.font === undefined || (c.font === "Times New Roman" && c.text.startsWith("hν"))), t.name);
  // A caption's plain text is always its runs joined (render.ts), or the library ships a lie.
  assert.ok(captions.every((c) => !c.runs || plainOf(c.runs) === c.text), `${t.name}: text is its runs joined`);
  if (arrows.length) {
    const [x0, y0, x1, y1] = box(m);
    assert.ok(near((x0 + x1) / 2, 0) && near((y0 + y1) / 2, 0), `${t.name} is centred`);
    // Energy rises up the page: a level is horizontal and no item is drawn upside down.
    for (const a of arrows.filter((x) => x.kind === "line")) assert.ok(near(a.from[1], a.to[1]), `${t.name}: a level is horizontal`);
  }
  // IUPAC's convention: a radiative transition is a straight arrow, a non-radiative one wavy.
  // So the only styled shafts are the wavy ones, and nothing else is dashed or bold.
  assert.ok(arrows.every((a) => a.style === undefined || a.style === "wavy"), `${t.name}: only wavy shafts are styled`);

  // Placed at a point, its middle is there, with new ids in a new group.
  const placed = addTemplate(addRing(EMPTY, 6, false, { point: [-8, 0] }), m, { point: [10, 5] });
  assert.equal(placed.arrows?.length ?? 0, arrows.length, t.name);
  assert.equal(placed.captions?.length ?? 0, captions.length, t.name);
  assert.equal(placed.groups?.length ?? 0, grouped ? 1 : 0, `${t.name}: one group`);
  if (arrows.length) {
    const [a0, b0, a1, b1] = box({ ...placed, atoms: [], bonds: [] });
    assert.ok(near((a0 + a1) / 2, 10) && near((b0 + b1) / 2, 5), `${t.name} goes where it is placed`);
    // It keeps its way up: every point moves by the same step, so absorption still points up.
    placed.arrows!.forEach((a, i) => assert.ok(near(a.from[0], arrows[i].from[0] + 10) && near(a.from[1], arrows[i].from[1] + 5), `${t.name} keeps its way up`));
  }
  // A condition stays on its arrow through placing, with the arrow's new id.
  for (const c of captions.filter((x) => x.on)) {
    const now = placed.captions!.find((x) => x.text === c.text) ?? assert.fail(`${t.name}: ${c.text} is lost`);
    assert.equal(now.on?.side, c.on!.side, t.name);
    assert.ok(placed.arrows!.some((a) => a.id === now.on!.arrow), `${t.name}: ${c.text} still names an arrow of this drawing`);
  }

  // CDXML (as ChemDraw reads it): every arrow, caption, run and the group come back.
  const read = fromCdxml(toCdxml(placed, DEFAULT_STYLE));
  assert.deepEqual(read.lost, {}, t.name);
  assert.equal(read.mol.atoms.length, 6, t.name);
  assert.equal(read.mol.arrows?.length ?? 0, arrows.length, `${t.name}: every arrow comes back`);
  assert.equal(read.mol.captions?.length ?? 0, captions.length, `${t.name}: every caption comes back`);
  assert.deepEqual([...(read.mol.captions ?? [])].map((c) => c.text).sort(), captions.map((c) => c.text).sort(), `${t.name}: the text comes back`);
  // The superscripts and subscripts of ¹O₂ and ³X* survive, run for run.
  for (const c of captions.filter((x) => x.runs)) {
    const back = read.mol.captions!.find((x) => x.text === c.text) ?? assert.fail(`${t.name}: ${c.text} is lost`);
    assert.deepEqual(runsOfText(back), runsOfText(c), `${t.name}: ${c.text} keeps its superscripts and subscripts`);
  }
  // A wavy shaft stays wavy: a non-radiative transition that comes back straight is wrong.
  assert.equal((read.mol.arrows ?? []).filter((a) => a.style === "wavy").length, arrows.filter((a) => a.style === "wavy").length, `${t.name}: the wavy shafts come back`);
  assert.equal((read.mol.arrows ?? []).filter((a) => a.kind === "line").length, arrows.filter((a) => a.kind === "line").length, `${t.name}: the levels come back as lines`);
  assert.equal(read.mol.groups?.length ?? 0, grouped ? 1 : 0, `${t.name}: one group`);
  if (grouped) {
    assert.equal(read.mol.groups![0].items.length, arrows.length + captions.length, t.name);
    assert.ok(read.mol.groups![0].integral, "a click picks all of it, as ChemDraw's clip art");
  }

  // A .oct file gives it back as it was, to the bit.
  const oct = readOct(writeOct(placed, DEFAULT_STYLE)).mol;
  assert.deepEqual(same(oct.arrows), same(placed.arrows), `${t.name}: the arrows round-trip through .oct`);
  assert.deepEqual(same(oct.captions), same(placed.captions), `${t.name}: the captions round-trip through .oct`);
  assert.deepEqual(same(oct.groups), same(placed.groups), t.name);
}

// What the set is for, spelled out so a later edit cannot quietly drop it.
const by = (name: string) => set.items.find((t) => t.name === name) ?? assert.fail(`no ${name}`);
// The two reaction arrows carry their label as a condition, so it follows the arrow.
for (const name of ["Reaction arrow, hν", "Reaction arrow, Δ"]) {
  const m = by(name).mol, [a] = m.arrows!;
  assert.equal(m.arrows!.length, 1, name);
  assert.equal(m.captions!.length, 1, name);
  assert.deepEqual(m.captions![0].on, { arrow: a.id, side: "above" }, `${name}: the label is a condition on the arrow`);
}
// The species are written as photochemistry writes them: the multiplicity a left superscript,
// the excited state starred, the stoichiometry a subscript.
assert.deepEqual(runsOfText(by("Singlet oxygen").mol.captions![0]), [["1", "super"], ["O", ""], ["2", "sub"]]);
assert.deepEqual(runsOfText(by("Triplet oxygen").mol.captions![0]), [["3", "super"], ["O", ""], ["2", "sub"]]);
assert.deepEqual(runsOfText(by("Excited triplet state").mol.captions![0]), [["3", "super"], ["X", ""], ["*", "super"]]);
assert.deepEqual(runsOfText(by("Excited sensitiser").mol.captions![0]), [["Sens", ""], ["*", "super"]]);
// A state's number is a real subscript run, never the Unicode subscript character: U+2080
// and U+2081 are small full-height digits in Arial rather than subscripts, and they stay
// those characters in CDXML and in Word, where nobody can restyle them.
for (const name of ["Jablonski diagram", "Jablonski diagram with vibrational levels"]) {
  for (const [text, letter, index] of [["S0", "S", "0"], ["S1", "S", "1"], ["T1", "T", "1"]]) {
    const label = by(name).mol.captions!.find((c) => c.text === text) ?? assert.fail(`${name}: no ${text}`);
    assert.deepEqual(runsOfText(label), [[letter, ""], [index, "sub"]], `${name}: ${text} is a subscript run`);
  }
  assert.ok(by(name).mol.captions!.every((c) => !/[₀-ₜ⁰-ⁿ]/.test(c.text)), `${name}: no Unicode sub- or superscript characters`);
}
// hν is two physical quantities, so it is set in italic as the literature sets it, with a
// real Greek nu. The abbreviations beside it are abbreviations, so they stay upright.
for (const name of ["Reaction arrow, hν", "Absorption (hν)", "Fluorescence", "Phosphorescence"]) {
  const [label] = by(name).mol.captions!;
  // A real Greek nu, U+03BD, and a face that draws it as one. Arial — the document font —
  // draws a Greek nu as a plain v, so beside the Latin letter the two are one glyph and the
  // notation is lost. The whole label takes the serif, not only the nu: a serif nu next to a
  // sans h does not belong together on the page.
  assert.ok(label.text.includes("\u03bd"), `${name}: a Greek nu, not a Latin v`);
  assert.equal(label.font, "Times New Roman", `${name}: a face that draws the nu Greek`);
  assert.ok(!label.runs?.some((r) => r.font), `${name}: one face for the whole label`);
  assert.ok(!label.italic, `${name}: upright, since an italic serif nu leans back towards a v`);
}
for (const name of ["Reaction arrow, Δ", "Intersystem crossing", "Internal conversion", "Vibrational relaxation", "Energy transfer"]) {
  const [label] = by(name).mol.captions!;
  assert.ok(!label.italic && label.font === undefined, `${name}: the document's own font, upright`);
}
// No arrow sets a head of its own: a transition drawn with a special head would not match
// the arrows a chemist draws beside it in the same document.
for (const t of set.items) assert.ok((t.mol.arrows ?? []).every((a) => a.headSize === undefined), `${t.name}: Octet's own arrowheads`);

// No label touches an arrow.
//
// This is the check that was missing. Every label in the set was first placed by hand, at an
// offset measured from the arrow's centre line, and every one of them came out sitting ON
// its arrow — a wavy shaft swings each side of that line and an arrowhead is wider still.
// Measured here against what Octet actually draws, so an offset that only looks right cannot
// pass again.
{
  const S = frameStyle(STYLE_SPEC, (STYLE_SPEC.bond * 4) / 3);
  const BOND = S.bond, SIZE = (STYLE_SPEC.captionSize * 4 * S.k) / 3;
  const CAP = (0.716 * SIZE) / BOND;
  const widthOf = (c: Caption) =>
    (c.runs?.length ? c.runs : [{ text: c.text, script: undefined }])
      .reduce((w, r) => w + [...r.text].reduce((t, ch) => t + (arialGlyph(ch)[0] * (r.script ? SIZE * 0.68 : SIZE)) / 1000, 0), 0) / BOND;
  const inside = (p: number[], b: number[]) => p[0] > b[0] && p[0] < b[2] && p[1] > b[1] && p[1] < b[3];
  const turn = (a: number[], c: number[], e: number[]) => Math.sign((c[0] - a[0]) * (e[1] - a[1]) - (c[1] - a[1]) * (e[0] - a[0]));
  const cross = (p: number[], q: number[], r: number[], w: number[]) => turn(p, q, r) * turn(p, q, w) < 0 && turn(r, w, p) * turn(r, w, q) < 0;
  for (const t of set.items) {
    const edges: number[][][] = [];
    for (const a of t.mol.arrows ?? []) {
      for (const shape of arrowShapes(a as Arrow, S, BOND)) {
        const pts = shape.map(([x, y]) => [x / BOND, -y / BOND]);
        for (let i = 0; i < pts.length; i++) edges.push([pts[i], pts[(i + 1) % pts.length]]);
      }
    }
    for (const c of t.mol.captions ?? []) {
      if (c.on) continue; // a condition on an arrow is laid out by Octet, not placed here
      const w = widthOf(c), high = c.runs?.some((r) => r.script === "super") ? CAP + (0.33 * SIZE) / BOND : CAP;
      const low = c.runs?.some((r) => r.script === "sub") ? (0.212 * SIZE) / BOND : 0;
      const box = [c.x - w / 2, c.y - low, c.x + w / 2, c.y + high];
      const hit = edges.find(([p, q]) =>
        inside(p, box) || inside(q, box) ||
        [[[box[0], box[1]], [box[2], box[1]]], [[box[2], box[1]], [box[2], box[3]]], [[box[2], box[3]], [box[0], box[3]]], [[box[0], box[3]], [box[0], box[1]]]]
          .some(([r, v]) => cross(p, q, r, v)));
      assert.ok(!hit, `${t.name}: "${c.text}" sits on an arrow`);
    }
  }
}
// Absorption points up and emission down, or the diagram says the opposite of what it means.
assert.ok(by("Absorption (hν)").mol.arrows![0].to[1] > by("Absorption (hν)").mol.arrows![0].from[1], "absorption points up");
for (const name of ["Fluorescence", "Phosphorescence", "Internal conversion", "Vibrational relaxation"]) {
  const [a] = by(name).mol.arrows!;
  assert.ok(a.to[1] < a.from[1], `${name} points down`);
}
// Fluorescence and phosphorescence are radiative, so their shafts are straight; internal
// conversion, vibrational relaxation, intersystem crossing and energy transfer are not.
for (const name of ["Absorption (hν)", "Fluorescence", "Phosphorescence"]) assert.equal(by(name).mol.arrows![0].style, undefined, `${name} is radiative`);
for (const name of ["Intersystem crossing", "Internal conversion", "Vibrational relaxation", "Energy transfer"]) assert.equal(by(name).mol.arrows![0].style, "wavy", `${name} is non-radiative`);

// The Jablonski diagrams: three levels (S₀, S₁, T₁) with the ground state under both
// columns, the triplet to the right of the singlets and below S₁, and the four transitions
// between them. The intersystem crossing is the only one that is not vertical.
for (const name of ["Jablonski diagram", "Jablonski diagram with vibrational levels"]) {
  const m = by(name).mol, lines = m.arrows!.filter((a) => a.kind === "line"), heads = m.arrows!.filter((a) => a.kind === "reaction");
  const label = (text: string) => m.captions!.find((c) => c.text === text) ?? assert.fail(`${name}: no ${text}`);
  const [s0, s1, t1] = ["S0", "S1", "T1"].map(label);
  assert.ok(s1.y > t1.y && t1.y > s0.y, `${name}: S₁ over T₁ over S₀`);
  assert.ok(t1.x > s1.x && t1.x > s0.x, `${name}: the triplet is to the right of the singlets`);
  // The ground state is the widest level and reaches under the triplet column.
  const widest = lines.reduce((w, a) => (Math.abs(a.to[0] - a.from[0]) > Math.abs(w.to[0] - w.from[0]) ? a : w));
  assert.ok(near(widest.from[1], Math.min(...lines.map((a) => a.from[1])), 0.7), `${name}: the widest level is the ground state`);
  assert.ok(widest.to[0] > t1.x - 1.5, `${name}: the ground state runs under the triplet column`);
  // Absorption, fluorescence, phosphorescence and intersystem crossing, no more and no less.
  assert.ok(heads.length >= 4, `${name}: ${heads.length} transitions`);
  const slanted = heads.filter((a) => !near(a.from[0], a.to[0]));
  assert.equal(slanted.length, 1, `${name}: only the intersystem crossing is slanted`);
  assert.equal(slanted[0].style, "wavy", `${name}: the intersystem crossing is non-radiative`);
  assert.ok(slanted[0].to[1] < slanted[0].from[1] && slanted[0].to[0] > slanted[0].from[0], `${name}: it crosses down and to the right, S₁ to T₁`);
  assert.ok(heads.some((a) => near(a.from[0], a.to[0]) && a.to[1] > a.from[1] && !a.style), `${name}: absorption, up and radiative`);
  assert.ok(heads.filter((a) => near(a.from[0], a.to[0]) && a.to[1] < a.from[1] && !a.style).length >= 2, `${name}: fluorescence and phosphorescence, down and radiative`);
}
// The fuller diagram adds the vibrational manifolds: three sub-levels over each state, and
// relaxation down to the origin of S₁, which is what makes the Stokes shift visible.
{
  const plain = by("Jablonski diagram").mol, fuller = by("Jablonski diagram with vibrational levels").mol;
  assert.equal(fuller.arrows!.filter((a) => a.kind === "line").length, plain.arrows!.filter((a) => a.kind === "line").length + 9, "three sub-levels over each of the three states");
  const vertical = fuller.arrows!.filter((a) => a.kind === "reaction" && a.style === "wavy" && near(a.from[0], a.to[0]));
  assert.equal(vertical.length, 1, "one vibrational relaxation");
  assert.ok(vertical[0].to[1] < vertical[0].from[1], "it relaxes downwards");
}

console.log(`photochemistry.check: ${set.items.length} templates place, keep one line width, and round-trip through CDXML and .oct ok`);
