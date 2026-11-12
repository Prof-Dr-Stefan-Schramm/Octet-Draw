// Run: node src/geometry.check.ts. Fails loudly if 3D Optimise stops sending the force-field solver the right
// structure (chiral tags in the solver's convention, cis and trans as drawn, Kekulé bonds, hydrogens) or stops putting
// its answer back facing the drawing with the hand kept. ReShiki's adapter tests (crates/io/src/geometry/tests.rs,
// view/tests.rs) as behaviour, on our own small molecules. The solver itself is tested in src-tauri/geometry.
import assert from "node:assert/strict";
import { ANGSTROM, applyConformer, fitRotation, geometryOf, geometryRequest, plainError, refusal, tagOf, type GeometryResponse } from "./geometry.ts";
import { rotate, type V3 } from "./model3d.ts";
import type { Mol } from "./render.ts";

// Our own molecules, laid out and wedged by RDKit 2026.09.2 (Compute2DCoords, WedgeMolBonds; coordinates over 1.5 Å),
// with the chiral tags RDKit gives them from SMILES (1 clockwise, 2 anticlockwise, in bond order) and their E/Z.
type Fixture = { name: string; atoms: [string, number, number][]; bonds: [number, number, number, number][]; tags: number[]; ez?: "E" | "Z" };
const FIXTURES: Fixture[] = [
  { name: "L-alanine N[C@@H](C)C(=O)O", atoms: [["N", 1, -0.866], ["C", 0.5, 0], ["C", 1, 0.866], ["C", -0.5, 0], ["O", -1, 0.866], ["O", -1, -0.866]], bonds: [[0, 1, 1, 0], [1, 2, 1, 6], [1, 3, 1, 0], [3, 4, 2, 0], [3, 5, 1, 0]], tags: [0, 1, 0, 0, 0, 0] },
  { name: "D-alanine N[C@H](C)C(=O)O", atoms: [["N", 1, -0.866], ["C", 0.5, 0], ["C", 1, 0.866], ["C", -0.5, 0], ["O", -1, 0.866], ["O", -1, -0.866]], bonds: [[0, 1, 1, 0], [1, 2, 1, 1], [1, 3, 1, 0], [3, 4, 2, 0], [3, 5, 1, 0]], tags: [0, 2, 0, 0, 0, 0] },
  { name: "(R)-CHFClBr F[C@H](Cl)Br", atoms: [["F", 0.866, 0.5], ["C", 0, 0], ["Cl", -0.866, 0.5], ["Br", 0, -1]], bonds: [[1, 0, 1, 1], [1, 2, 1, 0], [1, 3, 1, 0]], tags: [0, 2, 0, 0] },
  { name: "(S)-CHFClBr F[C@@H](Cl)Br", atoms: [["F", 0.866, 0.5], ["C", 0, 0], ["Cl", -0.866, 0.5], ["Br", 0, -1]], bonds: [[1, 0, 1, 6], [1, 2, 1, 0], [1, 3, 1, 0]], tags: [0, 1, 0, 0] },
  { name: "C[C@](F)(Cl)CC, four heavy neighbours, the first one hashed", atoms: [["C", -1.155, 0.5], ["C", -0.289, 0], ["F", -0.789, -0.866], ["Cl", 0.211, 0.866], ["C", 0.577, -0.5], ["C", 1.443, 0]], bonds: [[1, 0, 1, 6], [1, 2, 1, 0], [1, 3, 1, 0], [1, 4, 1, 0], [4, 5, 1, 0]], tags: [0, 2, 0, 0, 0, 0] },
  { name: "C[C@@H]1CCCC(=O)C1, a ring stereocentre", atoms: [["C", 1.732, -0.75], ["C", 0.866, -0.25], ["C", 0.866, 0.75], ["C", 0, 1.25], ["C", -0.866, 0.75], ["C", -0.866, -0.25], ["O", -1.732, -0.75], ["C", 0, -0.75]], bonds: [[1, 0, 1, 1], [1, 2, 1, 0], [2, 3, 1, 0], [3, 4, 1, 0], [4, 5, 1, 0], [5, 6, 2, 0], [5, 7, 1, 0], [7, 1, 1, 0]], tags: [0, 2, 0, 0, 0, 0, 0, 0] },
  { name: "(E)-2-butene", atoms: [["C", -1.32, -0.091], ["C", -0.4, 0.301], ["C", 0.4, -0.301], ["C", 1.32, 0.091]], bonds: [[0, 1, 1, 0], [1, 2, 2, 0], [2, 3, 1, 0]], tags: [0, 0, 0, 0], ez: "E" },
  { name: "(Z)-2-butene", atoms: [["C", -1, -0.433], ["C", -0.5, 0.433], ["C", 0.5, 0.433], ["C", 1, -0.433]], bonds: [[0, 1, 1, 0], [1, 2, 2, 0], [2, 3, 1, 0]], tags: [0, 0, 0, 0], ez: "Z" },
];
const molOf = (f: Fixture): Mol => ({
  atoms: f.atoms.map(([label, x, y]) => ({ label, location: [x, y, 0] as [number, number, number] })),
  bonds: f.bonds.map(([a, b, type, stereo]) => ({ type, atoms: [a, b] as [number, number], ...(stereo ? { stereo } : {}) })),
});
const all = (m: Mol) => m.atoms.map((_, i) => i);

// Chiral tags from Octet's wedges follow the solver's (RDKit's) convention, so a generated shape has the drawn hand.
for (const f of FIXTURES) {
  const req = geometryRequest(molOf(f), all(molOf(f)), "MMFF94s");
  assert.ok(typeof req !== "string", f.name);
  assert.deepEqual(req.atoms.map((a) => a.chiral_tag), f.tags, `${f.name}: chiral tags`);
  if (f.ez) {
    const b = req.bonds.find((x) => x.order === 2)!;
    assert.equal(b.stereo, f.ez === "E" ? 5 : 4, `${f.name}: trans (5) or cis (4)`);
    assert.deepEqual(b.stereo_atoms, [0, 3]);
  }
}

// Turning a wedge round (or making it a hash) gives the other tag; a plain drawing gives none.
{
  const f = FIXTURES[2], m = molOf(f), flipped = { ...m, bonds: m.bonds.map((b, k) => (k === 0 ? { ...b, stereo: 6 } : b)) }, plain = { ...m, bonds: m.bonds.map((b) => ({ ...b, stereo: undefined })) };
  assert.equal((geometryRequest(flipped, all(m), "UFF") as { atoms: { chiral_tag: number }[] }).atoms[1].chiral_tag, 1);
  assert.equal((geometryRequest(plain, all(m), "UFF") as { atoms: { chiral_tag: number }[] }).atoms[1].chiral_tag, 0);
}

// A double bond drawn in line with a substituent says nothing; one in a small ring is not given (it is fixed anyway).
{
  const inLine: Mol = { atoms: [["C", -2, 0], ["C", -1, 0], ["C", 0, 0], ["C", 0.5, 0.866]].map(([l, x, y]) => ({ label: l as string, location: [x as number, y as number, 0] as [number, number, number] })), bonds: [{ type: 1, atoms: [0, 1] }, { type: 2, atoms: [1, 2] }, { type: 1, atoms: [2, 3] }] };
  assert.equal((geometryRequest(inLine, [0, 1, 2, 3], "UFF") as { bonds: { stereo: number }[] }).bonds[1].stereo, 0);
  const ring = molOf(FIXTURES[5]);
  ring.bonds[4] = { ...ring.bonds[4], type: 2 };
  ring.bonds[5] = { ...ring.bonds[5], type: 1 };
  const req = geometryRequest(ring, all(ring), "UFF") as { bonds: { stereo: number; order: number }[] };
  assert.equal(req.bonds[4].order, 2);
  assert.equal(req.bonds[4].stereo, 0, "a ring double bond under 8 atoms");
}

// Hydrogens as Octet counts them, Kekulé bonds for aromatic ones, elements by number; no implicit hydrogens added.
{
  const benzene: Mol = { atoms: Array.from({ length: 6 }, (_, k) => ({ label: "C", location: [Math.cos((k * Math.PI) / 3), Math.sin((k * Math.PI) / 3), 0] as [number, number, number] })), bonds: Array.from({ length: 6 }, (_, k) => ({ type: 4, atoms: [k, (k + 1) % 6] as [number, number] })) };
  const req = geometryRequest(benzene, all(benzene), "MMFF94s");
  assert.ok(typeof req !== "string");
  assert.deepEqual(req.bonds.map((b) => b.order).sort(), [1, 1, 1, 2, 2, 2]);
  assert.ok(req.atoms.every((a) => a.explicit_h === 1 && a.no_implicit && a.atomic_number === 6));
  const ala = geometryRequest(molOf(FIXTURES[0]), all(molOf(FIXTURES[0])), "MMFF94s") as { atoms: { explicit_h: number; atomic_number: number }[] };
  assert.deepEqual(ala.atoms.map((a) => a.explicit_h), [2, 1, 3, 0, 0, 1]);
  assert.deepEqual(ala.atoms.map((a) => a.atomic_number), [7, 6, 6, 6, 8, 8]);
}

// What the solver cannot take, with the reason.
{
  const m = molOf(FIXTURES[0]);
  assert.match(refusal({ ...m, atoms: m.atoms.map((a, i) => (i === 0 ? { ...a, label: "Pt" } : a)) }, all(m))!, /Pt/);
  assert.match(refusal({ ...m, atoms: m.atoms.map((a, i) => (i === 2 ? { ...a, text: "Ph" } : a)) }, all(m))!, /Expand/);
  assert.match(refusal({ ...m, atoms: m.atoms.map((a, i) => (i === 2 ? { ...a, radical: 1 } : a)) }, all(m))!, /radical/);
  assert.equal(refusal(m, all(m)), undefined);
  assert.equal(typeof geometryRequest({ ...m, atoms: m.atoms.map((a, i) => (i === 0 ? { ...a, label: "Fe" } : a)) }, all(m), "UFF"), "string");
  assert.equal(plainError("MMFF parameters are unavailable for this molecule: atom 3"), "The MMFF force field has no parameters for this structure.");
  assert.equal(plainError("The 3D calculation took longer than 60 seconds. Octet stopped it."), "The 3D calculation took longer than 60 seconds. Octet stopped it.");
}

// Horn's fit: a proper rotation that undoes a turn, and keeps distances.
{
  const pts: V3[] = [[1.2, 0.1, -0.3], [-0.4, 1.1, 0.5], [-0.6, -0.9, 0.2], [0.1, 0.2, -1.4], [-0.3, -0.5, 1.0]];
  const c = pts.reduce((s, p) => [s[0] + p[0] / 5, s[1] + p[1] / 5, s[2] + p[2] / 5], [0, 0, 0]), centred = pts.map((p): V3 => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
  const turn: [number, number, number, number] = [Math.cos(0.6), Math.sin(0.6) * 0.48, Math.sin(0.6) * 0.6, Math.sin(0.6) * 0.64];
  const turned = centred.map((p) => rotate(turn, p)), q = fitRotation(centred, turned);
  centred.forEach((p, k) => { const r = rotate(q, p); assert.ok(Math.hypot(r[0] - turned[k][0], r[1] - turned[k][1], r[2] - turned[k][2]) < 1e-6, "the fit undoes the turn"); });
  // Fitted onto its mirror image, it stays a proper rotation (the hand is kept).
  const mirror = centred.map((p): V3 => [-p[0], p[1], p[2]]), qm = fitRotation(centred, mirror);
  assert.ok(Math.abs(Math.hypot(...qm) - 1) < 1e-9);
  assert.equal(tagOf(centred.slice(0, 4).map((p) => rotate(qm, p))), tagOf(centred.slice(0, 4)));
}

// 3D Optimise puts the answer on the drawing: same centre, facing as drawn, a C–C bond about a bond length, the hand
// kept, depth shading on; the added hydrogens are not drawn. A model takes them.
{
  const f = FIXTURES[0], m = molOf(f);
  // A plausible L-alanine shape (Å) with its hydrogens, as the solver answers: N, Cα, Cβ, C, O, O, then H.
  const xyz: V3[] = [[1.45, -0.6, 0.2], [0.4, 0.4, 0.0], [0.9, 1.75, -0.45], [-0.85, -0.1, -0.7], [-1.0, -0.15, -1.9], [-1.85, -0.55, 0.1], [0.2, 0.5, 1.08], [2.3, -0.2, 0.55], [1.15, -1.3, 0.85]];
  const res: GeometryResponse = { coordinates: xyz, hydrogen_parents: [1, 0, 0], original_count: 6, initial_energy: 10, energy: 2, gradient: null, converged: true, field: "MMFF94s", diagnostics: [] };
  const out = applyConformer(m, all(m), res);
  assert.equal(out.atoms.length, 6, "no hydrogens drawn");
  assert.ok(out.atoms.every((a) => a.shade));
  const mid = (mm: Mol) => mm.atoms.reduce((s, a) => [s[0] + a.location[0] / 6, s[1] + a.location[1] / 6], [0, 0]);
  assert.ok(Math.hypot(mid(out)[0] - mid(m)[0], mid(out)[1] - mid(m)[1]) < 1e-9, "centred where it was");
  const d = (mm: Mol, i: number, j: number) => Math.hypot(...[0, 1, 2].map((k) => (mm.atoms[i].location[k] ?? 0) - (mm.atoms[j].location[k] ?? 0)));
  const dx = (i: number, j: number) => Math.hypot(...[0, 1, 2].map((k) => xyz[i][k] - xyz[j][k]));
  assert.ok(Math.abs(d(out, 1, 2) - dx(1, 2) / ANGSTROM) < 1e-3, "Å over 1.52 at the drawing's bond length");
  // Each atom stays on its side: the fit faces the shape as drawn.
  for (const i of all(m)) assert.ok(Math.sign(out.atoms[i].location[0] - mid(out)[0]) === Math.sign(m.atoms[i].location[0] - mid(m)[0]) || Math.abs(m.atoms[i].location[0] - mid(m)[0]) < 0.2, `atom ${i} faces as drawn`);
  const around = (mm: Mol): V3[] => [0, 2, 3].map((j) => [0, 1, 2].map((k) => (mm.atoms[j].location[k] ?? 0) - (mm.atoms[1].location[k] ?? 0)) as V3);
  const fromXyz = [0, 2, 3].map((j) => [0, 1, 2].map((k) => xyz[j][k] - xyz[1][k]) as V3);
  assert.equal(tagOf(around(out)), tagOf(fromXyz), "the hand is kept");
  const g = geometryOf(res);
  assert.equal(g.xyz.length, 6);
  assert.deepEqual(g.hydrogens!.map((h) => h.parent), [1, 0, 0]);
  assert.equal(g.field, "MMFF94s");
}

console.log("geometry checks pass");
