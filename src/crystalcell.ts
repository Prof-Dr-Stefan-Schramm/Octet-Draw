// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/model/src/models3d.rs (shown_sites, site_bonds, crossing_halves, cell_ink, axis_spot, seams, Along, tilted) and crates/model/src/models3d/crystal.rs (Cell, molecule_atoms), MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// A crystal's 3D model (crystal.ts reads it): the atoms of its unit cell with their light copies on the far faces,
// edges and corners (as crystallographers draw a cell; rock salt shows 27 ions), repeated 1 to 4 cells along each axis,
// the cell box (front edges solid, hidden edges dashed, an origin dot, italic a, b and c), short dashed stubs where a
// network's bonds leave the box, Look along a, b, c or [111], and for ORTEP plots Molecule only and Include solvent.
// It is drawn by the 3D model painter (model3d.ts paintScene); copies are pictures only, never atoms of the drawing.

import type { Mol } from "./render.ts";
import {
  middleOf, openingRotation, paintScene, pointsOf, quaternion, rotate, sceneView, shownOf, tilted, WORLD,
  type Adp, type Along, type Crystal, type Model3d, type PaintOptions, type Prim3d, type Quat, type V3, type View3d,
} from "./model3d.ts";
import { ellipsoidOf, ellipsoidRadius, rotatedEllipsoid, type Ellipsoid, type Probability } from "./ortep.ts";

type P = [number, number];
type M3 = [V3, V3, V3];
export const MAX_REPEAT = 4, COPY_OPACITY = 0.55;
// The most atoms (cell atoms and their copies) a crystal model draws; Repeat stops short of more.
export const MAX_SHOWN = 20_000;
const ON_FACE = 1e-3; // how near a fractional coordinate must be to 0 for an atom to lie on a face of its cell
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: V3): V3 => { const n = Math.max(Math.hypot(...v), 1e-300); return [v[0] / n, v[1] / n, v[2] / n]; };

// ---- The cell ----

export const repeatOf = (c: Crystal): V3 => (c.repeat ?? [1, 1, 1]).map((n) => Math.max(1, Math.min(MAX_REPEAT, Math.round(n)))) as V3;
// The point at fractional coordinates f.
export const cellAt = (v: M3, f: V3): V3 => add(add(v[0].map((x) => x * f[0]) as V3, v[1].map((x) => x * f[1]) as V3), v[2].map((x) => x * f[2]) as V3);
export function fractionalOf(v: M3): (p: V3) => V3 {
  const volume = dot(v[0], cross(v[1], v[2])), r = [cross(v[1], v[2]), cross(v[2], v[0]), cross(v[0], v[1])].map((x) => x.map((y) => y / volume) as V3);
  return (p) => r.map((x) => dot(p, x)) as V3;
}
// The eight corners: corner i is (i & 1) a + (i >> 1 & 1) b + (i >> 2 & 1) c.
export const cellCorners = (v: M3): V3[] => Array.from({ length: 8 }, (_, i) => cellAt(v, [i & 1, (i >> 1) & 1, (i >> 2) & 1]));
// The cell of the whole repeat.
export const wholeCell = (c: Crystal): M3 => { const r = repeatOf(c); return c.vectors.map((v, k) => v.map((x) => x * r[k])) as M3; };

// The copies of the model's atoms the cell shows, by atom and cell: each atom in every cell of the repeat, and again,
// one cell on along each axis where it lies on the near face of that axis, so the far faces, edges and corners of the
// whole repeat are filled too. A molecule goes by its centre, so it is copied whole.
export function shownSites(model: Model3d): [number, V3][] {
  const c = model.crystal;
  if (!c) return model.xyz.map((_, i) => [i, [0, 0, 0]]);
  const n = model.xyz.length, group = Array.from({ length: n }, (_, i) => i), root = (i: number) => { while (group[i] !== i) i = group[i]; return i; };
  for (const [a, b] of model.bonds) group[root(a)] = root(b);
  const network = new Set((c.crossing ?? []).flatMap((x) => [root(x.a), root(x.b)]));
  const sums = new Map<number, [V3, number]>();
  model.xyz.forEach((p, i) => { const s = sums.get(root(i)) ?? [[0, 0, 0], 0]; sums.set(root(i), [add(s[0], p), s[1] + 1]); });
  const frac = fractionalOf(c.vectors), at = model.xyz.map((p, i) => {
    const s = sums.get(root(i))!;
    return frac(network.has(root(i)) ? p : (s[0].map((x) => x / s[1]) as V3));
  });
  const repeat = repeatOf(c), out: [number, V3][] = [];
  for (let i = 0; i <= repeat[0]; i++) for (let j = 0; j <= repeat[1]; j++) for (let k = 0; k <= repeat[2]; k++) {
    const cell: V3 = [i, j, k];
    for (let a = 0; a < n && out.length < MAX_SHOWN; a++) if ([0, 1, 2].every((x) => cell[x] < repeat[x] || Math.abs(at[a][x]) < ON_FACE)) out.push([a, cell]);
  }
  return out;
}
// Bonds within and between the shown cells, as pairs of places in `sites`: each cell's own bonds, and each bond leaving
// a cell whose partner's cell is shown.
export function siteBonds(model: Model3d, sites: [number, V3][]): [number, number][] {
  const key = (a: number, c: V3) => `${a}|${c.join(",")}`, index = new Map(sites.map(([a, c], k) => [key(a, c), k]));
  const cells = [...new Map(sites.map(([, c]) => [c.join(","), c])).values()], out: [number, number][] = [];
  for (const c of cells) {
    for (const [a, b] of model.bonds) { const i = index.get(key(a, c)), j = index.get(key(b, c)); if (i !== undefined && j !== undefined) out.push([i, j]); }
    for (const x of model.crystal?.crossing ?? []) { const i = index.get(key(x.a, c)), j = index.get(key(x.b, add(c, x.image))); if (i !== undefined && j !== undefined) out.push([i, j]); }
  }
  return out;
}
// Molecule only (ORTEP): the components (bonds and bonds leaving the cell) that hold a listed CIF input site, and
// every network; a model with no input sites keeps all. Without solvent, a discrete component is hidden when it has
// fewer heavy atoms than the largest kept one and at most eight; equal-sized molecules stay. A display rule only.
export function moleculeAtoms(model: Model3d, includeSolvent = true): Set<number> {
  const c = model.crystal, n = model.xyz.length, asymmetric = new Set((c?.sites ?? []).filter((s) => s.asymmetric && s.atom < n).map((s) => s.atom));
  const near: number[][] = Array.from({ length: n }, () => []), network = new Set<number>();
  for (const [a, b] of model.bonds) { near[a].push(b); near[b].push(a); }
  for (const x of c?.crossing ?? []) { near[x.a].push(x.b); near[x.b].push(x.a); network.add(x.a); network.add(x.b); }
  const seen = new Set<number>(), parts: { members: number[]; extended: boolean; heavy: number }[] = [];
  for (let s = 0; s < n; s++) {
    if (seen.has(s)) continue;
    seen.add(s);
    const members: number[] = [], pending = [s];
    while (pending.length) { const i = pending.pop()!; members.push(i); for (const j of near[i]) if (!seen.has(j)) { seen.add(j); pending.push(j); } }
    const extended = members.some((i) => network.has(i));
    if (extended || !asymmetric.size || members.some((i) => asymmetric.has(i))) parts.push({ members, extended, heavy: members.filter((i) => model.elements[i] !== "H").length });
  }
  const largest = Math.max(0, ...parts.filter((p) => !p.extended).map((p) => p.heavy));
  return new Set(parts.filter((p) => includeSolvent || p.extended || p.heavy === largest || p.heavy > 8).flatMap((p) => p.members));
}

// ---- Views ----

// The rows of the rotation looking straight down a direction of the cell: c up, or b up looking down c.
export function alongBasis(v: M3, along: Along): M3 {
  const [a, b, c] = v, [toward, up] = along === "a" ? [a, c] : along === "b" ? [b, c] : along === "c" ? [c, b] : [add(add(a, b), c), c];
  const z = unit(toward), y = unit(sub(up, z.map((x) => x * dot(up, z)) as V3));
  return [cross(y, z), y, z];
}
// The crystallographer's view: b to the right, c up, a towards the viewer, turned a little so the cell reads as 3D.
function crystallographers(v: M3): Quat {
  const x = unit(v[1]), y = unit(sub(v[2], x.map((t) => t * dot(v[2], x)) as V3));
  return tilted([x, y, cross(x, y)], 0.3, -0.45);
}
// A model's opening view: down its chosen direction, else the crystallographer's view of its cell, else (no cell) its
// principal axes, as any 3D model's.
export function openingView(model: Model3d): Quat {
  const c = model.crystal;
  if (c) return c.along ? quaternion(alongBasis(c.vectors, c.along)) : crystallographers(c.vectors);
  const n = model.xyz.length || 1, centre = model.xyz.reduce<V3>((s, p) => add(s, p.map((x) => x / n) as V3), [0, 0, 0]);
  return openingRotation(model.xyz.map((p) => sub(p, centre)));
}

// A crystal model's element at atom i: the drawn atom's, so Na⁺ changed to K⁺ in the drawing shows in the model.
function symbolOf(m: Mol | undefined, model: Model3d, i: number): string {
  const s = model.sources[i], a = s === null || s === undefined || !m ? undefined : m.atoms[s];
  return a && !a.text && /^[A-Z][a-z]{0,2}$/.test(a.label) ? a.label : model.elements[i];
}
export type CrystalScene = { sites: [number, V3][]; points: { symbol: string; xyz: V3 }[]; shown: boolean[]; bonds: [number, number][]; alpha: (number | undefined)[]; hold?: V3[]; adps: (Adp | undefined)[] };
export function crystalScene(m: Mol | undefined, model: Model3d): CrystalScene {
  const c = model.crystal!, only = !!c.moleculeOnly;
  const sites: [number, V3][] = only ? [...moleculeAtoms(model, c.includeSolvent !== false)].sort((a, b) => a - b).map((i) => [i, [0, 0, 0]]) : shownSites(model);
  const base = shownOf(model), opacity = c.copyOpacity ?? COPY_OPACITY, adp = new Map((c.sites ?? []).map((s) => [s.atom, s.adp]));
  const copy = (cell: V3) => cell.some((x) => x !== 0);
  return {
    sites, points: sites.map(([i, cell]) => ({ symbol: symbolOf(m, model, i), xyz: add(model.xyz[i], cellAt(c.vectors, cell)) })),
    shown: sites.map(([i, cell]) => base[i] !== false && !(copy(cell) && opacity <= 0)), bonds: siteBonds(model, sites),
    alpha: sites.map(([, cell]) => (copy(cell) && opacity < 1 ? opacity : undefined)), ...(only ? {} : { hold: cellCorners(wholeCell(c)) }),
    adps: sites.map(([i]) => adp.get(i)),
  };
}
// The model's view (origin: its frame's centre, drawing units, y up) and, with the ellipsoids style, each point's
// ellipsoid in view space (none for hydrogens, atoms without displacement parameters and bad tensors).
export function crystalView(m: Mol | undefined, model: Model3d, origin: P): { view: View3d; scene: CrystalScene; ellipsoids: (Ellipsoid | undefined)[] } {
  const c = model.crystal!, scene = crystalScene(m, model), style = model.style ?? "ballStick", p = (c.probability ?? 50) as Probability;
  const cells = scene.points.map((q, k) => (style === "ellipsoids" && q.symbol !== "H" && scene.adps[k] ? ellipsoidOf(scene.adps[k]!, c.vectors, p) : undefined));
  const view = sceneView(scene.points, scene.shown, scene.bonds, style, model.rotation, origin, model.size, undefined, { hold: scene.hold, radii: cells.map((e) => e && ellipsoidRadius(e)) });
  return { view, scene, ellipsoids: cells.map((e) => e && rotatedEllipsoid(e, (v) => rotate(model.rotation, v))) };
}
// The size that draws a crystal at 1.5 Å a bond length (ReShiki's 2D scale), its frame holding the whole cell.
export function crystalSize(model: Model3d): number {
  const reach = model.crystal ? crystalView(undefined, model, [0, 0]).view.reach : sceneView(pointsOf(model), shownOf(model), model.bonds, model.style ?? "ballStick", model.rotation, [0, 0], 1).reach;
  return Math.max(1 / WORLD, reach / 1.5 / 0.44);
}

// Place the 2D atoms of model k where its view shows them (1.5 Å a bond length, keeping their depth), their middle at
// `keep` (the old middle when unset), and the model's frame over them.
export function layOutCrystal(m: Mol, k: number, keep?: P): Mol {
  const model = m.models![k], old = keep ?? middleOf(m, model) ?? [0, 0];
  const centre = model.crystal ? crystalView(m, model, [0, 0]).view.centre : sceneView(pointsOf(model), shownOf(model), model.bonds, model.style ?? "ballStick", model.rotation, [0, 0], model.size).centre;
  const placed = new Map<number, V3>();
  model.sources.forEach((s, i) => { if (s !== null && s < m.atoms.length) placed.set(s, rotate(model.rotation, sub(model.xyz[i], centre)).map((x) => x / 1.5) as V3); });
  if (!placed.size) return m;
  const xs = [...placed.values()].map((p) => p[0]), ys = [...placed.values()].map((p) => p[1]);
  const mid: P = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2], shift: P = [old[0] - mid[0], old[1] - mid[1]];
  const atoms = m.atoms.map((a, i) => { const p = placed.get(i); return p ? { ...a, location: [p[0] + shift[0], p[1] + shift[1], p[2]] as V3 } : a; });
  return { ...m, atoms, models: m.models!.map((x, j) => (j === k ? { ...x, offset: [-mid[0], -mid[1]] as P } : x)) };
}

// A crystal model's settings changed (repeat, copies, look along, molecule only, solvent, probability): what is unset is
// its default. A change that changes the frame keeps the atoms' drawn size; Look along lays the 2D drawing out again.
export function setCrystal(m: Mol, k: number, change: Partial<Crystal>): Mol {
  const model = m.models?.[k];
  if (!model?.crystal) return m;
  const before = crystalView(m, model, [0, 0]).view.reach;
  const crystal = Object.fromEntries(Object.entries({ ...model.crystal, ...change }).filter(([, v]) => v !== undefined)) as Crystal;
  let next: Model3d = { ...model, crystal };
  if ("along" in change) next.rotation = openingView(next);
  const after = crystalView(m, next, [0, 0]).view.reach;
  next = { ...next, size: Math.min(1e5, Math.max(1e-3, (next.size * after) / before)) };
  const out = { ...m, models: m.models!.map((x, j) => (j === k ? next : x)) };
  return "along" in change ? layOutCrystal(out, k) : out;
}
// The repeat that keeps the drawn atoms under MAX_SHOWN, at most `want` along each axis.
export function fittingRepeat(model: Model3d, want: V3): V3 {
  const r = want.map((n) => Math.max(1, Math.min(MAX_REPEAT, n))) as V3, atoms = Math.max(1, model.xyz.length);
  while (atoms * (r[0] + 1) * (r[1] + 1) * (r[2] + 1) > MAX_SHOWN && r.some((n) => n > 1)) r[r.indexOf(Math.max(...r))]--;
  return r;
}

// ---- Drawing ----

// Where an axis label goes: past the axis's end, in the widest gap between the three box edges that meet there.
export function axisSpot(corners: P[], k: 0 | 1 | 2, size: number): P | undefined {
  const end = corners[1 << k], others = [0, (1 << k) | (1 << ((k + 1) % 3)), (1 << k) | (1 << ((k + 2) % 3))].map((i) => corners[i]);
  if (Math.hypot(end[0] - corners[0][0], end[1] - corners[0][1]) < size) return undefined; // seen end-on
  const angles = others.filter((q) => Math.hypot(q[0] - end[0], q[1] - end[1]) > 1e-9).map((q) => Math.atan2(q[1] - end[1], q[0] - end[0])).sort((a, b) => a - b);
  if (!angles.length) return undefined;
  let best = [angles[0] + Math.PI, -1];
  angles.forEach((a, i) => { const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI, gap = next - a; if (gap > best[1]) best = [a + gap / 2, gap]; });
  const d = 1.1 * size;
  return [end[0] + Math.cos(best[0]) * d, end[1] + Math.sin(best[0]) * d];
}

// A crystal model's primitives: the cell's hidden edges, seams and the stubs of bonds leaving it behind; the atoms and
// bonds (copies faint) by the painter; then the front edges, the origin dot and the a, b and c labels.
export function crystalPrimitives(m: Mol, model: Model3d, o: Omit<PaintOptions, "size" | "style" | "look" | "labels" | "scheme" | "morph" | "alpha" | "ellipsoids"> & { morph?: number } = {}): Prim3d[] {
  const middle = middleOf(m, model), c = model.crystal!;
  if (!middle) return [];
  const { view: v, scene, ellipsoids } = crystalView(m, model, [middle[0] + model.offset[0], middle[1] + model.offset[1]]);
  const { morph: _, ...rest } = o;
  const atoms = paintScene(v, { ...rest, style: model.style, look: model.look, labels: model.labels, scheme: model.scheme, size: model.size, alpha: scene.alpha, ellipsoids });
  if (c.moleculeOnly) return atoms;
  const ink = o.ink ?? "#1e2226", place = (p: V3) => rotate(model.rotation, sub(p, v.centre));
  const proj = (q: V3): P => { const f = v.perspective > 0 ? v.camera / (v.camera - q[2]) : 1; return [v.origin[0] + q[0] * v.scale * f, -(v.origin[1] + q[1] * v.scale * f)]; };
  const width = Math.max(1, Math.min(3, (model.size * WORLD) / 220)) / WORLD, size = Math.max(0.4, Math.min(1.2, 0.06 * model.size));
  const faint = (alpha: number, inner: Prim3d): Prim3d => ({ kind: "opacity", alpha, inner });
  const behind: Prim3d[] = [], front: Prim3d[] = [];
  // Stubs: a bond leaving the whole repeat, from each copy of its atom halfway to its partner's copy (not drawn).
  if (model.style !== "spaceFilling") {
    const repeat = repeatOf(c), shown = new Set(scene.sites.map(([a, cell]) => `${a}|${cell.join(",")}`));
    for (const x of c.crossing ?? []) {
      const halfway = sub(add(model.xyz[x.b], cellAt(c.vectors, x.image)), model.xyz[x.a]).map((t) => t / 2) as V3;
      for (const [atom, partner, sign] of [[x.a, x.b, 1], [x.b, x.a, -1]] as const) {
        scene.sites.forEach(([a, cell], k) => {
          if (a !== atom || !scene.shown[k]) return;
          const to = cell.map((t, i) => t + sign * x.image[i]) as V3;
          if (to.every((t, i) => t >= 0 && t < repeat[i]) || shown.has(`${partner}|${to.join(",")}`)) return;
          const from = scene.points[k].xyz, end = add(from, halfway.map((t) => sign * t) as V3);
          behind.push(faint(0.55 * (scene.alpha[k] ?? 1), { kind: "wire", from: proj(place(from)), to: proj(place(end)), width, colour: ink, dash: 2.5 * width }));
        });
      }
    }
  }
  // The box: an edge is in front when either face it bounds faces the viewer.
  const whole = wholeCell(c), corners = cellCorners(whole).map(place), start = place([0, 0, 0]), vectors = whole.map((x) => sub(place(x), start));
  const corner = (bits: number[]) => corners[bits[0] | (bits[1] << 1) | (bits[2] << 2)];
  const faces = (k: number, s: number) => {
    const k1 = (k + 1) % 3, k2 = (k + 2) % 3;
    let normal = cross(vectors[k1], vectors[k2]);
    if ((dot(normal, vectors[k]) < 0) === (s === 1)) normal = normal.map((t) => -t) as V3;
    const bits = [0, 0, 0];
    bits[k] = s;
    const on = corner(bits), toward: V3 = v.perspective > 0 ? sub([0, 0, v.camera], on) : [0, 0, 1];
    return dot(normal, toward) > 0;
  };
  for (let k = 0; k < 3; k++) {
    const k1 = (k + 1) % 3, k2 = (k + 2) % 3;
    for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const bits = [0, 0, 0];
      bits[k1] = i; bits[k2] = j;
      const from = proj(corner(bits));
      bits[k] = 1;
      const to = proj(corner(bits));
      if (faces(k1, i) || faces(k2, j)) front.push(faint(0.55, { kind: "wire", from, to, width, colour: ink }));
      else behind.unshift(faint(0.4, { kind: "wire", from, to, width, colour: ink, dash: 3 * width }));
    }
  }
  // Seams: the inner lattice planes of a repeat, thin.
  const repeat = repeatOf(c);
  for (let k = 0; k < 3; k++) for (let t = 1; t < repeat[k]; t++) {
    const k1 = (k + 1) % 3, k2 = (k + 2) % 3, f = t / repeat[k];
    const at = (u: number, w: number) => { const q: V3 = [0, 0, 0]; q[k] = f; q[k1] = u; q[k2] = w; return proj(place(cellAt(whole, q))); };
    for (const [[a, b], [p, q]] of [[[0, 0], [1, 0]], [[1, 0], [1, 1]], [[1, 1], [0, 1]], [[0, 1], [0, 0]]]) behind.push(faint(0.3, { kind: "wire", from: at(a, b), to: at(p, q), width: 0.6 * width, colour: ink }));
  }
  const origin = proj(corner([0, 0, 0]));
  front.push({ kind: "sphere", c: origin, r: width * 1.8, focal: origin, stops: [[0, ink], [1, ink]] });
  const flat = corners.map(proj);
  (["a", "b", "c"] as const).forEach((name, k) => {
    const spot = axisSpot(flat, k as 0 | 1 | 2, size);
    if (spot) front.push({ kind: "text", at: [spot[0], spot[1] + size * 0.35], text: name, size, colour: ink, italic: true });
  });
  return [...behind, ...atoms, ...front];
}

// ---- Reading and writing ----

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isV3 = (v: unknown, most = 1e4): v is V3 => Array.isArray(v) && v.length === 3 && v.every((x) => isNum(x) && Math.abs(x) <= most);
const MAX_NOTES = 16, MAX_NOTE = 512, MAX_LABEL = 64, MAX_U = 10;
function readAdp(v: unknown): Adp | undefined {
  const x = v as { iso?: unknown; aniso?: unknown };
  if (!x || typeof x !== "object") return undefined;
  if (isNum(x.iso) && Math.abs(x.iso) <= MAX_U) return { iso: x.iso };
  if (Array.isArray(x.aniso) && x.aniso.length === 6 && x.aniso.every((u) => isNum(u) && Math.abs(u) <= MAX_U)) return { aniso: [...x.aniso] as [number, number, number, number, number, number] };
  return undefined;
}
// A model's crystal from Octet's file (n: the model's atoms), or none when it is not sound: the model then stays, as a
// plain model. Settings out of range are left out (their defaults).
export function readCrystal(d: unknown, n: number): Crystal | undefined {
  const x = d as Record<string, unknown>;
  if (!x || typeof x !== "object" || !Array.isArray(x.vectors) || x.vectors.length !== 3 || !x.vectors.every((v) => isV3(v, 1000))) return undefined;
  const vectors = x.vectors as M3, volume = dot(vectors[0], cross(vectors[1], vectors[2]));
  if (!(volume > 1e-3)) return undefined;
  const index = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < n;
  const crossing = x.crossing;
  if (crossing !== undefined && !(Array.isArray(crossing) && crossing.length <= 8 * n && crossing.every((c) => c && index(c.a) && index(c.b) && c.a <= c.b && isV3(c.image, 3) && (c.image as number[]).every(Number.isInteger)))) return undefined;
  const sites = x.sites;
  if (sites !== undefined && !(Array.isArray(sites) && sites.length <= n && sites.every((s) => s && index(s.atom) && (s.label === undefined || (typeof s.label === "string" && s.label.length <= MAX_LABEL)) && (s.adp === undefined || readAdp(s.adp)) && (s.asymmetric === undefined || s.asymmetric === true)))) return undefined;
  const notes = Array.isArray(x.notes) ? x.notes.filter((t): t is string => typeof t === "string").slice(0, MAX_NOTES).map((t) => t.slice(0, MAX_NOTE)) : [];
  const repeat = isV3(x.repeat, MAX_REPEAT) && x.repeat.every((r) => Number.isInteger(r) && r >= 1) && x.repeat.some((r) => r !== 1) ? x.repeat : undefined;
  const opacity = isNum(x.copyOpacity) && x.copyOpacity >= 0 && x.copyOpacity <= 1 && x.copyOpacity !== COPY_OPACITY ? x.copyOpacity : undefined;
  const along = ["a", "b", "c", "111"].includes(x.along as string) ? (x.along as Along) : undefined;
  const probability = [30, 70, 90].includes(x.probability as number) ? (x.probability as 30 | 70 | 90) : undefined;
  return {
    vectors: vectors.map((v) => [...v]) as M3,
    ...(crossing?.length ? { crossing: (crossing as Crystal["crossing"])!.map((c) => ({ a: c.a, b: c.b, image: [...c.image] as V3 })) } : {}),
    ...(sites?.length ? { sites: (sites as NonNullable<Crystal["sites"]>).map((s) => ({ atom: s.atom, ...(s.label ? { label: s.label } : {}), ...(s.adp ? { adp: readAdp(s.adp)! } : {}), ...(s.asymmetric ? { asymmetric: true as const } : {}) })) } : {}),
    ...(notes.length ? { notes } : {}), ...(repeat ? { repeat: [...repeat] as V3 } : {}), ...(opacity !== undefined ? { copyOpacity: opacity } : {}), ...(along ? { along } : {}),
    ...(probability ? { probability } : {}), ...(x.moleculeOnly === true ? { moleculeOnly: true as const } : {}), ...(x.includeSolvent === false ? { includeSolvent: false as const } : {}),
  };
}
// A crystal as written to Octet's file: vectors to 0.0001 Å, U to 0.000001 Å²; settings at their defaults left out.
export function writeCrystal(c: Crystal): Record<string, unknown> {
  const r = (v: number) => Math.round(v * 1e4) / 1e4, u = (v: number) => Math.round(v * 1e6) / 1e6;
  return {
    ...c, vectors: c.vectors.map((v) => v.map(r)),
    ...(c.sites ? { sites: c.sites.map((s) => ({ ...s, ...(s.adp ? { adp: "iso" in s.adp ? { iso: u(s.adp.iso) } : { aniso: s.adp.aniso.map(u) } } : {}) })) } : {}),
    ...(c.repeat && c.repeat.some((n) => n !== 1) ? {} : { repeat: undefined }), ...(c.copyOpacity === COPY_OPACITY ? { copyOpacity: undefined } : {}),
  };
}

