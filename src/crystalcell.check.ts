// Run: node src/crystalcell.check.ts. Fails loudly if a crystal's 3D model stops drawing its unit cell as it should:
// boundary copies, repeat, the box, Look along, Molecule only and solvent, and keeping its cell through edits, copy and
// paste, saving and the screen reader. ReShiki's cell tests (crates/model/src/models3d/crystal_3d_tests.rs,
// models3d/crystal/tests.rs, crates/io/src/crystal/tests.rs), rewritten with our own structures typed here.
import assert from "node:assert/strict";
import { readCrystal } from "./crystal.ts";
import { alongBasis, cellAt, crystalPrimitives, crystalScene, crystalView, fittingRepeat, layOutCrystal, moleculeAtoms, openingView, setCrystal, shownSites, siteBonds } from "./crystalcell.ts";
import { describeModel, isStale, modelPrimitives, primitiveNodes, rotate, svgText, type Model3d, type Prim3d, type V3 } from "./model3d.ts";
import { deleteAtoms, extractSelection, insertMol } from "./edit.ts";
import { parse, serialize } from "./file.ts";
import { toCdxml } from "./cdxml.ts";
import { DEFAULT_STYLE } from "./docstyle.ts";
import { structureText } from "./access.ts";
import type { Mol } from "./render.ts";

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const signed: string[] = [];
for (const p of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) for (let s = 0; s < 8; s++) signed.push(p.map((k, i) => `${(s >> i) & 1 ? "-" : ""}${"xyz"[k]}`).join(","));
const cubic = (a: number) => `_cell_length_a ${a}\n_cell_length_b ${a}\n_cell_length_c ${a}\n_cell_angle_alpha 90\n_cell_angle_beta 90\n_cell_angle_gamma 90\n`;
const SITES = "loop_\n_atom_site_label\n_atom_site_type_symbol\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\n";
// Rock salt (Fm-3m, 192 operators made from the signed permutations and F-centring).
const FM3M = [["0", "0", "0"], ["0", "1/2", "1/2"], ["1/2", "0", "1/2"], ["1/2", "1/2", "0"]].flatMap((t) => signed.map((o) => o.split(",").map((c, i) => (t[i] === "0" ? c : `${c}+${t[i]}`)).join(",")));
const NACL = `data_nacl\n${cubic(5.6402)}loop_\n_space_group_symop_operation_xyz\n${FM3M.map((o) => `'${o}'`).join("\n")}\n${SITES}Na1 Na1+ 0 0 0\nCl1 Cl1- 0.5 0.5 0.5\n`;
// Strontium titanate, cubic perovskite (a = 3.899 Å), every atom listed (P1).
const SRTIO3 = `data_srtio3\n${cubic(3.899)}_space_group_name_H-M_alt 'P 1'\n${SITES}Sr1 Sr 0.5 0.5 0.5\nTi1 Ti 0 0 0\nO1 O 0.5 0 0\nO2 O 0 0.5 0\nO3 O 0 0 0.5\n`;
// Dry ice (Pa-3).
const PA3_HALF = ["x,y,z", "-x+1/2,-y,z+1/2", "-x,y+1/2,-z+1/2", "x+1/2,-y+1/2,-z", "z,x,y", "z+1/2,-x+1/2,-y", "-z+1/2,-x,y+1/2", "-z,x+1/2,-y+1/2", "y,z,x", "-y,z+1/2,-x+1/2", "y+1/2,-z+1/2,-x", "-y+1/2,-z,x+1/2"];
const invert = (op: string) => op.split(",").map((c) => c.replace(/[+-]?[xyz]/g, (t) => (t.startsWith("-") ? "+" + t.slice(1) : "-" + t.replace("+", ""))).replace(/\+(1\/2)/, "-$1").replace(/^\+/, "")).join(",");
const CO2 = `data_co2\n${cubic(5.624)}loop_\n_symmetry_equiv_pos_as_xyz\n${[...PA3_HALF, ...PA3_HALF.map(invert)].map((o) => `'${o}'`).join("\n")}\n${SITES}C1 C 0 0 0\nO1 O 0.1185 0.1185 0.1185\n`;
const open = (text: string) => readCrystal("cif", text).mol;
const kinds = (prims: Prim3d[]) => prims.map((p) => (p.kind === "opacity" ? p.inner.kind : p.kind));
const inner = (p: Prim3d): Prim3d => (p.kind === "opacity" ? inner(p.inner) : p);

// ---- Rock salt fills its cell as crystallographers draw it ----
{
  const m = open(NACL), x = m.models![0];
  const sites = shownSites(x);
  assert.equal(sites.length, 27, "8 corners, 12 edges, 6 faces and the centre");
  assert.equal(siteBonds(x, sites).length, 54);
  // Each copy is its atom moved by whole cells.
  const scene = crystalScene(m, x);
  scene.sites.forEach(([a, cell], k) => assert.ok(scene.points[k].xyz.every((v, i) => near(v, x.xyz[a][i] + cellAt(x.crystal!.vectors, cell)[i], 1e-9))));
  assert.equal(scene.alpha.filter((a) => a === undefined).length, 8, "the cell's own atoms at full strength");
  assert.ok(scene.alpha.every((a) => a === undefined || near(a, 0.55)), "copies at 55%");
  const two = setCrystal(m, 0, { repeat: [2, 2, 2] }).models![0], s2 = shownSites(two);
  assert.equal(s2.length, 125);
  assert.equal(siteBonds(two, s2).length, 300);
  // The copies are pictures only: the drawing still has its 8 ions and 12 bonds.
  assert.equal(m.atoms.length, 8);
  assert.equal(m.bonds.length, 12);
  // Stubs: in a 1 × 1 × 1 cell every bond leaving the box from a shown ion is drawn as a short dashed stub.
  const prims = crystalPrimitives(m, x, { paper: "#ffffff" }), dashed = prims.map(inner).filter((p) => p.kind === "wire" && p.dash);
  assert.ok(dashed.length > 3, "dashed hidden edges and stubs");
}

// ---- Perovskite: titanium on eight corners, oxygen on twelve edges ----
{
  const m = open(SRTIO3), x = m.models![0], scene = crystalScene(m, x), count = (el: string) => scene.points.filter((p) => p.symbol === el).length;
  assert.deepEqual([count("Ti"), count("O"), count("Sr")], [8, 12, 1]);
  assert.equal(x.xyz.length, 5, "the model keeps its five atoms");
  // Each titanium–oxygen bond along the twelve edges, drawn once.
  const tiO = scene.bonds.filter(([a, b]) => [scene.points[a].symbol, scene.points[b].symbol].sort().join() === "O,Ti");
  assert.equal(tiO.length, 24);
}

// ---- Dry ice: copies come as whole molecules ----
{
  const m = open(CO2), x = m.models![0], sites = shownSites(x), byCell = new Map<string, number>();
  for (const [, cell] of sites) byCell.set(cell.join(), (byCell.get(cell.join()) ?? 0) + 1);
  assert.ok([...byCell.values()].every((n) => n % 3 === 0), "three atoms of each molecule copied together");
  assert.equal(siteBonds(x, sites).length, (sites.length / 3) * 2);
}

// ---- The box: nine solid edges and three dashed ones, a dot at the origin, a, b and c in italics ----
{
  const m = open(NACL), prims = crystalPrimitives(m, m.models![0], { paper: "#ffffff" }).map(inner);
  const box = prims.filter((p): p is Extract<Prim3d, { kind: "wire" }> => p.kind === "wire" && !(p.dash && p.dash < 3 * p.width - 1e-9) && near(p.width, prims.find((q) => q.kind === "wire")!.width));
  const edges = box.filter((p) => !p.dash), hidden = box.filter((p) => p.dash);
  assert.equal(edges.length, 9);
  assert.equal(hidden.length, 3);
  const labels = prims.filter((p): p is Extract<Prim3d, { kind: "text" }> => p.kind === "text");
  assert.deepEqual(labels.map((t) => t.text), ["a", "b", "c"]);
  assert.ok(labels.every((t) => t.italic));
  // Twelve edges, three meeting at each of the eight corners.
  const ends = new Map<string, number>();
  for (const w of [...edges, ...hidden]) for (const q of [w.from, w.to]) { const k = q.map((v) => v.toFixed(6)).join(); ends.set(k, (ends.get(k) ?? 0) + 1); }
  assert.equal(ends.size, 8);
  assert.ok([...ends.values()].every((n) => n === 3));
  // Labels sit outside the box, clear of its edges.
  const svg = svgText(primitiveNodes(crystalPrimitives(m, m.models![0], { paper: "#ffffff" }), "c"));
  assert.ok(svg.includes('font-style="italic"') && svg.includes("stroke-dasharray"));
}

// ---- Look along: down an axis, the drawing laid out again on its box ----
{
  const m = open(NACL), along = setCrystal(m, 0, { along: "c" }), x = along.models![0];
  assert.equal(x.crystal!.along, "c");
  // c points at the viewer; b up.
  const c = rotate(x.rotation, x.crystal!.vectors[2]), b = rotate(x.rotation, x.crystal!.vectors[1]);
  assert.ok(near(c[0], 0, 1e-9) && near(c[1], 0, 1e-9) && c[2] > 0);
  assert.ok(near(b[0], 0, 1e-9) && b[1] > 0);
  const labels = crystalPrimitives(along, x, { paper: "#ffffff" }).map(inner).filter((p): p is Extract<Prim3d, { kind: "text" }> => p.kind === "text").map((t) => t.text);
  assert.deepEqual(labels, ["a", "b"], "an axis seen end-on has no label");
  // The 2D atoms lie where the view puts them, 1.5 Å a bond length, with their old middle.
  const middle = (q: Mol) => { const xs = q.atoms.map((a) => a.location[0]), ys = q.atoms.map((a) => a.location[1]); return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]; };
  assert.ok(middle(along).every((v, k) => near(v, middle(m)[k], 1e-9)));
  const centre = crystalView(along, x, [0, 0]).view.centre;
  const placed = x.xyz.map((p) => rotate(x.rotation, [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]]).map((v) => v / 1.5));
  const d = (i: number, j: number, q: number[][]) => Math.hypot(q[i][0] - q[j][0], q[i][1] - q[j][1]);
  for (let i = 1; i < 8; i++) assert.ok(near(d(0, i, along.atoms.map((a) => a.location)), d(0, i, placed), 1e-9));
  // Along a, b and [111], each a proper rotation.
  for (const dir of ["a", "b", "111"] as const) {
    const r = alongBasis(x.crystal!.vectors, dir), det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
    assert.ok(near(det, 1, 1e-9), dir);
  }
  // The opening view: b to the right, c up, a towards the viewer, turned a little.
  const q = openingView(m.models![0]), a3 = rotate(q, [1, 0, 0]), b3 = rotate(q, [0, 1, 0]), c3 = rotate(q, [0, 0, 1]);
  assert.ok(a3[2] > 0.5 && b3[0] > 0.5 && c3[1] > 0.5);
}

// ---- Repeat keeps the atoms' size; the copies' opacity ----
{
  const m = open(NACL), x = m.models![0], big = setCrystal(m, 0, { repeat: [2, 1, 1] }).models![0];
  const s = (y: Model3d) => crystalView(m, y, [0, 0]).view.scale;
  assert.ok(near(s(x), s(big), 1e-9), "the scale of the atoms stays");
  assert.ok(big.size > x.size);
  const faint = setCrystal(m, 0, { copyOpacity: 0.3 });
  assert.ok(crystalScene(faint, faint.models![0]).alpha.every((a) => a === undefined || near(a, 0.3)));
  const none = setCrystal(m, 0, { copyOpacity: 0 });
  assert.equal(crystalScene(none, none.models![0]).shown.filter(Boolean).length, 8, "invisible copies do not show");
  // A big cell cannot repeat past the most atoms Octet draws.
  const r = fittingRepeat({ ...x, xyz: Array(1500).fill([0, 0, 0]) }, [4, 4, 4]);
  assert.ok(1500 * (r[0] + 1) * (r[1] + 1) * (r[2] + 1) <= 20_000 && r.every((n) => n >= 1));
  // Saved: defaults are not written, other values are read back.
  const back = parse(serialize(setCrystal(setCrystal(m, 0, { copyOpacity: 0.3 }), 0, { repeat: [3, 1, 2] }))).models![0].crystal!;
  assert.equal(back.copyOpacity, 0.3);
  assert.deepEqual(back.repeat, [3, 1, 2]);
  const plain = JSON.parse(serialize(m)).models[0].crystal;
  assert.ok(!("copyOpacity" in plain) && !("repeat" in plain));
}

// ---- Molecule only and solvent ----
{
  const co2 = open(CO2), x = co2.models![0], kept = moleculeAtoms(x);
  assert.equal(kept.size, 3, "the listed sites' molecule: one CO2");
  const mo = setCrystal(co2, 0, { moleculeOnly: true });
  assert.equal(crystalScene(mo, mo.models![0]).points.length, 3);
  assert.equal(crystalScene(mo, mo.models![0]).bonds.length, 2);
  assert.equal(moleculeAtoms(x, false).size, 3);
  assert.equal(mo.atoms.length, 12, "the drawing is unchanged");
  assert.ok(!kinds(crystalPrimitives(mo, mo.models![0], { paper: "#ffffff" })).includes("text"), "no cell, no labels");
  const nacl = open(NACL);
  for (const solvent of [true, false]) assert.equal(moleculeAtoms(nacl.models![0], solvent).size, 8, "a network keeps the whole cell");
  // Our own host and solvents, as a model: a ten-carbon chain, a water and another water (all listed sites).
  const chain: V3[] = Array.from({ length: 10 }, (_, i) => [1 + 1.5 * i, 2, 2]), waters: V3[] = [[3, 8, 8], [3.9, 8, 8], [2.7, 8.9, 8], [12, 8, 8], [12.9, 8, 8], [11.7, 8.9, 8]];
  const host: Model3d = { sources: [], elements: [...Array(10).fill("C"), "O", "H", "H", "O", "H", "H"], xyz: [...chain, ...waters], bonds: [...Array.from({ length: 9 }, (_, i) => [i, i + 1] as [number, number]), [10, 11], [10, 12], [13, 14], [13, 15]],
    fingerprint: "", rotation: [1, 0, 0, 0], offset: [0, 0], size: 1, display: "3d", crystal: { vectors: [[20, 0, 0], [0, 12, 0], [0, 0, 12]], sites: [{ atom: 0, asymmetric: true }, { atom: 10, asymmetric: true }, { atom: 13, asymmetric: true }] } };
  assert.equal(moleculeAtoms(host, true).size, 16);
  assert.deepEqual([...moleculeAtoms(host, false)].sort((a, b) => a - b), Array.from({ length: 10 }, (_, i) => i), "solvent off hides the small molecules");
  const twoWaters: Model3d = { ...host, elements: host.elements.slice(10), xyz: host.xyz.slice(10), bonds: [[0, 1], [0, 2], [3, 4], [3, 5]], crystal: { ...host.crystal!, sites: [{ atom: 0, asymmetric: true }, { atom: 3, asymmetric: true }] } };
  assert.equal(moleculeAtoms(twoWaters, false).size, 6, "equally small molecules all stay");
  const legacy: Model3d = { ...host, crystal: { vectors: host.crystal!.vectors } };
  assert.equal(moleculeAtoms(legacy, true).size, 16, "without input sites, all molecules");
}

// ---- Editing: a substitution keeps the cell, other changes mark the model ----
{
  const m = open(NACL), x = m.models![0], na = m.atoms.findIndex((a) => a.label === "Na");
  const k = { ...m, atoms: m.atoms.map((a, i) => (i === na ? { ...a, label: "K" } : a)) };
  assert.ok(!isStale(k, x), "Na⁺ to K⁺ keeps the cell");
  assert.ok(crystalScene(k, x).points.some((p) => p.symbol === "K"), "and shows in the model");
  const charged = { ...m, atoms: m.atoms.map((a, i) => (i === na ? { ...a, charge: 2 } : a)) };
  assert.ok(!isStale(charged, x));
  const gone = deleteAtoms(m, new Set([na]));
  assert.ok(gone.models?.[0] && isStale(gone, gone.models[0]), "a deleted atom marks the model");
  const bonded = { ...m, bonds: [...m.bonds, { type: 1, atoms: [0, 1] as [number, number] }] };
  assert.ok(isStale(bonded, x), "a new bond marks it too");
  // Copy and paste keep the cell; the copy's atoms follow their new places.
  const all = new Set(m.atoms.map((_, i) => i)), part = extractSelection(m, all, new Set());
  assert.ok(part.models?.[0].crystal);
  const pasted = insertMol(m, part, [20, 0]).mol;
  assert.equal(pasted.models!.length, 2);
  assert.deepEqual(pasted.models![1].sources, x.sources.map((s) => s! + 8));
  assert.deepEqual(pasted.models![1].crystal, x.crystal);
  // CDXML has the drawn atoms and bonds only.
  const cdxml = toCdxml(m, DEFAULT_STYLE);
  assert.ok(!/crystal|vectors|copyOpacity/.test(cdxml));
  assert.equal((cdxml.match(/<n\s/g) ?? []).length, 8);
  // The screen reader.
  assert.match(describeModel(x), /unit cell/);
  assert.match(structureText(m, [...all], {}).name, /3D model, ball and stick, in its unit cell/);
}

// ---- Dark paper: the cell is drawn in the ink it is given ----
{
  const m = open(NACL), prims = modelPrimitives(m, m.models![0], { dark: true, ink: "var(--ink)" }).map(inner);
  assert.ok(prims.filter((p) => p.kind === "wire").every((p) => p.kind === "wire" && p.colour === "var(--ink)"));
  assert.ok(prims.filter((p) => p.kind === "text").every((p) => p.kind === "text" && p.colour === "var(--ink)"));
}

// ---- Layout: the 2D drawing and the model's frame agree ----
{
  const m = open(NACL), x = m.models![0], again = layOutCrystal(m, 0, [5, 7]);
  const xs = again.atoms.map((a) => a.location[0]), ys = again.atoms.map((a) => a.location[1]);
  assert.ok(near((Math.min(...xs) + Math.max(...xs)) / 2, 5, 1e-9) && near((Math.min(...ys) + Math.max(...ys)) / 2, 7, 1e-9));
  assert.deepEqual(again.models![0].offset, x.offset, "the frame moves with its atoms");
  assert.ok(m.atoms.some((a) => Math.abs(a.location[2]) > 0.1), "depth kept");
}

console.log("crystalcell.check: all passed");
