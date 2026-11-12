// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/model/src/atom_labels/dl_descriptors.rs,
// crates/model/src/atom_labels/steroid.rs and crates/model/src/chemistry/stereo_lint.rs, MIT OR Apache-2.0,
// © 2026 Ameyanagi and ReShiki contributors. (steroid α/β order: OPSIN, MIT, © 2017 Daniel Lowe.)
//
// Names Show Stereochemistry can add beside a stereocentre's R or S (Settings > Drawing > Stereochemistry): D and L on
// α-amino acids and sugars, the steroid nucleus's α and β in place of R and S, and a mark on a centre whose
// configuration the drawing does not set. ReShiki reads them from each centre's stored parity; Octet reads each hand
// from the drawing (cip.ts handIn), so a Fischer, Haworth, chair or wedge drawing gives the same name, however it is
// turned on the page.
import { AROMATIC, HBOND, hydrogens, orderOf, type Mol } from "./render.ts";
import { cipLabels, handIn, stereoMarks } from "./cip.ts";
import { expandWithOrigins, stereoFacts } from "./chem.ts";

export type NameOptions = { dl?: boolean; steroid?: boolean; unset?: "" | "?" | "Ξ" };
// For each drawn atom: its D or L, its steroid locant and face (3β), or its undefined mark (?, Ξ, ξ).
export type StereoNames = { dl: Map<number, "D" | "L">; steroid: Map<number, string>; unset: Map<number, "?" | "Ξ" | "ξ"> };

// The expanded structure as a graph: each atom's neighbours (bond order), and its hydrogens (implicit and drawn).
type G = { m: Mol; adj: { to: number; order: number }[][]; h: number[] };
function graph(m: Mol): G {
  const adj: G["adj"] = m.atoms.map(() => []), used = m.atoms.map(() => 0);
  for (const b of m.bonds) {
    const [i, j] = b.atoms;
    if (b.type === HBOND || i === j || !m.atoms[i] || !m.atoms[j]) continue;
    adj[i].push({ to: j, order: b.type === AROMATIC ? 1.5 : orderOf(b.type) });
    adj[j].push({ to: i, order: b.type === AROMATIC ? 1.5 : orderOf(b.type) });
    used[i] += orderOf(b.type); used[j] += orderOf(b.type);
  }
  const h = m.atoms.map((a, i) => (a.implicitHCount ?? hydrogens(a.label, a.charge ?? 0, used[i], a.radical === 1 ? 1 : a.radical ? 2 : 0)) + adj[i].filter((e) => isH(m, e.to)).length);
  return { m, adj, h };
}
const isH = (m: Mol, i: number) => m.atoms[i].label === "H" && !m.atoms[i].text;
const el = (g: G, i: number) => g.m.atoms[i].label;
// A centre's hand in the order given, its one H (drawn or implicit) last.
function hand(g: G, c: number, order: number[]): "R" | "S" | undefined {
  const hs = g.adj[c].filter((e) => isH(g.m, e.to)).map((e) => e.to);
  if (g.h[c] !== 1 || hs.length > 1) return undefined;
  return handIn(g.m, c, [...order, hs[0] ?? -1]);
}

// ---- D and L (dl_descriptors.rs) ----

// C(=O)X with X not carbon (an acid, ester, amide or aldehyde; not a ketone).
const carbonyl = (g: G, i: number, centre: number) => el(g, i) === "C" && g.adj[i].some((e) => e.order === 2 && el(g, e.to) === "O") && !g.adj[i].some((e) => e.to !== centre && el(g, e.to) === "C");
// An α-amino acid's Cα: one H, single bonds to one N and two C, one of them a carbonyl. L when, with N, the carbonyl C
// and the side chain in that order, the hand is S (L-alanine is S; L-cysteine, whose side chain ranks higher, is R).
function aminoAcid(g: G, c: number): "D" | "L" | undefined {
  const heavy = g.adj[c].filter((e) => !isH(g.m, e.to));
  if (el(g, c) !== "C" || g.h[c] !== 1 || heavy.length !== 3 || heavy.some((e) => e.order !== 1)) return undefined;
  const n = heavy.filter((e) => el(g, e.to) === "N"), cs = heavy.filter((e) => el(g, e.to) === "C");
  if (n.length !== 1 || cs.length !== 2) return undefined;
  const co = cs.filter((e) => carbonyl(g, e.to, c));
  if (co.length !== 1) return undefined;
  const side = cs.find((e) => e !== co[0])!.to, h = hand(g, c, [n[0].to, co[0].to, side]);
  return h && (h === "S" ? "L" : "D");
}
// A sugar's configurational carbon (its highest-numbered stereocentre) as its O, the carbon towards C-1 and the carbon
// away from it: D when, in that order, the hand is R (D-glyceraldehyde's, with the OH on the right of a Fischer
// projection whose CHO is at the top).
const sugarName = (g: G, c: number, o: number, upper: number, lower: number): "D" | "L" | undefined => { const h = hand(g, c, [o, upper, lower]); return h && (h === "R" ? "D" : "L"); };
const singles = (g: G, i: number) => g.adj[i].every((e) => e.order === 1);
// An open-chain aldose: CHO, then CH(OH) carbons, then CH2OH; its configurational carbon is the one next to CH2OH.
function aldose(g: G, c: number): "D" | "L" | undefined {
  if (el(g, c) !== "C" || g.h[c] !== 1 || !singles(g, c)) return undefined;
  const cs = g.adj[c].filter((e) => el(g, e.to) === "C").map((e) => e.to), os = g.adj[c].filter((e) => el(g, e.to) === "O").map((e) => e.to);
  if (cs.length !== 2 || os.length !== 1) return undefined;
  const ch2oh = (i: number) => g.h[i] === 2 && singles(g, i) && g.adj[i].some((e) => el(g, e.to) === "O");
  for (const [lower, upper] of [[cs[0], cs[1]], [cs[1], cs[0]]]) {
    if (!ch2oh(lower)) continue;
    // Up the chain through CH(OH) carbons to the CHO.
    let prev = c, cur = upper;
    const seen = new Set([c]);
    for (;;) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const ccs = g.adj[cur].filter((e) => el(g, e.to) === "C" && e.to !== prev), oo = g.adj[cur].filter((e) => el(g, e.to) === "O");
      if (g.h[cur] === 1 && ccs.length === 0 && oo.length === 1 && oo[0].order === 2) return sugarName(g, c, os[0], upper, lower);
      if (g.h[cur] !== 1 || !singles(g, cur) || ccs.length !== 1 || oo.length !== 1) break;
      [prev, cur] = [cur, ccs[0].to];
    }
  }
  return undefined;
}
// A pyranose or furanose (Haworth, chair or wedges): a ring of 5 or 6, carbons and one O. Of the ring O's two carbons,
// the anomeric one has an exocyclic O; the other carries the exocyclic C (C-5 of a hexopyranose), or is a ring CH2 (a
// pentopyranose), when its ring neighbour with an OH is the configurational carbon.
function ringSugar(g: G, o: number): [number, "D" | "L"] | undefined {
  if (el(g, o) !== "O" || g.adj[o].length !== 2) return undefined;
  const [a, b] = g.adj[o].map((e) => e.to);
  // The ring: a path from a to b of 3 or 4 carbons not through o.
  const path = ringPath(g, a, b, o);
  if (!path || path.length < 4 || path.length > 5 || path.some((i) => el(g, i) !== "C")) return undefined;
  const ring = new Set([o, ...path]);
  const exoO = (i: number) => g.adj[i].some((e) => !ring.has(e.to) && el(g, e.to) === "O" && e.order === 1);
  const end = exoO(a) && !exoO(b) ? b : exoO(b) && !exoO(a) ? a : undefined;
  if (end === undefined) return undefined;
  const inner = (i: number, not: number) => g.adj[i].find((e) => ring.has(e.to) && e.to !== not)!.to;
  const branch = g.adj[end].filter((e) => !ring.has(e.to) && !isH(g.m, e.to));
  if (branch.length === 1 && el(g, branch[0].to) === "C" && branch[0].order === 1 && g.h[end] === 1) {
    const name = sugarName(g, end, o, inner(end, o), branch[0].to);
    return name && [end, name];
  }
  if (branch.length || g.h[end] !== 2) return undefined;
  const c = inner(end, o), oh = g.adj[c].filter((e) => !ring.has(e.to) && el(g, e.to) === "O" && e.order === 1);
  if (oh.length !== 1 || g.h[c] !== 1) return undefined;
  const name = sugarName(g, c, oh[0].to, inner(c, end), end);
  return name && [c, name];
}
// The shortest path from a to b not through `not` (atoms, a first and b last), up to 6 atoms.
function ringPath(g: G, a: number, b: number, not: number): number[] | undefined {
  const parent = new Map([[a, -1]]), queue = [a];
  for (let k = 0; k < queue.length && queue.length < 400; k++) {
    const i = queue[k];
    if (i === b) break;
    for (const e of g.adj[i]) if (e.to !== not && !parent.has(e.to)) { parent.set(e.to, i); queue.push(e.to); }
  }
  if (!parent.has(b)) return undefined;
  const path = [b];
  while (path[path.length - 1] !== a && path.length < 7) path.push(parent.get(path[path.length - 1])!);
  return path[path.length - 1] === a ? path.reverse() : undefined;
}

// ---- Steroid α and β (steroid.rs) ----

// Gonane's bonds by locant, the search order (the five-membered ring first) and OPSIN's clockwise order of the
// nucleus (alphaBetaClockwiseAtomOrdering).
const EDGES: [number, number][] = [[1, 2], [2, 3], [3, 4], [4, 5], [5, 10], [10, 1], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [9, 11], [11, 12], [12, 13], [13, 14], [14, 8], [14, 15], [15, 16], [16, 17], [17, 13]];
const SEARCH = [13, 14, 15, 16, 17, 8, 9, 11, 12, 10, 5, 6, 7, 1, 2, 3, 4];
const CLOCKWISE = [11, 12, 13, 17, 16, 15, 14, 8, 7, 6, 5, 4, 3, 2, 1, 10, 9];
const PATTERN: number[][] = Array.from({ length: 17 }, () => []);
for (const [a, b] of EDGES) { PATTERN[a - 1].push(b - 1); PATTERN[b - 1].push(a - 1); }
// Each embedding of gonane among the ring atoms: locant - 1 → atom. Gonane has no symmetry, so each fixes the locants.
function nuclei(g: G): number[][] {
  const ring = ringAtoms(g), adj = g.adj.map((es, i) => (ring.has(i) ? es.map((e) => e.to).filter((j) => ring.has(j)) : []));
  const out: number[][] = [];
  const search = (map: number[], depth: number) => {
    if (out.length > 20) return;
    if (depth === SEARCH.length) { out.push([...map]); return; }
    const locant = SEARCH[depth] - 1, anchor = PATTERN[locant].find((n) => map[n] >= 0);
    if (anchor === undefined) return;
    for (const atom of adj[map[anchor]]) {
      if (adj[atom].length < PATTERN[locant].length || map.includes(atom)) continue;
      if (map.some((mapped, other) => mapped >= 0 && PATTERN[locant].includes(other) !== adj[atom].includes(mapped))) continue;
      map[locant] = atom;
      search(map, depth + 1);
      map[locant] = -1;
    }
  };
  for (const start of ring) { const map = Array(17).fill(-1); map[SEARCH[0] - 1] = start; search(map, 1); }
  return out;
}
// Atoms on a ring: an end of a bond that is not a bridge.
function ringAtoms(g: G): Set<number> {
  const out = new Set<number>();
  g.adj.forEach((es, i) => { for (const e of es) if (e.to > i && (!out.has(i) || !out.has(e.to)) && viaOther(g, i, e.to)) { out.add(i); out.add(e.to); } });
  return out;
}
// Are i and j joined other than by their own bond?
function viaOther(g: G, i: number, j: number): boolean {
  const seen = new Set([i]), stack = g.adj[i].map((e) => e.to).filter((k) => k !== j);
  stack.forEach((k) => seen.add(k));
  while (stack.length) {
    const k = stack.pop()!;
    if (k === j) return true;
    for (const e of g.adj[k]) if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
  }
  return false;
}
// The nucleus centres' faces: for a nucleus atom with R or S and one H or none, its neighbours before and after it in
// the clockwise order; of its other two, a nucleus atom (or the one that is not H) second. α when, in the order
// [before, second, third, after] (H last), the hand is R: OPSIN's SMILES @@ in that order. Two external groups other
// than H (a 17-ethynyl steroid) give no face; a centre two nuclei name differently gets none.
function steroidFaces(g: G, cip: (string | undefined)[]): Map<number, string> {
  const out = new Map<number, string>(), clash = new Set<number>();
  for (const nucleus of nuclei(g)) {
    CLOCKWISE.forEach((locant, k) => {
      const c = nucleus[locant - 1];
      if (cip[c] !== "R" && cip[c] !== "S") return;
      const ns = g.adj[c].map((e) => e.to), drawnH = ns.filter((j) => isH(g.m, j)).length, implicit = g.h[c] - drawnH;
      if (!((ns.length === 3 && implicit === 1) || (ns.length === 4 && implicit === 0 && drawnH <= 1))) return;
      const all = ns.length === 3 ? [...ns, -1] : ns;
      const prev = nucleus[CLOCKWISE[(k + 16) % 17] - 1], next = nucleus[CLOCKWISE[(k + 1) % 17] - 1];
      const rest = all.filter((j) => j !== prev && j !== next);
      if (rest.length !== 2) return;
      const hy = (j: number) => j < 0 || isH(g.m, j), inN = (j: number) => j >= 0 && nucleus.includes(j);
      const second = inN(rest[0]) ? rest[0] : inN(rest[1]) || (hy(rest[0]) && !hy(rest[1])) ? rest[1] : hy(rest[1]) && !hy(rest[0]) ? rest[0] : undefined;
      if (second === undefined) return;
      const third = rest[0] === second ? rest[1] : rest[0], h = handIn(g.m, c, [prev, second, third, next]);
      if (!h) return;
      const label = `${locant}${h === "R" ? "α" : "β"}`;
      if (out.has(c) && out.get(c) !== label) clash.add(c);
      out.set(c, label);
    });
  }
  for (const c of clash) out.delete(c);
  return out;
}

// ---- The names for a drawing ----

// The names on a drawing's atoms (only those asked for): read with its written labels expanded, and given to the drawn
// atoms (a centre inside a label has no drawn atom). D/L and α/β only where Octet's CIP label is R or S.
export function stereoNames(drawn: Mol, opts: NameOptions): StereoNames {
  const out: StereoNames = { dl: new Map(), steroid: new Map(), unset: new Map() };
  if (!opts.dl && !opts.steroid && !opts.unset) return out;
  let x: Mol, from: number[];
  try { ({ mol: x, from } = expandWithOrigins(drawn)); } catch { return out; }
  if (x.atoms.length > 1000) return out;
  const drawnAtom = (k: number) => (drawn.atoms[from[k]] && !drawn.atoms[from[k]].text && from.indexOf(from[k]) === k ? from[k] : undefined);
  const g = graph(x), cip = opts.dl || opts.steroid ? cipLabels(x).atoms : [];
  if (opts.dl) {
    x.atoms.forEach((_, k) => {
      if (cip[k] !== "R" && cip[k] !== "S") return;
      const name = aminoAcid(g, k) ?? aldose(g, k), d = drawnAtom(k);
      if (name && d !== undefined) out.dl.set(d, name);
    });
    x.atoms.forEach((_, k) => {
      const found = ringSugar(g, k), d = found && drawnAtom(found[0]);
      if (found && d !== undefined && (cip[found[0]] === "R" || cip[found[0]] === "S")) out.dl.set(d, found[1]);
    });
  }
  if (opts.steroid) for (const [k, label] of steroidFaces(g, cip)) { const d = drawnAtom(k); if (d !== undefined) out.steroid.set(d, label); }
  if (opts.unset) for (const [i, mark] of unsetMarks(drawn, x, from, opts.unset)) out.unset.set(i, mark);
  return out;
}

// What Show Stereochemistry draws beside each atom, with the names asked for (ReShiki atom_labels.rs
// atom_stereo_texts): a steroid face in place of R or S ("3β"), D or L before R or S ("L (S)", the D or L upright, the R
// or S italic), or a grey mark on an undefined centre ("(Ξ)"). paren: the R/S setting's parentheses. added: a name or
// mark Octet adds, which CDXML has no attribute for (written as plain text).
export type StereoText = { prefix?: string; text: string; upright?: boolean; muted?: boolean; added?: boolean };
export function stereoTexts(cip: (string | undefined)[], names: StereoNames, paren: (c: string) => string): Map<number, StereoText> {
  const out = new Map<number, StereoText>();
  cip.forEach((c, i) => {
    if (!c) return;
    const face = names.steroid.get(i), dl = names.dl.get(i);
    out.set(i, face ? { text: paren(face), upright: true, added: true } : dl ? { prefix: `${dl} `, text: paren(c), added: true } : { text: paren(c) });
  });
  for (const [i, mark] of names.unset) if (!out.has(i)) out.set(i, { text: paren(mark), upright: true, muted: true, added: true });
  return out;
}

// Centres that could be stereocentres but whose configuration the drawing does not set (stereo_lint.rs
// undefined_with_pseudo): ? or Ξ, and ξ where both configurations would make it pseudoasymmetric (r or s). A centre
// on a wavy bond is drawn as unknown already and gets none.
function unsetMarks(drawn: Mol, x: Mol, from: number[], mark: "?" | "Ξ"): Map<number, "?" | "Ξ" | "ξ"> {
  const out = new Map<number, "?" | "Ξ" | "ξ">();
  let unset: Set<number>;
  try { unset = stereoFacts({ ...drawn, atoms: drawn.atoms.map((a) => ({ ...a, cip: true as const })) }).unset; } catch { return out; }
  for (const i of unset) {
    if (drawn.bonds.some((b) => b.display === "wavy" && b.atoms.includes(i))) continue;
    out.set(i, mark);
    if (mark !== "Ξ") continue;
    const k = from.indexOf(i), ns = x.bonds.flatMap((b) => (b.type !== HBOND && b.atoms.includes(k) ? [b.atoms[0] === k ? b.atoms[1] : b.atoms[0]] : []));
    if (k < 0 || ns.length < 3 || ns.length > 4) continue;
    const order = ns.length === 3 ? [...ns, -1] : ns;
    const pseudo = [order, [order[1], order[0], order[2], order[3]]].every((atoms) => {
      const trial: Mol = { ...x, atoms: x.atoms.map((a, j) => (j === k ? { ...a, kept: { atoms, marks: stereoMarks(x, k, atoms) } } : a)) };
      const c = cipLabels(trial).atoms[k];
      return c === "r" || c === "s";
    });
    if (pseudo) out.set(i, "ξ");
  }
  return out;
}
