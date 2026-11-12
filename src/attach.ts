// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/model/src/templates.rs and src/app/template_library.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// A template put on the drawing at the template atom or bond the user chose (its anchor), and how it joins: Connect
// with a bond (a new single bond), Share an atom, or Fuse along a bond. Automatic is ChemDraw's click rule and Octet's
// addTemplate as it was: on an atom the template shares it, on a bond it fuses along it, on empty space it is centred
// there. A chosen anchor is never swapped for another atom silently: a join that cannot be made is refused with its
// reason, and the drawing stays as it was.
import { addTemplate, inRing, neighbours, nextDirection, pos, scaleAt, stampTemplate, type P } from "./edit.ts";
import { HBOND, hydrogens, orderOf, type Atom, type Bond, type Mol } from "./render.ts";
import { graphOf } from "./naming.ts";
import { iupacLocants } from "./namer.ts";

// The template atom or bond (indices into the template's own drawing) it attaches by; none is Automatic.
export type TemplateAnchor = { atom: number } | { bond: number };
export type TemplateMode = "auto" | "connect" | "share" | "fuse";
export type Attach = { anchor?: TemplateAnchor; mode?: TemplateMode };
// Where it goes: an atom or bond of the drawing, else a point. toward: where a drag from there was let go (the side or
// the direction, in 15° steps).
export type AttachTarget = Attach & { atom?: number; bond?: number; point?: P; toward?: P };
export type Attached = { mol: Mol; refusal?: undefined } | { mol?: undefined; refusal: string };

export const MODES: { mode: TemplateMode; name: string }[] = [
  { mode: "auto", name: "Automatic" }, { mode: "connect", name: "Connect with a bond" }, { mode: "share", name: "Share an atom" }, { mode: "fuse", name: "Fuse along a bond" },
];

const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P, k: number): P => [a[0] * k, a[1] * k];
const len = (a: P) => Math.hypot(a[0], a[1]);
const angle = (a: P) => Math.atan2(a[1], a[0]);
const rot = (a: P, t: number): P => [a[0] * Math.cos(t) - a[1] * Math.sin(t), a[0] * Math.sin(t) + a[1] * Math.cos(t)];
const cross = (a: P, b: P) => a[0] * b[1] - a[1] * b[0];
const STEP = Math.PI / 12; // 15°
const snap = (t: number) => Math.round(t / STEP) * STEP;
const at = (t: Mol, i: number): P => [t.atoms[i].location[0], t.atoms[i].location[1]];
const middle = (ps: P[]): P => mul(ps.reduce((s, p) => add(s, p), [0, 0] as P), 1 / (ps.length || 1));

// A template atom that stands for any atom (R, R1, X, A, Ar, *): it takes the drawing atom it joins.
const generic = (a: Atom) => !!a.text && /^(R\d*'*|X|A|Ar|\*)$/.test(a.text);
// A label that is the element with its hydrogens (OH, NH2, CH3), as typed: the atom is a plain atom. Any other typed
// label (OMe, Ph, Boc) is an abbreviation.
const plainText = (a: Atom) => !a.text || new RegExp(`^(H\\d*)?${a.label}(H\\d*)?$`).test(a.text);
// The bond orders an atom has (a hydrogen bond adds none).
const used = (m: Mol, i: number) => m.bonds.reduce((s, b) => s + (b.atoms.includes(i) && b.type !== HBOND ? orderOf(b.type) : 0), 0);
// How many more bonds an atom takes: its implicit hydrogens. An element whose valence Octet does not know takes none.
const free = (m: Mol, i: number) => { const a = m.atoms[i]; return hydrogens(a.label, a.charge ?? 0, used(m, i), a.radical ?? 0); };
const most = (a: Atom) => hydrogens(a.label, a.charge ?? 0, 0, a.radical ?? 0); // the bonds it has room for at most

// Why an atom cannot take `need` more bonds (ReShiki blocked): undefined when it can.
export function blocked(m: Mol, i: number, need = 1): string | undefined {
  const a = m.atoms[i];
  if (generic(a)) return undefined;
  const el = a.label;
  if (!plainText(a)) return `${a.text} is a label. Expand it first.`;
  if (a.radical) return `${el} has a radical.`;
  if (a.implicitHCount !== undefined) return `${el} has fixed hydrogens.`;
  if (free(m, i) < need - 1e-9) return `${el} has no free valence.`;
  return undefined;
}
// Whether a template atom and a drawing atom can become one atom (ReShiki compatible): the same element, charge and
// isotope, and no radical. A generic template atom takes any drawing atom.
export function compatible(ta: Atom, da: Atom): boolean {
  if (generic(ta)) return plainText(da);
  return ta.label === da.label && (ta.charge ?? 0) === (da.charge ?? 0) && ta.isotope === da.isotope && !ta.radical && !da.radical && plainText(da) && plainText(ta);
}
// A bond two structures can share: plain (no wedge, hash, wavy or bold), single, double or aromatic.
const plainBond = (b: Bond) => !b.stereo && (!b.display || (b.display as string) === "plain") && (b.type === 1 || b.type === 2 || b.type === 4);

// The directions (radians) a new bond can leave a template atom by (ReShiki connection_directions): the middle of its
// widest gaps between bonds. No bonds: to the right. One triple bond: straight on. One bond: 120° either way.
export function outwardDirections(m: Mol, i: number): number[] {
  const here = pos(m, i), dirs = m.bonds.filter((b) => b.atoms.includes(i) && b.type !== HBOND).map((b) => {
    const j = b.atoms[0] === i ? b.atoms[1] : b.atoms[0];
    return { t: angle(sub(pos(m, j), here)), order: b.type };
  });
  if (!dirs.length) return [0];
  if (dirs.length === 1) return dirs[0].order === 3 ? [dirs[0].t + Math.PI] : [dirs[0].t + (2 * Math.PI) / 3, dirs[0].t - (2 * Math.PI) / 3];
  const ts = dirs.map((d) => (d.t + 2 * Math.PI) % (2 * Math.PI)).sort((a, b) => a - b);
  const gaps = ts.map((t, k) => { const gap = (k + 1 < ts.length ? ts[k + 1] : ts[0] + 2 * Math.PI) - t; return { mid: t + gap / 2, gap }; });
  const widest = Math.max(...gaps.map((g) => g.gap));
  return gaps.filter((g) => widest - g.gap < 1e-4).map((g) => g.mid);
}

// How crowded new atoms are against the drawing's (ReShiki connection_score, Attachment::score): a steep cost for an
// atom nearer than `near` bond lengths to another, and a gentle one for every pair.
function crowding(m: Mol, placed: P[], scale: number, near: number, skip = new Set<number>()): number {
  let s = 0;
  placed.forEach((p, k) => {
    if (skip.has(k)) return;
    for (let i = 0; i < m.atoms.length; i++) {
      const d = len(sub(p, pos(m, i))) / scale;
      s += 1000 * Math.max(0, near - d) ** 2 + 0.05 / (d + 0.1) ** 2;
    }
  });
  return s;
}

// One way to put the template: where f takes its points, the template atoms that become drawing atoms (shared), and a
// new bond from a drawing atom to a template atom (connect).
type Pose = { f: (q: P) => P; scale: number; kz: number; mirrored: boolean; shared: Map<number, number>; connect?: [number, number]; score: number };

// The drawing atoms a join changes: each must keep within its valence.
function overValence(m: Mol, atoms: number[]): string | undefined {
  for (const i of atoms) {
    const a = m.atoms[i];
    if (generic(a) || !most(a)) continue;
    if (used(m, i) > most(a) + 1e-9) return `${a.label} would have too many bonds.`;
  }
  return undefined;
}

// The best pose that makes a sound structure: the drawing with the template in it, or the first reason.
function best(m: Mol, t: Mol, poses: Pose[], reason: string): Attached {
  if (!poses.length) return { refusal: reason };
  let first: string | undefined;
  for (const p of [...poses].sort((a, b) => a.score - b.score)) {
    const { mol: stamped, ids } = stampTemplate(m, t, p.f, { scale: p.scale, kz: p.kz, mirrored: p.mirrored, shared: p.shared });
    let mol = stamped;
    if (p.connect) {
      const [i, k] = p.connect, j = ids[k];
      if (i === j || mol.bonds.some((b) => b.atoms.includes(i) && b.atoms.includes(j))) { first ??= "The template would land on the drawing."; continue; }
      mol = { ...mol, bonds: [...mol.bonds, { type: 1, atoms: [i, j] }] };
    }
    const why = overValence(mol, [...p.shared.values(), ...(p.connect ? [p.connect[0]] : [])]);
    if (!why) return { mol };
    first ??= why;
  }
  return { refusal: first ?? reason };
}

// Share an atom: template atom s becomes drawing atom i. A template atom with one bond puts it exactly along the
// drawing atom's next bond direction; otherwise the template's middle goes that way (addTemplate's rule). With a drag,
// the template points at the pointer, in 15° steps.
function sharePoses(m: Mol, t: Mol, i: number, sources: number[], toward?: P): Pose[] {
  const here = pos(m, i), scale = scaleAt(m, i), aim = toward && len(sub(toward, here)) > 0.3 * scale ? snap(angle(sub(toward, here))) : undefined;
  return sources.map((s) => {
    const others = t.atoms.map((_, k) => k).filter((k) => k !== s), ns = neighbours(t, s);
    const v = ns.length === 1 && aim === undefined ? sub(at(t, ns[0]), at(t, s)) : sub(middle(others.map((k) => at(t, k))), at(t, s));
    const turn = len(v) > 1e-6 ? (aim ?? angle(nextDirection(m, i))) - angle(v) : 0, from = at(t, s);
    const f = (q: P) => add(here, mul(rot(sub(q, from), turn), scale));
    return { f, scale, kz: scale, mirrored: false, shared: new Map([[s, i]]), score: crowding(m, t.atoms.map((_, k) => f(at(t, k))), scale, 0.75, new Set([s])) };
  });
}

// Fuse along a bond: template bond e on drawing bond k, both ways round. The template goes on the side of the pointer
// after a drag, else on the open side (addTemplate's rule).
function fusePoses(m: Mol, t: Mol, k: number, edges: number[], toward?: P): Pose[] {
  const [i, j] = m.bonds[k].atoms, a = pos(m, i), b = pos(m, j), be = sub(b, a), scale = (scaleAt(m, i) + scaleAt(m, j)) / 2;
  const normal: P = mul([-be[1], be[0]], 1 / (len(be) || 1)), side = (p: P) => Math.sign(cross(be, sub(p, a)));
  const others = [...neighbours(m, i), ...neighbours(m, j)].filter((x) => x !== i && x !== j);
  const want = toward && Math.abs(cross(be, sub(toward, a))) / (len(be) || 1) > 0.15 * scale ? side(toward) : undefined;
  const poses: Pose[] = [];
  for (const e of edges) for (const [s1, s2] of [t.bonds[e].atoms, [t.bonds[e].atoms[1], t.bonds[e].atoms[0]]]) {
    if (!compatible(t.atoms[s1], m.atoms[i]) || !compatible(t.atoms[s2], m.atoms[j])) continue;
    const te = sub(at(t, s2), at(t, s1));
    if (len(te) < 1e-6 || len(be) < 1e-6) continue;
    const kk = len(be) / len(te), turn = angle(be) - angle(te), e0 = at(t, s1);
    const fused = (q: P) => add(a, mul(rot(sub(q, e0), turn), kk));
    const centre = middle(t.atoms.map((_, n) => fused(at(t, n))));
    const mirrored = want !== undefined ? side(centre) !== want : others.reduce((s, x) => s + side(pos(m, x)), 0) * side(centre) > 0;
    const f = mirrored ? (q: P) => { const p = fused(q); return sub(p, mul(normal, 2 * cross(be, sub(p, a)) / (len(be) || 1))); } : fused;
    poses.push({ f, scale, kz: kk * (mirrored ? -1 : 1), mirrored, shared: new Map([[s1, i], [s2, j]]), score: crowding(m, t.atoms.map((_, n) => f(at(t, n))), scale, 0.75, new Set([s1, s2])) });
  }
  return poses;
}

// Connect with a bond: a new single bond from drawing atom i, one bond length long (the atom's scale), along its next
// bond direction or the pointer's (15° steps); template atom s at its far end, turned so that one of its open sides
// faces back along the bond (exact 120° at a ring atom), the least crowded kept (ReShiki best_connection).
function connectPoses(m: Mol, t: Mol, i: number, sources: number[], toward?: P): Pose[] {
  const here = pos(m, i), scale = scaleAt(m, i), dir = toward && len(sub(toward, here)) > 0.3 * scale ? snap(angle(sub(toward, here))) : angle(nextDirection(m, i));
  const dest = add(here, mul([Math.cos(dir), Math.sin(dir)], scale));
  return sources.flatMap((s) => outwardDirections(t, s).map((out) => {
    const turn = dir + Math.PI - out, from = at(t, s);
    const f = (q: P) => add(dest, mul(rot(sub(q, from), turn), scale));
    return { f, scale, kz: scale, mirrored: false, shared: new Map<number, number>(), connect: [i, s] as [number, number], score: crowding(m, t.atoms.map((_, k) => f(at(t, k))), scale, 0.85) };
  }));
}

// A template placed with its anchor and join (see the top of this file). Without either it is addTemplate.
export function attachTemplate(m: Mol, t: Mol, target: AttachTarget): Attached {
  const mode = target.mode ?? "auto", anchor = validAnchor(t, target.anchor);
  const onAtom = target.atom !== undefined && target.atom < m.atoms.length, onBond = !onAtom && target.bond !== undefined && target.bond < m.bonds.length;
  if (!t.atoms.length || (mode === "auto" && !anchor)) return { mol: addTemplate(m, t, { ...(onBond ? { bond: target.bond } : onAtom ? { atom: target.atom } : {}), ...(target.point ? { point: target.point } : {}) }) };
  if (!onAtom && !onBond) {
    // Empty space: the anchor (an atom, or a bond's middle) lands on the point.
    if (!anchor) return { mol: addTemplate(m, t, { point: target.point ?? [0, 0] }) };
    const from = "atom" in anchor ? at(t, anchor.atom) : middle(t.bonds[anchor.bond].atoms.map((k) => at(t, k))), to = target.point ?? [0, 0];
    return { mol: stampTemplate(m, t, (q) => add(to, sub(q, from)), { scale: 1, kz: 1, mirrored: false }).mol };
  }
  const how = mode === "auto" ? (anchor && "bond" in anchor ? "fuse" : "share") : mode;
  if (how === "fuse" && !onBond) return { refusal: mode === "auto" ? "The chosen template bond joins a bond. Point to a bond." : "Fuse along a bond: point to a bond." };
  if (how !== "fuse" && !onAtom) return { refusal: mode === "auto" ? "The chosen template atom joins an atom. Point to an atom." : `${how === "connect" ? "Connect with a bond" : "Share an atom"}: point to an atom.` };
  if (how !== "fuse" && anchor && "bond" in anchor) return { refusal: "Choose a template atom for this join, or Fuse along a bond." };
  if (how === "fuse" && anchor && "atom" in anchor) return { refusal: "Choose a template bond to fuse along, or another join." };
  if (how === "fuse") {
    const k = target.bond!, bond = m.bonds[k];
    if (!plainBond(bond)) return { refusal: "Fuse along a plain single, double or aromatic bond." };
    const chosen = anchor && "bond" in anchor ? anchor.bond : undefined;
    if (chosen !== undefined && !plainBond(t.bonds[chosen])) return { refusal: "The chosen template bond is not a plain single, double or aromatic bond." };
    // Automatic within Fuse: every plain template bond, ring bonds first as addTemplate prefers them.
    const edges = chosen !== undefined ? [chosen] : t.bonds.map((_, e) => e).filter((e) => plainBond(t.bonds[e])).sort((x, y) => Number(inRing(t, y)) - Number(inRing(t, x)));
    const why = bond.atoms.map((i) => m.atoms[i]).find((a) => !plainText(a) || a.radical);
    if (why) return { refusal: why.text ? `${why.text} is a label. Expand it first.` : `${why.label} has a radical.` };
    return best(m, t, fusePoses(m, t, k, edges, target.toward), chosen !== undefined ? "The elements of the two bonds are not the same." : "No template bond matches this bond.");
  }
  const i = target.atom!;
  if (how === "share") {
    const chosen = anchor && "atom" in anchor ? anchor.atom : undefined;
    const sources = (chosen !== undefined ? [chosen] : t.atoms.map((_, k) => k)).filter((s) => compatible(t.atoms[s], m.atoms[i]));
    const need = chosen !== undefined ? used(t, chosen) : 1, why = blocked(m, i, need);
    if (why) return { refusal: why };
    if (!sources.length) return { refusal: chosen !== undefined ? `The chosen template atom (${t.atoms[chosen].text ?? t.atoms[chosen].label}) and ${m.atoms[i].text ?? m.atoms[i].label} are not the same element.` : `The template has no ${m.atoms[i].label} atom to share.` };
    return best(m, t, sharePoses(m, t, i, sources, target.toward), "No template atom fits here.");
  }
  // Connect with a bond.
  const why = blocked(m, i);
  if (why) return { refusal: why };
  const chosen = anchor && "atom" in anchor ? anchor.atom : undefined;
  if (chosen !== undefined && blocked(t, chosen)) return { refusal: `The chosen template atom: ${blocked(t, chosen)}` };
  const sources = chosen !== undefined ? [chosen] : t.atoms.map((_, k) => k).filter((k) => !blocked(t, k));
  if (!sources.length) return { refusal: "No template atom has a free valence." };
  return best(m, t, connectPoses(m, t, i, sources, target.toward), "The template has no room here.");
}

// An anchor that is in the template, else none (a damaged setting, or a template edited since).
export function validAnchor(t: Mol, a: TemplateAnchor | undefined): TemplateAnchor | undefined {
  if (!a || typeof a !== "object") return undefined;
  if ("atom" in a) return Number.isInteger(a.atom) && a.atom >= 0 && a.atom < t.atoms.length ? { atom: a.atom } : undefined;
  if ("bond" in a) return Number.isInteger(a.bond) && a.bond >= 0 && a.bond < t.bonds.length ? { bond: a.bond } : undefined;
  return undefined;
}
// A join read from the settings: only the modes Octet has, an anchor only when it is in the template.
export function readAttach(t: Mol, v: unknown): Attach | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Attach, mode = MODES.some((x) => x.mode === o.mode) && o.mode !== "auto" ? o.mode : undefined, anchor = validAnchor(t, o.anchor);
  return mode || anchor ? coupled({ ...(mode ? { mode } : {}), ...(anchor ? { anchor } : {}) }) : undefined;
}

// The anchor and join kept together (ReShiki template_library.rs, set mode and anchor): Fuse takes a bond, Connect and
// Share an atom, so a mode clears an anchor of the other kind; a bond chosen while Connect or Share is on switches to
// Fuse, an atom chosen while Fuse is on switches to Connect.
export function chooseMode(a: Attach, mode: TemplateMode): Attach {
  const anchor = a.anchor && ((mode === "fuse" && "atom" in a.anchor) || ((mode === "connect" || mode === "share") && "bond" in a.anchor)) ? undefined : a.anchor;
  return { ...(mode !== "auto" ? { mode } : {}), ...(anchor ? { anchor } : {}) };
}
export function chooseAnchor(a: Attach, anchor: TemplateAnchor | undefined): Attach {
  const mode = anchor && "bond" in anchor && (a.mode === "connect" || a.mode === "share") ? "fuse" : anchor && "atom" in anchor && a.mode === "fuse" ? "connect" : a.mode;
  return { ...(mode && mode !== "auto" ? { mode } : {}), ...(anchor ? { anchor } : {}) };
}
const coupled = (a: Attach): Attach => (a.anchor ? chooseAnchor(a, a.anchor) : a);

// Each template atom's number as Octet's namer numbers the structure (Show Atom Numbers: "9" in 9H-purin-6-amine),
// undefined where it has none.
// A sugar (a pyranose or furanose: one ring O, the ring carbons bearing OH) is numbered as carbohydrates are (C-1 the
// anomeric carbon, or C-2 in a ketose whose C-1 is its CH2OH), not as its oxane or oxolane name would number it.
const locantsKept = new WeakMap<Mol, (string | undefined)[]>();
export function sugarLocants(t: Mol): (string | undefined)[] | undefined {
  const el = (i: number) => t.atoms[i].label, ns = (i: number) => neighbours(t, i);
  const ring = t.bonds.map((_, k) => k).filter((k) => inRing(t, k)), inR = new Set(ring.flatMap((k) => t.bonds[k].atoms));
  const ringO = [...inR].filter((i) => el(i) === "O");
  if (ringO.length !== 1 || ![5, 6].includes(inR.size) || [...inR].some((i) => el(i) !== "C" && el(i) !== "O")) return undefined;
  const o = ringO[0], outside = (i: number, e: string) => ns(i).filter((j) => !inR.has(j) && el(j) === e);
  if ([...inR].filter((i) => outside(i, "O").length).length < 2) return undefined;
  const anomeric = ns(o).filter((i) => inR.has(i) && outside(i, "O").length);
  if (!anomeric.length) return undefined;
  const a = anomeric.sort((x, y) => outside(y, "C").length - outside(x, "C").length)[0], ketose = outside(a, "C").length > 0;
  const l: (string | undefined)[] = t.atoms.map(() => undefined);
  let n = ketose ? 2 : 1;
  if (ketose) l[outside(a, "C")[0]] = "1";
  // Round the ring from the anomeric carbon away from the ring O, then out along the last carbon's chain.
  let prev = o, at = a, last = a;
  while (at !== o && l[at] === undefined) {
    l[at] = String(n++);
    last = at;
    const next = ns(at).find((j) => inR.has(j) && j !== prev);
    if (next === undefined) return undefined;
    [prev, at] = [at, next];
  }
  for (let c = outside(last, "C")[0], from = last; c !== undefined && l[c] === undefined; ) {
    l[c] = String(n++);
    const next = ns(c).find((j) => j !== from && el(j) === "C" && l[j] === undefined);
    [from, c] = [c, next!];
  }
  l[o] = l[last];
  t.atoms.forEach((_, i) => { if (el(i) === "O" && i !== o) { const c = ns(i).find((j) => l[j] !== undefined && el(j) === "C"); if (c !== undefined) l[i] = l[c]; } });
  return l;
}
export function templateLocants(t: Mol): (string | undefined)[] {
  let l = locantsKept.get(t);
  if (!l) {
    const g = t.atoms.length && t.atoms.length <= 200 ? graphOf(t) : undefined;
    l = sugarLocants(t) ?? (g && iupacLocants(g)) ?? t.atoms.map(() => undefined);
    locantsKept.set(t, l);
  }
  return l;
}
// An atom's name in the picker: N-9 from its locant, else "atom 4 (N)" by its place in the template.
export function atomName(t: Mol, i: number): string {
  const a = t.atoms[i], l = templateLocants(t)[i], el = a.text ?? a.label;
  return l ? `${el}-${l}` : `atom ${i + 1} (${el})`;
}
// What the picker shows (ReShiki anchor_label): "Attach at N-9", "Attach at C-2–C-3", or Automatic attachment.
export function anchorLabel(t: Mol, a: TemplateAnchor | undefined): string {
  const anchor = validAnchor(t, a);
  if (!anchor) return "Automatic attachment";
  if ("atom" in anchor) return `Attach at ${atomName(t, anchor.atom)}`;
  const [i, j] = t.bonds[anchor.bond].atoms, l = templateLocants(t);
  if (l[i] && l[j]) return `Attach at ${atomName(t, i)}–${atomName(t, j)}`;
  return `Attach at bond ${i + 1}–${j + 1}`;
}
