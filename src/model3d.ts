// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/model/src/models3d.rs, crates/model/src/models3d/polish.rs and crates/model/src/scene/svg.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// 3D models of structures (Structure > Show as 3D Model): a structure's 3D shape kept with it in the drawing and drawn
// as balls and sticks, sticks, a wireframe or space-filling spheres, turned by the user, and drawn as vectors (shaded
// with gradients) so every export keeps them sharp. The structure stays in the drawing as it is: the model only
// adds a picture of it, beside it ("both") or in its place ("3d"). CDXML, CDX and MOL keep the 2D structure only.
//
// The painter is a 2D vector painter (no WebGL): points turned by the model's rotation, projected with a little
// perspective, sorted back to front, each ball a disc with a radial gradient and each bond two halves with a linear
// gradient across them. It takes plain points (paintScene), so other 3D pictures (crystal cells, later) draw the same
// way.
//
// Units: a model's points are in ångström. Its frame, offset and size are in drawing units (bond lengths, y up). The
// painter's primitives are in drawing units with y down (the canvas's px divided by its px per bond length).

import { clean3d } from "./clean3d.ts";
import { HBOND, type Mol } from "./render.ts";
import { crystalPrimitives, crystalView, readCrystal, writeCrystal } from "./crystalcell.ts";
import { ellipseExit, ellipsoidSections, FIXED_RADIUS, FOCAL_RADIUS, projectEllipsoid, radiusAlong, type Ellipsoid } from "./ortep.ts";

export type V3 = [number, number, number];
type P = [number, number];
export type Quat = [number, number, number, number]; // [w, x, y, z], a unit quaternion
export type Style3d = "ballStick" | "stick" | "wireframe" | "spaceFilling" | "ellipsoids"; // ellipsoids: ORTEP, crystals only
export type Display3d = "3d" | "both" | "2d";
export type Scheme3d = "octet" | "vesta" | "jmol";
export type ForceField = "MMFF94s" | "MMFF94" | "UFF";
export const STYLES_3D: Style3d[] = ["ballStick", "stick", "wireframe", "spaceFilling"];
// ORTEP ellipsoids are for crystals whose file gave displacement parameters (crystalcell.ts).
export const CRYSTAL_STYLES_3D: Style3d[] = [...STYLES_3D, "ellipsoids"];

// A model, kept in Mol.models. Its geometry is frozen when it is made: atoms (one per atom of the structure, in the
// structure's order then) and bonds between them, and the hydrogens added for the 3D shape. sources: the drawing's
// atom for each model atom, renumbered when atoms are removed, null when that atom has gone. A model whose structure
// changed chemically is "stale" (fingerprint) and keeps its old shape until Update Model.
export type Model3d = {
  sources: (number | null)[];
  elements: string[];
  xyz: V3[];
  bonds: [number, number][];
  hydrogens?: { parent: number; xyz: V3 }[];
  fingerprint: string;
  rotation: Quat;
  offset: P; // the frame's centre less the structure's middle, drawing units (y up)
  size: number; // drawing units: the farthest ball edge reaches 0.44 of it from the frame's centre
  display: Display3d;
  style?: Style3d; // unset: ball and stick
  look?: "glossy"; // unset: flat (thin dark outlines, for journals)
  hydrogensShown?: "polar" | "none"; // unset: all
  labels?: "heteroatoms" | "all"; // unset: none
  scheme?: Scheme3d; // unset: Octet's colours
  field?: ForceField; // the force field that made the shape; unset: Octet's own 3D Clean Up
  seed?: number;
  crystal?: Crystal; // a crystal structure's unit cell and what its file said of each site (crystal.ts, crystalcell.ts)
};

// A crystal's displacement parameters in Å² as U (B values are converted): isotropic, or U11 U22 U33 U12 U13 U23 as
// CIF gives them, in the basis of the reciprocal-length-scaled lattice vectors.
export type Adp = { iso: number } | { aniso: [number, number, number, number, number, number] };
export type Along = "a" | "b" | "c" | "111";
// A model's unit cell (ReShiki's Cell, Site and crystal settings). The model's xyz are Cartesian Å in the lattice's
// frame, the cell's origin at 0. Atoms are named by their place in the model (sources), so they follow renumbering.
// crossing: bonds of a network that leave the cell, from atom a to the copy of atom b `image` cells away (a ≤ b).
// sites: each atom's label, displacement parameters, and whether it is a listed CIF input site (asymmetric).
// notes: what Octet said when it read the file. The rest are display settings, unset at their defaults: repeat 1 × 1
// × 1, copies at 55% opacity, the opening view, 50% probability ellipsoids, all molecules, solvent shown.
export type Crystal = {
  vectors: [V3, V3, V3];
  crossing?: { a: number; b: number; image: V3 }[];
  sites?: { atom: number; label?: string; adp?: Adp; asymmetric?: true }[];
  notes?: string[];
  repeat?: V3;
  copyOpacity?: number;
  along?: Along;
  probability?: 30 | 70 | 90;
  moleculeOnly?: true;
  includeSolvent?: false;
};

// ---- Colours and radii ----

const SYMBOLS = ("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr " +
  "Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt " +
  "Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt").split(" ");
// VESTA's element colours (K. Momma and F. Izumi) and Jmol's, both as pymatgen tabulates them (ElementColorSchemes.yaml,
// MIT, © 2011-2012 MIT & The Regents of the University of California, through LBNL), H to Mt in order.
const VESTA = ("ffcccc fce8ce 86df73 5ed77b 1fa20f 4c4c4c b0b9e6 fe0300 b0b9e6 fe37b5 f9dc3c fb7b15 81b2d6 1b3bfa c09cc2 fffa00 31fc02 cffec4 a121f6 5a96bd " +
  "b563ab 78caff e51900 00009e a7089d b57100 0000af b7bbbd 2247dc 8f8f81 9ee373 7e6ea6 74d057 9aef0f 7e3102 fac1f3 702eb0 00ff00 94ffff 00ff00 " +
  "73c2c9 54b5b5 3b9e9e 248f8f 0a7d8c 006985 c0c0c0 ffd98f a67573 9a8eb9 9e63b5 d47a00 940094 429eb0 57178f 00c900 5ac449 ffffc7 d9ffc7 c7ffc7 " +
  "a3ffc7 8fffc7 61ffc7 45ffc7 30ffc7 1fffc7 00ff9c 00e675 00d452 00bf38 00ab24 4dc2ff 4da6ff 2194d6 267dab 266696 175487 d0d0e0 ffd123 b8b8d0 " +
  "a6544d 575961 9e4fb5 ab5c00 754f45 428296 420066 007d00 70abfa 00baff 00a1ff 008fff 0080ff 006bff 545cf2 785ce3 8a4fe3 a136d4 b31fd4 b31fba " +
  "b30da6 bd0d87 c70066 cc0059 d1004f d90045 e00038 e6002e eb0026").split(" ");
const JMOL = ("ffffff d9ffff cc80ff c2ff00 ffb5b5 909090 3050f8 ff0d0d 90e050 b3e3f5 ab5cf2 8aff00 bfa6a6 f0c8a0 ff8000 ffff30 1ff01f 80d1e3 8f40d4 3dff00 " +
  "e6e6e6 bfc2c7 a6a6ab 8a99c7 9c7ac7 e06633 f090a0 50d050 c88033 7d80b0 c28f8f 668f8f bd80e3 ffa100 a62929 5cb8d1 702eb0 00ff00 94ffff 94e0e0 " +
  "73c2c9 54b5b5 3b9e9e 248f8f 0a7d8c 006985 c0c0c0 ffd98f a67573 668080 9e63b5 d47a00 940094 429eb0 57178f 00c900 70d4ff ffffc7 d9ffc7 c7ffc7 " +
  "a3ffc7 8fffc7 61ffc7 45ffc7 30ffc7 1fffc7 00ff9c 00e675 00d452 00bf38 00ab24 4dc2ff 4da6ff 2194d6 267dab 266696 175487 d0d0e0 ffd123 b8b8d0 " +
  "a6544d 575961 9e4fb5 ab5c00 754f45 428296 420066 007d00 70abfa 00baff 00a1ff 008fff 0080ff 006bff 545cf2 785ce3 8a4fe3 a136d4 b31fd4 b31fba " +
  "b30da6 bd0d87 c70066 cc0059 d1004f d90045 e00038 e6002e eb0026").split(" ");
// Octet's own colours (ReShiki's prototype table): calm hues for print; other elements take Jmol's. Ball-and-stick
// radii in Å.
const OWN: Record<string, [string, number]> = {
  H: ["eef0f2", 0.23], C: ["8d949b", 0.33], N: ["3f6fd6", 0.32], O: ["e0483d", 0.31], S: ["e3b52e", 0.4], F: ["5fbf4f", 0.3], Cl: ["3fae4a", 0.4],
  Br: ["9b4a2c", 0.44], P: ["ef8a2f", 0.4], B: ["", 0.3], Si: ["", 0.4], As: ["", 0.42], Se: ["", 0.42], I: ["", 0.48],
};
// Van der Waals radii (Å) for space-filling: Bondi's (1964), as ReShiki's.
const VDW: Record<string, number> = { H: 1.1, C: 1.7, N: 1.55, O: 1.52, S: 1.8, P: 1.8, F: 1.47, Cl: 1.75, Br: 1.85, As: 1.85, B: 1.92, Si: 2.1, Se: 1.9, I: 1.98 };
const BOND_RADIUS = 0.085, STICK_RADIUS = 0.16, WIRE_RADIUS = 0.02;
const GREY = "999999";

export function colourOf(symbol: string, scheme: Scheme3d = "octet"): string {
  const k = SYMBOLS.indexOf(symbol);
  if (scheme === "vesta") return "#" + (VESTA[k] ?? GREY);
  if (scheme === "jmol") return "#" + (JMOL[k] ?? GREY);
  return "#" + (OWN[symbol]?.[0] || JMOL[k] || GREY);
}
// A ball's radius in Å for a style.
export function radiusOf(symbol: string, style: Style3d = "ballStick"): number {
  if (style === "spaceFilling") return VDW[symbol] ?? 1.8;
  if (style === "stick") return STICK_RADIUS;
  if (style === "wireframe") return WIRE_RADIUS;
  if (style === "ellipsoids") return FIXED_RADIUS;
  return OWN[symbol]?.[1] ?? 0.35;
}

// ---- Turning ----

// The rotation b, then a.
export const compose = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
export function rotate(q: Quat, v: V3): V3 {
  const [w, x, y, z] = q, dot = x * v[0] + y * v[1] + z * v[2], uu = x * x + y * y + z * z;
  const cross: V3 = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]];
  return [0, 1, 2].map((k) => 2 * dot * [x, y, z][k] + (w * w - uu) * v[k] + 2 * w * cross[k]) as V3;
}
const about = (angle: number, axis: 0 | 1 | 2): Quat => { const q: Quat = [Math.cos(angle / 2), 0, 0, 0]; q[axis + 1] = Math.sin(angle / 2); return q; };
const unit = (q: Quat, keep: Quat): Quat => { const n = Math.hypot(...q); return Number.isFinite(n) && n > 1e-6 ? (q.map((v) => v / n) as Quat) : keep; };
// A drag of dx, dy screen px (y down): 0.01 radian a px, across about the vertical axis and down about the horizontal
// one, the front going with the pointer. roll: about the line of sight instead (Shift-drag).
export function turn(q: Quat, dx: number, dy: number, roll = false): Quat {
  const step = roll ? about(-dx * 0.01, 2) : compose(about(dx * 0.01, 1), about(dy * 0.01, 0));
  return unit(compose(step, q), q);
}
// Structure Perspective's turn (edit.ts tiltAtoms), in degrees: yaw about the vertical axis, then pitch about the
// horizontal one, the same sense a 2D structure turns.
export const tiltQuat = (q: Quat, yaw: number, pitch: number): Quat => unit(compose(about((pitch * Math.PI) / 180, 0), compose(about((yaw * Math.PI) / 180, 1), q)), q);
// A turn in the page's plane, anticlockwise in degrees (as Octet's 2D rotation).
export const rollQuat = (q: Quat, degrees: number): Quat => unit(compose(about((degrees * Math.PI) / 180, 2), q), q);

// The unit quaternion of a proper rotation matrix (rows).
export function quaternion(m: number[][]): Quat {
  const t = m[0][0] + m[1][1] + m[2][2];
  let q: Quat;
  if (t > 0) { const s = Math.sqrt(t + 1) * 2; q = [s / 4, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s]; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; q = [(m[2][1] - m[1][2]) / s, s / 4, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s]; }
  else if (m[1][1] > m[2][2]) { const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; q = [(m[0][2] - m[2][0]) / s, (m[0][1] + m[1][0]) / s, s / 4, (m[1][2] + m[2][1]) / s]; }
  else { const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; q = [(m[1][0] - m[0][1]) / s, (m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, s / 4]; }
  return unit(q, [1, 0, 0, 0]);
}
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// The centred points' two principal axes (power iteration), as screen x and y; z is x × y.
function principalBasis(points: V3[]): V3[] {
  const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i][j] += p[i] * p[j];
  const trace = c[0][0] + c[1][1] + c[2][2];
  const principal = (start: V3, previous?: V3): V3 => {
    const deflate = (v: V3): V3 => { if (!previous) return v; const d = dot3(v, previous); return [v[0] - d * previous[0], v[1] - d * previous[1], v[2] - d * previous[2]]; };
    let v = start;
    for (let k = 0; k < 60; k++) {
      const next = deflate(c.map((row) => dot3(row as V3, v)) as V3), n = Math.hypot(...next);
      if (trace > 1e-9 && n > 1e-9 * Math.max(trace, 1e-300)) { v = next.map((x) => x / n) as V3; continue; }
      // Degenerate: the coordinate axis least along `previous`.
      const axes = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as V3[]).map(deflate).sort((a, b) => dot3(b, b) - dot3(a, a));
      const n2 = Math.hypot(...axes[0]) || 1;
      return axes[0].map((x) => x / n2) as V3;
    }
    return v;
  };
  const x = principal([1, 0.3, 0.2]), y = principal([0.2, 1, 0.3], x).map((v) => -v) as V3;
  return [x, y, cross3(x, y)];
}
// The basis tilted a little (about x, then y) so the opening view reads as 3D.
export function tilted(basis: V3[], ax: number, ay: number): Quat {
  const [sx, cx, sy, cy] = [Math.sin(ax), Math.cos(ax), Math.sin(ay), Math.cos(ay)];
  const rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]], ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const mul = (a: number[][], b: number[][]) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
  return quaternion(mul(mul(rx, ry), basis));
}
// The opening view of a model: its principal axes across and up the page, tilted a little; of the four ways round
// (each a proper rotation, so the hand is kept), the one whose picture best follows the structure as drawn. points:
// the model's atoms, centred (Å); drawn: where each is in the drawing (y up), or none.
export function openingRotation(points: V3[], drawn: (P | undefined)[] = []): Quat {
  const basis = principalBasis(points), first = tilted(basis, -0.35, 0.3);
  const pairs = points.map((p, i) => [p, drawn[i]] as const).filter((x): x is readonly [V3, P] => !!x[1]);
  if (pairs.length < 2) return first;
  const c = pairs.reduce((s, [, d]) => [s[0] + d[0] / pairs.length, s[1] + d[1] / pairs.length], [0, 0]);
  const score = (q: Quat) => pairs.reduce((s, [p, d]) => { const r = rotate(q, p); return s + (d[0] - c[0]) * r[0] + (d[1] - c[1]) * r[1]; }, 0);
  let best: [Quat, number] = [first, score(first)];
  for (const [x, y] of [[-1, 1], [1, -1], [-1, -1]]) {
    const q = tilted([basis[0].map((v) => v * x) as V3, basis[1].map((v) => v * y) as V3, basis[2].map((v) => v * x * y) as V3], -0.35, 0.3), s = score(q);
    if (s > best[1] + 1e-6 * Math.max(Math.abs(best[1]), Math.abs(s), 1e-12)) best = [q, s];
  }
  return best[0];
}

// ---- The model's points ----

export type Point3d = { symbol: string; xyz: V3; source: number | null; parent?: number };
// Every point of a model: its atoms, then its added hydrogens (parent: the model atom they are on).
export function pointsOf(model: Model3d): Point3d[] {
  return [...model.elements.map((symbol, i) => ({ symbol, xyz: model.xyz[i], source: model.sources[i] })),
    ...(model.hydrogens ?? []).map((h) => ({ symbol: "H", xyz: h.xyz, source: null, parent: h.parent }))];
}
// Every bond of a model, as pairs of points.
export function bondsOf(model: Model3d): [number, number][] {
  const n = model.elements.length;
  return [...model.bonds, ...(model.hydrogens ?? []).map((h, k): [number, number] => [h.parent, n + k])];
}
// Which points show: hydrogens All, Polar (on N, O or S) or None. A model of hydrogen only shows them all.
export function shownOf(model: Model3d): boolean[] {
  const points = pointsOf(model), bonds = bondsOf(model);
  if (!model.hydrogensShown || points.every((p) => p.symbol === "H")) return points.map(() => true);
  return points.map((p, i) => {
    if (p.symbol !== "H") return true;
    if (model.hydrogensShown === "none") return false;
    const on = bonds.find((b) => b.includes(i)), other = on ? points[on[0] === i ? on[1] : on[0]].symbol : "";
    return other === "N" || other === "O" || other === "S";
  });
}
// The Mol atoms a model is drawn for (its sources that are still there).
export const liveAtoms = (model: Model3d) => model.sources.filter((s): s is number => s !== null);
// The middle of the structure as drawn (drawing units, y up): the frame's centre less its offset.
export function middleOf(m: Mol, model: Model3d): P | undefined {
  const live = liveAtoms(model).filter((i) => i < m.atoms.length);
  if (!live.length) return undefined;
  const xs = live.map((i) => m.atoms[i].location[0]), ys = live.map((i) => m.atoms[i].location[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}
// Atoms whose 2D drawing a model shows in its place.
export function shownAs3d(m: Mol): Set<number> {
  return new Set((m.models ?? []).filter((x) => x.display === "3d").flatMap(liveAtoms));
}

// ---- View and projection ----

// Defaults, as ReShiki's: depth fade towards the paper, and perspective (0 none, 1 strong).
const DEPTH_FADE = 0.35, PERSPECTIVE = 0.2;
// ReShiki's size-relative widths are in its world units (42 a bond length); Octet's are bond lengths.
export const WORLD = 42;
export type View3d = { centre: V3; rotated: V3[]; symbols: string[]; shown: boolean[]; bonds: [number, number][]; style: Style3d; reach: number; origin: P; scale: number; camera: number; perspective: number; wire: number };
// Centre: the heavy atoms' centroid. reach: the farthest shown ball edge from it (Å).
// hold: points the view must hold besides the shown balls (a crystal's cell corners); the centre is then their middle.
// radii: a point's own radius (Å) where it is not its style's ball (an ORTEP ellipsoid's largest semi-axis).
export function sceneView(points: { symbol: string; xyz: V3 }[], shown: boolean[], bonds: [number, number][], style: Style3d, rotation: Quat, origin: P, size: number, perspective = PERSPECTIVE, extra: { hold?: V3[]; radii?: (number | undefined)[] } = {}): View3d {
  const heavy = points.filter((p) => p.symbol !== "H"), use = extra.hold?.length ? extra.hold.map((xyz) => ({ xyz })) : heavy.length ? heavy : points, n = use.length || 1;
  const centre = use.reduce<V3>((c, p) => [c[0] + p.xyz[0] / n, c[1] + p.xyz[1] / n, c[2] + p.xyz[2] / n], [0, 0, 0]);
  const from = (p: V3) => Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]);
  const reach = Math.max(0.1, ...points.flatMap((p, i) => (shown[i] ? [from(p.xyz) + (extra.radii?.[i] ?? radiusOf(p.symbol, style))] : [])), ...(extra.hold ?? []).map(from));
  return {
    centre, rotated: points.map((p) => rotate(rotation, [p.xyz[0] - centre[0], p.xyz[1] - centre[1], p.xyz[2] - centre[2]])), symbols: points.map((p) => p.symbol), shown,
    bonds: style === "spaceFilling" ? [] : bonds.filter(([a, b]) => shown[a] && shown[b]), style, reach, origin, scale: (0.44 * size) / reach,
    camera: reach * (1.2 + 9 * (1 - perspective)), perspective, wire: Math.max((size * WORLD) / 190, 1.6) / WORLD,
  };
}
export function viewOf(m: Mol, model: Model3d): View3d | undefined {
  const middle = middleOf(m, model);
  if (!middle) return undefined;
  if (model.crystal) return crystalView(m, model, [middle[0] + model.offset[0], middle[1] + model.offset[1]]).view;
  return sceneView(pointsOf(model), shownOf(model), bondsOf(model), model.style ?? "ballStick", model.rotation, [middle[0] + model.offset[0], middle[1] + model.offset[1]], model.size);
}
// A turned point on the page (drawing units, y down) and its perspective factor.
export function project(v: View3d, p: V3): [P, number] {
  const f = v.perspective > 0 ? v.camera / (v.camera - p[2]) : 1;
  return [[v.origin[0] + p[0] * v.scale * f, -(v.origin[1] + p[1] * v.scale * f)], f];
}
// The frame (drawing units, y up): a square round every turn of the model, so it holds still while turning.
export function viewFrame(v: View3d): [P, P] {
  const k = v.reach / v.camera, spread = v.perspective > 0 ? 1 / Math.sqrt(1 - k * k) : 1;
  const half = v.reach * v.scale * spread + (v.style === "wireframe" ? v.wire : 0);
  return [[v.origin[0] - half, v.origin[1] - half], [v.origin[0] + half, v.origin[1] + half]];
}
export function frameOf(m: Mol, model: Model3d): [P, P] | undefined {
  const v = viewOf(m, model);
  return v && viewFrame(v);
}
// The model (index in m.models) shown in 3D whose frame holds p (drawing units, y up), the nearest centre first.
export function modelAt(m: Mol, p: P, margin = 0): number | undefined {
  let best: [number, number] | undefined;
  (m.models ?? []).forEach((x, k) => {
    if (x.display === "2d") return;
    const f = frameOf(m, x);
    if (!f || p[0] < f[0][0] - margin || p[0] > f[1][0] + margin || p[1] < f[0][1] - margin || p[1] > f[1][1] + margin) return;
    const d = Math.hypot(p[0] - (f[0][0] + f[1][0]) / 2, p[1] - (f[0][1] + f[1][1]) / 2);
    if (!best || d < best[1]) best = [k, d];
  });
  return best?.[0];
}

// ---- The painter ----

export type Stop = [number, string, number?]; // offset, colour, opacity
export type Outline = { colour: string; alpha: number; width: number };
export type Prim3d =
  | { kind: "sphere"; c: P; r: number; focal: P; stops: Stop[]; outline?: Outline }
  | { kind: "quad"; corners: [P, P, P, P]; from: P; to: P; stops: Stop[]; outline?: Outline }
  | { kind: "contour"; polygons: P[][]; outline: Outline }
  | { kind: "wire"; from: P; to: P; width: number; colour: string; dash?: number }
  // An ORTEP ellipsoid: its outline (centre and semi-axis vectors), the light's focal point in its own unit disc, and
  // for an anisotropic one its principal-plane lines and front octant (ortep.ts).
  | { kind: "ellipsoid"; c: P; axes: [P, P]; focal: P; stops: Stop[]; outline?: Outline; section?: { octant: P[]; arcs: P[][]; fill: string; colour: string; width: number } }
  | { kind: "text"; at: P; text: string; size: number; colour: string; italic?: true }
  | { kind: "opacity"; alpha: number; inner: Prim3d };

type RGB = [number, number, number];
const rgbOf = (hex: string): RGB => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hexOf = (c: RGB) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const WHITE: RGB = [255, 255, 255], BLACK: RGB = [0, 0, 0];
// The flat look's outline on light paper; on dark paper the document's ink (white) at less opacity.
export const OUTLINE: Outline = { colour: "#1e2226", alpha: 0.85, width: 0 };

export type PaintOptions = {
  style?: Style3d; look?: "glossy"; labels?: "heteroatoms" | "all"; scheme?: Scheme3d; size: number;
  paper?: string; // the colour further atoms fade towards; unset: no fade (dark paper)
  dark?: boolean; // dark paper: outlines in light ink
  ink?: string; // the outlines' colour (the canvas's ink, so exports draw them as on white paper); unset: ReShiki's
  morph?: { e: number; flat: (V3 | undefined)[]; fading: boolean[] }; // 0 flat on the drawing, 1 the model
  font?: string;
  alpha?: (number | undefined)[]; // each point's opacity, where it is not 1 (a crystal's copies)
  ellipsoids?: (Ellipsoid | undefined)[]; // the ellipsoids style: each point's ellipsoid in view space, or a fixed sphere
};

// With ellipsoids, a half-bond starts at its atom's centre (the atom is drawn over the end) and the two halves meet
// midway between where the stick leaves each outline on the page; none where the two surfaces touch.
function ortepHalf(v: View3d, ellipsoids: (Ellipsoid | undefined)[], s: number, o: number): [P, P, number, number] | undefined {
  const ps = v.rotated[s], po = v.rotated[o], d: V3 = [po[0] - ps[0], po[1] - ps[1], po[2] - ps[2]], distance = Math.hypot(...d);
  if (distance === 0) return undefined;
  const dir = d.map((x) => x / distance) as V3, radius = (i: number) => (ellipsoids[i] ? radiusAlong(ellipsoids[i]!, dir) : FIXED_RADIUS);
  const [rs, ro] = [radius(s), radius(o)];
  if (rs + ro >= distance) return undefined;
  const a = ps.map((p, k) => p + dir[k] * rs) as V3, b = po.map((p, k) => p - dir[k] * ro) as V3;
  const [start, fs] = project(v, ps), [end] = project(v, po);
  let [middle, fm] = project(v, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (length > 0) {
    const u: P = [(end[0] - start[0]) / length, (end[1] - start[1]) / length], lens = { scale: v.scale, origin: v.origin, ...(v.perspective > 0 ? { camera: v.camera } : {}) };
    const exit = (i: number, from: P, towards: P) => {
      const e = ellipsoids[i], outline = e && projectEllipsoid(e, v.rotated[i], lens);
      return outline ? ellipseExit(outline, from, towards) : FIXED_RADIUS * v.scale * project(v, v.rotated[i])[1];
    };
    const ea = exit(s, start, u), eb = exit(o, end, [-u[0], -u[1]]);
    if (ea !== undefined && eb !== undefined) { const t = (ea + length - eb) / 2; middle = [start[0] + u[0] * t, start[1] + u[1] * t]; }
  }
  const r = BOND_RADIUS * v.scale;
  return [start, middle, r * fs, r * fm];
}

// The half-bond from point s towards o: its projected start, the projected middle and its half width at each.
function halfBond(v: View3d, s: number, o: number): [P, P, number, number] {
  const ps = v.rotated[s], po = v.rotated[o];
  const [start, fs] = project(v, ps), [middle, fm] = project(v, [(ps[0] + po[0]) / 2, (ps[1] + po[1]) / 2, (ps[2] + po[2]) / 2]);
  if (v.style === "wireframe") return [start, middle, v.wire / 2, v.wire / 2];
  const r = (v.style === "stick" ? STICK_RADIUS : v.style === "spaceFilling" ? 0 : BOND_RADIUS) * v.scale;
  return [start, middle, r * fs, r * fm];
}

// The primitives of a scene, back to front.
export function paintScene(v: View3d, o: PaintOptions): Prim3d[] {
  const style = o.style ?? "ballStick", glossy = o.look === "glossy", reach = v.reach;
  const e = o.morph ? Math.max(0, Math.min(1, o.morph.e)) : 1;
  if (o.morph && e < 1) v = { ...v, rotated: v.rotated.map((p, i) => { const f = o.morph!.flat[i]; return f ? (mix(f, p, e) as V3) : p; }) };
  const fade = (z: number) => (o.paper ? DEPTH_FADE * Math.max(0, Math.min(1, (reach - z) / (2 * reach))) : 0);
  const line = Math.max(0.6, Math.min(1.1, (o.size * WORLD) / 400)) / WORLD;
  const outline = (width: number): Outline | undefined => (glossy ? undefined : o.dark ? { colour: o.ink ?? "#e1e8ee", alpha: 0.55, width } : { ...OUTLINE, colour: o.ink ?? OUTLINE.colour, width });
  const paper = o.paper ? rgbOf(o.paper) : WHITE;
  type Item = [number, number, number, { bond: [number, number] } | { atom: number } | { label: number }];
  const items: Item[] = [];
  // Each half-bond sorts at its own depth but never after its atom, so the ball covers the half that points towards
  // the viewer, yet a half-bond still passes in front of a farther atom.
  const ells = o.ellipsoids ?? [], half = (s: number, t: number) => (style === "ellipsoids" ? ortepHalf(v, ells, s, t) : halfBond(v, s, t));
  for (const [a, b] of v.bonds) {
    if (style === "ellipsoids" && !half(a, b)) continue;
    const mz = (v.rotated[a][2] + v.rotated[b][2]) / 2;
    for (const [s, t] of [[a, b], [b, a]]) {
      const z = (v.rotated[s][2] + mz) / 2 - 0.05;
      items.push([Math.min(z, v.rotated[s][2]), 0, z, { bond: [s, t] }]);
    }
  }
  const bonded = new Set(v.bonds.flat());
  v.symbols.forEach((_, i) => {
    if (!v.shown[i] || (style === "wireframe" && bonded.has(i))) return;
    items.push([v.rotated[i][2], 1, v.rotated[i][2], { atom: i }]);
  });
  if (o.labels) v.symbols.forEach((s, i) => {
    if (!v.shown[i] || (o.labels === "heteroatoms" && (s === "C" || s === "H"))) return;
    items.push([v.rotated[i][2], 2, v.rotated[i][2], { label: i }]);
  });
  items.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  // Where each half-bond is drawn, so the first of a pair can reach under the second.
  const order = new Map<string, number>();
  items.forEach((it, n) => { if ("bond" in it[3]) order.set(it[3].bond.join(","), n); });
  const shade = (base: RGB, stops: [number, RGB, number][]): Stop[] => stops.map(([off, to, t]) => [off, hexOf(mix(base, to, t))]);
  const rims: P[][] = [], drawn: Prim3d[] = [];
  items.forEach(([, , z, it], n) => {
    const i = "bond" in it ? it.bond[0] : "atom" in it ? it.atom : it.label, symbol = v.symbols[i];
    const base = mix(rgbOf(colourOf(symbol, o.scheme)), paper, fade(z));
    const fadingIn = !!o.morph?.fading[i] && e < 1;
    const wire = hexOf(mix(base, BLACK, symbol === "C" ? 0.35 : 0.1));
    let prim: Prim3d | undefined;
    if ("label" in it) {
      const [c, f] = project(v, v.rotated[i]), size = Math.max(o.size / 55, Math.min(o.size / 16, v.scale * f * 0.34));
      const surface = style === "wireframe" || style === "stick" ? paper : base, light = surface[0] * 0.2126 + surface[1] * 0.7152 + surface[2] * 0.0722;
      prim = { kind: "text", at: [c[0], c[1] + size * 0.35], text: symbol, size, colour: hexOf(mix(light < 135 ? WHITE : [24, 24, 24], paper, fade(z))) };
    } else if ("atom" in it) {
      const [c, f] = project(v, v.rotated[i]), ell = style === "ellipsoids" ? ells[i] : undefined;
      const lens = { scale: v.scale, origin: v.origin, ...(v.perspective > 0 ? { camera: v.camera } : {}) }, outlined = ell && projectEllipsoid(ell, v.rotated[i], lens);
      if (style === "wireframe") prim = { kind: "sphere", c, r: v.wire, focal: c, stops: [[0, wire], [1, wire]] };
      else if (ell && outlined) {
        // The light's focal point in the ellipse's own unit disc: up and left, along each semi-axis.
        const focal = outlined.axes.map((a) => (-0.38 * a[0] - 0.42 * a[1]) / Math.hypot(a[0], a[1])) as P, rim = outline(line);
        const sections = ell.anisotropic ? ellipsoidSections(ell, v.rotated[i], lens) : undefined;
        prim = { kind: "ellipsoid", c: outlined.c, axes: outlined.axes, focal,
          stops: glossy ? shade(base, [[0, WHITE, 0.85], [0.18, WHITE, 0.35], [0.75, base, 0], [1, BLACK, 0.45]]) : shade(base, [[0, WHITE, 0.45], [0.6, base, 0], [1, BLACK, 0.18]]),
          ...(rim ? { outline: rim } : {}), ...(sections ? { section: { ...sections, fill: hexOf(mix(base, BLACK, 0.26)), colour: hexOf(mix(base, BLACK, 0.65)), width: rim?.width ?? 0.7 / WORLD } } : {}) };
      } else {
        const r = radiusOf(symbol, style) * v.scale * f;
        if (style === "stick") rims.push(Array.from({ length: 48 }, (_, k): P => [c[0] + r * Math.cos((Math.PI * k) / 24), c[1] + r * Math.sin((Math.PI * k) / 24)]));
        prim = { kind: "sphere", c, r, focal: [c[0] - r * 0.38, c[1] - r * 0.42],
          stops: glossy ? shade(base, [[0, WHITE, 0.85], [0.18, WHITE, 0.35], [0.75, base, 0], [1, BLACK, 0.45]]) : shade(base, [[0, WHITE, 0.45], [0.6, base, 0], [1, BLACK, 0.18]]),
          outline: style === "stick" ? undefined : outline(line) };
      }
    } else {
      const [s, t] = it.bond, [a, end0, start, halfWidth] = half(s, t)!;
      if (style === "wireframe") prim = { kind: "wire", from: a, to: end0, width: halfWidth * 2, colour: wire };
      else {
        const dx = end0[0] - a[0], dy = end0[1] - a[1], len = Math.hypot(dx, dy);
        if (len < line * 0.5 && style !== "stick") return;
        if (len < 1e-9) return;
        // The lit side faces up and left, as the balls' highlight, the same for both halves.
        const side = 0.38 * dy - 0.42 * dx < 0 ? -1 : 1, nx = (-dy / len) * side, ny = (dx / len) * side;
        // The half drawn first runs on under the other, so their edges never meet in a pale seam.
        let end = end0, width = halfWidth;
        const later = order.get(`${t},${s}`);
        if (later !== undefined && later > n && (v.symbols[t] !== "H" || e >= 1)) {
          const [b, , far] = half(t, s)!, other = Math.hypot(b[0] - end0[0], b[1] - end0[1]);
          if (other >= line * 0.5) { const reachOn = Math.min(halfWidth, other / 2), k = reachOn / other; end = [end0[0] + (dx / len) * reachOn, end0[1] + (dy / len) * reachOn]; width = halfWidth + (far - halfWidth) * k; }
        }
        const corners: [P, P, P, P] = [[a[0] + nx * start, a[1] + ny * start], [end[0] + nx * width, end[1] + ny * width], [end[0] - nx * width, end[1] - ny * width], [a[0] - nx * start, a[1] - ny * start]];
        if (style === "stick") rims.push(corners);
        prim = { kind: "quad", corners, from: [end0[0] + nx * halfWidth, end0[1] + ny * halfWidth], to: [end0[0] - nx * halfWidth, end0[1] - ny * halfWidth],
          stops: glossy ? shade(base, [[0, BLACK, 0.4], [0.3, WHITE, 0.55], [1, BLACK, 0.45]]) : shade(base, [[0, BLACK, 0.2], [0.4, WHITE, 0.3], [1, BLACK, 0.22]]),
          outline: style === "ballStick" || style === "ellipsoids" ? outline(line * 0.8) : undefined };
      }
    }
    const alpha = (fadingIn ? e : 1) * (o.alpha?.[i] ?? 1);
    if (prim) drawn.push(alpha < 1 ? { kind: "opacity", alpha, inner: prim } : prim);
  });
  // Stick: one outline round every shape, behind them all.
  const rim = style === "stick" && rims.length ? outline(line * 2) : undefined;
  return rim ? [{ kind: "contour", polygons: rims, outline: rim }, ...drawn] : drawn;
}

// A model's primitives in the drawing, with its morph from the drawing (0) to the model (1) if it is still growing.
export function modelPrimitives(m: Mol, model: Model3d, o: Omit<PaintOptions, "size" | "style" | "look" | "labels" | "scheme" | "morph"> & { morph?: number } = {}): Prim3d[] {
  if (model.crystal) return crystalPrimitives(m, model, o);
  const v = viewOf(m, model);
  if (!v) return [];
  let morph: PaintOptions["morph"];
  if (o.morph !== undefined && o.morph < 1) {
    // Points start on their drawn atoms (hydrogens on their atom's) and the added hydrogens fade in.
    const points = pointsOf(model), flatOf = (s: number | null): V3 | undefined => (s === null || s >= m.atoms.length ? undefined : [(m.atoms[s].location[0] - v.origin[0]) / v.scale, (m.atoms[s].location[1] - v.origin[1]) / v.scale, 0]);
    const eased = o.morph < 0.5 ? 4 * o.morph ** 3 : 1 - (2 - 2 * o.morph) ** 3 / 2;
    morph = { e: eased, flat: points.map((p) => flatOf(p.parent !== undefined ? model.sources[p.parent] : p.source)), fading: points.map((p) => p.parent !== undefined) };
  }
  return paintScene(v, { ...o, style: model.style, look: model.look, labels: model.labels, scheme: model.scheme, size: model.size, morph });
}

// ---- SVG ----

// An SVG element as plain data: written as text (svgText) or made into React elements by the editor.
export type SvgNode = { tag: string; attrs: Record<string, string | number>; children?: (SvgNode | string)[] };
const n4 = (x: number) => Math.round(x * 1e4) / 1e4;
const pts = (ps: P[]) => ps.map((p) => `${n4(p[0])},${n4(p[1])}`).join(" ");
const outlineAttrs = (o?: Outline): Record<string, string | number> => (o ? { stroke: o.colour, "stroke-opacity": o.alpha, "stroke-width": n4(o.width) } : {});
// The primitives as SVG: gradients in one <defs> first (ids from prefix, which must be unique in the page), then the
// shapes in order.
export function primitiveNodes(prims: Prim3d[], prefix: string): SvgNode[] {
  const defs: SvgNode[] = [];
  const stops = (s: Stop[]) => s.map(([offset, colour, alpha]): SvgNode => ({ tag: "stop", attrs: { offset: n4(offset), "stop-color": colour, ...(alpha !== undefined && alpha < 1 ? { "stop-opacity": alpha } : {}) } }));
  const one = (p: Prim3d): SvgNode => {
    switch (p.kind) {
      case "sphere": {
        if (p.stops.every((s) => s[1] === p.stops[0][1])) return { tag: "circle", attrs: { cx: n4(p.c[0]), cy: n4(p.c[1]), r: n4(p.r), fill: p.stops[0][1], ...outlineAttrs(p.outline) } };
        const id = `${prefix}${defs.length}`;
        defs.push({ tag: "radialGradient", attrs: { id, gradientUnits: "userSpaceOnUse", cx: n4(p.c[0]), cy: n4(p.c[1]), r: n4(p.r), fx: n4(p.focal[0]), fy: n4(p.focal[1]), fr: n4(0.05 * p.r) }, children: stops(p.stops) });
        return { tag: "circle", attrs: { cx: n4(p.c[0]), cy: n4(p.c[1]), r: n4(p.r), fill: `url(#${id})`, ...outlineAttrs(p.outline) } };
      }
      case "quad": {
        const id = `${prefix}${defs.length}`;
        defs.push({ tag: "linearGradient", attrs: { id, gradientUnits: "userSpaceOnUse", x1: n4(p.from[0]), y1: n4(p.from[1]), x2: n4(p.to[0]), y2: n4(p.to[1]) }, children: stops(p.stops) });
        const fill: SvgNode = { tag: "polygon", attrs: { points: pts(p.corners), fill: `url(#${id})` } };
        if (!p.outline) return fill;
        // Only the two long sides are outlined: the ends meet the ball and the other half.
        const [a, b, c, d] = p.corners;
        return { tag: "g", attrs: {}, children: [fill, { tag: "path", attrs: { d: `M${pts([a])}L${pts([b])}M${pts([d])}L${pts([c])}`, fill: "none", ...outlineAttrs(p.outline) } }] };
      }
      case "ellipsoid": {
        // The gradient in the ellipse's own frame: a unit disc scaled to its semi-axes, turned with it.
        const [a, b] = p.axes.map((x) => Math.hypot(x[0], x[1])), angle = (Math.atan2(p.axes[0][1], p.axes[0][0]) * 180) / Math.PI, id = `${prefix}${defs.length}`;
        defs.push({ tag: "radialGradient", attrs: { id, gradientUnits: "userSpaceOnUse", cx: 0, cy: 0, r: 1, fx: n4(p.focal[0]), fy: n4(p.focal[1]), fr: FOCAL_RADIUS, gradientTransform: `scale(${n4(a)} ${n4(b)})` }, children: stops(p.stops) });
        const shape: SvgNode = { tag: "g", attrs: { transform: `translate(${n4(p.c[0])} ${n4(p.c[1])}) rotate(${n4(angle)})` }, children: [{ tag: "ellipse", attrs: { rx: n4(a), ry: n4(b), fill: `url(#${id})`, ...outlineAttrs(p.outline) } }] };
        if (!p.section) return shape;
        const s = p.section, line = (q: P[]) => `M${pts(q).replace(/ /g, "L")}`;
        return { tag: "g", attrs: {}, children: [shape,
          { tag: "path", attrs: { d: `${line(s.octant)}Z`, fill: s.fill, stroke: s.colour, "stroke-width": n4(s.width), "stroke-linejoin": "round" } },
          ...(s.arcs.length ? [{ tag: "path", attrs: { d: s.arcs.map(line).join(""), fill: "none", stroke: s.colour, "stroke-width": n4(s.width), "stroke-linecap": "round" } }] : [])] };
      }
      case "contour":
        return { tag: "path", attrs: { d: p.polygons.map((q) => `M${pts(q).replace(/ /g, "L")}Z`).join(""), fill: "none", "stroke-linejoin": "round", ...outlineAttrs(p.outline) } };
      case "wire":
        return { tag: "line", attrs: { x1: n4(p.from[0]), y1: n4(p.from[1]), x2: n4(p.to[0]), y2: n4(p.to[1]), stroke: p.colour, "stroke-width": n4(p.width), "stroke-linecap": p.dash ? "butt" : "round", ...(p.dash ? { "stroke-dasharray": `${n4(p.dash)} ${n4(p.dash)}` } : {}) } };
      case "text":
        return { tag: "text", attrs: { x: n4(p.at[0]), y: n4(p.at[1]), "font-size": n4(p.size), ...(p.italic ? { "font-style": "italic" } : { "font-weight": "bold" }), "text-anchor": "middle", fill: p.colour }, children: [p.text] };
      case "opacity":
        return { tag: "g", attrs: { opacity: n4(p.alpha) }, children: [one(p.inner)] };
    }
  };
  const body = prims.map(one);
  return defs.length ? [{ tag: "defs", attrs: {}, children: defs }, ...body] : body;
}
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const svgText = (nodes: (SvgNode | string)[]): string => nodes.map((x) => (typeof x === "string" ? escape(x)
  : `<${x.tag}${Object.entries(x.attrs).map(([k, v]) => ` ${k}="${escape(String(v))}"`).join("")}${x.children?.length ? `>${svgText(x.children)}</${x.tag}>` : "/>"}`)).join("");

// ---- Making a model, and keeping it with its structure ----

const ANGSTROM = 1.52; // Å in a bond length: Octet's 3D Clean Up makes a C–C single bond one bond length

// The fingerprint of a structure's chemistry, in the model's atom order: each atom's element, label, charge, isotope,
// radical and hydrogens; each bond's order and wedge; and any atom joined to the structure that the model lacks.
// Moving atoms or colouring them leaves it as it is.
// crystal: a crystal model keeps its cell when an atom's element or charge changes (Na+ to K+), so these are left out.
export function fingerprintOf(m: Mol, sources: (number | null)[], crystal = false): string {
  const at = new Map<number, number>();
  sources.forEach((s, k) => { if (s !== null && s < m.atoms.length) at.set(s, k); });
  const atoms = sources.map((s) => {
    const a = s === null ? undefined : m.atoms[s];
    return a ? (crystal ? [a.text ?? "", a.isotope ?? 0, a.radical ?? 0] : [a.label, a.text ?? "", a.charge ?? 0, a.isotope ?? 0, a.radical ?? 0, a.implicitHCount ?? -1]).join(":") : "-";
  });
  const bonds: string[] = [];
  let extra = 0;
  for (const b of m.bonds) {
    if (b.type === HBOND) continue;
    const i = at.get(b.atoms[0]), j = at.get(b.atoms[1]);
    if (i === undefined && j === undefined) continue;
    if (i === undefined || j === undefined) { extra++; continue; }
    const wedge = b.stereo === 1 || b.stereo === 6 ? `${b.stereo}>${i}` : "";
    bonds.push(`${Math.min(i, j)}-${Math.max(i, j)}:${b.type}:${wedge}`);
  }
  return `${atoms.join(",")}|${bonds.sort().join(",")}|${extra}`;
}
export const isStale = (m: Mol, model: Model3d) => model.sources.some((s) => s === null || s >= m.atoms.length) || fingerprintOf(m, model.sources, !!model.crystal) !== model.fingerprint;

// A 3D shape for a structure: what it was given (hydrogens added, in Å) or, without one, the atoms' own depth when the
// structure has real depth (a 3D file, 3D Clean Up), or else Octet's 3D Clean Up of it. atoms: a whole structure.
export type Geometry = { xyz: V3[]; hydrogens?: { parent: number; xyz: V3 }[]; field?: ForceField; seed?: number };
export function drawnGeometry(m: Mol, atoms: number[]): Geometry {
  const zs = atoms.map((i) => m.atoms[i].location[2] ?? 0), deep = Math.max(...zs) - Math.min(...zs) > 0.3;
  const shaped = deep ? m : clean3d(m, atoms);
  return { xyz: atoms.map((i): V3 => { const l = shaped.atoms[i].location; return [l[0] * ANGSTROM, l[1] * ANGSTROM, (l[2] ?? 0) * ANGSTROM]; }) };
}
// A new model of a structure (atoms: all of it, in the drawing's order), shown as `display`, with its opening view
// following the drawing and its size so a bond is about a bond length.
export function newModel(m: Mol, atoms: number[], g: Geometry, display: Display3d, keep?: Partial<Model3d>): Model3d {
  const local = new Map(atoms.map((a, k) => [a, k]));
  const bonds = m.bonds.filter((b) => b.type !== HBOND && local.has(b.atoms[0]) && local.has(b.atoms[1])).map((b): [number, number] => [local.get(b.atoms[0])!, local.get(b.atoms[1])!]);
  const model: Model3d = { sources: [...atoms], elements: atoms.map((i) => m.atoms[i].label), xyz: g.xyz, bonds, ...(g.hydrogens?.length ? { hydrogens: g.hydrogens } : {}),
    fingerprint: fingerprintOf(m, atoms), rotation: [1, 0, 0, 0], offset: [0, 0], size: 1, display, ...(g.field ? { field: g.field } : {}), ...(g.seed !== undefined ? { seed: g.seed } : {}) };
  const keepView = keep?.rotation !== undefined;
  const out: Model3d = { ...model, ...(keep?.style ? { style: keep.style } : {}), ...(keep?.look ? { look: keep.look } : {}), ...(keep?.hydrogensShown ? { hydrogensShown: keep.hydrogensShown } : {}),
    ...(keep?.labels ? { labels: keep.labels } : {}), ...(keep?.scheme ? { scheme: keep.scheme } : {}) };
  const points = pointsOf(out), heavy = points.filter((p) => p.symbol !== "H"), use = heavy.length ? heavy : points;
  const c = use.reduce<V3>((s, p) => [s[0] + p.xyz[0] / use.length, s[1] + p.xyz[1] / use.length, s[2] + p.xyz[2] / use.length], [0, 0, 0]);
  out.rotation = keepView ? keep!.rotation! : openingRotation(model.xyz.map((p): V3 => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]), atoms.map((i): P => [m.atoms[i].location[0], m.atoms[i].location[1]]));
  // The size that draws the model at about the drawing's own scale (1.5 Å a bond length, as ReShiki's).
  const reach = Math.max(0.1, ...points.map((p) => Math.hypot(p.xyz[0] - c[0], p.xyz[1] - c[1], p.xyz[2] - c[2]) + radiusOf(p.symbol, out.style)));
  out.size = keep?.size ?? Math.max(1 / WORLD, reach / 1.5 / 0.44);
  out.offset = keep?.offset ?? (display === "both" ? besideOffset(m, atoms, out.size) : [0, 0]);
  return out;
}
// Where a model shown beside its structure goes: to its right, a bond length clear.
function besideOffset(m: Mol, atoms: number[], size: number): P {
  const xs = atoms.map((i) => m.atoms[i].location[0]);
  return [(Math.max(...xs) - Math.min(...xs)) / 2 + 1 + 0.5 * size, 0];
}
// Show a model as 3D, both or 2D. A model going to "both" from "3d" moves beside its structure, and back.
export function setDisplay(m: Mol, k: number, display: Display3d): Mol {
  const model = m.models?.[k];
  if (!model || model.display === display) return m;
  const offset: P = display === "both" ? besideOffset(m, liveAtoms(model).filter((i) => i < m.atoms.length), model.size) : display === "3d" ? [0, 0] : model.offset;
  return { ...m, models: m.models!.map((x, j) => (j === k ? { ...x, display, offset } : x)) };
}
// The model a structure has (by any of its atoms), if any.
export const modelOf = (m: Mol, atoms: Iterable<number>): number | undefined => {
  const set = new Set(atoms);
  const k = (m.models ?? []).findIndex((x) => x.sources.some((s) => s !== null && set.has(s)));
  return k < 0 ? undefined : k;
};
// Models follow their atoms when atoms are renumbered (map: old index to new, undefined when gone). A model with
// none of its atoms left goes.
export function remapModels(models: Model3d[] | undefined, map: (i: number) => number | undefined): Model3d[] | undefined {
  const out = models?.map((x) => ({ ...x, sources: x.sources.map((s) => (s === null ? null : map(s) ?? null)) })).filter((x) => x.sources.some((s) => s !== null));
  return out?.length ? out : undefined;
}
// The models whose atoms are all in a part taken out of the drawing (copy, a template), renumbered for it.
export function modelsWithin(models: Model3d[] | undefined, map: Map<number, number>): Model3d[] | undefined {
  const out = models?.filter((x) => liveAtoms(x).every((s) => map.has(s))).map((x) => ({ ...x, sources: x.sources.map((s) => (s === null ? null : map.get(s)!)) }));
  return out?.length ? out : undefined;
}
// Scale models with their atoms (a resize or Scale…): k times as big, the offset too.
export function scaleModels(m: Mol, ids: Set<number>, k: number): Mol {
  if (!m.models?.some((x) => liveAtoms(x).some((s) => ids.has(s)))) return m;
  return { ...m, models: m.models.map((x) => (liveAtoms(x).some((s) => ids.has(s)) ? { ...x, size: Math.min(1e5, Math.max(1e-3, x.size * Math.abs(k))), offset: [x.offset[0] * k, x.offset[1] * k] as P } : x)) };
}
// Turn the shown models of these atoms (Structure Perspective, degrees) and say which atoms they hold, so the
// structure itself does not turn.
export function tiltModels(m: Mol, ids: Set<number>, yaw: number, pitch: number): { mol: Mol; held: Set<number> } {
  const held = new Set<number>();
  if (!m.models?.length) return { mol: m, held };
  const models = m.models.map((x) => {
    if (x.display === "2d" || !liveAtoms(x).some((s) => ids.has(s))) return x;
    for (const s of liveAtoms(x)) held.add(s);
    return { ...x, rotation: tiltQuat(x.rotation, yaw, pitch) };
  });
  return { mol: held.size ? { ...m, models } : m, held };
}

// ---- Reading a model from Octet's file ----

const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isV3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((x) => isNum(x) && Math.abs(x as number) <= 1e4);
const MAX_POINTS = 2000;
// A model from a file, or undefined when it is not sound (it is then left out, and the structure stays).
export function readModel(d: unknown, atoms: number): Model3d | undefined {
  const x = d as Record<string, unknown>;
  if (!x || typeof x !== "object") return undefined;
  const { sources, elements, xyz, bonds, hydrogens, rotation, offset, size } = x;
  if (!Array.isArray(sources) || !Array.isArray(elements) || !Array.isArray(xyz) || !Array.isArray(bonds) || sources.length === 0 || sources.length > MAX_POINTS
    || elements.length !== sources.length || xyz.length !== sources.length || bonds.length > 4 * MAX_POINTS) return undefined;
  if (!sources.every((s) => s === null || (Number.isInteger(s) && s >= 0 && s < atoms)) || new Set(sources.filter((s) => s !== null)).size !== sources.filter((s) => s !== null).length) return undefined;
  if (!elements.every((e) => typeof e === "string" && /^[A-Z][a-z]{0,2}$/.test(e)) || !xyz.every(isV3)) return undefined;
  const n = sources.length, index = (v: unknown, hi: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < hi;
  if (!bonds.every((b) => Array.isArray(b) && b.length === 2 && index(b[0], n) && index(b[1], n) && b[0] !== b[1])) return undefined;
  if (hydrogens !== undefined && !(Array.isArray(hydrogens) && hydrogens.length <= MAX_POINTS && hydrogens.every((h) => h && index(h.parent, n) && isV3(h.xyz)))) return undefined;
  if (!(Array.isArray(rotation) && rotation.length === 4 && rotation.every(isNum) && Math.abs(Math.hypot(...(rotation as number[])) - 1) < 1e-3)) return undefined;
  if (!(Array.isArray(offset) && offset.length === 2 && offset.every((v) => isNum(v) && Math.abs(v as number) < 1e5)) || !(isNum(size) && (size as number) > 0 && (size as number) <= 1e5)) return undefined;
  if (!["3d", "both", "2d"].includes(x.display as string) || typeof x.fingerprint !== "string" || x.fingerprint.length > 200000) return undefined;
  const one = <T extends string>(v: unknown, ok: readonly T[]) => (ok.includes(v as T) ? { v: v as T } : undefined);
  const crystal = x.crystal === undefined ? undefined : readCrystal(x.crystal, sources.length), style = one(x.style, (crystal ? ["stick", "wireframe", "spaceFilling", "ellipsoids"] : ["stick", "wireframe", "spaceFilling"]) as Style3d[]), hs = one(x.hydrogensShown, ["polar", "none"] as const), labels = one(x.labels, ["heteroatoms", "all"] as const);
  const scheme = one(x.scheme, ["vesta", "jmol"] as const), field = one(x.field, ["MMFF94s", "MMFF94", "UFF"] as const);
  return {
    sources: sources as (number | null)[], elements: elements as string[], xyz: xyz as V3[], bonds: bonds as [number, number][], ...(hydrogens ? { hydrogens: (hydrogens as { parent: number; xyz: V3 }[]).map((h) => ({ parent: h.parent, xyz: h.xyz })) } : {}),
    fingerprint: x.fingerprint, rotation: (rotation as number[]).map((v) => v / Math.hypot(...(rotation as number[]))) as Quat, offset: offset as P, size: size as number, display: x.display as Display3d,
    ...(style ? { style: style.v } : {}), ...(x.look === "glossy" ? { look: "glossy" as const } : {}), ...(hs ? { hydrogensShown: hs.v } : {}), ...(labels ? { labels: labels.v } : {}),
    ...(crystal ? { crystal } : {}), ...(scheme ? { scheme: scheme.v } : {}), ...(field ? { field: field.v } : {}), ...(Number.isInteger(x.seed) && (x.seed as number) >= 0 && (x.seed as number) < 2 ** 31 ? { seed: x.seed as number } : {}),
  };
}
// A model as written to Octet's file: coordinates to 0.0001 Å.
export function writeModel(x: Model3d): Record<string, unknown> {
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return { ...x, xyz: x.xyz.map((p) => p.map(r)), ...(x.hydrogens ? { hydrogens: x.hydrogens.map((h) => ({ parent: h.parent, xyz: h.xyz.map(r) })) } : {}), rotation: x.rotation.map((v) => Math.round(v * 1e8) / 1e8), offset: x.offset.map(r), size: r(x.size), ...(x.crystal ? { crystal: writeCrystal(x.crystal) } : {}) };
}

// The words a screen reader says for a model.
export function describeModel(model: Model3d): string {
  const style = { ballStick: "ball and stick", stick: "stick", wireframe: "wireframe", spaceFilling: "space-filling", ellipsoids: `${model.crystal?.probability ?? 50}% probability ellipsoids` }[model.style ?? "ballStick"];
  const cell = model.crystal && !model.crystal.moleculeOnly ? ", in its unit cell" : "";
  return `3D model, ${style}${cell}${model.display === "both" ? ", beside its structure" : ""}`;
}
// A 2D turn of a structure (anticlockwise, degrees) turns its model the same way in the page's plane, and its offset.
export function rollModels(models: Model3d[], ids: Set<number>, degrees: number): Model3d[] {
  const c = Math.cos((degrees * Math.PI) / 180), s = Math.sin((degrees * Math.PI) / 180);
  return models.map((x) => (x.display !== "2d" && liveAtoms(x).length && liveAtoms(x).every((i) => ids.has(i))
    ? { ...x, rotation: rollQuat(x.rotation, degrees), offset: [x.offset[0] * c - x.offset[1] * s, x.offset[0] * s + x.offset[1] * c] as P } : x));
}
