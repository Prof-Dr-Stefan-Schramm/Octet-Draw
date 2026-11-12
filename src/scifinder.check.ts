// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), src/clipboard/copy_as/chemdoodle/tests.rs,
// src/clipboard/copy_as/chemdoodle/aromatic_tests.rs and crates/model/src/reactions/copy_tests.rs, MIT OR Apache-2.0,
// © 2026 Ameyanagi and ReShiki contributors. The tests are re-expressed with Octet's own small molecules.
//
// Run: node src/scifinder.check.ts. Fails loudly if Edit > Copy As > SciFinder (issue #113) stops giving SMILES for
// structures and ChemDoodle JSON for one reaction step: roles by the step, one atom of each participant in rs and ps,
// Kekulé bonds for an aromatic ring however it is drawn, charges, isotopes and wedges kept, hydrogens counted,
// agents left out, and refusals for what ChemDoodle JSON cannot hold. The drawing itself never changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// chem.ts reads the drawing tokens and loads Indigo's wasm as a browser does; these stand in for the browser.
const g = globalThis as Record<string, unknown>;
g.document = { documentElement: {}, createElement: () => ({ getContext: () => ({}) }) };
g.getComputedStyle = () => ({ getPropertyValue: () => "10" });
g.window = globalThis;
g.self = { location: { origin: "file://" } };
g.fetch = async (u: URL | string) => new Response(readFileSync(new URL(String(u))), { headers: { "content-type": "application/wasm" } });
const { parseStructure, ready, toSmiles } = await import("./chem.ts");
const { chemDoodleReaction, forSciFinder } = await import("./scifinder.ts");
type Mol = import("./render.ts").Mol;
type RxnStep = import("./chem.ts").RxnStep;
await ready;

type CdAtom = { i: string; l: string; x: number; y: number; c?: number; m?: number; h: number; r?: number };
type CdBond = { b: number; e: number; o?: number; s?: string };
type Cd = { m: { a: CdAtom[]; b: CdBond[] }[]; s: { t: string; i: string; x1: number; y1: number; x2: number; y2: number; a: string; rs: string[]; ps: string[] }[] };

// Structures side by side (each moved 8 bond lengths on from the last), and their atoms by structure.
function scheme(...smiles: string[]): { mol: Mol; parts: number[][] } {
  const mol: Mol = { atoms: [], bonds: [] }, parts: number[][] = [];
  smiles.forEach((s, k) => {
    const m = parseStructure(s), base = mol.atoms.length;
    parts.push(m.atoms.map((_, i) => base + i));
    mol.atoms.push(...m.atoms.map((a) => ({ ...a, location: [a.location[0] + 8 * k, a.location[1], 0] as [number, number, number] })));
    mol.bonds.push(...m.bonds.map((b) => ({ ...b, atoms: [b.atoms[0] + base, b.atoms[1] + base] as [number, number] })));
  });
  return { mol, parts };
}
const json = (mol: Mol, steps: RxnStep[]) => {
  const before = JSON.stringify(mol), out = forSciFinder(mol, steps);
  assert.equal(JSON.stringify(mol), before, "copying never changes the drawing");
  assert.ok(!("refused" in out), "refused" in out ? out.refused : "");
  assert.equal(out.reaction, true);
  return { cd: JSON.parse(out.text) as Cd, out };
};
const refused = (mol: Mol, steps: RxnStep[]) => {
  const out = forSciFinder(mol, steps);
  assert.ok("refused" in out, "expected a refusal");
  return out.refused;
};
const orders = (m: { b: CdBond[] }) => m.b.map((b) => b.o ?? 1);

// Structures with no reaction: SMILES, as Copy As SMILES gives it (CAS Draw's text field takes it); every structure kept.
{
  const { mol } = scheme("CCO", "c1ccccc1");
  const out = forSciFinder(mol, []);
  assert.ok(!("refused" in out));
  assert.equal(out.reaction, false);
  assert.equal(out.text, toSmiles(mol));
  assert.equal(out.text.split(".").length, 2, "both structures, as one SMILES with a dot");
  assert.equal(forSciFinder({ atoms: [], bonds: [] }, []).hasOwnProperty("refused"), true, "nothing to copy");
}

// One step: ethanol → acetaldehyde. One molecule a side, the arrow a synthetic Line from reactants to products,
// rs and ps naming the first atom of each (ReShiki role_references_follow_explicit_membership_and_leave_source_unchanged).
{
  const { mol, parts } = scheme("CCO", "CC=O");
  const { cd } = json(mol, [{ reactants: [parts[0]], products: [parts[1]], agents: [] }]);
  assert.equal(cd.m.length, 2);
  assert.deepEqual(cd.m.map((m) => m.a.map((a) => a.l).sort().join("")), ["CCO", "CCO"]);
  assert.deepEqual(cd.m.map((m) => m.a.map((a) => a.h).reduce((s, h) => s + h, 0)), [6, 4], "C2H6O and C2H4O");
  assert.deepEqual(cd.m.map(orders).map((o) => o.sort().join("")), ["11", "12"]);
  const [line] = cd.s;
  assert.equal(line.t, "Line");
  assert.equal(line.a, "synthetic");
  assert.deepEqual(line.rs, [cd.m[0].a[0].i]);
  assert.deepEqual(line.ps, [cd.m[1].a[0].i]);
  // The arrow runs left to right between the two molecules, at a bond length of 20 (ChemDoodle's), y down.
  const right0 = Math.max(...cd.m[0].a.map((a) => a.x)), left1 = Math.min(...cd.m[1].a.map((a) => a.x));
  assert.ok(right0 < line.x1 && line.x1 < line.x2 && line.x2 < left1, "arrow between the molecules");
  assert.equal(line.y1, line.y2);
  const b = cd.m[0].b[0], a = cd.m[0].a;
  assert.ok(Math.abs(Math.hypot(a[b.b].x - a[b.e].x, a[b.b].y - a[b.e].y) - 20) < 0.1, "bond length 20");
  // Atom ids are unique across the reaction.
  const ids = cd.m.flatMap((m) => m.a.map((x) => x.i));
  assert.equal(new Set(ids).size, ids.length);
}

// Several separate molecules on a side: each its own participant, in the step's order
// (every_disconnected_component_becomes_a_participant_in_source_order).
{
  const { mol, parts } = scheme("CC(=O)O", "OCC", "CC(=O)OCC", "O");
  const { cd } = json(mol, [{ reactants: [parts[0], parts[1]], products: [parts[2], parts[3]], agents: [] }]);
  assert.equal(cd.m.length, 4);
  assert.deepEqual(cd.s[0].rs, [cd.m[0].a[0].i, cd.m[1].a[0].i]);
  assert.deepEqual(cd.s[0].ps, [cd.m[2].a[0].i, cd.m[3].a[0].i]);
  assert.deepEqual(cd.m.map((m) => m.a.length), [4, 3, 6, 1], "acetic acid, ethanol, ethyl acetate, water");
  assert.equal(cd.m[3].a[0].h, 2, "water's oxygen has two hydrogens");
}

// Roles come from the step, not from where the molecules sit: the same step drawn right to left (products first)
// still has the reactant in rs (ReShiki ring_roles_follow_arrow_start_and_end_in_every_direction_without_mutation).
{
  const { mol, parts } = scheme("C1CCCCC1", "c1ccccc1");
  const { cd } = json(mol, [{ reactants: [parts[1]], products: [parts[0]], agents: [] }]);
  assert.deepEqual(cd.m.map((m) => m.a.reduce((s, a) => s + a.h, 0)), [6, 12], "benzene is the reactant, cyclohexane the product");
  assert.ok(cd.s[0].x1 < cd.s[0].x2, "the arrow points from reactants to products");
}

// Benzene drawn with alternating bonds or with aromatic bonds (Octet's type 4, a ring with a circle) copies with three
// double and three single bonds and one H on each carbon (aromatic_and_alternating_benzene_copy_as_kekule_without_source_changes).
{
  for (const aromatic of [false, true]) {
    const { mol, parts } = scheme("c1ccccc1", "C1CCCCC1");
    if (aromatic) {
      mol.bonds = mol.bonds.map((b) => (parts[0].includes(b.atoms[0]) ? { ...b, type: 4 } : b));
      mol.atoms = mol.atoms.map((a, i) => (parts[0].includes(i) ? { ...a, circle: true } : a));
    }
    const { cd } = json(mol, [{ reactants: [parts[0]], products: [parts[1]], agents: [] }]);
    assert.deepEqual(orders(cd.m[0]).sort().join(""), "111222", aromatic ? "aromatic bonds made Kekulé" : "alternating bonds kept");
    assert.ok(cd.m[0].a.every((a) => a.h === 1));
    // Kekulé: every carbon has exactly one double bond.
    const doubles = cd.m[0].a.map((_, i) => cd.m[0].b.filter((b) => (b.o ?? 1) === 2 && (b.b === i || b.e === i)).length);
    assert.deepEqual(doubles, [1, 1, 1, 1, 1, 1]);
  }
  // Pyrrole drawn aromatic: the NH keeps its hydrogen.
  const { mol, parts } = scheme("c1cc[nH]c1", "C1CCNC1");
  mol.bonds = mol.bonds.map((b) => (parts[0].includes(b.atoms[0]) ? { ...b, type: 4 } : b));
  const { cd } = json(mol, [{ reactants: [parts[0]], products: [parts[1]], agents: [] }]);
  assert.equal(cd.m[0].a.find((a) => a.l === "N")?.h, 1);
  assert.equal(orders(cd.m[0]).filter((o) => o === 2).length, 2);
}

// Charges, isotopes and a deuterium atom are kept (charges_isotopes_and_separate_deuterium_are_retained).
{
  const { mol, parts } = scheme("CC(=O)[O-]", "[13CH3]C(=O)O");
  const d = mol.atoms.length;
  // CH3D drawn with D as its own atom, beside the rest.
  mol.atoms.push({ label: "C", location: [20, 0, 0] }, { label: "D", location: [21, 0, 0] });
  mol.bonds.push({ type: 1, atoms: [d, d + 1] });
  const { cd } = json(mol, [{ reactants: [parts[0], [d, d + 1]], products: [parts[1]], agents: [] }]);
  const o = cd.m[0].a.filter((a) => a.l === "O");
  assert.deepEqual(o.map((a) => a.c ?? 0).sort(), [-1, 0], "acetate keeps its charge");
  assert.equal(o.find((a) => a.c === -1)?.h, 0);
  const deut = cd.m[1].a.find((a) => a.l === "H");
  assert.equal(deut?.m, 2, "D goes as hydrogen of mass 2");
  assert.equal(cd.m[1].a.find((a) => a.l === "C")?.h, 3, "CH3D: three more hydrogens on the carbon");
  assert.deepEqual(cd.m[2].a.filter((a) => a.m).map((a) => [a.l, a.m]), [["C", 13]], "13C kept");
}

// An ammonium ion and a radical: the charge and the unpaired electron go, and the hydrogens agree.
{
  const { mol, parts } = scheme("[NH4+]", "C[CH2]");
  const { cd } = json(mol, [{ reactants: [parts[0]], products: [parts[1]], agents: [] }]);
  assert.deepEqual([cd.m[0].a[0].c, cd.m[0].a[0].h], [1, 4]);
  const ethyl = cd.m[1].a.find((a) => a.r);
  assert.deepEqual([ethyl?.r, ethyl?.h], [1, 2]);
}

// A wedge: ChemDoodle's protruding bond, from the stereocentre; a hash, recessed.
{
  const { mol, parts } = scheme("CC(O)CC", "CC(=O)CC");
  const centre = 1, oxygen = 2;
  mol.bonds = mol.bonds.map((b) => (b.atoms[0] === centre && b.atoms[1] === oxygen ? { ...b, stereo: 1 } : b));
  const { cd } = json(mol, [{ reactants: [parts[0]], products: [parts[1]], agents: [] }]);
  const wedge = cd.m[0].b.find((b) => b.s);
  assert.equal(wedge?.s, "protruding");
  assert.equal(cd.m[0].a[wedge!.b].l, "C", "the wedge starts at the stereocentre");
  mol.bonds = mol.bonds.map((b) => (b.stereo ? { ...b, stereo: 6 } : b));
  assert.equal(json(mol, [{ reactants: [parts[0]], products: [parts[1]], agents: [] }]).cd.m[0].b.find((b) => b.s)?.s, "recessed");
}

// Agents (structures above and below the arrow) are left out, and the result says so.
{
  const { mol, parts } = scheme("CCO", "CC=O", "O=[Cr](=O)=O");
  const { cd, out } = json(mol, [{ reactants: [parts[0]], products: [parts[1]], agents: [parts[2]] }]);
  assert.equal(cd.m.length, 2);
  assert.ok(!cd.m.some((m) => m.a.some((a) => a.l === "Cr")));
  assert.equal(out.agents, true);
}

// What ChemDoodle JSON cannot hold is refused, with a reason (unsupported_chemistry_has_no_prepared_payload;
// absent_multiple_degenerate_unsupported_arrows_and_missing_sides_are_distinct).
{
  const { mol, parts } = scheme("CCO", "CC=O", "CC(=O)O");
  assert.match(refused(mol, [{ reactants: [parts[0]], products: [parts[1]], agents: [] }, { reactants: [parts[1]], products: [parts[2]], agents: [] }]), /one reaction at a time/);
  // An R group.
  const r = scheme("CCO", "CC=O");
  r.mol.atoms[0] = { ...r.mol.atoms[0], label: "R" };
  assert.match(refused(r.mol, [{ reactants: [r.parts[0]], products: [r.parts[1]], agents: [] }]), /elements only|plain structures/);
  // A bad RXN file, and one without a product.
  assert.deepEqual(chemDoodleReaction("not a reaction"), { refused: "Octet cannot write this reaction for SciFinder." });
  assert.match((chemDoodleReaction("$RXN\n\n\n\n  1  0\n$MOL\n\n\n\n  1  0  0  0  0  0  0  0  0  0999 V2000\n    0.0000    0.0000    0.0000 C   0  0\nM  END\n") as { refused: string }).refused, /starting material and a product/);
}

// The commands: Edit > Copy As > SciFinder in the app's menu, the command palette, and the page's handler.
{
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const editor = read("Editor.tsx"), main = read("../src-tauri/src/main.rs");
  assert.match(main, /item\("copy_scifinder", "SciFinder", ""\)/);
  assert.match(editor, /copy_scifinder: \(\) => copyForSciFinder\(\)/, "menu command");
  assert.match(editor, /copy_scifinder: \["Copy for SciFinder"/, "command palette");
  assert.match(editor, /command === "copy_scifinder"\) return copyForSciFinder\(\)/, "palette and Actions runner");
}

console.log("scifinder.check.ts: all passed");
