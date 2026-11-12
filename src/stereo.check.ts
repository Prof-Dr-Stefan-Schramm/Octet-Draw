// Run: node src/stereo.check.ts. The stricter stereo checks and Redraw Stereo Bonds: a wedge or hash that sets nothing,
// one drawn the wrong way round (and Swap the ends of all), an allene wedged at both ends, a double bond whose E or Z the
// drawing does not show, the IUPAC style notes (off by default), and Redraw Stereo Bonds, which never moves an atom or
// changes a configuration. ReShiki's behaviour tests (crates/model/src/chemistry/stereo_lint/tests.rs, src/app/stereo/
// tests.rs; MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors) on our own small drawings.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const g = globalThis as Record<string, unknown>;
g.document = { documentElement: {}, createElement: () => ({ getContext: () => ({}) }) };
g.getComputedStyle = () => ({ getPropertyValue: () => "10" });
g.window = globalThis;
g.self = { location: { origin: "file://" } };
g.fetch = async (u: URL | string) => new Response(readFileSync(new URL(String(u))), { headers: { "content-type": "application/wasm" } });
const { cipOf, parseStructure, ready, redrawStereo, stereoFacts, toInchi } = await import("./chem.ts");
const { problems, WARNING_TYPES } = await import("./check.ts");
const { flipBonds } = await import("./edit.ts");
const { fromCdxml, toCdxml } = await import("./cdxml.ts");
const { DEFAULT_STYLE } = await import("./docstyle.ts");
type Mol = import("./render.ts").Mol;
type Bond = Mol["bonds"][number];
await ready;

const atom = (label: string, x: number, y: number, more: Partial<Mol["atoms"][number]> = {}): Mol["atoms"][number] => ({ label, location: [x, y, 0], ...more });
const bond = (a: number, b: number, more: Partial<Bond> = {}): Bond => ({ type: 1, atoms: [a, b], ...more });
// Problems with Indigo's facts, as the Editor reads them (every kind, the style notes too).
const found = (m: Mol) => problems(m, stereoFacts(m));
const kinds = (m: Mol, type: string) => found(m).filter((p) => p.type === type);
const SETS = "sets nothing";
// A carbon with F, Cl and Br (and its H) at x: the centre's first bond (to F) takes `first`.
const tetra = (x = 0, first: Partial<Bond> = { stereo: 1 }): Mol => ({
  atoms: [atom("C", x, 0), atom("F", x + 1, 0), atom("Cl", x - 0.5, -0.87), atom("Br", x - 0.5, 0.87)],
  bonds: [bond(0, 1, first), bond(0, 2), bond(0, 3)],
});
const join = (...ms: Mol[]): Mol => {
  const out: Mol = { atoms: [], bonds: [] };
  for (const m of ms) { const n = out.atoms.length; out.atoms.push(...m.atoms); out.bonds.push(...m.bonds.map((b) => ({ ...b, atoms: [b.atoms[0] + n, b.atoms[1] + n] as [number, number] }))); }
  return out;
};
const turned = (m: Mol, k: number): Mol => flipBonds(m, [k]);

// 1. A wedge from the stereocentre sets it: no warning. Turned round (narrow end on F) it is backwards, and its fix
// swaps the ends; the centre is not also called unset. A wedge on propane's middle carbon (no stereocentre at either
// end) sets nothing, and its fix redraws the stereo bonds.
{
  const m = tetra();
  assert.deepEqual(found(m), [], "a wedge from the centre");
  const back = found(turned(m, 0));
  assert.deepEqual(back.map((p) => [p.type, p.bond, p.fix?.command]), [["backwards", 0, "flip_bond:0"]]);
  assert.match(back[0].message, /cannot be a stereocentre/);
  const propane: Mol = { atoms: [atom("C", 0, 0), atom("C", 0.87, 0.5), atom("C", -0.87, 0.5)], bonds: [bond(0, 1, { stereo: 1 }), bond(0, 2)] };
  const none = found(propane);
  assert.deepEqual(none.map((p) => [p.type, p.bond, p.fix?.command]), [["backwards", 0, "redraw_stereo_at:0"]]);
  assert.match(none[0].message, new RegExp(SETS));
  assert.deepEqual(found({ ...propane, bonds: [bond(0, 1, { stereo: 6 }), bond(0, 2)] }).length, 1, "a hash too");
  assert.deepEqual(found({ ...propane, bonds: [bond(0, 1, { display: "hollow" }), bond(0, 2)] }).length, 1, "a hollow wedge too");
  // A wedge from a carbon to a carbon that is no stereocentre (ReShiki's tetra with F made C): the wide end's carbon
  // is a CH3, so turned round it sets nothing there either.
  const methyl: Mol = { ...m, atoms: m.atoms.map((a, i) => (i === 1 ? { ...a, label: "C" } : a)) };
  assert.deepEqual(found(methyl), [], "a wedge from a stereocentre to a methyl");
  assert.deepEqual(found(turned(methyl, 0)).map((p) => p.fix?.command), ["flip_bond:0"], "turned round: backwards");
}
// Wedges that are not warned about: from a metal (a complex's shape), from a label, the Stereocentres templates (a C with
// bare methyls), at an allene's end, and between the atoms of a hindered biaryl's axis and its rings.
{
  const metal: Mol = { atoms: [atom("Pt", 0, 0), atom("Cl", 1, 0), atom("Cl", -1, 0), atom("N", 0, 1), atom("N", 0, -1)], bonds: [bond(0, 1, { stereo: 1 }), bond(0, 2, { stereo: 6 }), bond(0, 3), bond(0, 4)] };
  assert.deepEqual(found(metal), [], "a metal's wedges");
  const generic: Mol = { atoms: [atom("C", 0, 0), atom("C", 1, 0), atom("C", -0.5, 0.87), atom("C", -0.5, -0.87), atom("C", 0, 1)], bonds: [bond(0, 1, { stereo: 1 }), bond(0, 2, { stereo: 6 }), bond(0, 3)] };
  assert.deepEqual(found(generic), [], "a stereocentre still to be filled in");
  // 2,2'-dimethyl-6,6'-dinitrobiphenyl-like axis (four ortho groups) wedged on its ring bonds: the axis, not a centre.
  const biaryl = parseStructure("Cc1cccc(O)c1-c1c(C)cccc1O");
  const axis = biaryl.bonds.findIndex((b) => b.type === 1 && b.atoms.every((i) => biaryl.bonds.filter((x) => x.atoms.includes(i)).length === 3 && biaryl.atoms[i].label === "C") && biaryl.bonds.filter((x) => x.atoms.some((i) => b.atoms.includes(i))).length === 5);
  assert.ok(axis >= 0, "the axis bond");
  const [a, c] = biaryl.bonds[axis].atoms, ring = biaryl.bonds.findIndex((b, k) => k !== axis && b.atoms.includes(a));
  const wedged: Mol = { ...biaryl, bonds: biaryl.bonds.map((b, k) => (k === ring ? { ...b, atoms: [a, b.atoms[0] === a ? b.atoms[1] : b.atoms[0]] as [number, number], stereo: 1 } : b)) };
  assert.deepEqual(kinds(wedged, "backwards"), [], "an axis's wedge");
  // A wedge out of the ring, from a ring CH to an F put on it, still sets nothing.
  const ch = wedged.atoms.findIndex((_, i) => i !== a && i !== c && wedged.atoms[i].label === "C" && wedged.bonds.filter((b) => b.atoms.includes(i)).length === 2);
  const p = wedged.atoms[ch].location, f: Mol = { ...wedged, atoms: [...wedged.atoms, atom("F", p[0] + 1, p[1])], bonds: [...wedged.bonds, bond(ch, wedged.atoms.length, { stereo: 1 })] };
  assert.equal(kinds(f, "backwards").length, 1, "an exocyclic wedge on a biaryl ring");
}

// 2. Swap the ends of all: two reversed wedges (one in each of two structures) and one that sets nothing. Each reversed
// one's fix turns both round in one step; the other is left as it is.
{
  const m = join(turned(tetra(0), 0), turned(tetra(4), 0), { atoms: [atom("C", 8, 0), atom("C", 8.87, 0.5), atom("C", 7.13, 0.5)], bonds: [bond(0, 1, { stereo: 1 }), bond(0, 2)] });
  const back = kinds(m, "backwards");
  assert.deepEqual(back.map((p) => p.fix?.command), ["redraw_stereo_at:8", "flip_bonds:0,3", "flip_bonds:0,3"]);
  assert.equal(back[1].fix?.label, "Swap the ends of all 2");
  const fixed = flipBonds(m, [0, 3]);
  assert.deepEqual(kinds(fixed, "backwards").map((p) => p.bond), [6], "only the one that sets nothing is left");
  assert.deepEqual(fixed.bonds[6], m.bonds[6]);
  // A hidden warning's bond (Display Warnings off) is not turned with the others.
  const hidden: Mol = { ...m, bonds: m.bonds.map((b, k) => (k === 3 ? { ...b, ignoreWarnings: true } : b)) };
  assert.deepEqual(kinds(hidden, "backwards").map((p) => p.fix?.command), ["redraw_stereo_at:8", "flip_bond:0"]);
}

// 3. An allene wedged at both ends: ambiguous, on its middle atom; at one end it sets the axis and is not warned about.
{
  const allene = (both: boolean): Mol => ({
    atoms: [atom("C", -1, 1), atom("C", 0, 0), atom("C", 1, 0), atom("C", 2, 0), atom("C", 3, 1), atom("F", -1, -1), atom("F", 3, -1)],
    bonds: [bond(1, 0, { stereo: 1 }), bond(1, 2, { type: 2 }), bond(2, 3, { type: 2 }), bond(3, 4, both ? { stereo: 6 } : {}), bond(1, 5), bond(3, 6)],
  });
  // (Its middle carbon, in line, also has ChemDraw's linear-atom warning.)
  const stereoKinds = (m: Mol) => found(m).filter((p) => p.type !== "linear");
  assert.deepEqual(stereoKinds(allene(true)).map((p) => [p.type, p.atom]), [["ambiguous", 2]]);
  assert.match(stereoKinds(allene(true))[0].message, /^The allene at C3 has wedges or hashes at both ends/);
  assert.deepEqual(stereoKinds(allene(false)), [], "one end only");
}

// 4. Double bonds: F–CH=CH–Cl drawn zig-zag sets E; with the F on the line of the C=C it can be E or Z (only where Show
// Stereochemistry is on, as ChemDraw warns of an unset centre); a second F on that carbon makes it no stereo unit; a
// crossed double bond or a wavy bond at an end says E/Z is not known. A cumulene with two double bonds is an axis.
{
  const alkene = (fx: number, fy: number, more: (m: Mol) => Mol = (m) => m): Mol => more({
    atoms: [atom("F", fx, fy, { cip: true }), atom("C", 0, 0, { cip: true }), atom("C", 1, 0, { cip: true }), atom("Cl", 1.5, -0.87, { cip: true })],
    bonds: [bond(0, 1), bond(1, 2, { type: 2 }), bond(2, 3)],
  });
  const open = (m: Mol) => kinds(m, "unspecified").filter((p) => p.bond !== undefined);
  assert.deepEqual(open(alkene(-0.5, 0.87)), [], "zig-zag");
  assert.deepEqual(stereoFacts(alkene(-0.5, 0.87)).doubles, new Set());
  const line = alkene(-1, 0);
  assert.deepEqual(open(line).map((p) => [p.bond, p.message]), [[1, "The double bond C2=C3 can be E or Z, but the drawing does not show which. Draw its substituents zig-zag, or use a crossed double bond if E/Z is not known."]]);
  assert.deepEqual(open({ ...line, atoms: line.atoms.map((a) => ({ ...a, cip: undefined })) }), [], "Show Stereochemistry off");
  const two = alkene(-1, 0, (m) => ({ atoms: [...m.atoms, atom("F", -0.5, 0.87, { cip: true })], bonds: [...m.bonds, bond(1, 4)] }));
  assert.deepEqual(open(two), [], "two F on one end");
  assert.deepEqual(open(alkene(-1, 0, (m) => ({ ...m, bonds: m.bonds.map((b, k) => (k === 1 ? { ...b, display: "either" } : b)) }))), [], "a crossed double bond");
  assert.deepEqual(open(alkene(-1, 0, (m) => ({ ...m, bonds: m.bonds.map((b, k) => (k === 0 ? { ...b, display: "wavy" } : b)) }))), [], "a wavy bond at an end");
  const cumulene: Mol = { atoms: ["F", "C", "C", "C", "Cl"].map((l, i) => atom(l, i, 0, { cip: true })), bonds: [bond(0, 1), bond(1, 2, { type: 2 }), bond(2, 3, { type: 2 }), bond(3, 4)] };
  assert.deepEqual(open(cumulene), [], "an allene is an axis");
  // An open double bond and an open centre in one drawing: both are named; a backwards wedge's centre is not also unset.
  const both = join(turned(tetra(0, { stereo: 1 }), 0), tetra(4, {}), line);
  const shown: Mol = { ...both, atoms: both.atoms.map((a) => ({ ...a, cip: true })) };
  const said = found(shown).map((p) => `${p.type} ${p.atom ?? ""} ${p.bond ?? ""}`);
  assert.ok(said.includes("backwards  0") && said.includes("unspecified 4 ") && said.includes("unspecified  7"), said.join("; "));
  assert.ok(!said.some((s) => s.startsWith("unspecified 0 ")), "the backwards wedge's centre is not also unset");
}

// 5. The IUPAC style notes: a kind of their own, off by default (Settings > Warnings lists it).
{
  assert.deepEqual(WARNING_TYPES.find((w) => w.id === "style"), { id: "style", name: "IUPAC style notes (ST-1)", on: false });
  const style = (m: Mol) => kinds(m, "style").map((p) => p.message.split(/[,.]/)[0]);
  // Tapered and parallel hashes in one drawing (across two structures); a centre shown only by a parallel hash.
  const mixed = join(tetra(0, { stereo: 6 }), tetra(4, { display: "hashed" }));
  assert.deepEqual(style(mixed), ["The drawing has both tapered and parallel hashed bonds", "C5 is shown only with bold"]);
  for (const display of ["bold", "hollow"] as const) assert.deepEqual(style(tetra(0, { display })), ["C1 is shown only with bold"], display);
  assert.deepEqual(style(tetra()), [], "a plain wedge");
  // A T: two plain bonds in line at the centre.
  const t: Mol = { atoms: [atom("C", 0, 0), atom("F", 0, 1), atom("Cl", -1, 0), atom("Br", 1, 0)], bonds: [bond(0, 1, { stereo: 1 }), bond(0, 2), bond(0, 3)] };
  assert.deepEqual(style(t), ["Two plain bonds at C1 are almost in a straight line (a T shape)"]);
  // A ring atom where the ring bends in (ReShiki's dented five-membered ring), wedged to O.
  const dent: Mol = { atoms: [atom("C", -1, 1), atom("C", 0, 0), atom("C", 1, 1), atom("C", 1, -1), atom("C", -1, -1), atom("O", 0, 1), atom("F", 2, 1)],
    bonds: [bond(0, 1), bond(1, 2), bond(2, 3), bond(3, 4), bond(4, 0), bond(1, 5, { stereo: 1 }), bond(2, 6)] };
  assert.ok(stereoFacts(dent).centres.has(1), "C2 is a stereocentre");
  assert.ok(style(dent).includes("The ring bends in at C2"), style(dent).join("; "));
  // A wavy bond from a stereocentre to a double bond's atom.
  const wavy: Mol = { atoms: [atom("C", 0, 0), atom("C", 1, 0), atom("C", 2, 0), atom("F", -0.5, 0.87), atom("Cl", -0.5, -0.87), atom("Br", 2.5, 0.87)],
    bonds: [bond(0, 1, { display: "wavy" }), bond(1, 2, { type: 2 }), bond(0, 3), bond(0, 4), bond(2, 5)] };
  const wavyFacts = { ...stereoFacts(wavy), centres: new Set([0]) };
  assert.deepEqual(problems(wavy, wavyFacts).filter((p) => p.type === "style").map((p) => p.bond), [0]);
}

// 6. Redraw Stereo Bonds. Menthol (three stereocentres) drawn by Octet, then with every wedge turned round and made a
// hash (and each hash a wedge), so the wide end is on the centre and the drawing still means menthol to Octet's
// labeller and ChemDraw, though not to InChI: Redraw puts a wedge or hash from each centre again, moves no atom, and
// the drawing reads as menthol again (same InChI, same R and S).
{
  const menthol = "CC(C)[C@@H]1CC[C@@H](C)C[C@H]1O", m = parseStructure(menthol);
  const want = toInchi(menthol), labels = cipOf(m).atoms;
  assert.equal(toInchi(m), want);
  const stereo = m.bonds.flatMap((b, k) => (b.stereo ? [k] : []));
  assert.equal(stereo.length, 3);
  const back = flipBonds({ ...m, bonds: m.bonds.map((b) => (b.stereo ? { ...b, stereo: b.stereo === 1 ? 6 : 1 } : b)) }, stereo);
  assert.deepEqual(cipOf(back).atoms, labels, "a wide end read as the centre's");
  assert.equal(kinds(back, "backwards").length, 3);
  const r = redrawStereo(back);
  assert.equal(r.count, 3);
  assert.equal(r.refused, 0);
  assert.equal(toInchi(r.mol), want, "the same stereoisomer");
  assert.deepEqual(cipOf(r.mol).atoms.slice(0, m.atoms.length), labels);
  assert.deepEqual(r.mol.atoms.slice(0, m.atoms.length).map((a) => a.location), m.atoms.map((a) => a.location), "no atom moved");
  assert.deepEqual(found(r.mol), [], "no warnings");
  for (const b of r.mol.bonds) if (b.stereo) assert.ok(stereoFacts(r.mol).centres.has(b.atoms[0]), "each narrow end on a centre");
  // Redrawn again: nothing changes.
  assert.deepEqual(redrawStereo(r.mol).mol.bonds, r.mol.bonds);
  // Undo, copy and paste, save and export: the result is plain wedges and hashes, so a CDXML round trip keeps it.
  assert.equal(toInchi(fromCdxml(toCdxml(r.mol, DEFAULT_STYLE)).mol), want, "CDXML keeps the redrawn wedges");
}
// trans-2-Methylcyclohexanol with its wedge and hash on ring bonds: they move to the OH and the CH3 (out of the ring).
{
  const smiles = "C[C@@H]1CCCC[C@H]1O", m = parseStructure(smiles), want = toInchi(smiles);
  // Each centre's wedge moved onto a ring bond to a CH2, with the hand kept (a wedge or a hash, whichever reads the same).
  const centres = [...stereoFacts(m).centres];
  assert.equal(centres.length, 2);
  let onRing = m;
  for (const c of centres) {
    const w = onRing.bonds.findIndex((b) => b.stereo && b.atoms[0] === c), ring = onRing.bonds.findIndex((b) => !b.stereo && b.atoms.includes(c) && onRing.bonds.filter((x) => x.atoms.includes(b.atoms[0] === c ? b.atoms[1] : b.atoms[0])).length >= 2 && !centres.includes(b.atoms[0] === c ? b.atoms[1] : b.atoms[0]));
    const other = onRing.bonds[ring].atoms[0] === c ? onRing.bonds[ring].atoms[1] : onRing.bonds[ring].atoms[0];
    const pick = ([1, 6] as const).map((s) => ({ ...onRing, bonds: onRing.bonds.map((b, k) => (k === w ? { ...b, stereo: undefined } : k === ring ? { ...b, atoms: [c, other] as [number, number], stereo: s } : b)) })).find((x) => toInchi(x) === want || cipOf(x).atoms[c] === cipOf(m).atoms[c])!;
    onRing = pick;
  }
  assert.equal(toInchi(onRing), want, "the ring wedges draw the same stereoisomer");
  const r = redrawStereo(onRing);
  assert.equal(r.count, 2);
  assert.equal(toInchi(r.mol), want);
  for (const b of r.mol.bonds.filter((x) => x.stereo)) assert.ok(["O", "C"].includes(r.mol.atoms[b.atoms[1]].label) && r.mol.bonds.filter((x) => x.atoms.includes(b.atoms[1])).length === 1, "on a substituent");
}
// Only the structures the selection touches; perspective, wavy bonds and 3D structures are left as drawn; a wedge that
// sets nothing is made plain; a drawing with no stereocentres has nothing to redraw.
{
  const a = turned(tetra(0), 0), b = turned(tetra(4), 0), m = join(a, b);
  const one = redrawStereo(m, new Set([0]));
  assert.equal(one.count, 1);
  assert.deepEqual(one.mol.bonds.slice(3), m.bonds.slice(3), "the other structure is left");
  assert.deepEqual(one.mol.bonds[0].atoms[0], 0, "from the centre");
  assert.equal(redrawStereo(m).count, 2);
  const propane: Mol = { atoms: [atom("C", 0, 0), atom("C", 0.87, 0.5), atom("C", -0.87, 0.5)], bonds: [bond(0, 1, { stereo: 1, colour: "#ff0000" }), bond(0, 2)] };
  const plain = redrawStereo(propane);
  assert.equal(plain.count, 0);
  assert.deepEqual(plain.mol.bonds[0], { type: 1, atoms: [0, 1], colour: "#ff0000" }, "made plain, its colour kept");
  const flat: Mol = { atoms: [atom("C", 0, 0), atom("C", 1, 0)], bonds: [bond(0, 1)] };
  assert.deepEqual(redrawStereo(flat), { mol: flat, count: 0, refused: 0 });
  const deep: Mol = { ...a, atoms: a.atoms.map((x, i) => (i === 1 ? { ...x, location: [x.location[0], x.location[1], 0.5] as [number, number, number] } : x)) };
  assert.equal(redrawStereo(deep).mol, deep, "a structure drawn in 3D");
  const wavy: Mol = { ...tetra(0, { display: "wavy" }) };
  assert.equal(redrawStereo(wavy).mol, wavy, "a wavy bond");
  // A centre whose neighbours lie on top of each other gives no hand: its bonds are left, and nothing is counted.
  const squashed: Mol = { ...tetra(), atoms: tetra().atoms.map((x, i) => (i === 2 ? { ...x, location: [0, 0, 0] as [number, number, number] } : x)) };
  const s = redrawStereo(squashed);
  assert.equal(s.count, 0);
  assert.deepEqual(s.mol.bonds, squashed.bonds);
}
// Wiring: Structure > Redraw Stereo Bonds, the command and its palette name, the Actions panel (drawing, selection,
// structure), the warnings' fixes, and the style notes' switch read with the other stereo warnings.
{
  const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
  const main = read("../src-tauri/src/main.rs"), editor = read("Editor.tsx"), actions = read("Actions.tsx");
  const has = (text: string, part: string) => assert.ok(text.includes(part), part);
  has(main, `&item("redraw_stereo", "Redraw Stereo Bonds", "")?,`);
  has(editor, `redraw_stereo: () => redrawStereoBonds(selection.size ? selection : undefined)`);
  has(editor, `redraw_stereo: ["Redraw stereo bonds", "", <Triangle size={18} />]`);
  has(editor, `command.startsWith("flip_bonds:")`);
  has(editor, `command.startsWith("redraw_stereo_at:")`);
  has(editor, `"backwards", "style"] as const).some(warnOn)`);
  // Defined once, then in the drawing's, a selection's and a structure's panel.
  assert.equal(actions.match(/\bredraw\b(?!:)/g)?.length, 4);
}
console.log("stereo.check: ok");
