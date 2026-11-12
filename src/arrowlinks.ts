// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/model/src/arrow_anchors.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// Curved arrows whose ends follow what they point at. A curved or fishhook arrow's end can be linked to an atom, a
// bond or a lone pair (or radical dot): the end is kept at the target's centre plus a stored offset, pushed out along
// the link's direction only when it would sit inside the target's ink plus a gap (never pulled in, so resolving again
// changes nothing). Atoms are indices, so every edit that renumbers atoms remaps the links (remapLinks, joinLinks).
// The links are only a drawing aid: they carry no chemistry, and the arrow's from and to always hold the resolved ends,
// which every file and export writes.
import type { Arrow, ArrowLink, ArrowTarget, Drawing, Mol, Style } from "./render.ts";
import { arrowPath, headSize, headsOf, scaleOf } from "./render.ts";

type P = [number, number];
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P, k: number): P => [a[0] * k, a[1] * k];
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1];
const len = (a: P) => Math.hypot(a[0], a[1]);
// A unit vector; a zero one is up the page (ReShiki's fallback, y up here).
const unit = (a: P): P => { const n = len(a); return n > 1e-9 ? [a[0] / n, a[1] / n] : [0, 1]; };
const turn = (a: P, t: number): P => [a[0] * Math.cos(t) - a[1] * Math.sin(t), a[0] * Math.sin(t) + a[1] * Math.cos(t)];
const at = (m: Mol, i: number): P => [m.atoms[i].location[0], m.atoms[i].location[1]];

// The clearance beyond the target's ink, in pt (ReShiki's end_gap).
export const LINK_GAP_PT = 1.2;
// Arrows whose ends link: the curved (two-electron) and fishhook (one-electron) arrows. A double-headed curved arrow
// and an arc line show no one electron flow from a source to a sink, so they stay free (as in ReShiki).
export const linkable = (a: Pick<Arrow, "kind">) => a.kind === "curved" || a.kind === "fishhook";
export const linked = (a: Pick<Arrow, "fromLink" | "toLink">) => !!(a.fromLink || a.toLink);
export const hasLinks = (m: Pick<Mol, "arrows">) => !!m.arrows?.some(linked);
// The marks a link can name: lone pairs (pair0 to pair3) and radical dots (radical0, radical1), as Atom.angles keys them.
export const PAIR_KEY = /^(pair[0-3]|radical[01])$/;
// What the links need of a drawing: label boxes and where the marks are (px, y down). Parts and Drawing both have them.
export type LinkInk = Pick<Drawing, "label" | "electrons">;
// The drawing's style in px (render's Style; s.bond is px per bond length) and pt, px per point.
export type LinkStyle = Pick<Style, "bond" | "line" | "bold" | "spacing" | "size" | "labelPt"> & { pt: number };

// The atoms a target names: an atom, or a bond's two.
export const targetAtoms = (t: ArrowTarget): number[] => ("bond" in t ? [...t.bond] : [t.atom]);
const sameLink = (a?: ArrowLink, b?: ArrowLink) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

// Each bond by its two atoms, for finding a bond target's bond.
const bondKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
function bondsOf(m: Mol) { const out = new Map<string, number>(); m.bonds.forEach((b, k) => out.set(bondKey(b.atoms[0], b.atoms[1]), k)); return out; }

// Ports Target::center: an atom's position, a point along a bond, or where a lone pair is drawn. Undefined when the
// atom, bond or mark is gone (the end then lets go).
export function targetCentre(m: Mol, t: ArrowTarget, ink: Pick<LinkInk, "electrons">, L: number, bonds = bondsOf(m)): P | undefined {
  const ok = (i: number) => Number.isInteger(i) && i >= 0 && i < m.atoms.length;
  if ("bond" in t) {
    const [a, b] = t.bond;
    if (!ok(a) || !ok(b) || !bonds.has(bondKey(a, b))) return undefined;
    return add(at(m, a), mul(sub(at(m, b), at(m, a)), t.t));
  }
  if (!ok(t.atom)) return undefined;
  if (t.pair === undefined) return at(m, t.atom);
  const e = ink.electrons.find((x) => x.atom === t.atom && x.key === t.pair);
  return e ? [e.at[0] / L, -e.at[1] / L] : undefined;
}

// A lone pair or radical dot link names its mark by key, but the renderer numbers an atom's marks by where they fall
// (a turn of the structure, or a new bond, can make another pair pair0). So the link holds on to the mark of its kind on
// its atom that points most nearly its own way out (dir), and takes that mark's key and way out. Undefined when the atom
// has no mark of that kind left (the end lets go).
export function markLink(m: Mol, l: ArrowLink, ink: Pick<LinkInk, "electrons">, L: number): ArrowLink | undefined {
  if ("bond" in l.on || l.on.pair === undefined) return l;
  const atom = l.on.atom, kind = l.on.pair.replace(/\d+$/, "");
  if (atom >= m.atoms.length) return undefined;
  const o = at(m, atom), d = unit(l.dir);
  let best: { key: string; out: P; score: number } | undefined;
  for (const e of ink.electrons) {
    if (e.atom !== atom || !e.key || e.key.replace(/\d+$/, "") !== kind || !PAIR_KEY.test(e.key)) continue;
    const out = unit(sub([e.at[0] / L, -e.at[1] / L], o)), score = dot(out, d) + (e.key === l.on.pair ? 1e-6 : 0);
    if (!best || score > best.score) best = { key: e.key, out, score };
  }
  if (!best) return undefined;
  return best.key === l.on.pair && len(sub(best.out, d)) < 1e-9 ? l : { ...l, on: { atom, pair: best.key }, dir: best.out };
}

// Ports projection_direction: a bond's own normal now (so a stretched or turned bond still gives a true
// perpendicular), on the side of dir; anything else, dir.
function pushDirection(m: Mol, t: ArrowTarget, dir: P): P {
  if (!("bond" in t)) return unit(dir);
  const u = unit(sub(at(m, t.bond[1]), at(m, t.bond[0]))), n: P = [-u[1], u[0]];
  return dot(n, dir) >= 0 ? n : mul(n, -1);
}

// Ports clearance and half_stroke: how far the target's ink reaches along d from its centre (bond lengths).
function clearance(m: Mol, ink: LinkInk, s: LinkStyle, t: ArrowTarget, d: P, centre: P, bonds: Map<string, number>): number {
  const L = s.bond;
  if ("bond" in t) {
    const b = m.bonds[bonds.get(bondKey(t.bond[0], t.bond[1]))!], k = (scaleOf(m.atoms[t.bond[0]]) + scaleOf(m.atoms[t.bond[1]])) / 2;
    const line = s.line * k, bold = s.bold * k;
    // Hashes and hollow wedges span the bold width and are then stroked; a wedge or bold bond is the bold width.
    const stroke = b.display === "hashed" || b.display === "hollow" || b.stereo === 6 ? bold / 2 + line / 2 : b.display === "bold" || b.stereo === 1 ? bold / 2 : line / 2;
    const rails = b.type === 2 || b.type === 3 || b.type === 4 ? 1 : b.type === 14 ? 1.5 : 0;
    const spacing = (b.spacing !== undefined ? (b.spacing / 100) * L : s.spacing) * k;
    const u = unit(sub(at(m, t.bond[1]), at(m, t.bond[0]))), n: P = [-u[1], u[0]];
    return (stroke + Math.abs(dot(n, d)) * Math.max(spacing * rails, b.display === "wavy" ? 1.25 * line : 0)) / L;
  }
  const a = m.atoms[t.atom], half = (s.line * scaleOf(a)) / 2 / L;
  if (t.pair === undefined) {
    // The farthest corner of the label's ink box along d; an unlabelled atom, half the line width.
    const b = ink.label[t.atom];
    if (!b) return half;
    const corners: P[] = [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]];
    return Math.max(half, ...corners.map((q) => dot(sub([q[0] / L, -q[1] / L], centre), d)));
  }
  // A lone pair: two dots of radius 0.09 z, 0.19 z either side of the way out from the atom (render.ts), or a bar
  // across it as long as the pair is wide; a radical, one dot of radius 0.1 z. z: the atom's label size.
  const z = (s.size * (a.size && s.labelPt ? a.size / s.labelPt : 1) * scaleOf(a)) / L, r = unit(sub(centre, at(m, t.atom))), n: P = [-r[1], r[0]];
  if (t.pair.startsWith("radical")) return 0.1 * z;
  if (a.bars) return 0.28 * z * Math.abs(dot(n, d)) + half * Math.abs(dot(r, d));
  return 0.19 * z * Math.abs(dot(n, d)) + 0.09 * z;
}

// Ports Anchor::resolved: centre + offset, pushed out along the link's direction when it would sit inside the
// target's ink plus the gap plus half the arrow's line. Never pulled in. Undefined when the target is gone.
export function resolveEnd(m: Mol, ink: LinkInk, s: LinkStyle, link: ArrowLink, pen: number, bonds = bondsOf(m)): P | undefined {
  const centre = targetCentre(m, link.on, ink, s.bond, bonds);
  if (!centre) return undefined;
  const d = pushDirection(m, link.on, link.dir), need = clearance(m, ink, s, link.on, d, centre, bonds) + ((link.gap ?? LINK_GAP_PT) * s.pt) / s.bond + pen;
  const p = add(centre, link.offset), along = dot(sub(p, centre), d);
  // A tiny guard only when a correction is needed, so resolving again never walks the end outward.
  return along < need ? add(p, mul(d, need - along + 1e-7)) : p;
}
// Half an arrow's line width, in bond lengths.
const penOf = (a: Omit<Arrow, "id">, s: LinkStyle) => ((a.width !== undefined ? a.width * s.pt : s.line) * scaleOf(a)) / 2 / s.bond;

// The similarity (a turn and scale, or with mirror a flip) that takes an arrow's old ends to its new ones: what the
// edit did to the arrow. A short arrow only moves.
function motionOf(a0: Arrow, a1: Arrow): { f: (q: P) => P; lin: (v: P) => P; size: number } {
  const u0 = sub(a0.to, a0.from), u1 = sub(a1.to, a1.from), mirror = (a0.bend ?? 0) * (a1.bend ?? 0) < 0, n0 = dot(u0, u0);
  if (n0 < 1e-18) { const d = sub(a1.from, a0.from); return { f: (q) => add(q, d), lin: (v) => v, size: 1 }; }
  // As complex numbers: z' = c z + e, or c conj(z) + e for a mirror.
  const v0: P = mirror ? [u0[0], -u0[1]] : u0, c: P = [(u1[0] * v0[0] + u1[1] * v0[1]) / n0, (u1[1] * v0[0] - u1[0] * v0[1]) / n0];
  const lin = (v: P): P => { const w: P = mirror ? [v[0], -v[1]] : v; return [c[0] * w[0] - c[1] * w[1], c[0] * w[1] + c[1] * w[0]]; };
  const e = sub(a1.from, lin(a0.from));
  return { f: (q) => add(lin(q), e), lin, size: len(c) };
}

// Ports reconcile, resolved_endpoints and apply_resolved_endpoints, with the transformed rule (arrow_anchors.rs
// 1185-1253, 1363-1400) worked out from what the edit did. before: the drawing before the edit (undefined: nothing
// moved by hand). For each linked end of a curved arrow:
// - a link that is new (or renumbered) to this edit, or an end that has not moved, follows its target;
// - an end the edit moved keeps its link only when its target's atoms moved with it (the arrow and its targets turned,
//   flipped, scaled or moved together): then its offset and direction are taken from where it is now. Otherwise (the
//   arrow moved alone, or its end handle was dragged off) the link drops and the end stays where it was put;
// - a target that is gone (atom, bond or mark deleted) drops the link, and the end stays where it was last drawn.
// The end then goes where the link resolves (resolveEnd), and the arc follows: its bend is kept. Arrows of other kinds
// lose their links. Returns the same array when nothing changed (keeps React's memos and the arrows' ink cache).
export function reconcileArrows(before: Mol | undefined, m: Mol, ink: LinkInk, s: LinkStyle): Arrow[] | undefined {
  if (!hasLinks(m)) return m.arrows;
  const bonds = bondsOf(m), was = new Map((before?.arrows ?? []).map((a) => [a.id, a]));
  let changed = false;
  const arrows = m.arrows!.map((a) => {
    if (!linked(a)) return a;
    if (!linkable(a)) { changed = true; const { fromLink: _f, toLink: _t, ...rest } = a; return rest as Arrow; }
    const old = was.get(a.id), pen = penOf(a, s), out: Arrow = { ...a };
    let motion: ReturnType<typeof motionOf> | undefined;
    for (const end of ["from", "to"] as const) {
      const key = end === "from" ? "fromLink" : "toLink";
      let link = a[key];
      if (!link) { delete out[key]; continue; }
      // Where this end was before the edit: the old end that had this very link (Reverse swaps them).
      const prior = old && (sameLink(old.fromLink, link) ? old.from : sameLink(old.toLink, link) ? old.to : undefined);
      if (prior && len(sub(a[end], prior)) > 1e-9) {
        motion ??= motionOf(old!, a);
        const mv = motion, tol = 1e-4 * Math.max(1, mv.size);
        const together = targetAtoms(link.on).every((i) => i < before!.atoms.length && i < m.atoms.length && len(sub(mv.f(at(before!, i)), at(m, i))) < tol);
        const centre = together ? targetCentre(m, link.on, ink, s.bond, bonds) : undefined;
        link = centre ? { ...link, offset: sub(a[end], centre), dir: unit(mv.lin(link.dir)) } : undefined;
      }
      if (link) link = markLink(m, link, ink, s.bond);
      const p = link && resolveEnd(m, ink, s, link, pen, bonds), centre = link && p && targetCentre(m, link.on, ink, s.bond, bonds);
      if (!link || !p || !centre) { delete out[key]; continue; }
      // Where nothing has moved, the end and link stay exactly as they were (no rounding creeps in).
      const still = len(sub(p, a[end])) < 1e-9, offset = sub(still ? a[end] : p, centre);
      out[end] = still ? a[end] : p;
      out[key] = len(sub(offset, link.offset)) < 1e-9 ? link : { ...link, offset };
    }
    const same = out.from === a.from && out.to === a.to && out.fromLink === a.fromLink && out.toLink === a.toLink;
    if (same) return a;
    changed = true;
    return out;
  });
  return changed ? arrows : m.arrows;
}
export function reconcileLinks(before: Mol | undefined, m: Mol, ink: LinkInk, s: LinkStyle): Mol {
  const arrows = reconcileArrows(before, m, ink, s);
  return arrows === m.arrows ? m : { ...m, arrows };
}

// Ports Target::remap and remap: each linked atom through map; a link to an atom that is gone drops (its end stays
// where it is). A bond whose two atoms come out the other way round swaps them and measures t from the other end.
export function remapLinks<T extends Pick<Arrow, "fromLink" | "toLink">>(arrows: T[] | undefined, map: (i: number) => number | undefined): T[] | undefined {
  if (!arrows?.some(linked)) return arrows;
  const one = (l?: ArrowLink): ArrowLink | undefined => {
    if (!l) return undefined;
    if ("bond" in l.on) {
      const a = map(l.on.bond[0]), b = map(l.on.bond[1]);
      if (a === undefined || b === undefined || a === b) return undefined;
      return { ...l, on: a < b ? { bond: [a, b], t: l.on.t } : { bond: [b, a], t: 1 - l.on.t } };
    }
    const i = map(l.on.atom);
    return i === undefined ? undefined : { ...l, on: { ...l.on, atom: i } };
  };
  return arrows.map((a) => {
    if (!linked(a)) return a;
    const { fromLink: f, toLink: t, ...rest } = a, from = one(f), to = one(t);
    return { ...rest, ...(from ? { fromLink: from } : {}), ...(to ? { toLink: to } : {}) } as T;
  });
}
// Ports remap_for_join: atoms merged into others (into: merged → kept) take their links with them, before the merged
// atoms are removed. A lone pair on a merged atom is not kept (the kept atom has its own marks), and a bond whose two
// atoms became one is gone: those links drop.
export function joinLinks<T extends Pick<Arrow, "fromLink" | "toLink">>(arrows: T[] | undefined, into: Map<number, number>): T[] | undefined {
  if (!arrows?.some(linked) || !into.size) return arrows;
  return remapLinks(arrows.map((a) => {
    const drop = (l?: ArrowLink) => !!l && !("bond" in l.on) && l.on.pair !== undefined && into.has(l.on.atom);
    if (!drop(a.fromLink) && !drop(a.toLink)) return a;
    const { fromLink: f, toLink: t, ...rest } = a;
    return { ...rest, ...(f && !drop(f) ? { fromLink: f } : {}), ...(t && !drop(t) ? { toLink: t } : {}) } as T;
  }), (i) => into.get(i) ?? i);
}
// Ports transformed for an edit that moves picked arrows and atoms by f together (Turn, Flip, Scale, a resize): a link
// whose target's atoms all move with its arrow is carried exactly, its offset and direction through f's linear part, so
// the end lands where f puts it. Other links are left for reconcileArrows to judge.
export function transformLinks(a: Arrow, atoms: Set<number>, f: (q: P) => P): Arrow {
  if (!linked(a)) return a;
  const o = f([0, 0]), lin = (v: P): P => sub(f(v), o);
  const one = (l?: ArrowLink) => (l && targetAtoms(l.on).every((i) => atoms.has(i)) ? { ...l, offset: lin(l.offset), dir: unit(lin(l.dir)) } : l);
  const from = one(a.fromLink), to = one(a.toLink);
  return { ...a, ...(from ? { fromLink: from } : {}), ...(to ? { toLink: to } : {}) };
}
// Ports Arrow::reverse's swap: the links go with their ends.
export const reverseLinks = (a: Arrow): Partial<Arrow> => ({ fromLink: a.toLink, toLink: a.fromLink });

// The way an arc leaves its end, out from that end along the curve (y up): the chord turned by half the sweep, to the
// side the arc bulges.
export function tangentOut(from: P, to: P, bend: number, end: "from" | "to"): P {
  const u = unit(sub(to, from)), half = 2 * Math.atan(2 * bend);
  return end === "from" ? turn(u, half) : turn(mul(u, -1), -half);
}
// Ports the link part of create and Pick::commit: a new link for an end on target t, whose centre is at `centre`
// (where the Arrow tool snapped the end: the atom, the bond's middle or the lone pair), on an arc from `from` to `to`
// with this bend. Its direction: a lone pair's own way out from its atom; a bond's normal on the side the arc comes
// from; an atom, the way the arc leaves it.
export function linkFor(m: Mol, t: ArrowTarget, centre: P, arc: { from: P; to: P; bend?: number }, end: "from" | "to"): ArrowLink | undefined {
  if (targetAtoms(t).some((i) => !Number.isInteger(i) || i < 0 || i >= m.atoms.length)) return undefined;
  const way = tangentOut(arc.from, arc.to, arc.bend ?? 0, end);
  let dir = way;
  if ("bond" in t) { const u = unit(sub(at(m, t.bond[1]), at(m, t.bond[0]))), n: P = [-u[1], u[0]]; dir = dot(n, way) >= 0 ? n : mul(n, -1); }
  else if (t.pair !== undefined && len(sub(centre, at(m, t.atom))) > 1e-6) dir = unit(sub(centre, at(m, t.atom)));
  return { on: t, offset: sub(arc[end], centre), dir };
}
// A new curved arrow's links (the Arrow tool): each end on the target it was drawn on, unless both are on one target.
export function linkEnds<T extends Omit<Arrow, "id">>(m: Mol, a: T, from?: { on: ArrowTarget; at: P }, to?: { on: ArrowTarget; at: P }): T {
  if (!linkable(a) || (from && to && JSON.stringify(from.on) === JSON.stringify(to.on))) return a;
  const f = from && linkFor(m, from.on, from.at, a, "from"), t = to && linkFor(m, to.on, to.at, a, "to");
  return { ...a, ...(f ? { fromLink: f } : {}), ...(t ? { toLink: t } : {}) };
}

// ——— Arrowheads clear of bonds (part B) ———
// Ports open_approach and HeadInk (arrow_anchors.rs 642-826) for Octet's arcs. ReShiki turns a cubic's end tangent.
// An arc has one bend for both ends, so here the head end goes round its atom to the arrival direction, and the arc
// takes the bend whose tangent there is that direction (the start stays; its departure turns with the bend). Only a head that touches a bond (or whose shaft does) is moved, so an arrow drawn
// clear keeps its place and aiming again changes nothing. Candidates face the source (within OPEN_APPROACH of the way
// back to it). A clear head and clear shaft win over a clear head alone; then the smallest extra gap (up to one more
// gap, in eighths); then the widest angle from the bonds (up to OPEN_APPROACH); then the nearest to the preferred way.
const OPEN_APPROACH = Math.PI / 3;
type Seg = { a: P; b: P; w: number }; // a bond's ink near the atom: its axis and how far its lines reach either side (px)
// The bonds at an atom as bands round their axes (px, y down): half the stroke, plus the spacing of a double, triple or
// aromatic bond's second line on either side (which side Octet draws it on is not known here, so both).
export function bondInk(m: Mol, atom: number, s: LinkStyle): { segs: Seg[]; ways: P[] } {
  const L = s.bond, px = (q: P): P => [q[0] * L, -q[1] * L], segs: Seg[] = [], ways: P[] = [];
  for (const b of m.bonds) {
    if (b.atoms[0] !== atom && b.atoms[1] !== atom) continue;
    const o = at(m, atom), q = at(m, b.atoms[b.atoms[0] === atom ? 1 : 0]), sc = (scaleOf(m.atoms[b.atoms[0]]) + scaleOf(m.atoms[b.atoms[1]])) / 2;
    const stroke = (b.display === "hashed" || b.display === "hollow" || b.stereo === 6 ? s.bold / 2 + s.line / 2 : b.display === "bold" || b.stereo === 1 ? s.bold / 2 : s.line / 2) * sc;
    const rails = b.type === 2 || b.type === 3 || b.type === 4 ? 1 : b.type === 14 ? 1.5 : 0, spacing = (b.spacing !== undefined ? (b.spacing / 100) * L : s.spacing) * sc;
    segs.push({ a: px(o), b: px(q), w: stroke + spacing * rails + (b.display === "wavy" ? 1.25 * s.line : 0) });
    ways.push(unit(sub(q, o)));
  }
  return { segs, ways };
}
const segPoint = (p: P, a: P, b: P) => { const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1))); return len(sub(p, add(a, mul(ab, t)))); };
const crossZ = (a: P, b: P) => a[0] * b[1] - a[1] * b[0];
const segSeg = (p: P, q: P, a: P, b: P) => {
  const d1 = crossZ(sub(q, p), sub(a, p)), d2 = crossZ(sub(q, p), sub(b, p)), d3 = crossZ(sub(b, a), sub(p, a)), d4 = crossZ(sub(b, a), sub(q, a));
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(segPoint(p, a, b), segPoint(q, a, b), segPoint(a, p, q), segPoint(b, p, q));
};
const inTri = (p: P, t: P[]) => { const s = [0, 1, 2].map((i) => crossZ(sub(t[(i + 1) % 3], t[i]), sub(p, t[i]))); return s.every((v) => v >= 0) || s.every((v) => v <= 0); };
// Whether an arrow's head at its end, and its shaft, touch the bond ink (px). The head as its full triangle (a half
// head's too: either side may meet a bond), its length back along the arc and its width either side. The bonds all
// start at the atom the head points at, where they meet: the ink there, as near the atom as the tip and a line width
// more, is where the head points, and does not count.
export function touches(a: Omit<Arrow, "id">, bonds: Seg[], s: LinkStyle): { head: boolean; shaft: boolean } {
  const L = s.bond, path = arrowPath({ ...a, id: 0 }, L), size = headSize(a), line = (a.width !== undefined ? a.width * s.pt : s.line) * scaleOf(a);
  const H = size.length * line, W = size.width * line, T = path[path.length - 1];
  const ink = bonds.flatMap((g) => { const r = len(sub(T, g.a)) + line, l = len(sub(g.b, g.a)); return l > r ? [{ ...g, a: add(g.a, mul(sub(g.b, g.a), r / l)) }] : []; });
  // The point on the path H back from the tip.
  let back = T, left = H;
  for (let i = path.length - 1; i > 0 && left > 0; i--) { const d = len(sub(path[i], path[i - 1])); if (d >= left) { back = add(path[i], mul(sub(path[i - 1], path[i]), left / d)); left = 0; } else { left -= d; back = path[i - 1]; } }
  const u = unit(sub(T, back)), n: P = [-u[1], u[0]], base = sub(T, mul(u, H)), tri: P[] = [T, add(base, mul(n, W)), sub(base, mul(n, W))];
  const head = ink.some((g) => [0, 1, 2].some((i) => segSeg(tri[i], tri[(i + 1) % 3], g.a, g.b) < g.w + line / 2) || inTri(g.a, tri));
  // The shaft, up to the head's base, in steps of no more than a line width or so.
  const pts: P[] = [];
  for (let i = 0; i + 1 < path.length; i++) { const k = Math.max(1, Math.ceil(len(sub(path[i + 1], path[i])) / Math.max(1, line * 2))); for (let j = 0; j < k; j++) pts.push(add(path[i], mul(sub(path[i + 1], path[i]), j / k))); }
  const shaft = pts.filter((q) => len(sub(q, T)) > H).some((q) => ink.some((g) => segPoint(q, g.a, g.b) < g.w + line / 2));
  return { head, shaft };
}
// Ports open_approach and aim_end for a new curved arrow: when its head end is linked to an atom (not a lone pair or a
// bond) and its head or shaft touches the atom's bonds, that end goes round the atom (and the arc takes the bend for
// it) to where they clear, with the least extra gap. The other end and the side the arc bulges to stay. ink: the drawing
// as it is (its label boxes). Run once, on release.
export function aimHead<T extends Omit<Arrow, "id">>(m: Mol, a: T, ink: LinkInk, s: LinkStyle): T {
  const { start, end } = headsOf(a), which = end !== "none" ? "to" : start !== "none" ? "from" : undefined;
  const key = which === "to" ? "toLink" : "fromLink", link = which && a[key];
  if (!which || !link || "bond" in link.on || link.on.pair !== undefined || link.on.atom >= m.atoms.length) return a;
  const atom = link.on.atom, centre = at(m, atom), other = which === "to" ? a.from : a.to, bonds = bondsOf(m);
  const { segs, ways } = bondInk(m, atom, s);
  if (!segs.length) return a;
  const back = unit(sub(other, centre)), preferred = unit(link.dir), pen = penOf(a, s), gap = link.gap ?? LINK_GAP_PT;
  // The head lies along the arc's tangent at its end, so to come in along d the arc takes the bend that gives that
  // tangent from the other end (tangentOut the other way round). It keeps the side it bulges to, and at most a half
  // circle (sweep 180°). own: the arrow's own bend, for the way it was drawn.
  const most = 0.5, side = Math.sign(a.bend ?? 0);
  const bendFor = (p: P, d: P) => {
    const v = unit(sub(other, p)), phi = Math.atan2(crossZ(v, d), dot(v, d)), b = Math.tan((which === "to" ? -phi : phi) / 2) / 2;
    return Math.abs(b) > most || (side && b * side < 0) ? undefined : b;
  };
  const trial = (d: P, extra: number, own: boolean) => {
    const l: ArrowLink = { ...link, offset: [0, 0], dir: d, ...(extra ? { gap: gap + extra } : {}) };
    const p = resolveEnd(m, ink, s, l, pen, bonds)!, bend = own ? a.bend : bendFor(p, d);
    if (bend === undefined && !own) return undefined;
    const t = which === "to" ? { ...a, to: p, bend } : reverseOf({ ...a, from: p, bend });
    return { l, p, bend, hit: touches(t, segs, s) };
  };
  // The least extra gap (in eighths of one more gap) at which the head and shaft clear, or the head alone.
  const score = (d: P, own = false) => {
    let headOnly: { extra: number; l: ArrowLink; p: P; bend?: number } | undefined;
    const angle = Math.min(OPEN_APPROACH, ...ways.map((w) => Math.acos(Math.max(-1, Math.min(1, dot(w, d))))));
    for (let i = 0; i <= 8; i++) {
      const r = trial(d, (gap * i) / 8, own);
      if (!r) return undefined;
      if (!r.hit.head && !r.hit.shaft) return { clear: true, extra: (gap * i) / 8, l: r.l, p: r.p, bend: r.bend, angle };
      if (!r.hit.head && !headOnly) headOnly = { extra: (gap * i) / 8, l: r.l, p: r.p, bend: r.bend };
    }
    return headOnly ? { clear: false, ...headOnly, angle } : undefined;
  };
  const first = score(preferred, true);
  if (first?.clear && first.extra === 0) return a; // already clear
  type Best = NonNullable<ReturnType<typeof score>> & { turn: number };
  const better = (x: Best, y?: Best) => !y || (x.clear !== y.clear ? x.clear : Math.abs(x.extra - y.extra) > 1e-9 ? x.extra < y.extra : Math.abs(x.angle - y.angle) > 1e-4 ? x.angle > y.angle : x.turn < y.turn);
  let best: Best | undefined = first && { ...first, turn: 0 };
  const facing = Math.cos(OPEN_APPROACH) - 1e-4, step = Math.PI / 180;
  for (const sign of [1, -1]) {
    for (let k = 1; k <= 180; k++) {
      const d = turn(preferred, sign * k * step);
      // A side stops where it no longer faces the source.
      if (dot(d, back) < facing) break;
      const r = score(d);
      if (r && better({ ...r, turn: k }, best)) best = { ...r, turn: k };
    }
  }
  if (!best || best.turn === 0 && best.extra === 0) return a;
  return { ...a, [which]: best.p, [key]: best.l, ...(best.bend !== undefined ? { bend: best.bend } : {}) };
}
// An arrow the other way round, so its start's head is tested as an end's.
const reverseOf = <T extends Omit<Arrow, "id">>(a: T): T => ({ ...a, from: a.to, to: a.from, bend: -(a.bend ?? 0) });

// Ports validate (for a file's links): finite numbers, a direction that is not zero, a gap of 0 to 1000 pt, atom
// numbers in range, a bond's atoms in order with t in 0 to 1, and a mark key Octet knows.
export function readLink(x: unknown, atoms: number): ArrowLink | undefined {
  if (!x || typeof x !== "object") return undefined;
  const l = x as Record<string, unknown>, on = l.on as Record<string, unknown> | undefined;
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const pt = (v: unknown): v is P => Array.isArray(v) && v.length === 2 && v.every(num);
  const atom = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < atoms;
  if (!pt(l.offset) || !pt(l.dir) || len(l.dir) < 1e-5 || (l.gap !== undefined && !(num(l.gap) && l.gap >= 0 && l.gap <= 1000)) || !on || typeof on !== "object") return undefined;
  let target: ArrowTarget;
  if (on.bond !== undefined) {
    const b = on.bond;
    if (!Array.isArray(b) || b.length !== 2 || !atom(b[0]) || !atom(b[1]) || b[0] >= b[1] || !num(on.t) || on.t < 0 || on.t > 1) return undefined;
    target = { bond: [b[0], b[1]], t: on.t };
  } else {
    if (!atom(on.atom) || (on.pair !== undefined && !(typeof on.pair === "string" && PAIR_KEY.test(on.pair)))) return undefined;
    target = on.pair !== undefined ? { atom: on.atom, pair: on.pair as string } : { atom: on.atom };
  }
  return { on: target, offset: [l.offset[0], l.offset[1]], dir: [l.dir[0], l.dir[1]], ...(l.gap !== undefined ? { gap: l.gap as number } : {}) };
}
// A link as the file keeps it: numbers rounded as the rest of the file's.
export const writeLink = (l: ArrowLink, round: (x: number) => number) => ({ on: "bond" in l.on ? { bond: l.on.bond, t: round(l.on.t) } : l.on, offset: l.offset.map(round), dir: l.dir.map(round), ...(l.gap !== undefined ? { gap: round(l.gap) } : {}) });
