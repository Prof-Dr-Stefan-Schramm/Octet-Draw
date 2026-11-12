// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/model/src/arrow_anchors/tests.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// Run: node src/arrowlinks.check.ts. Curved arrows whose ends follow the atom, bond or lone pair they were drawn on
// (arrowlinks.ts). ReShiki's behaviour tests, re-expressed on our own small drawings: an editor commit is modelled as
// commit(before, after), what the Editor's set does (reconcileLinks with the drawing of the new drawing).
import assert from "node:assert/strict";
import { hasLinks, linkEnds, linkFor, linkable, readLink, reconcileLinks, remapLinks, resolveEnd, reverseLinks, targetCentre, tangentOut, type LinkStyle } from "./arrowlinks.ts";
import { EMPTY, addArrow, addRing, deleteAtom, deleteBond, duplicateSelection, extractSelection, flipAtoms, insertMol, joinOverlaps, moveAtoms, pos, transformParts, updateArrow } from "./edit.ts";
import { history } from "./history.ts";
import { parse, serialize } from "./file.ts";
import { readOct, writeOct } from "./oct.ts";
import { fromCdxml, toCdxml } from "./cdxml.ts";
import { DEFAULT_STYLE } from "./docstyle.ts";
import { describe } from "./access.ts";
import { cleanUpReaction, findReaction, gapFor } from "./reaction.ts";
import { render, type Arrow, type ArrowLink, type Box, type Ink, type Mol } from "./render.ts";

type P = [number, number];
const pt = 4 / 3, S = { bond: 14.4 * pt, line: 0.6 * pt, bold: 2 * pt, spacing: 0.18 * 14.4 * pt, hash: 2.5 * pt, margin: 1.69 * pt, size: 10 * pt, labelPt: 10 };
const L = S.bond, LS: LinkStyle = { ...S, pt };
// Every glyph a 9.6 x 9.5 px box, as render.check's.
const box: P[] = [];
for (let i = 0; i <= 40; i++) { const f = i / 40; box.push([9.6 * f, 0], [9.6 * f, -9.5], [0, -9.5 * f], [9.6, -9.5 * f]); }
const measure = (text: string): Ink => ({ width: 9.6 * text.length, ascent: 9.5, outline: box });
const ink = (m: Mol) => render(m, S, measure, L);
// One committed edit, as the Editor's set makes it.
const commit = (before: Mol | undefined, after: Mol) => reconcileLinks(before, after, ink(after), LS);
const near = (p: P, q: P, tol = 1e-6) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;
const arrow = (m: Mol, id: number) => m.arrows!.find((a) => a.id === id)!;
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const twice = (m: Mol, msg: string) => { const again = commit(m, m); assert.deepEqual(commit(again, again), m, `${msg}: resolving again changes nothing`); assert.equal(again, m, `${msg}: same drawing`); };

// Hydroxide (O0, three lone pairs; H1) and formaldehyde (C2, O3 double bonded; H4, H5), two bond lengths apart.
const base: Mol = {
  atoms: [
    { label: "O", location: [0, 0, 0], charge: -1, pairs: 3 }, { label: "H", location: [-1, 0, 0] },
    { label: "C", location: [2, 0, 0] }, { label: "O", location: [2.87, 0.5, 0] }, { label: "H", location: [2, -1, 0] }, { label: "H", location: [1.13, 0.5, 0] },
  ],
  bonds: [{ type: 1, atoms: [0, 1] }, { type: 2, atoms: [2, 3] }, { type: 1, atoms: [2, 4] }, { type: 1, atoms: [2, 5] }],
};
const drawn = ink(base), pair = drawn.electrons.find((e) => e.atom === 0 && e.key === "pair0")!, pairAt: P = [pair.at[0] / L, -pair.at[1] / L];
// Arrow 1: from O0's first lone pair to C2 (an atom). Arrow 2: from the C=O bond's middle to O3.
const a1 = linkEnds(base, { kind: "curved", from: pairAt, to: pos(base, 2), bend: 0.3 } as Omit<Arrow, "id">, { on: { atom: 0, pair: "pair0" }, at: pairAt }, { on: { atom: 2 }, at: pos(base, 2) });
const mid: P = [(2 + 2.87) / 2, 0.25];
const a2 = linkEnds(base, { kind: "curved", from: mid, to: pos(base, 3), bend: 0.4 } as Omit<Arrow, "id">, { on: { bond: [2, 3], t: 0.5 }, at: mid }, { on: { atom: 3 }, at: pos(base, 3) });
let [m0, id1] = addArrow(base, a1);
let id2: number;
[m0, id2] = addArrow(m0, a2);
const m = commit(base, m0);

// ——— Creating a link ———
assert.ok(a1.fromLink && a1.toLink && a2.fromLink && a2.toLink, "each end drawn on a target is linked");
assert.deepEqual(a1.fromLink!.on, { atom: 0, pair: "pair0" });
assert.deepEqual(a2.fromLink!.on, { bond: [2, 3], t: 0.5 });
assert.deepEqual(m.atoms, base.atoms, "a link changes no atom");
assert.deepEqual(m.bonds, base.bonds, "nor any bond");
for (const kind of ["double", "arc", "reaction", "line"] as const) assert.ok(!linkable({ kind }) && !linkEnds(base, { kind, from: [0, 0], to: [2, 0] }, { on: { atom: 0 }, at: [0, 0] }).fromLink, `${kind}: not linked`);
assert.ok(linkable({ kind: "fishhook" }) && linkable({ kind: "curved" }));
assert.ok(!linkEnds(base, { kind: "curved", from: [0, 0], to: [0, 0.3], bend: 0.3 }, { on: { atom: 0 }, at: [0, 0] }, { on: { atom: 0 }, at: [0, 0] }).fromLink, "the same target at both ends: a free arrow");
// The ends sit clear of what they point at: outside O0's lone pair dots, C2 and the C=O bond's lines, by 1.2 pt and half the line.
const gap = (1.2 * pt + S.line / 2) / L;
assert.ok(Math.hypot(...sub(arrow(m, id1).to, pos(m, 2))) >= S.line / 2 / L + gap - 1e-9, "an atom end clear of the atom");
assert.ok(Math.hypot(...sub(arrow(m, id1).from, pairAt)) >= 0.09 * S.size / L + gap - 1e-9, "a lone-pair end clear of the dots");
const cn: P = [-0.5, 0.87].map((v) => v / Math.hypot(0.5, 0.87)) as P, off = (q: P) => Math.abs((q[0] - mid[0]) * cn[0] + (q[1] - mid[1]) * cn[1]);
assert.ok(off(arrow(m, id2).from) >= (S.line / 2 + S.spacing) / L + gap - 1e-6, "a bond end clear of both lines of a double bond");
assert.ok(Math.hypot(...sub(arrow(m, id2).to, pos(m, 3))) > 0.25, "an end on a label clear of the letter");
// The bond end goes out on the side the arc comes from.
assert.ok(tangentOut(mid, pos(base, 3), 0.4, "from")[0] * a2.fromLink!.dir[0] + tangentOut(mid, pos(base, 3), 0.4, "from")[1] * a2.fromLink!.dir[1] > 0);
twice(m, "new arrows");
console.log("arrowlinks.check: creation ok");

// ——— Moving what an end points at ———
// The formaldehyde moved without the arrows: arrow 1's end follows C2, its start stays; arrow 2 moves whole.
const shift = (x: Mol, ids: number[], d: P) => commit(x, moveAtoms(x, new Set(ids), d));
const moved = shift(m, [2, 3, 4, 5], [1.5, -0.7]);
assert.ok(near(arrow(moved, id1).from, arrow(m, id1).from), "the start on the hydroxide stays");
assert.ok(near(arrow(moved, id1).to, [arrow(m, id1).to[0] + 1.5, arrow(m, id1).to[1] - 0.7]), "the end follows C2");
assert.ok(near(arrow(moved, id2).from, [arrow(m, id2).from[0] + 1.5, arrow(m, id2).from[1] - 0.7]) && near(arrow(moved, id2).to, [arrow(m, id2).to[0] + 1.5, arrow(m, id2).to[1] - 0.7]), "both ends on the moved structure: the arrow moves whole");
assert.equal(arrow(moved, id1).bend, 0.3, "the arc keeps its bend");
twice(moved, "after a move");
// Only the target atom moved: that end follows it.
const one = shift(m, [2], [0, 0.6]);
assert.ok(near(arrow(one, id1).to, [arrow(m, id1).to[0], arrow(m, id1).to[1] + 0.6]), "the end follows its one atom");
// Everything moved but the arrows: both arrows move whole.
const all = shift(m, [0, 1, 2, 3, 4, 5], [-2, 3]);
for (const id of [id1, id2]) assert.ok(near(arrow(all, id).from, [arrow(m, id).from[0] - 2, arrow(m, id).from[1] + 3]) && near(arrow(all, id).to, [arrow(m, id).to[0] - 2, arrow(m, id).to[1] + 3]), "the arrows go with the drawing");
console.log("arrowlinks.check: follow ok");

// ——— Moving the arrow itself ———
const byArrow = (x: Mol, id: number, d: P) => ({ ...x, arrows: x.arrows!.map((a) => (a.id === id ? { ...a, from: [a.from[0] + d[0], a.from[1] + d[1]] as P, to: [a.to[0] + d[0], a.to[1] + d[1]] as P } : a)) });
// Alone: both links drop and the arrow stays where it was put (settled default 1).
const alone = commit(m, byArrow(m, id1, [0.4, 0.4]));
assert.ok(!arrow(alone, id1).fromLink && !arrow(alone, id1).toLink, "an arrow moved alone lets go");
assert.ok(near(arrow(alone, id1).from, [arrow(m, id1).from[0] + 0.4, arrow(m, id1).from[1] + 0.4]), "and stays where it was put");
assert.ok(arrow(alone, id2).fromLink && arrow(alone, id2).toLink, "the other arrow keeps its links");
// With its targets: links kept, moved once.
const withAll = commit(m, byArrow(moveAtoms(m, new Set([0, 1, 2, 3, 4, 5]), [0.4, 0.4]), id1, [0.4, 0.4]));
assert.ok(arrow(withAll, id1).fromLink && arrow(withAll, id1).toLink, "moved with its targets, an arrow keeps its links");
assert.ok(near(arrow(withAll, id1).to, [arrow(m, id1).to[0] + 0.4, arrow(m, id1).to[1] + 0.4]), "moved once");
// With one of its targets: that link is kept, the other drops.
const withOne = commit(m, byArrow(moveAtoms(m, new Set([2, 3, 4, 5]), [0.4, 0.4]), id1, [0.4, 0.4]));
assert.ok(!arrow(withOne, id1).fromLink && arrow(withOne, id1).toLink, "moved with one target, it keeps that link only");
// An end handle dragged off: that end lets go (the Editor sets its link from where it is let go); the other stays linked.
const dragged = commit(m, updateArrow(m, id1, { to: [1, 2], toLink: undefined }));
assert.ok(arrow(dragged, id1).fromLink && !arrow(dragged, id1).toLink && near(arrow(dragged, id1).to, [1, 2]), "a dragged end is free");
const relinked = commit(m, updateArrow(m, id1, { to: pos(m, 3), toLink: linkFor(m, { atom: 3 }, pos(m, 3), { ...arrow(m, id1), to: pos(m, 3) }, "to") }));
assert.deepEqual(arrow(relinked, id1).toLink!.on, { atom: 3 }, "let go on another atom, it links to that");
// The bend handle keeps both links.
const bent = commit(m, updateArrow(m, id1, { bend: 0.6 }));
assert.ok(arrow(bent, id1).fromLink && arrow(bent, id1).toLink, "a new bend keeps the links");
// Reverse: the links go with their ends.
const rev = commit(m, updateArrow(m, id1, { ...reverseLinks(arrow(m, id1)), from: arrow(m, id1).to, to: arrow(m, id1).from, bend: -0.3 }));
assert.deepEqual(arrow(rev, id1).toLink!.on, { atom: 0, pair: "pair0" });
assert.deepEqual(arrow(rev, id1).fromLink!.on, { atom: 2 });
assert.ok(near(arrow(rev, id1).from, arrow(m, id1).to), "reversed in place");
// Another kind: a straight or double-headed arrow lets go; a fishhook keeps them.
assert.ok(!hasLinks(commit(m, updateArrow(updateArrow(m, id2, { kind: "reaction", bend: undefined }), id1, { kind: "double" }))), "other kinds let go");
assert.ok(arrow(commit(m, updateArrow(m, id1, { kind: "fishhook" })), id1).toLink, "a fishhook keeps them");
console.log("arrowlinks.check: arrow edits ok");

// ——— Turns, flips and scales (transformParts, as the Editor's turn, flip and scale) ———
const every = new Set([0, 1, 2, 3, 4, 5]), c: P = [1, 0.3];
const rot = (deg: number) => { const r = (deg * Math.PI) / 180; return (q: P): P => [c[0] + (q[0] - c[0]) * Math.cos(r) - (q[1] - c[1]) * Math.sin(r), c[1] + (q[0] - c[0]) * Math.sin(r) + (q[1] - c[1]) * Math.cos(r)]; };
for (const deg of [15, 90, 180, 233]) {
  const f = rot(deg), turned = commit(m, transformParts(m, every, new Set([id1, id2]), f));
  for (const id of [id1, id2]) {
    assert.ok(arrow(turned, id).fromLink && arrow(turned, id).toLink, `turned ${deg}° with its targets: links kept`);
    // Labels stay upright as the structure turns, so an end by a label may be pushed out a little more; never in.
    // Lone pairs are placed again round their atom (clear of its upright label and charge), so an end on one follows
    // the pair where it is now drawn.
    if (id === id2) assert.ok(near(arrow(turned, id).from, f(arrow(m, id).from), 0.02), `turned ${deg}° once`);
    assert.ok(near(arrow(turned, id).to, f(arrow(m, id).to), 0.02), `turned ${deg}° once`);
  }
  const lp = ink(turned).electrons.find((e) => e.atom === 0 && e.key === (arrow(turned, id1).fromLink!.on as { pair: string }).pair)!;
  assert.ok(Math.hypot(arrow(turned, id1).from[0] - lp.at[0] / L, arrow(turned, id1).from[1] + lp.at[1] / L) < 0.3, "still at the oxygen's lone pair");
  twice(turned, `turned ${deg}°`);
  // Turned without the arrows: each end follows its target (an atom end by its offset, so it stays as far off).
  const left = commit(m, transformParts(m, every, new Set(), f));
  for (const id of [id1, id2]) assert.ok(arrow(left, id).fromLink && arrow(left, id).toLink, `turned ${deg}° without the arrows: links kept`);
  assert.ok(near(sub(arrow(left, id1).to, pos(left, 2)), sub(arrow(m, id1).to, pos(m, 2)), 1e-6), "the end keeps its place by C2");
}
// A turn about the target atom itself keeps that link (the atom does not move, the arrow does with it).
const aboutC: (q: P) => P = (q) => { const r = Math.PI / 3, o = pos(m, 2); return [o[0] + (q[0] - o[0]) * Math.cos(r) - (q[1] - o[1]) * Math.sin(r), o[1] + (q[0] - o[0]) * Math.sin(r) + (q[1] - o[1]) * Math.cos(r)]; };
const pivot = commit(m, transformParts(m, new Set([2, 3, 4, 5]), new Set([id2]), aboutC));
assert.ok(arrow(pivot, id2).fromLink && arrow(pivot, id2).toLink, "turned about its target atom: links kept");
// Flip across (flipAtoms moves the atoms first, as the Editor's Flip does).
const across = (q: P): P => [2 * c[0] - q[0], q[1]];
const flipped = commit(m, transformParts(flipAtoms(m, every, "horizontal", true, c[0]), new Set(), new Set([id1, id2]), across, [1, 1], undefined, 1, "across", every));
for (const id of [id1, id2]) {
  assert.ok(arrow(flipped, id).fromLink && arrow(flipped, id).toLink, "flipped with its targets: links kept");
  assert.ok(near(arrow(flipped, id).to, across(arrow(m, id).to), 1e-6), "flipped once");
  assert.equal(arrow(flipped, id).bend, -arrow(m, id).bend!, "the bend turns over");
}
twice(flipped, "flipped");
// Scaled down to 0.15: kept, and each end pushed out no further than the ink needs, which is fixed in size.
const small = (q: P): P => [c[0] + (q[0] - c[0]) * 0.15, c[1] + (q[1] - c[1]) * 0.15];
const shrunk = commit(m, transformParts(m, every, new Set([id1, id2]), small, [0.15, 0.15]));
for (const id of [id1, id2]) assert.ok(arrow(shrunk, id).fromLink && arrow(shrunk, id).toLink, "scaled with its targets: links kept");
assert.ok(Math.hypot(...sub(arrow(shrunk, id1).to, pos(shrunk, 2))) >= S.line / 2 / L + gap - 1e-9, "a shrunk end is still clear");
assert.ok(Math.hypot(...sub(arrow(shrunk, id1).to, pos(shrunk, 2))) < 0.3, "and pushed out only as far as needed");
twice(shrunk, "scaled to 0.15");
// A stretch across the bond (20 × 0.02): the bond end is still clear along the bond's own normal now.
const stretch = (q: P): P => [q[0] * 20, q[1] * 0.02];
const pulled = commit(m, moveAtoms({ ...m, atoms: m.atoms.map((a) => ({ ...a, location: [...stretch([a.location[0], a.location[1]]), 0] as [number, number, number] })) }, new Set(), [0, 0]));
{
  const [p2, p3] = [pos(pulled, 2), pos(pulled, 3)], u = sub(p3, p2), n: P = [-u[1] / Math.hypot(...u), u[0] / Math.hypot(...u)], q = sub(arrow(pulled, id2).from, [(p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2]);
  assert.ok(Math.abs(q[0] * n[0] + q[1] * n[1]) >= (S.line / 2 + S.spacing) / L + gap - 1e-6, "clear along the stretched bond's normal");
}
console.log("arrowlinks.check: transforms ok");

// ——— Delete, Undo and renumbering ———
// Delete C2: arrow 1's end stays where it was and lets go; Undo brings the link back; Redo takes it away again.
let h = history({ stack: [m], at: 0 }, { type: "set", mol: commit(m, deleteAtom(m, 2)) });
const gone = h.stack[h.at];
assert.ok(arrow(gone, id1).fromLink && !arrow(gone, id1).toLink, "the deleted atom's end lets go");
assert.ok(near(arrow(gone, id1).to, arrow(m, id1).to), "and stays where it was");
assert.ok(!arrow(gone, id2).fromLink, "a bond whose atom went lets go");
h = history(h, { type: "undo" });
assert.deepEqual(arrow(h.stack[h.at], id1), arrow(m, id1), "Undo brings the link back");
h = history(h, { type: "redo" });
assert.ok(!arrow(h.stack[h.at], id1).toLink, "Redo takes it away again");
// Delete an earlier atom (the hydroxide's H1): later atoms are numbered one less, and the links follow them.
const less = commit(m, deleteAtom(m, 1));
assert.deepEqual(arrow(less, id1).toLink!.on, { atom: 1 }, "C2 is atom 1 now, and so is the link");
assert.deepEqual(arrow(less, id2).fromLink!.on, { bond: [1, 2], t: 0.5 });
assert.ok(near(arrow(less, id1).to, arrow(m, id1).to) && near(arrow(less, id2).from, arrow(m, id2).from), "the ends stay put");
// Another bond deleted (bond indices change): a bond link names atoms, so it holds. The linked bond deleted: it lets go.
assert.deepEqual(arrow(commit(m, deleteBond(m, 0)), id2).fromLink!.on, { bond: [2, 3], t: 0.5 }, "another bond deleted: the link holds");
assert.ok(!arrow(commit(m, deleteBond({ ...m, atoms: [...m.atoms, { label: "C", location: [5, 5, 0] }], bonds: [...m.bonds, { type: 1, atoms: [3, 6] }] }, 1)), id2).fromLink, "the bond deleted: it lets go");
// The bond's atoms the other way round: t is measured from the other end.
assert.deepEqual(remapLinks([arrow(m, id2)], (i) => (i === 2 ? 9 : i === 3 ? 4 : i))![0].fromLink!.on, { bond: [4, 9], t: 0.5 });
assert.deepEqual(remapLinks([{ ...arrow(m, id2), fromLink: { ...arrow(m, id2).fromLink!, on: { bond: [2, 3], t: 0.2 } } }], (i) => (i === 2 ? 9 : 4))![0].fromLink!.on, { bond: [4, 9], t: 0.8 });
// Fewer lone pairs: a link to a pair that is no longer drawn lets go.
const fewer = commit(m, { ...m, atoms: m.atoms.map((a, i) => (i === 0 ? { ...a, pairs: 0 } : a)) });
assert.ok(!arrow(fewer, id1).fromLink && arrow(fewer, id1).toLink, "the lone pair gone: its end lets go");
// An atom moved onto the target atom joins it: the link goes to the atom it joined.
const extra: Mol = { ...m, atoms: [...m.atoms, { label: "C", location: [4, 4, 0] }], bonds: [...m.bonds, { type: 1, atoms: [3, 6] }] };
const ontoC = joinOverlaps(moveAtoms(extra, new Set([2]), [2, 4]), new Set([2])).mol;
assert.deepEqual(arrow(ontoC, id1).toLink!.on, { atom: 5 }, "the end on the joined atom follows the atom it joined");
console.log("arrowlinks.check: delete ok");

// ——— Copy, paste and duplicate ———
const part = extractSelection(m, every, new Set([id1, id2]));
const pasted = insertMol(m, part, [10, 0]), pm = commit(m, pasted.mol), copy = pm.arrows![pm.arrows!.length - 2];
assert.deepEqual(copy.toLink!.on, { atom: 8 }, "a pasted arrow links to the pasted atoms");
assert.ok(near(copy.to, [arrow(m, id1).to[0] + 10, arrow(m, id1).to[1]]), "where the copy of its target is");
assert.ok(!hasLinks(extractSelection(m, new Set(), new Set([id1]))), "an arrow copied without its atoms is free");
const half = extractSelection(m, new Set([2, 3, 4, 5]), new Set([id1]));
assert.ok(!half.arrows![0].fromLink && half.arrows![0].toLink, "copied with one target, it keeps that link only");
const dup = duplicateSelection(m, every, new Set([id1]));
assert.ok(dup.mol.arrows!.at(-1)!.toLink && dup.mol.arrows!.at(-1)!.toLink!.on.atom === 8, "an Option-drag copy links to the copied atoms");
// A pasted drawing in a larger label font pushes the end clear of the larger letters.
const big = commit(undefined, { ...pm, atoms: pm.atoms.map((a, i) => (i === 9 ? { ...a, size: 30 } : a)) });
assert.ok(Math.hypot(...sub(big.arrows![big.arrows!.length - 1].to, pos(big, 9))) > Math.hypot(...sub(copy.to, pos(pm, 9))), "a larger label pushes its end out");
console.log("arrowlinks.check: copy ok");

// ——— Never pulled in, and no drift ———
const at3 = () => Math.hypot(...sub(arrow(m, id2).to, pos(m, 3)));
const smaller = commit(m, { ...m, atoms: m.atoms.map((a, i) => (i === 3 ? { ...a, size: 6 } : a)) });
assert.ok(near(arrow(smaller, id2).to, arrow(m, id2).to), "a smaller label leaves the end where it is");
let larger = commit(m, { ...m, atoms: m.atoms.map((a, i) => (i === 3 ? { ...a, size: 20 } : a)) });
assert.ok(Math.hypot(...sub(arrow(larger, id2).to, pos(m, 3))) > at3(), "a larger one pushes it out");
const settled = arrow(larger, id2).to;
for (let k = 0; k < 20; k++) larger = commit(larger, larger);
assert.deepEqual(arrow(larger, id2).to, settled, "twenty more commits add no drift");
// An arrow without links is never changed.
const free = addArrow(base, { kind: "curved", from: [0.3, 0.3], to: [1.8, 0.1], bend: 0.3 })[0];
assert.equal(commit(base, free), free, "a free arrow stays exactly as it is");
console.log("arrowlinks.check: clearance ok");

// ——— Files: .oct keeps the links; CDXML has the arrow as drawn ———
const back = readOct(writeOct(m, DEFAULT_STYLE), true).mol;
for (const id of [id1, id2]) {
  const b = back.arrows!.find((a) => a.kind === arrow(m, id).kind && near(a.from, arrow(m, id).from, 1e-3))!;
  assert.deepEqual(b.fromLink!.on, arrow(m, id).fromLink!.on, "reopened: the start's link");
  assert.deepEqual(b.toLink!.on, arrow(m, id).toLink!.on, "reopened: the end's link");
}
const reopened = commit(back, back);
assert.ok(near(reopened.arrows![0].to, arrow(m, id1).to, 1e-3), "reopened arrows resolve where they were");
assert.ok(near(commit(reopened, moveAtoms(reopened, new Set([2, 3, 4, 5]), [1, 0])).arrows![0].to, [arrow(m, id1).to[0] + 1, arrow(m, id1).to[1]], 1e-3), "and still follow");
// Bad links in a file are left off, and the arrow is kept.
const json = JSON.parse(serialize(m));
json.arrows[0].fromLink = { on: { atom: 99 }, offset: [0, 0], dir: [0, 1] };
json.arrows[0].toLink = { on: { bond: [3, 2], t: 0.5 }, offset: [0, 0], dir: [0, 1] };
json.arrows[1].fromLink = { on: { atom: 0, pair: "charge" }, offset: [0, 0], dir: [0, 1] };
json.arrows[1].toLink = { on: { atom: 3 }, offset: [0, 0], dir: [0, 0] };
const bad = parse(JSON.stringify(json));
assert.equal(bad.arrows!.length, 2);
assert.ok(!hasLinks(bad), "every bad link is left off");
assert.equal(readLink({ on: { bond: [1, 2], t: 1.5 }, offset: [0, 0], dir: [1, 0] }, 5), undefined, "t past the bond's end");
assert.equal(readLink({ on: { atom: 1 }, offset: [Infinity, 0], dir: [1, 0] }, 5), undefined, "not a number");
assert.equal(readLink({ on: { atom: 1 }, offset: [0, 0], dir: [1, 0], gap: 2000 }, 5), undefined, "too big a gap");
assert.ok(readLink({ on: { atom: 1, pair: "radical1" }, offset: [0, 0], dir: [1, 0] }, 5), "a radical dot");
// An older Octet reads arrows with the fields it knows: the ends where they were drawn.
assert.ok(near([json.arrows[0].x2, json.arrows[0].y2], arrow(m, id1).to, 1e-3), "the file's ends are the resolved ends");
// CDXML (which has no place for links, as ChemDraw's has none) has each arrow where it is drawn.
const cd = fromCdxml(toCdxml(m, DEFAULT_STYLE)).mol;
for (const id of [id1, id2]) {
  const ends = cd.arrows!.flatMap((a) => [a.from, a.to]), drawnAt = [arrow(m, id).from, arrow(m, id).to];
  const o = sub(pos(cd, 0), pos(m, 0));
  for (const q of drawnAt) assert.ok(ends.some((e) => near(e, [q[0] + o[0], q[1] + o[1]], 2e-2)), "CDXML has the arrow as drawn");
}
assert.ok(!hasLinks(cd), "and no links");
// A selection copied as CDXML (the clipboard) keeps links to the atoms it holds, renumbered.
const sel = parse(serialize(extractSelection(m, new Set([2, 3, 4, 5]), new Set([id2]))));
assert.deepEqual(sel.arrows![0].fromLink!.on, { bond: [0, 1], t: 0.5 }, "renumbered with the copied atoms");
console.log("arrowlinks.check: files ok");

// ——— Screen readers name a linked end by what it is linked to ———
const names = describe(m, { box: () => [0, 0, 1, 1] }).filter((x) => x.role === "curved arrow").map((x) => x.name);
assert.ok(names.some((n) => /^From a lone pair on oxygen 1 to carbon 1$/.test(n)), names.join(" | "));
assert.ok(names.some((n) => /^From the bond between carbon 1 and oxygen 1 to oxygen 1$/.test(n)), names.join(" | "));
console.log("arrowlinks.check: screen reader ok");

// ——— Clean Up Reaction: linked ends stay on their targets (the old guess by distance is left for free ends) ———
{
  let t: Mol = addRing(EMPTY, 6, false, { point: [0, 0.6] }), rxn: number, push: number;
  [t, rxn] = addArrow(t, { kind: "reaction", from: [3, 0], to: [6, 0] });
  t = addRing(t, 5, false, { point: [8.4, -0.5] });
  const src = 0, dst = 7, line: [P, P] = [pos(t, src), pos(t, dst)];
  [t, push] = addArrow(t, linkEnds(t, { kind: "curved", from: line[0], to: line[1], bend: 0.3 }, { on: { atom: src }, at: line[0] }, { on: { atom: dst }, at: line[1] }));
  t = commit(undefined, t);
  const boxOf = (x: Mol) => (atoms: number[]): Box => { const ps = atoms.map((i) => pos(x, i)); return [Math.min(...ps.map((q) => q[0])), Math.min(...ps.map((q) => q[1])), Math.max(...ps.map((q) => q[0])), Math.max(...ps.map((q) => q[1]))]; };
  const r = findReaction(t, rxn, t.arrows!, boxOf(t), () => undefined)!;
  const done = commit(t, cleanUpReaction(t, r, t.arrows!, { gap: gapFor(10, 14.4), captionBox: () => undefined, plusBox: [-0.25, -0.15, 0.25, 0.45], captionPt: 10, bondPt: 14.4 }));
  assert.ok(Math.hypot(...sub(pos(done, dst), pos(t, dst))) > 0.1 && Math.hypot(...sub(sub(pos(done, dst), pos(t, dst)), sub(pos(done, src), pos(t, src)))) > 0.1, "the two structures move apart");
  const a = arrow(done, push);
  assert.ok(a.fromLink && a.toLink, "Clean Up Reaction keeps the links");
  assert.ok(near(sub(a.from, pos(done, src)), sub(arrow(t, push).from, pos(t, src))) && near(sub(a.to, pos(done, dst)), sub(arrow(t, push).to, pos(t, dst))), "each end is still by its atom");
}
console.log("arrowlinks.check: clean up ok");

// ——— Small pieces ———
assert.equal(targetCentre(m, { bond: [2, 4], t: 0.5 }, drawn, L)?.[0], 2, "a bond's point");
assert.equal(targetCentre(m, { bond: [0, 2], t: 0.5 }, drawn, L), undefined, "no bond between those atoms");
assert.equal(resolveEnd(m, drawn, LS, { on: { atom: 40 }, offset: [0, 0], dir: [0, 1] } as ArrowLink, 0), undefined, "an atom that is not there");
console.log("arrowlinks.check: all ok");
