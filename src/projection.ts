// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/model/src/stereochemistry.rs, crates/model/src/fischer.rs
// and crates/io/src/engine/native_fischer.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
//
// Stereo projection tools: Invert Configuration Here, Convert to Fischer Projection and Convert to Wedge Drawing.
// ReShiki marks Fischer bonds and stores each centre's winding; Octet keeps the configuration in the atoms' depth (a
// Fischer projection's chain lies back, its horizontal arms come forward, as Octet's Fischer templates), so the rules
// and refusals are ReShiki's and the data model is Octet's. A turn on the page keeps the depth, so it never changes a
// configuration; a Fischer projection turned off its axes is simply no longer read as one (fischerCross).
import { HBOND, hydrogens, orderOf, type Atom, type Bond, type Mol } from "./render.ts";
import { handIn, keptHolds, stereoMarks } from "./cip.ts";
import { cipOf, cleanUp, expandWithOrigins, toInchi, wedgesFrom } from "./chem.ts";
import { deleteAtoms, flattenAtoms, fragments, perspectiveBonds } from "./edit.ts";

export type Result = { mol: Mol; error?: undefined } | { error: string; mol?: undefined };
const fail = (error: string): Result => ({ error });

export const INVERT_SELECT = "Select one atom with a defined configuration.";
export const INVERT_DONE = "Configuration inverted. Undo restores the original.";
const RECONNECTS = "A group on this atom joins the ring or chain again. Octet cannot move it safely.";
const JOINED = "The groups on this atom are joined. Octet cannot move them safely.";
const FUSED = "This atom is in more than one ring. Octet cannot invert it in a drawing with depth.";
const UNSAFE = "Octet cannot invert this atom and keep the other stereocentres. The drawing is not changed.";
export const FISCHER_SELECT = "Select one structure to convert to a Fischer projection.";
export const FISCHER_KIND = "A Fischer projection needs one acyclic structure with its stereocentres on the longest carbon chain and no E/Z double bond.";
const FISCHER_KEEP = "Octet cannot keep the configuration in a Fischer projection. The drawing is not changed.";
export const WEDGE_SELECT = "Select a Fischer projection or another structure drawn with depth.";
const WEDGE_KEEP = "Octet cannot keep the configuration in a wedge drawing. The drawing is not changed.";

type V3 = [number, number, number];
const loc = (m: Mol, i: number): V3 => [m.atoms[i].location[0], m.atoms[i].location[1], m.atoms[i].location[2] ?? 0];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 | undefined => { const l = Math.hypot(...a); return l > 1e-3 ? [a[0] / l, a[1] / l, a[2] / l] : undefined; };
// The atoms bonded to i (hydrogen bonds left out).
const near = (m: Mol, i: number) => m.bonds.flatMap((b) => (b.type !== HBOND && b.atoms[0] !== b.atoms[1] && b.atoms.includes(i) ? [b.atoms[0] === i ? b.atoms[1] : b.atoms[0]] : []));
const defined = (c?: string) => !!c && /^[RSrs]$/.test(c);
// Is the bond from i to j in a ring (its ends joined without it)?
function inRing(m: Mol, i: number, j: number): boolean {
  const seen = new Set([i]), next = near(m, i).filter((k) => k !== j);
  next.forEach((k) => seen.add(k));
  while (next.length) {
    const k = next.pop()!;
    if (k === j) return true;
    for (const l of near(m, k)) if (!seen.has(l)) { seen.add(l); next.push(l); }
  }
  return false;
}
// The atoms of the branch from centre through root (stereochemistry.rs branch): undefined when it reaches an atom
// that stays (it joins the ring or chain again).
function branchOf(m: Mol, centre: number, root: number, stay: Set<number>): Set<number> | undefined {
  const seen = new Set<number>(), stack = [root];
  while (stack.length) {
    const j = stack.pop()!;
    if (stay.has(j)) return undefined;
    if (seen.has(j)) continue;
    seen.add(j);
    for (const k of near(m, j)) if (k !== centre && !seen.has(k)) stack.push(k);
  }
  return seen;
}
// A centre's neighbours in a fixed order (-1 for the implicit H of an atom with three) and its hand in that order.
function handOf(m: Mol, i: number): { order: number[]; hand?: "R" | "S" } {
  const order = near(m, i).sort((p, q) => p - q);
  if (order.length === 3) order.push(-1);
  return { order, hand: handIn(m, i, order) };
}

// ---- Fischer projections (fischer.rs) ----

// A Fischer cross at atom c: four plain single bonds, each within 10° of a page axis, one each way (y up), the two
// horizontal arms in front of the centre and the two vertical ones not. A flat cross (no depth), or one turned off its
// axes, is no Fischer centre.
export type Cross = { centre: number; up: number; right: number; down: number; left: number };
const AXIS = Math.tan((10 * Math.PI) / 180);
export function fischerCross(m: Mol, c: number): Cross | undefined {
  const bonds = m.bonds.filter((b) => b.type !== HBOND && b.atoms.includes(c));
  if (bonds.length !== 4 || !m.atoms[c]) return undefined;
  const slot: (number | undefined)[] = [undefined, undefined, undefined, undefined];
  for (const b of bonds) {
    if (b.type !== 1 || b.stereo || b.display) return undefined;
    const j = b.atoms[0] === c ? b.atoms[1] : b.atoms[0], [dx, dy, dz] = sub(loc(m, j), loc(m, c));
    if (!dx && !dy) return undefined;
    const axis = Math.abs(dx) <= Math.abs(dy) * AXIS ? (dy > 0 ? 0 : 2) : Math.abs(dy) <= Math.abs(dx) * AXIS ? (dx > 0 ? 1 : 3) : -1;
    if (axis < 0 || slot[axis] !== undefined) return undefined;
    if (axis % 2 ? dz < 0.1 : dz > 0.05) return undefined;
    slot[axis] = j;
  }
  const [up, right, down, left] = slot as number[];
  return { centre: c, up, right, down, left };
}
// Every Fischer centre among some atoms (all, if none are given).
export const fischerCrosses = (m: Mol, ids?: Set<number>): Cross[] => m.atoms.flatMap((_, c) => { const x = !ids?.size || ids.has(c) ? fischerCross(m, c) : undefined; return x ? [x] : []; });

// ---- Invert Configuration Here (stereochemistry.rs invert_configuration) ----

// Atom i's configuration inverted, its drawing convention kept: a centre drawn with wedges has its wedges turned the
// other way; a centre drawn in depth (Fischer, Haworth, chair, 3D) has its groups off the chain or ring turned half a
// turn about the line that halves them, so each takes the other's place (a Fischer projection's horizontal arms, a
// ring atom's up and down groups; one group and an implicit H: the group goes where the H was); a configuration kept
// from a ChemDraw file has two of its neighbours swapped. A half turn is no reflection, so every other stereocentre
// keeps its configuration: Octet checks that only atom i's hand changed, or changes nothing.
export function invertAt(m: Mol, i: number): Result {
  const a = m.atoms[i], ns = a ? near(m, i) : [];
  if (!a || ns.length < 3 || ns.length > 4) return fail(INVERT_SELECT);
  let cip: (string | undefined)[];
  try { cip = cipOf(m).atoms; } catch { return fail(INVERT_SELECT); }
  if (!defined(cip[i])) return fail(INVERT_SELECT);
  const before = new Map(cip.flatMap((c, j) => (defined(c) ? [[j, handOf(m, j)] as const] : [])));
  if (!before.get(i)?.hand) return fail(UNSAFE);
  const persp = perspectiveBonds(m), z = (j: number) => loc(m, j)[2];
  const kept = a.kept && keptHolds(m, i, a.kept) ? a.kept : undefined;
  const depth = ns.some((j) => Math.abs(z(j) - z(i)) >= 0.2);
  const marks = m.bonds.flatMap((b, k) => (b.atoms[0] === i && (b.stereo === 1 || b.stereo === 6 || b.display === "hollow") && !persp.has(k) ? [k] : []));
  const others = m.bonds.flatMap((b, k) => (b.type === 1 && !b.stereo && b.atoms.includes(i) && !persp.has(k) && (b.display === "hashed" || b.display === "dashed" || (b.display === "bold" && !inRing(m, b.atoms[0], b.atoms[1]))) ? [k] : []));
  let out: Mol | string;
  if (depth || (kept && !marks.length && ns.filter((j) => inRing(m, i, j)).length === 2)) out = turnGroups(m, i, ns);
  else if (marks.length || others.length) out = turnMarks(m, i, marks.length ? marks : others);
  else if (kept) out = m;
  else return fail(INVERT_SELECT);
  if (typeof out === "string") return fail(out);
  if (kept) {
    const atoms = [kept.atoms[1], kept.atoms[0], kept.atoms[2], kept.atoms[3]];
    out = { ...out, atoms: out.atoms.map((x, j) => (j === i ? { ...x, kept: { atoms, marks: stereoMarks(out as Mol, i, atoms) } } : x)) };
  }
  // Only atom i's hand changes.
  for (const [j, { order, hand }] of before) {
    if (!hand) continue;
    const now = handIn(out, j, order);
    if (j === i ? !now || now === hand : now !== hand) return fail(UNSAFE);
  }
  return { mol: out };
}

// Wedges at the centre turned the other way: wedge ⇄ hash, a hollow wedge to a hashed bond and back, a bold bond to a
// hash (stereochemistry.rs invert_mark). Each bond is drawn from the centre.
function turnMarks(m: Mol, i: number, ks: number[]): Mol {
  const bonds = m.bonds.map((b, k): Bond => {
    if (!ks.includes(k)) return b;
    const atoms: [number, number] = b.atoms[0] === i ? b.atoms : [b.atoms[1], b.atoms[0]];
    if (b.display === "hollow") return { ...b, atoms, display: "hashed", stereo: undefined };
    if (b.stereo === 1 || b.stereo === 6) return { ...b, atoms, stereo: b.stereo === 1 ? 6 : 1 };
    if (b.display === "hashed" || b.display === "dashed") return { ...b, atoms, display: "hollow", stereo: undefined };
    return { ...b, atoms, display: undefined, stereo: 6 };
  });
  return { ...m, bonds };
}

// A depth centre's groups that are not on its chain or ring, turned half a turn about the line through the centre
// that halves them.
function turnGroups(m: Mol, i: number, ns: number[]): Mol | string {
  const cross = fischerCross(m, i), z = (j: number) => loc(m, j)[2];
  let stay: number[];
  if (cross) stay = [cross.up, cross.down];
  else {
    const ring = ns.filter((j) => inRing(m, i, j));
    if (ring.length > 2) return FUSED;
    if (ring.length === 2) stay = ring;
    else {
      // Off a ring: the two atoms lying clearly furthest back (a Fischer projection turned on the page), else the two
      // largest groups.
      const back = [...ns].sort((p, q) => z(p) - z(q));
      if (ns.length === 4 && z(back[1]) + 0.2 <= z(back[2])) stay = back.slice(0, 2);
      else {
        const size = (j: number) => branchOf(m, i, j, new Set())?.size ?? 0;
        stay = [...ns].sort((p, q) => size(q) - size(p) || z(p) - z(q)).slice(0, 2);
      }
    }
  }
  const moved = ns.filter((j) => !stay.includes(j));
  if (!moved.length || moved.length > 2 || (moved.length === 1 && ns.length !== 3)) return INVERT_SELECT;
  const keep = new Set([i, ...stay]), parts = moved.map((r) => branchOf(m, i, r, keep));
  if (parts.some((p) => !p)) return RECONNECTS;
  const all = new Set<number>();
  for (const p of parts as Set<number>[]) for (const j of p) { if (all.has(j)) return JOINED; all.add(j); }
  const c = loc(m, i), v = (j: number) => unit(sub(loc(m, j), c));
  const [p, q] = (moved.length === 2 ? moved : stay).map(v);
  const sum = p && q ? unit(add(p, q)) : undefined, u = sum && (moved.length === 2 ? sum : ([-sum[0], -sum[1], -sum[2]] as V3));
  if (!u) return UNSAFE;
  // A turn about a line in the page draws the groups mirrored, so their own wedges turn round with them; a label's side
  // swaps where its group is mirrored left to right (or top to bottom).
  const inPage = Math.abs(u[2]) < 0.5, flipX = 2 * u[0] * u[0] - 1 < 0, flipY = 2 * u[1] * u[1] - 1 < 0;
  const side: Partial<Record<NonNullable<Atom["align"]>, Atom["align"]>> = { ...(flipX ? { left: "right", right: "left" } : {}), ...(flipY ? { above: "below", below: "above" } : {}) };
  const atoms = m.atoms.map((a, j): Atom => {
    if (!all.has(j)) return a;
    const d = sub(loc(m, j), c), t = 2 * dot(u, d);
    return { ...a, location: [c[0] + t * u[0] - d[0], c[1] + t * u[1] - d[1], c[2] + t * u[2] - d[2]], ...(a.align && side[a.align] ? { align: side[a.align] } : {}) };
  });
  const bonds = !inPage ? m.bonds : m.bonds.map((b) => (all.has(b.atoms[0]) && all.has(b.atoms[1]) && (b.stereo === 1 || b.stereo === 6) ? { ...b, stereo: b.stereo === 1 ? 6 : 1 } : b));
  return { ...m, atoms, bonds };
}

// ---- Convert to Fischer Projection (native_fischer.rs to_fischer) ----

// The selected structure (one, acyclic, every stereocentre on its longest carbon chain and none at its ends, no E or
// Z double bond) drawn as a Fischer projection: the chain vertical, one bond apart, its more oxidised end at the top,
// centred where the structure was; each group off the chain moved whole beside its chain atom, the horizontal ones in
// front (depth 0.5) of the chain (depth 0); an explicit H on each stereocentre that had an implicit one; left and right
// chosen so each centre keeps its configuration. Accepted only when the InChI is unchanged.
export function toFischer(m: Mol, ids: Set<number>): Result {
  const frags = fragments(m).filter((g) => !ids.size || g.some((i) => ids.has(i)));
  if (frags.length !== 1) return fail(FISCHER_SELECT);
  const F = frags[0], inF = new Set(F), own = m.bonds.filter((b) => b.type !== HBOND && inF.has(b.atoms[0]));
  if (own.length + 1 !== F.length || F.some((i) => m.atoms[i].centre || m.atoms[i].attach || m.atoms[i].bead)) return fail(FISCHER_KIND);
  let cip: { atoms: (string | undefined)[]; bonds: (string | undefined)[] }, x: Mol, from: number[], inchi: string | undefined;
  try { cip = cipOf(m); ({ mol: x, from } = expandWithOrigins(m)); inchi = toInchi(m); } catch { return fail(FISCHER_KIND); }
  if (!inchi || m.bonds.some((b, k) => inF.has(b.atoms[0]) && cip.bonds[k])) return fail(FISCHER_KIND);
  const centres = F.filter((i) => defined(cip.atoms[i]));
  if (!centres.length) return fail(FISCHER_KIND);
  // The longest carbon chain (native_fischer.rs longest_carbon_chain): from any carbon its farthest carbon, then that
  // one's farthest, for each set of joined carbons.
  const carbon = (i: number) => m.atoms[i].label === "C";
  const far = (s: number) => {
    const parent = new Map<number, number>([[s, -1]]), queue = [s];
    for (let k = 0; k < queue.length; k++) for (const j of near(m, queue[k])) if (carbon(j) && !parent.has(j)) { parent.set(j, queue[k]); queue.push(j); }
    return { end: queue[queue.length - 1], parent, seen: queue };
  };
  let chain: number[] = [];
  const done = new Set<number>();
  for (const s of F) {
    if (!carbon(s) || done.has(s)) continue;
    const a = far(s);
    a.seen.forEach((j) => done.add(j));
    const b = far(a.end), path = [b.end];
    while (path[path.length - 1] !== a.end) path.push(b.parent.get(path[path.length - 1])!);
    if (path.length > chain.length) chain = path;
  }
  if (chain.length < 3) return fail(FISCHER_KIND);
  // The more oxidised end on top: the bond orders from its carbon to atoms other than C and H (a written label read).
  const oxidation = (i: number) => {
    const k = from.indexOf(i);
    return x.bonds.reduce((s, b) => { if (b.type === HBOND || !b.atoms.includes(k)) return s; const o = x.atoms[b.atoms[0] === k ? b.atoms[1] : b.atoms[0]].label; return o === "C" || o === "H" ? s : s + orderOf(b.type); }, 0);
  };
  if (oxidation(chain[0]) < oxidation(chain[chain.length - 1])) chain.reverse();
  const onChain = new Set(chain), n = chain.length;
  if (centres.some((c) => !onChain.has(c) || c === chain[0] || c === chain[n - 1] || m.atoms[c].text)) return fail(FISCHER_KIND);
  const bondAt = (p: number, q: number) => m.bonds.find((b) => b.type !== HBOND && b.atoms.includes(p) && b.atoms.includes(q));
  if (chain.some((c, k) => k && bondAt(chain[k - 1], c)?.type !== 1) || centres.some((c) => near(m, c).some((j) => bondAt(c, j)?.type !== 1))) return fail(FISCHER_KIND);
  const was = new Map(centres.map((c) => [c, handOf(m, c)]));
  if ([...was.values()].some((h) => !h.hand)) return fail(FISCHER_KEEP);

  // The drawing without its stereo bonds or kept configurations (the depth will hold them), and an H on each centre
  // with an implicit one.
  const base: Mol = {
    ...m,
    atoms: m.atoms.map((a, i) => { if (!inF.has(i) || !a.kept) return a; const { kept: _, ...rest } = a; return rest; }),
    bonds: m.bonds.map((b) => { if (!inF.has(b.atoms[0])) return b; const { stereo: _, ...rest } = b; return rest.display && ["hashed", "bold", "hollow", "dashed", "wavy"].includes(rest.display) ? { ...rest, display: undefined } : rest; }),
  };
  const addedH = new Map<number, number>();
  for (const c of centres) {
    if (near(m, c).length !== 3) continue;
    const used = near(m, c).length, h = hydrogens(m.atoms[c].label, m.atoms[c].charge ?? 0, used, m.atoms[c].radical);
    if (h !== 1 && m.atoms[c].implicitHCount !== 1) return fail(FISCHER_KIND);
    addedH.set(c, base.atoms.length);
    base.atoms.push({ label: "H", location: loc(m, c) });
    base.bonds.push({ type: 1, atoms: [c, base.atoms.length - 1] });
  }
  const sides = new Map(centres.map((c) => [c, near(base, c).filter((j) => !onChain.has(j))]));
  const [cx, cy] = [0, 1].map((d) => F.reduce((s, i) => s + m.atoms[i].location[d], 0) / F.length);
  const layout = (): Mol => {
    const atoms = base.atoms.map((a) => ({ ...a, location: [...a.location] as V3 }));
    // A group moved whole: its root to `to`, the rest with it.
    const move = (root: number, parent: number, to: V3) => {
      const d = sub(to, loc(base, root)), stack: [number, number][] = [[root, parent]];
      while (stack.length) {
        const [j, p] = stack.pop()!;
        atoms[j].location = add(loc(base, j), d);
        for (const k of near(base, j)) if (k !== p) stack.push([k, j]);
      }
    };
    chain.forEach((id, k) => {
      const at: V3 = [cx, cy + (n - 1) / 2 - k, 0];
      atoms[id].location = at;
      const groups = sides.get(id) ?? near(base, id).filter((j) => !onChain.has(j));
      groups.forEach((g, gi) => {
        const end = k === 0 || k === n - 1, dy = k === 0 ? 0.6 : -0.6;
        const to: V3 = end ? (gi < 2 ? [at[0] + (gi ? 0.8 : -0.8), at[1] + dy, 0] : [at[0], at[1] + (k === 0 ? 1 : -1), 0]) : [at[0] + (gi ? 1 : -1), at[1], 0.5];
        move(g, id, to);
      });
    });
    return { ...base, atoms };
  };
  if (chain.some((id, k) => k && k < n - 1 && near(base, id).filter((j) => !onChain.has(j)).length > 2)) return fail(FISCHER_KIND);
  const wrong = (out: Mol) => centres.filter((c) => { const h = was.get(c)!; return handIn(out, c, h.order.map((j) => (j < 0 ? addedH.get(c)! : j))) !== h.hand; });
  let out = layout();
  for (const c of wrong(out)) sides.set(c, [...sides.get(c)!].reverse());
  out = layout();
  if (wrong(out).length || toInchi(out) !== inchi) return fail(FISCHER_KEEP);
  return { mol: out };
}

// ---- Convert to Wedge Drawing (native_fischer.rs wedge_request) ----

// The selected structures drawn with depth (Fischer projections, and Haworth, chair or 3D drawings), or all of them,
// drawn flat with wedges: each stereocentre's plain H drawn for the projection taken away, the structure flattened and
// cleaned up (Clean Up Structure), and one wedge or hash on each stereocentre where Octet puts them on a SMILES import,
// with the hand the depth gave. Accepted only when the InChI is unchanged.
export function toWedges(m: Mol, ids: Set<number>): Result {
  const frags = fragments(m).filter((g) => (!ids.size || g.some((i) => ids.has(i))) && g.some((i) => Math.abs(m.atoms[i].location[2] ?? 0) > 1e-6));
  if (!frags.length) return fail(WEDGE_SELECT);
  let cip: (string | undefined)[], inchi: string | undefined;
  try { cip = cipOf(m).atoms; inchi = toInchi(m); } catch { return fail(WEDGE_KEEP); }
  const inF = new Set(frags.flat()), centres = [...inF].filter((i) => defined(cip[i]));
  if (!inchi) return fail(WEDGE_KEEP);
  const plainH = (j: number) => { const a = m.atoms[j], b = m.bonds.filter((x) => x.atoms.includes(j)); return a.label === "H" && !a.text && !a.isotope && !a.charge && b.length === 1 && b[0].type === 1 && !b[0].stereo && !b[0].display; };
  const drop = new Set<number>();
  for (const c of centres) { const h = near(m, c).find(plainH); if (h !== undefined && near(m, c).length === 4) drop.add(h); }
  const gone = [...drop].sort((p, q) => p - q), to = (i: number) => i - gone.filter((g) => g < i).length;
  // Stereo bonds and kept configurations in these structures go: the depth holds the configuration.
  const bare: Mol = {
    ...m,
    atoms: m.atoms.map((a, i) => { if (!inF.has(i) || !a.kept) return a; const { kept: _, ...rest } = a; return rest; }),
    bonds: m.bonds.map((b) => { if (!inF.has(b.atoms[0])) return b; const { stereo: _, ...rest } = b; return rest.display && ["hashed", "bold", "hollow", "dashed"].includes(rest.display) ? { ...rest, display: undefined } : rest; }),
  };
  const deep = drop.size ? deleteAtoms(bare, drop) : bare, keep = new Set([...inF].filter((i) => !drop.has(i)).map(to));
  // The hands are read with each removed H's place (a Fischer centre lies in the plane of its chain and one arm, so
  // the centre itself cannot stand in for its H).
  const hs = new Map(centres.flatMap((c) => { const h = near(m, c).find((j) => drop.has(j)); return h === undefined ? [] : [[to(c), m.atoms[h].location] as const]; }));
  let out: Mol;
  try { out = wedgesFrom(cleanUp(flattenAtoms(deep, keep), keep), deep, centres.map(to), hs); } catch { return fail(WEDGE_KEEP); }
  return toInchi(out) === inchi ? { mol: out } : fail(WEDGE_KEEP);
}
