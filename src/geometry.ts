// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/io/src/geometry.rs and crates/io/src/geometry/view.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// 3D Optimise (Structure menu) and the 3D shape of a 3D model: a structure sent to the force-field solver
// (src-tauri/geometry, run in a worker process by the app), and its answer put back. Octet's atoms and bonds become
// the solver's request: elements, charges, hydrogens (as Octet counts them), Kekulé bonds, a chiral tag for each
// stereocentre from its wedges, and each double bond's cis or trans as drawn. The answer is in Å with the added
// hydrogens after the structure's own atoms; it is turned to face as the drawing does (Horn's fit, a proper rotation,
// so the hand is kept) and scaled so a C–C bond is about a bond length.
import { AROMATIC, HBOND, QUADRUPLE, hydrogens, type Mol } from "./render.ts";
import { kekulise, rings } from "./rings.ts";
import type { ForceField, Geometry, V3 } from "./model3d.ts";

export type GeometryAtom = { atomic_number: number; isotope: number; charge: number; explicit_h: number; no_implicit: boolean; aromatic: boolean; radical: number; chiral_tag: 0 | 1 | 2 };
export type GeometryBond = { a: number; b: number; order: 1 | 2 | 3 | 12; aromatic: boolean; stereo: 0 | 1 | 2 | 3 | 4 | 5; stereo_atoms: [number, number] | null };
export type GeometryRequest = {
  atoms: GeometryAtom[]; bonds: GeometryBond[]; field: ForceField; operation: "Generate" | "Relax" | "Evaluate";
  coordinates: V3[]; fixed_atoms: number[]; conformers: number; seed: number; max_iterations: number;
};
export type GeometryResponse = {
  coordinates: V3[]; hydrogen_parents: number[]; original_count: number; initial_energy: number; energy: number;
  gradient: V3[] | null; converged: boolean; field: ForceField; diagnostics: string[];
};

// The solver's elements (ReShiki's list): no metals.
const NUMBERS: Record<string, number> = { H: 1, B: 5, C: 6, N: 7, O: 8, F: 9, Si: 14, P: 15, S: 16, Cl: 17, As: 33, Se: 34, Br: 35, I: 53 };
export const SEED = 0x52534b; // ReShiki's
export const ANGSTROM = 1.52; // Å in a bond length (Octet's 3D Clean Up: a C–C single bond is one bond length)

// The solver's chiral tag (RDKit's): look along v1·(v2 × v3), where v1, v2, v3 go from the atom to its first three
// neighbours in the order its bonds come in the request (its hydrogens last): 1 (clockwise) when it is negative, 2
// when positive. With a fourth neighbour d (or the hydrogen, opposite the others), det(v1 − d, v2 − d, v3 − d) has the
// same sign for any tetrahedral shape, and stays sound when only the fourth is wedged.
export function tagOf(vs: V3[]): 0 | 1 | 2 {
  if (vs.length < 3) return 0;
  const d: V3 = vs[3] ?? [-(vs[0][0] + vs[1][0] + vs[2][0]), -(vs[0][1] + vs[1][1] + vs[2][1]), -(vs[0][2] + vs[1][2] + vs[2][2])];
  const [a, b, c] = vs.slice(0, 3).map((v): V3 => [v[0] - d[0], v[1] - d[1], v[2] - d[2]]);
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  return Math.abs(det) < 1e-9 ? 0 : det < 0 ? 1 : 2;
}

// Why a structure cannot go to the solver, or undefined.
export function refusal(m: Mol, atoms: number[]): string | undefined {
  for (const i of atoms) {
    const a = m.atoms[i];
    if (a.text || a.inner) return "Expand its labels first (Structure > Expand Label).";
    if (a.query || a.centre || a.attach || a.bead) return "Octet cannot calculate a 3D shape for query atoms, attachment points or beads.";
    if (NUMBERS[a.label] === undefined) return `Octet cannot calculate a 3D shape with ${a.label}: the force fields have no parameters for it.`;
    if (a.radical) return "Octet cannot calculate a 3D shape for a radical.";
    if (Math.abs(a.charge ?? 0) > 8) return "The charge on an atom is too large.";
  }
  const set = new Set(atoms);
  if (m.bonds.some((b) => set.has(b.atoms[0]) && set.has(b.atoms[1]) && (b.type === QUADRUPLE || b.query || (b.type !== 1 && b.type !== 2 && b.type !== 3 && b.type !== AROMATIC && b.type !== HBOND))))
    return "Octet cannot calculate a 3D shape with this kind of bond.";
  if (atoms.length > 512) return "This structure has too many atoms for a 3D calculation (512 at most).";
  return undefined;
}

// The request for a structure (atoms: all of it, in the drawing's order), or a reason it cannot go.
export function geometryRequest(m: Mol, atoms: number[], field: ForceField, seed = SEED): GeometryRequest | string {
  const why = refusal(m, atoms);
  if (why) return why;
  const local = new Map(atoms.map((g, k) => [g, k]));
  const own = m.bonds.filter((b) => b.type !== HBOND && local.has(b.atoms[0]) && local.has(b.atoms[1]));
  // Aromatic bonds drawn as such become Kekulé bonds.
  const aromatic = own.flatMap((b, k) => (b.type === AROMATIC ? [k] : []));
  const doubled = new Set<number>();
  if (aromatic.length) {
    const edges = aromatic.map((k): [number, number] => [local.get(own[k].atoms[0])!, local.get(own[k].atoms[1])!]);
    const hasDouble = new Set(own.filter((b) => b.type === 2).flatMap((b) => b.atoms.map((i) => local.get(i)!)));
    const order = [...new Set(edges.flat())].filter((i) => !hasDouble.has(i)).sort((x, y) => (m.atoms[atoms[x]].label === "C" ? 0 : 1) - (m.atoms[atoms[y]].label === "C" ? 0 : 1));
    kekulise(edges, order).forEach((d, j) => { if (d) doubled.add(aromatic[j]); });
  }
  const orderOf = (k: number) => (own[k].type === AROMATIC ? (doubled.has(k) ? 2 : 1) : own[k].type) as 1 | 2 | 3;
  const used = atoms.map(() => 0);
  own.forEach((b, k) => { for (const i of b.atoms) used[local.get(i)!] += orderOf(k); });
  const deep = (() => { const zs = atoms.map((i) => m.atoms[i].location[2] ?? 0); return Math.max(...zs) - Math.min(...zs) > 0.3; })();
  // Where each atom is for stereo: its drawn place, a wedge's far end in front and a hash's behind (or its real depth).
  const at = (i: number, from?: number): V3 => {
    const l = m.atoms[i].location;
    if (deep || from === undefined) return [l[0], l[1], deep ? l[2] ?? 0 : 0];
    const b = own.find((x) => x.atoms[0] === from && x.atoms[1] === i);
    return [l[0], l[1], b?.stereo === 1 ? 0.8 : b?.stereo === 6 ? -0.8 : 0];
  };
  const neighbours = atoms.map(() => [] as number[]);
  for (const b of own) { const [x, y] = b.atoms.map((i) => local.get(i)!); neighbours[x].push(y); neighbours[y].push(x); }
  const wedged = new Set(own.filter((b) => b.stereo === 1 || b.stereo === 6).map((b) => local.get(b.atoms[0])!));
  const out: GeometryAtom[] = atoms.map((g, k) => {
    const a = m.atoms[g], h = a.implicitHCount ?? (a.label === "H" ? 0 : hydrogens(a.label, a.charge ?? 0, used[k]));
    let tag: 0 | 1 | 2 = 0;
    if (wedged.has(k) && neighbours[k].length + h === 4 && neighbours[k].length >= 3) {
      const c = at(g);
      tag = tagOf(neighbours[k].map((n) => { const p = at(atoms[n], g); return [p[0] - c[0], p[1] - c[1], p[2] - c[2]] as V3; }));
    }
    return { atomic_number: NUMBERS[a.label], isotope: a.isotope ?? 0, charge: a.charge ?? 0, explicit_h: h, no_implicit: true, aromatic: false, radical: 0, chiral_tag: tag };
  });
  // A double bond keeps its cis or trans as drawn (not in a ring of under 8, where it is fixed anyway).
  const small = new Set(rings({ atoms: atoms.map(() => ({ el: "C", charge: 0, h: 0 })), bonds: own.map((b) => ({ a: local.get(b.atoms[0])!, b: local.get(b.atoms[1])!, order: 1 as const })) })
    .filter((r) => r.length < 8).flatMap((r) => r.map((i, j) => [i, r[(j + 1) % r.length]].sort((x, y) => x - y).join(","))));
  const bonds: GeometryBond[] = own.map((b, k) => {
    const [x, y] = b.atoms.map((i) => local.get(i)!), order = orderOf(k);
    const base: GeometryBond = { a: x, b: y, order, aromatic: false, stereo: 0, stereo_atoms: null };
    if (order !== 2 || small.has([x, y].sort((p, q) => p - q).join(","))) return base;
    const rx = neighbours[x].find((n) => n !== y), ry = neighbours[y].find((n) => n !== x);
    if (rx === undefined || ry === undefined) return base;
    const p = (i: number) => at(atoms[i]), ax = p(x), ay = p(y), u = [ay[0] - ax[0], ay[1] - ax[1]];
    const side = (q: V3, o: V3) => u[0] * (q[1] - o[1]) - u[1] * (q[0] - o[0]);
    const sx = side(p(rx), ax), sy = side(p(ry), ay);
    if (Math.abs(sx) < 0.05 || Math.abs(sy) < 0.05) return base; // drawn in line: not known
    return { ...base, stereo: sx * sy > 0 ? 4 : 5, stereo_atoms: [rx, ry] };
  });
  const coordinates = deep ? atoms.map((i): V3 => { const l = m.atoms[i].location; return [l[0] * ANGSTROM, l[1] * ANGSTROM, (l[2] ?? 0) * ANGSTROM]; }) : [];
  return { atoms: out, bonds, field, operation: "Generate", coordinates, fixed_atoms: [], conformers: 8, seed, max_iterations: 500 };
}

// The answer as a model's shape: the structure's own atoms, then its hydrogens on their atoms.
export function geometryOf(res: GeometryResponse, seed = SEED): Geometry {
  const n = res.original_count;
  return { xyz: res.coordinates.slice(0, n), hydrogens: res.hydrogen_parents.map((parent, k) => ({ parent, xyz: res.coordinates[n + k] })), field: res.field, ...(seed !== SEED ? { seed } : {}) };
}

// Horn's best rotation (a unit quaternion) taking the centred points p onto the centred points q: the largest
// eigenvector of his 4×4 matrix, by power iteration from four starts (ReShiki's view.rs fit_rotation).
export function fitRotation(p: V3[], q: V3[]): [number, number, number, number] {
  const s = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  p.forEach((a, k) => { for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s[i][j] += a[i] * q[k][j]; });
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = s;
  const n = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const shift = n.flat().reduce((t, v) => t + Math.abs(v), 0) + 1e-12;
  const mul = (v: number[]) => n.map((row, i) => row.reduce((t, x, j) => t + x * v[j], 0) + shift * v[i]);
  const rayleigh = (v: number[]) => n.reduce((t, row, i) => t + v[i] * row.reduce((u, x, j) => u + x * v[j], 0), 0);
  let best: number[] = [1, 0, 0, 0], value = -Infinity;
  for (const start of [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) {
    let v = start;
    for (let k = 0; k < 200; k++) { const w = mul(v), len = Math.hypot(...w) || 1; v = w.map((x) => x / len); }
    const r = rayleigh(v);
    if (r > value + 1e-12) { value = r; best = v; }
  }
  const len = Math.hypot(...best) || 1;
  return best.map((x) => x / len) as [number, number, number, number];
}

// A structure in the drawing takes the solver's shape (3D Optimise): turned to face as drawn, centred where it was,
// a C–C bond about the drawing's median bond, depth shading on. Added hydrogens are not drawn.
export function applyConformer(m: Mol, atoms: number[], res: GeometryResponse): Mol {
  const n = atoms.length, xyz = res.coordinates.slice(0, n);
  const drawn = atoms.map((i): V3 => { const l = m.atoms[i].location; return [l[0], l[1], l[2] ?? 0]; });
  const set = new Set(atoms), lengths = m.bonds.filter((b) => b.type !== HBOND && set.has(b.atoms[0]) && set.has(b.atoms[1]))
    .map((b) => { const [p, q] = b.atoms.map((i) => m.atoms[i].location); return Math.hypot(p[0] - q[0], p[1] - q[1], (p[2] ?? 0) - (q[2] ?? 0)); }).sort((x, y) => x - y);
  const unit = lengths[Math.floor(lengths.length / 2)] || 1, k = unit / ANGSTROM;
  const mean = (ps: V3[]) => ps.reduce<V3>((s, p) => [s[0] + p[0] / ps.length, s[1] + p[1] / ps.length, s[2] + p[2] / ps.length], [0, 0, 0]);
  const cp = mean(xyz), cq = mean(drawn);
  const p = xyz.map((v): V3 => [(v[0] - cp[0]) * k, (v[1] - cp[1]) * k, (v[2] - cp[2]) * k]), q = drawn.map((v): V3 => [v[0] - cq[0], v[1] - cq[1], v[2] - cq[2]]);
  const [w, x, y, z] = fitRotation(p, q);
  const turn = (v: V3): V3 => {
    const d = x * v[0] + y * v[1] + z * v[2], uu = x * x + y * y + z * z, c: V3 = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]];
    return [0, 1, 2].map((i) => 2 * d * [x, y, z][i] + (w * w - uu) * v[i] + 2 * w * c[i]) as V3;
  };
  const place = new Map(atoms.map((g, j) => { const r = turn(p[j]); return [g, [cq[0] + r[0], cq[1] + r[1], cq[2] + r[2]] as V3]; }));
  return { ...m, atoms: m.atoms.map((a, i) => (place.has(i) ? { ...a, location: place.get(i)!, shade: true as const } : a)) };
}

// A solver message for the user: MMFF's missing parameters and the worker's own messages read as they are; the
// solver's technical ones as one plain sentence.
export function plainError(e: unknown): string {
  const text = String((e as Error)?.message ?? e);
  if (/^(Octet|The 3D)/.test(text)) return text;
  if (/MMFF parameters are unavailable/.test(text)) return "The MMFF force field has no parameters for this structure.";
  if (/conformers failed|embedding|validation/.test(text)) return "Octet cannot find a 3D shape that keeps this structure's stereochemistry.";
  return "Octet cannot calculate a 3D shape for this structure.";
}
