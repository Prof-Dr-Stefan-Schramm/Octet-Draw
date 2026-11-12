// Run: node src/crystal.check.ts. Fails loudly if Octet stops reading crystal files (CIF, PDB, POSCAR, XYZ) as it
// should. ReShiki's reader tests (crates/io/src/crystal/tests.rs), rewritten with our own structures typed here from
// published cell parameters (rock salt, dry ice, urea, rutile, iron, water, silicon); no outside file is used.
import assert from "node:assert/strict";
import { bondOrders, crystalFormat, CrystalError, fromLabel, fromSymbol, Lattice, parseOperator, readCrystal, sameSite, type CrystalFormat } from "./crystal.ts";
import { fractionalOf } from "./crystalcell.ts";
import { parse, serialize } from "./file.ts";
import { problems } from "./check.ts";
import type { Adp, Model3d, V3 } from "./model3d.ts";
import type { Mol } from "./render.ts";

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const open = (format: CrystalFormat, text: string) => readCrystal(format, text);
const model = (m: Mol): Model3d => { assert.equal(m.models?.length, 1); return m.models![0]; };
const count = (m: Mol, el: string) => m.atoms.filter((a) => a.label === el).length;
const distance = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fractional = (x: Model3d, i: number) => fractionalOf(x.crystal!.vectors)(x.xyz[i]);
// Bonds of an atom (by model index, which is the drawing's index on opening): inside the drawing and leaving the cell.
const bondsOf = (m: Mol, i: number) => m.bonds.filter((b) => b.atoms.includes(i)).length + (model(m).crystal?.crossing ?? []).reduce((n, c) => n + (c.a === i ? 1 : 0) + (c.b === i ? 1 : 0), 0);
const refused = (format: CrystalFormat, text: string, message: string) => {
  assert.throws(() => open(format, text), (e: unknown) => e instanceof CrystalError && e.message.includes(message), `${format} ${JSON.stringify(text.slice(0, 80))}: expected "${message}"`);
};

// ---- Our test structures ----

// Rock salt, Fm-3m (a = 5.6402 Å): the 192 operators made here from the 48 signed permutations and the four
// F-centring translations.
const signed: string[] = [];
for (const p of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) for (let s = 0; s < 8; s++) signed.push(p.map((k, i) => `${(s >> i) & 1 ? "-" : ""}${"xyz"[k]}`).join(","));
const FM3M = [["0", "0", "0"], ["0", "1/2", "1/2"], ["1/2", "0", "1/2"], ["1/2", "1/2", "0"]].flatMap((t) => signed.map((o) => o.split(",").map((c, i) => (t[i] === "0" ? c : `${c}+${t[i]}`)).join(",")));
const cubic = (a: number) => `_cell_length_a ${a}\n_cell_length_b ${a}\n_cell_length_c ${a}\n_cell_angle_alpha 90\n_cell_angle_beta 90\n_cell_angle_gamma 90\n`;
const NACL = `# rock salt, typed for Octet's checks\ndata_nacl\n_journal_name_full 'DROPPED journal'\n${cubic("5.6402(3)")}_space_group_name_H-M_alt 'F m -3 m'\nloop_\n_space_group_symop_operation_xyz\n${FM3M.map((o) => `'${o}'`).join("\n")}
loop_\n_atom_site_label\n_atom_site_type_symbol\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\n_atom_site_U_iso_or_equiv\nNa1 Na1+ 0 0 0 0.0120\nCl1 Cl1- 0.5 0.5 0.5 0.0110
loop_\n_refln_index_h\n_refln_index_k\n_refln_index_l\n1 1 1\n2 0 0\n`;
// Dry ice, Pa-3 (a = 5.624 Å, O at x = 0.1185: C=O 1.154 Å), with displacement parameters chosen for the checks.
const PA3_HALF = ["x,y,z", "-x+1/2,-y,z+1/2", "-x,y+1/2,-z+1/2", "x+1/2,-y+1/2,-z", "z,x,y", "z+1/2,-x+1/2,-y", "-z+1/2,-x,y+1/2", "-z,x+1/2,-y+1/2", "y,z,x", "-y,z+1/2,-x+1/2", "y+1/2,-z+1/2,-x", "-y+1/2,-z,x+1/2"];
const invert = (op: string) => op.split(",").map((c) => c.replace(/[+-]?[xyz]/g, (t) => (t.startsWith("-") ? "+" + t.slice(1) : "-" + t.replace("+", ""))).replace(/\+(1\/2)/, "-$1").replace(/^\+/, "")).join(",");
const PA3 = [...PA3_HALF, ...PA3_HALF.map(invert)];
const CO2 = `data_co2\n${cubic("5.624")}_symmetry_space_group_name_H-M 'P a -3'\nloop_\n_symmetry_equiv_pos_as_xyz\n${PA3.map((o) => `'${o}'`).join("\n")}
loop_\n_atom_site_label\n_atom_site_type_symbol\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\n_atom_site_U_iso_or_equiv\nC1 C 0 0 0 0.030\nO1 O 0.1185 0.1185 0.1185 0.045
loop_\n_atom_site_aniso_label\n_atom_site_aniso_U_11\n_atom_site_aniso_U_22\n_atom_site_aniso_U_33\n_atom_site_aniso_U_12\n_atom_site_aniso_U_13\n_atom_site_aniso_U_23\nO1 0.045 0.045 0.045 0.010 0.010 0.010\n`;
// Urea, planar, in a tetragonal cell (a = 5.565, c = 4.684 Å), one molecule, as HETATM records in PDB's columns.
const pdbAtom = (serial: number, name: string, x: number, y: number, z: number, element: string, extra = { alt: " ", residue: 1, b: 10 }) =>
  `HETATM${String(serial).padStart(5)} ${name.padEnd(4)}${extra.alt}URE A${String(extra.residue).padStart(4)}    ${x.toFixed(3).padStart(8)}${y.toFixed(3).padStart(8)}${z.toFixed(3).padStart(8)}  1.00${extra.b.toFixed(2).padStart(6)}          ${element.padStart(2)}\n`;
const UREA_ATOMS: [string, number, number, number, string][] = [["C1", 0, 0, 0, "C"], ["O1", 0, 1.26, 0, "O"], ["N1", 1.16, -0.7, 0, "N"], ["N2", -1.16, -0.7, 0, "N"], ["H1", 2.03, -0.2, 0, "H"], ["H2", 1.16, -1.71, 0, "H"], ["H3", -2.03, -0.2, 0, "H"], ["H4", -1.16, -1.71, 0, "H"]];
const UREA = "REMARK   1 urea, typed for Octet's checks\nCRYST1    5.565    5.565    4.684  90.00  90.00  90.00 P -4 21 m     2\n" + UREA_ATOMS.map(([n, x, y, z, e], k) => pdbAtom(k + 1, n, x + 2.78, y + 2.78, z + 2.34, e)).join("") + "END\n";
// Rutile TiO2 (a = 4.594, c = 2.959 Å, u = 0.305), POSCAR Direct.
const u = 0.305, RUTILE = `rutile\n1.0\n4.594 0 0\n0 4.594 0\n0 0 2.959\nTi O\n2 4\nDirect\n0 0 0\n0.5 0.5 0.5\n${u} ${u} 0\n${1 - u} ${1 - u} 0\n${0.5 + u} ${0.5 - u} 0.5\n${0.5 - u} ${0.5 + u} 0.5\n`;
const WATER = "3\nwater energy=-76.4\nO 0 0 0\nH 0.757 0.586 0\nH -0.757 0.586 0\n";
const h = 2.7155, SILICON = `2\nLattice="0 ${h} ${h} ${h} 0 ${h} ${h} ${h} 0" Properties=species:S:1:pos:R:3:forces:R:3 pbc="T T T"\nSi 0 0 0 0 0 0\nSi 1.35775 1.35775 1.35775 0 0 0\n`;
const CELL = `data_t\n${cubic("4")}`;
const SITES = "loop_\n_atom_site_label\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\n";

// ---- Rock salt: each ion once, with bonds leaving the cell ----
{
  const { mol, notes } = open("cif", NACL), x = model(mol);
  assert.deepEqual(notes, []);
  assert.deepEqual([count(mol, "Na"), count(mol, "Cl")], [4, 4]);
  for (let i = 0; i < 8; i++) assert.ok(fractional(x, i).every((f) => f >= -1e-3 && f < 1), "every ion in the cell");
  for (let i = 0; i < 8; i++) assert.equal(bondsOf(mol, i), 6, "six bonds round each ion");
  assert.equal(mol.bonds.length * 2 + x.crystal!.crossing!.length * 2, 48);
  assert.ok(x.crystal!.crossing!.length > 0);
  assert.ok(mol.atoms.every((a) => (a.label === "Na" ? a.charge === 1 : a.charge === -1)), "charges from Na1+ and Cl1-");
  assert.ok(mol.atoms.every((a) => a.implicitHCount === 0), "every atom explicit");
  assert.ok(near(x.crystal!.vectors[0][0], 5.6402));
  assert.equal(x.crystal!.sites!.filter((s) => s.label === "Na1").length, 4);
  assert.ok(x.crystal!.sites!.every((s) => s.adp && "iso" in s.adp && s.adp.iso > 0.01));
  assert.ok(mol.bonds.every((b) => b.distance), "bonds from distances are marked");
  assert.equal(x.display, "3d");
  // Check Structure leaves the six-bonded ions alone.
  assert.equal(problems(mol).length, 0);
}

// ---- Dry ice: whole molecules with their centres in the cell ----
{
  const { mol } = open("cif", CO2), x = model(mol);
  assert.deepEqual([count(mol, "C"), count(mol, "O")], [4, 8]);
  assert.equal(mol.bonds.length, 8);
  assert.ok(mol.bonds.every((b) => b.type === 2), "O=C=O");
  assert.equal(x.crystal!.crossing, undefined);
  for (const b of mol.bonds) assert.ok(near(distance(x.xyz[b.atoms[0]], x.xyz[b.atoms[1]]), 1.154, 0.01), "C=O whole, not across the cell");
  mol.atoms.forEach((a, i) => { if (a.label === "C") assert.ok(fractional(x, i).every((f) => f >= -1e-3 && f < 1)); });
  assert.ok(mol.atoms.some((a, i) => a.label === "O" && fractional(x, i).some((f) => f < -0.05)), "an oxygen sticks out of the box");
  const os = x.crystal!.sites!.filter((s) => mol.atoms[s.atom].label === "O");
  for (const s of os) {
    const adp = s.adp as { aniso: number[] };
    assert.ok(adp.aniso.slice(0, 3).every((v) => near(v, 0.045, 1e-6)));
    assert.ok(adp.aniso.slice(3).every((v) => near(Math.abs(v), 0.010, 1e-6)));
  }
  assert.ok(os.some((s) => (s.adp as { aniso: number[] }).aniso.slice(3).some((v) => v < 0)), "operators turn the off-diagonal terms");
  assert.equal(x.crystal!.sites!.filter((s) => s.asymmetric).length, 2, "the two listed sites");
}

// ---- Input sites follow positions, not operator names ----
{
  const cell = CELL.replace(/ 4\n/g, " 20\n"), sites = `${SITES}Ar1 .1 .2 .3\n`;
  for (const ops of ["'-x,-y,-z'\n'x,y,z'", "'x+1,y,z'\n'-x,-y,-z'"]) {
    const { mol } = open("cif", `${cell}loop_\n_symmetry_equiv_pos_as_xyz\n${ops}\n${sites}`), x = model(mol);
    assert.equal(mol.atoms.length, 2, ops);
    const listed = x.crystal!.sites!.filter((s) => s.asymmetric);
    assert.equal(listed.length, 1);
    assert.ok(distance(x.xyz[listed[0].atom], [2, 4, 6]) < 1e-4);
  }
  const text = `${cell}loop_\n_symmetry_equiv_pos_as_xyz\n'-x,-y,-z'\n${sites}`;
  let x = model(open("cif", text).mol);
  assert.equal(x.xyz.length, 1);
  assert.ok(!x.crystal!.sites![0].asymmetric);
  assert.ok(distance(x.xyz[0], [18, 16, 14]) < 1e-4);
  x = model(open("cif", text.replace("Ar1 .1 .2 .3", "Ar1 0 0 0")).mol);
  assert.ok(x.crystal!.sites![0].asymmetric, "a special position keeps its input site");
  x = model(open("cif", `${cell}loop_\n_symmetry_equiv_pos_as_xyz\n'-x,-y,-z'\n'x,y,z'\n${sites}Ar2 .9 .8 .7\n`).mol);
  assert.equal(x.xyz.length, 2);
  assert.ok(x.crystal!.sites!.every((s) => s.asymmetric), "a later record promotes a copy it lands on");
}

// ---- PDB: CRYST1 and a whole molecule ----
{
  const { mol } = open("pdb", UREA), x = model(mol);
  assert.equal(mol.atoms.length, 8);
  assert.equal(mol.bonds.length, 7);
  const double = mol.bonds.filter((b) => b.type === 2);
  assert.equal(double.length, 1);
  assert.deepEqual(double[0].atoms.map((i) => mol.atoms[i].label).sort(), ["C", "O"]);
  assert.ok(near(x.crystal!.vectors[2][2], 4.684, 1e-4));
  assert.equal(x.crystal!.crossing, undefined);
  assert.equal(x.crystal!.sites![0].label, "C1");
  const centre = [0, 1, 2].map((k) => x.xyz.reduce((s, _, i) => s + fractional(x, i)[k], 0) / x.xyz.length);
  assert.ok(centre.every((f) => f >= -1e-3 && f < 1));
  const adp = x.crystal!.sites![0].adp as { iso: number };
  assert.ok(near(adp.iso, 10 / (8 * Math.PI * Math.PI), 1e-9), "B becomes U");
  // Without hydrogens the nitrogens stay short of their valence, so no bond order is guessed.
  const bare = UREA.split("\n").filter((l) => !/ H\s*$/.test(l)).join("\n");
  const b = open("pdb", bare).mol;
  assert.equal(b.atoms.length, 4);
  assert.ok(b.bonds.every((x) => x.type === 1));
}

// ---- POSCAR ----
{
  const { mol } = open("poscar", RUTILE), x = model(mol);
  assert.deepEqual([count(mol, "Ti"), count(mol, "O")], [2, 4]);
  mol.atoms.forEach((a, i) => assert.equal(bondsOf(mol, i), a.label === "Ti" ? 6 : 3, `${a.label}${i}`));
  const ti = (i: number) => mol.atoms[i].label === "Ti";
  assert.ok(!mol.bonds.some((b) => ti(b.atoms[0]) && ti(b.atoms[1])) && !x.crystal!.crossing!.some((c) => ti(c.a) && ti(c.b)), "no Ti–Ti bond in an oxide");
  assert.equal(x.crystal!.sites, undefined);
  // A metal keeps its metal–metal bonds: bcc iron, eight neighbours and six next ones.
  const iron = open("poscar", "Fe bcc\n2.87\n1 0 0\n0 1 0\n0 0 1\nFe\n2\nDirect\n0 0 0\n0.5 0.5 0.5\n").mol;
  for (let i = 0; i < 2; i++) assert.equal(bondsOf(iron, i), 14);
  // Cartesian positions are scaled; POTCAR names and selective dynamics.
  const nacl = model(open("poscar", "x\n2.0\n1 0 0\n0 1 0\n0 0 1\nNa_pv Cl\n1 1\nSelective dynamics\nCartesian\n0 0 0 T T T\n0.5 0.5 0.5 F F F\n").mol);
  assert.ok(near(nacl.crystal!.vectors[0][0], 2));
  assert.ok(near(distance(nacl.xyz[0], nacl.xyz[1]), Math.sqrt(3), 1e-9));
  // Three scale factors.
  const three = model(open("poscar", "xyz\n1 2 3\n1 0 0\n0 1 0\n0 0 1\nAr\n1\nCartesian\n0.5 0.5 0.5\n").mol);
  assert.deepEqual(three.crystal!.vectors, [[1, 0, 0], [0, 2, 0], [0, 0, 3]]);
  assert.deepEqual(three.xyz[0], [0.5, 1, 1.5]);
  refused("poscar", "x\n1 2\n1 0 0\n0 1 0\n0 0 1\nAr\n1\nDirect\n0 0 0\n", "three positive");
}

// ---- XYZ ----
{
  const { mol } = open("xyz", WATER), x = model(mol);
  assert.equal(mol.bonds.length, 2);
  assert.equal(x.crystal, undefined, "no cell");
  assert.equal(x.display, "3d");
  assert.ok(mol.atoms.some((a) => Math.abs(a.location[2]) > 1e-6), "laid out with depth");
  assert.ok(!mol.bonds.some((b) => b.distance), "a molecule without a cell is not marked");
  const si = open("xyz", SILICON).mol;
  assert.equal(si.atoms.length, 2);
  assert.equal(si.bonds.length + model(si).crystal!.crossing!.length, 4);
  for (let i = 0; i < 2; i++) assert.equal(bondsOf(si, i), 4);
  assert.ok(si.bonds.every((b) => b.type === 1), "networks keep single bonds");
  // Periodic flags.
  const flags = (pbc: string) => `2\nLattice="10 0 0 0 10 0 0 0 10" pbc="${pbc}"\nC 0.1 5 5\nC 9.9 5 5\n`;
  assert.equal(open("xyz", flags("F F F")).mol.atoms.length, 2);
  assert.equal(model(open("xyz", flags("F F F")).mol).crystal, undefined);
  const one = open("xyz", flags("T T T"));
  assert.equal(one.mol.atoms.length, 1);
  assert.deepEqual(one.notes, ["1 overlapping atom left out"]);
  refused("xyz", flags("T T F"), "pbc");
  // Ethane carbons alone stay single.
  const ethane = open("xyz", "2\nethane carbons\nC 0 0 0\nC 1.54 0 0\n").mol;
  assert.deepEqual(ethane.bonds.map((b) => b.type), [1]);
}

// ---- Saving keeps the structure and nothing else of the file ----
{
  for (const [format, text] of [["cif", NACL], ["cif", CO2], ["pdb", UREA], ["poscar", RUTILE], ["xyz", WATER], ["xyz", SILICON]] as const) {
    const { mol } = open(format, text), saved = serialize(mol);
    for (const dropped of ["DROPPED", "journal", "refln", "energy", "forces", "REMARK", "symop", "typed"]) assert.ok(!saved.includes(dropped), `${format}: ${dropped}`);
    const back = parse(saved);
    assert.equal(!!back.models?.[0].crystal, !!mol.models![0].crystal, format);
    assert.deepEqual(parse(serialize(back)).models, back.models, `${format}: saving again changes nothing`);
    assert.deepEqual(back.models![0].crystal?.crossing, mol.models![0].crystal?.crossing);
    assert.deepEqual(back.bonds.map((b) => [b.atoms, b.type, b.distance]), mol.bonds.map((b) => [b.atoms, b.type, b.distance]));
  }
}

// ---- Symmetry operators ----
{
  assert.deepEqual(parseOperator("-x+1/2, y, -z"), { r: [[-1, 0, 0], [0, 1, 0], [0, 0, -1]], t: [0.5, 0, 0] });
  assert.deepEqual(parseOperator("1/2+X,Y-X,0.25+z"), { r: [[1, 0, 0], [-1, 1, 0], [0, 0, 1]], t: [0.5, 0, 0.25] });
  for (const bad of ["x,y", "x,y,z,x", "x,y,a", "2x,y,z", "x,x,z"]) assert.equal(parseOperator(bad), undefined, bad);
}

// ---- Disorder ----
{
  const text = `${CELL}_space_group_name_H-M_alt 'P 1'\n${SITES}_atom_site_disorder_group\nC1 0.1 0.1 0.1 .\nO1B 0.1 0.4 0.1 2\nO1A 0.4 0.1 0.1 1\nN1 0.6 0.6 0.6 2\n`;
  const { mol, notes } = open("cif", text);
  assert.deepEqual(model(mol).crystal!.sites!.map((s) => s.label), ["C1", "O1A"]);
  assert.deepEqual(notes, ["Disordered sites: kept group 1; left out group 2, 2 site records"]);
  assert.deepEqual(model(mol).crystal!.notes, notes);
}
{
  const atoms = `${SITES}_atom_site_occupancy\n_atom_site_disorder_assembly\n_atom_site_disorder_group\n`;
  const text = `${CELL}_audit_creation_method loop_based\n_publ_section_comment\n;\nnote\n; _space_group_name_H-M_alt 'P 1'\n${atoms}C0 .2 .2 .2 0 . .\nO1 .2 .2 .2 1 . 0\nN1A .5 .1 .1 .3 A 1\nN1B .1 .5 .1 .7 A 2\nS1C .1 .1 .5 .8 B 3\nS1D .7 .7 .5 .2 B 4\n`;
  const { mol, notes } = open("cif", text);
  assert.deepEqual(model(mol).crystal!.sites!.map((s) => s.label), ["O1", "N1B", "S1C"], "the unoccupied site goes; assemblies choose apart");
  assert.deepEqual(notes, ["Disordered sites: kept group 2 (occupancy 0.7) of assembly A; left out group 1 (0.3); kept group 3 (occupancy 0.8) of assembly B; left out group 4 (0.2), 2 site records"]);
  const huge = `${CELL}_space_group_name_H-M_alt 'P 1'\n${SITES}_atom_site_disorder_group\nC1 0 0 0 -9223372036854775808\n`;
  assert.equal(open("cif", huge).mol.atoms.length, 1);
}
{
  const atoms = `${SITES}_atom_site_occupancy\n_atom_site_disorder_group\n`;
  for (const [first, second] of [[".2", ".3"], [".2", "?"], ["?", ".2"], [".", ".2"]]) {
    const { mol, notes } = open("cif", `${CELL}_space_group_name_H-M_alt 'P 1'\n${atoms}O1A .1 .1 .1 ${first} 1\nO2A .4 .1 .1 ${second} 1\nO3A .7 .1 .1 ${first} 1\nO1B .1 .4 .1 .8 2\nO2B .4 .4 .1 .8 2\n`);
    assert.deepEqual(model(mol).crystal!.sites!.map((s) => s.label), ["O1A", "O2A", "O3A"], `${first} ${second}`);
    assert.deepEqual(notes, ["Disordered sites: kept group 1; left out group 2 (0.8), 2 site records"]);
  }
  const one = open("cif", `${CELL}_space_group_name_H-M_alt 'P 1'\n${atoms}O1A .1 .1 .1 .2 1\nO1B .1 .4 .1 ? 2\n`);
  assert.deepEqual(one.notes, ["Disordered sites: kept group 1 (occupancy 0.2); left out group 2, 1 site record"]);
  const major = open("cif", `${CELL}_space_group_name_H-M_alt 'P 1'\n${atoms}O1A .1 .1 .1 .4 1\nO2A .4 .1 .1 .4 1\nO3A .7 .1 .1 .4 1\nO1B .1 .4 .1 .6 -2\n`);
  assert.equal(major.mol.atoms.length, 1);
  assert.deepEqual(major.notes, ["Disordered sites: kept group 2 (occupancy 0.6); left out group 1 (0.4), 3 site records"]);
  for (const [rows, note] of [
    ["O1B .1 .4 .1 .5 2\nO1A .1 .1 .1 .5 1\n", "Disordered sites: kept group 1 (occupancy 0.5); left out group 2 (0.5), 1 site record"],
    ["O1C .4 .4 .1 .4 3\nO1B .1 .4 .1 .2 2\nO1A .1 .1 .1 .4 1\n", "Disordered sites: kept group 1 (occupancy 0.4); left out groups 2 (0.2), 3 (0.4), 2 site records"],
  ]) {
    const r = open("cif", `${CELL}_space_group_name_H-M_alt 'P 1'\n${atoms}${rows}`);
    assert.equal(model(r.mol).crystal!.sites![0].label, "O1A");
    assert.deepEqual(r.notes, [note]);
  }
  const rows = "ABCDEFGH".split("").map((set, i) => { const x = (0.05 + 0.1 * i).toFixed(2); return `O${i}A ${x} .1 .1 .3 ${set} 1\nO${i}B ${x} .6 .1 .7 ${set} 2\n`; }).join("");
  const many = open("cif", `${CELL}_space_group_name_H-M_alt 'P 1'\n${SITES}_atom_site_occupancy\n_atom_site_disorder_assembly\n_atom_site_disorder_group\n${rows}`);
  assert.equal(many.mol.atoms.length, 8);
  assert.deepEqual(many.notes, ["Disordered sites: kept one group in each of 8 assemblies, 8 site records"]);
}

// ---- Boundaries, B values, alternate locations ----
{
  const { mol, notes } = open("cif", `${CELL}${SITES}Ar1 0 0 0\nAr2 1.0 0 0\nAr3 0.99999 1 1\n`);
  assert.equal(mol.atoms.length, 1, "atoms on the cell's faces are kept once");
  assert.ok(notes.some((n) => n.includes("no symmetry operators")));
  const b = open("cif", `${CELL}${SITES}_atom_site_B_iso_or_equiv\nFe1 0 0 0 7.8957\nFe2 0.5 0.5 0.5 ?\nloop_\n_atom_site_aniso_label\n_atom_site_aniso_B_11\n_atom_site_aniso_B_22\n_atom_site_aniso_B_33\n_atom_site_aniso_B_12\n_atom_site_aniso_B_13\n_atom_site_aniso_B_23\nFe2 7.8957 7.8957 7.8957 0 0 0\n`);
  const [s0, s1] = model(b.mol).crystal!.sites!;
  assert.ok(near((s0.adp as { iso: number }).iso, 0.1, 1e-4));
  assert.ok(near((s1.adp as { aniso: number[] }).aniso[0], 0.1, 1e-4));
  const alt = [pdbAtom(1, "C1", 0, 0, 0, "C", { alt: "A", residue: 1, b: 10 }), pdbAtom(2, "C1", 0.5, 0, 0, "C", { alt: "B", residue: 1, b: 10 }), pdbAtom(3, "C2", 5, 0, 0, "C", { alt: "C", residue: 2, b: 10 }), pdbAtom(4, "C2", 5.5, 0, 0, "C", { alt: "D", residue: 2, b: 10 })].join("");
  const r = open("pdb", alt);
  assert.equal(r.mol.atoms.length, 2);
  assert.ok(r.notes[0].includes("left out 2 atom records"));
  assert.deepEqual(parse(serialize(r.mol)).models?.[0].crystal, undefined, "no cell: a plain model");
}

// ---- Refusals ----
{
  const atoms = SITES;
  for (const [format, text, message] of [
    ["cif", "data_x\n_cell_length_b 3\n", "no unit cell"],
    ["cif", `${CELL}${atoms}C1 0 0\n`, "not a whole number of rows"],
    ["cif", `${CELL};\nopen text\n`, "not closed"],
    ["cif", `${CELL}${atoms}Q1 0 0 0\n`, "element of atom 'Q1'"],
    ["cif", `${CELL}${atoms}C1 0 ? 0\n`, "no fractional coordinates"],
    ["cif", CELL.replace("_cell_angle_gamma 90", "_cell_angle_gamma 190") + atoms, "between 0° and 180°"],
    ["cif", `${CELL}loop_\n_symmetry_equiv_pos_as_xyz\n'x,y,q'\n${atoms}C1 0 0 0\n`, "symmetry operator"],
    ["cif", CELL, "no atom sites"],
    ["pdb", "CRYST1    5.000    5.000    5.000  90.00  90.00  90.00 P 1\n", "no ATOM"],
    ["poscar", "x\n1\n1 0 0\n0 1 0\n0 0 1\n1 1\nDirect\n0 0 0\n", "VASP 4"],
    ["poscar", "x\n1\n1 0 0\n0 1 0\n0 0 1\nNa\n2\nDirect\n0 0 0\n", "ends before"],
    ["poscar", "x\n1\n1 0 0\n0 1 0\n0 0 0\nNa\n1\nDirect\n0 0 0\n", "no volume"],
    ["xyz", "two\n\nC 0 0 0\n", "number of atoms"],
    ["xyz", "1\n\nXx 0 0 0\n", "not an element"],
    ["xyz", '1\nLattice="1 0 0 0 1 0"\nC 0 0 0\n', "nine numbers"],
    ["xyz", "2\n\nC 0 0 0\n", "ends before"],
  ] as const) refused(format, text, message);
  // Line numbers where they help.
  refused("cif", `${CELL}${atoms}Q1 0 0 0\n`, "Line 13:");
}

// ---- File names pick the format ----
{
  for (const [name, format] of [["NaCl.CIF", "cif"], ["1abc.pdb", "pdb"], ["1abc.ent", "pdb"], ["POSCAR", "poscar"], ["CONTCAR_relaxed", "poscar"], ["rutile.vasp", "poscar"], ["water.xyz", "xyz"], ["si.extxyz", "xyz"], ["C:\\data\\POSCAR", "poscar"], ["POSCAR.1", "poscar"], ["POSCAR study.oct", undefined], ["drawing.mol", undefined], ["notes.txt", undefined]] as const) assert.equal(crystalFormat(name), format, name);
}

// ---- Files cannot ask for endless work ----
{
  const lattice = new Lattice([[10, 0, 0], [30, 10, 0], [0, 0, 10]]);
  assert.ok(sameSite(lattice, [0, 0, 0], [0.05, 9.95, 0]));
  assert.ok(!sameSite(lattice, [0, 0, 0], [0.5, 9.5, 0]));
  refused("poscar", "Fe\n1\n2.8 0 0\n14 2.8 0\n0 0 2.8\nFe\n1\nDirect\n0 0 0\n", "reduced");
  refused("xyz", "1\nProperties=x:R:18446744073709551615:species:S:1:pos:R:3\nC 0 0 0\n", "Properties");
  refused("xyz", '2\nLattice="999 0 0 999 0.000001 0 0 0 999"\nC 0 0 0\nC 0 0 1\n', "thinner");
  const one = `${SITES}C1 0.1 0.2 0.3\n`;
  assert.equal(open("cif", `${CELL}loop_\n_symmetry_equiv_pos_as_xyz\n${"'x,y,z'\n'x+1,y,z'\n".repeat(700)}${one}`).mol.atoms.length, 1, "repeats count once");
  refused("cif", `${CELL}loop_\n_symmetry_equiv_pos_as_xyz\n${Array.from({ length: 200 }, (_, i) => `'x+${i}/400,y,z'\n`).join("")}${one}`, "at most 192");
  refused("cif", `${CELL}loop_\n_symmetry_equiv_pos_as_xyz\n${Array.from({ length: 100_000 }, (_, i) => `'x+${i}/200000,y,z'\n`).join("")}${one}`, "100000 symmetry operators");
  refused("xyz", "2001\n\n", "at most 2000");
  refused("cif", `${CELL}${SITES}${Array.from({ length: 2001 }, (_, i) => `C${i} ${(i % 13) / 13} ${Math.floor(i / 13) % 13 / 13} ${Math.floor(i / 169) / 13}\n`).join("")}`, "at most 2000");
}

// ---- Elements ----
{
  assert.deepEqual(fromSymbol("O2-"), { element: "O", charge: -2 });
  assert.deepEqual(fromSymbol("Fe3+"), { element: "Fe", charge: 3 });
  assert.deepEqual(fromSymbol("D"), { element: "H", charge: 0 });
  assert.equal(fromLabel("C1"), "C");
  assert.equal(fromLabel("Cl2A"), "Cl");
  assert.equal(fromLabel("O1W"), "O");
  assert.equal(fromLabel("CA"), "C", "a capital second letter is not part of the symbol");
}

// ---- Bond orders do not depend on atom order ----
{
  // Azulene with its hydrogens, by its graph alone: the shared bond stays single, each carbon gets one double bond.
  const ring = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [3, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 4]] as [number, number][];
  const hs = [0, 1, 2, 5, 6, 7, 8, 9].map((c, k) => [c, 10 + k] as [number, number]);
  for (const order of [[...ring, ...hs], [...hs, ...ring].reverse()]) {
    const atoms = [...Array(10).fill({ element: "C", charge: 0 }), ...Array(8).fill({ element: "H", charge: 0 })];
    const orders = bondOrders(atoms, order, atoms.map(() => false));
    const shared = order.findIndex(([a, b]) => (a === 3 && b === 4) || (a === 4 && b === 3));
    assert.equal(orders[shared], 1);
    for (let c = 0; c < 10; c++) assert.equal(order.filter((b, k) => b.includes(c) && orders[k] === 2).length, 1, `carbon ${c}`);
  }
}

// Each atom's displacement parameters are kept in Å² and survive saving.
{
  const { mol } = open("cif", CO2), back = parse(serialize(mol));
  const adps = (m: Mol) => m.models![0].crystal!.sites!.map((s) => s.adp as Adp);
  assert.deepEqual(adps(back), adps(mol).map((a) => ("iso" in a ? { iso: Math.round(a.iso * 1e6) / 1e6 } : { aniso: a.aniso.map((v) => Math.round(v * 1e6) / 1e6) })));
}

console.log("crystal.check: all passed");
