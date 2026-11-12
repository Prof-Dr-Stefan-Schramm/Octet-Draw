// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/model/src/arrow_anchors/tests.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// Run: node src/arrowaim.check.ts. A new curved arrow whose head is linked to an atom does not leave its head on the
// atom's bonds (arrowlinks.ts aimHead, ReShiki's open_approach on Octet's arcs): its end goes round the atom, and the arc
// takes the bend that brings the head in that way, to where the head and shaft clear the bond lines, and a little
// further out only if it must.
import assert from "node:assert/strict";
import { aimHead, bondInk, linkEnds, reconcileLinks, touches, type LinkStyle } from "./arrowlinks.ts";
import { addArrow, pos } from "./edit.ts";
import { render, type Arrow, type Ink, type Mol } from "./render.ts";

type P = [number, number];
const pt = 4 / 3, S = { bond: 14.4 * pt, line: 0.6 * pt, bold: 2 * pt, spacing: 0.18 * 14.4 * pt, hash: 2.5 * pt, margin: 1.69 * pt, size: 10 * pt, labelPt: 10 };
const L = S.bond, LS: LinkStyle = { ...S, pt };
const box: P[] = [];
for (let i = 0; i <= 40; i++) { const f = i / 40; box.push([9.6 * f, 0], [9.6 * f, -9.5], [0, -9.5 * f], [9.6, -9.5 * f]); }
const measure = (text: string): Ink => ({ width: 9.6 * text.length, ascent: 9.5, outline: box });
const ink = (m: Mol) => render(m, S, measure, L);
const angle = (a: P, b: P) => Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b)))));
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];

// Formaldehyde with its hydrogens: C0 (unlabelled), O1 up and right, H2 straight down, H3 up and left.
const ch2o: Mol = {
  atoms: [{ label: "C", location: [0, 0, 0] }, { label: "O", location: [0.87, 0.5, 0] }, { label: "H", location: [0, -1, 0] }, { label: "H", location: [-0.87, 0.5, 0] }],
  bonds: [{ type: 2, atoms: [0, 1] }, { type: 1, atoms: [0, 2] }, { type: 1, atoms: [0, 3] }],
};
const d = ink(ch2o);
// A curved arrow to C0, drawn from below along the C–H bond: its head would lie on that bond.
const onBond = (from: P, bend: number, more: Partial<Arrow> = {}) => linkEnds(ch2o, { kind: "curved", from, to: pos(ch2o, 0), bend, ...more } as Omit<Arrow, "id">, undefined, { on: { atom: 0 }, at: pos(ch2o, 0) });
const hit = (a: Omit<Arrow, "id">) => { const end = reconcileLinks(undefined, addArrow(ch2o, a)[0], d, LS).arrows![0]; return { end, ...touches(end, bondInk(ch2o, 0, LS).segs, LS) }; };
{
  const drawn = onBond([0.6, -2.4], 0.05);
  assert.ok(hit(drawn).head, "as drawn, the head lies on the C–H bond");
  const aimed = aimHead(ch2o, drawn, d, LS), r = hit(aimed);
  assert.ok(!r.head && !r.shaft, "aimed, the head and shaft clear every bond");
  assert.deepEqual(aimed.toLink!.on, { atom: 0 }, "still linked to the carbon");
  assert.ok(Math.sign(aimed.bend!) === Math.sign(drawn.bend!) && Math.abs(aimed.bend!) <= 0.5, "the arc bulges to the same side, at most a half circle");
  assert.deepEqual(aimed.from, drawn.from, "the start is kept");
  assert.ok(angle(aimed.toLink!.dir, sub(drawn.from, pos(ch2o, 0))) <= Math.PI / 3 + 1e-6, "the head still faces the start");
  assert.ok(Math.hypot(...r.end.to) < 0.4, "and stays by the atom");
  // Aiming again changes nothing, and the commit keeps the aimed end where it is.
  assert.deepEqual(aimHead(ch2o, aimed, d, LS), aimed, "aiming again changes nothing");
  const committed = reconcileLinks(undefined, addArrow(ch2o, aimed)[0], d, LS).arrows![0];
  assert.ok(Math.hypot(...sub(committed.to, aimed.to)) < 1e-6, "the commit keeps the aimed end");
  // A fishhook (a half head) is aimed the same way.
  const hook = aimHead(ch2o, onBond([0.6, -2.4], 0.05, { kind: "fishhook" }), d, LS);
  assert.ok(!hit(hook).head, "a fishhook's half head clears too");
}
// An arrow drawn clear of the bonds keeps exactly its place.
{
  const clear = onBond([-1.6, -1.2], 0.05);
  assert.ok(!hit(clear).head && !hit(clear).shaft, "drawn clear");
  assert.equal(aimHead(ch2o, clear, d, LS), clear, "an arrow drawn clear is left as it is");
}
// A head at the start (the Curves menu's Start) is aimed at its own end.
{
  const back = linkEnds(ch2o, { kind: "curved", from: pos(ch2o, 0), to: [0.05, -2.6], bend: -0.05, start: "full", end: "none" } as Omit<Arrow, "id">, { on: { atom: 0 }, at: pos(ch2o, 0) });
  const aimed = aimHead(ch2o, back, d, LS), r = reconcileLinks(undefined, addArrow(ch2o, aimed)[0], d, LS).arrows![0];
  const flipped = { ...r, from: r.to, to: r.from, bend: -(r.bend ?? 0) };
  assert.ok(!touches(flipped, bondInk(ch2o, 0, LS).segs, LS).head, "a start head clears the bonds");
}
// Free arrows, lone-pair and bond ends, and arrows with no head are not aimed.
{
  const free: Omit<Arrow, "id"> = { kind: "curved", from: [0.05, -2.6], to: [0, 0], bend: 0.05 };
  assert.equal(aimHead(ch2o, free, d, LS), free, "a free arrow is left alone");
  const toBond = linkEnds(ch2o, { kind: "curved", from: [0.05, -2.6], to: [0.43, 0.25], bend: 0.05 } as Omit<Arrow, "id">, undefined, { on: { bond: [0, 1], t: 0.5 }, at: [0.43, 0.25] });
  assert.equal(aimHead(ch2o, toBond, d, LS), toBond, "an end on a bond is placed by the bond");
  const headless = onBond([0.6, -2.4], 0.05, { end: "none" });
  assert.equal(aimHead(ch2o, headless, d, LS), headless, "no head, nothing to aim");
}
// Bond ink is as wide as it is drawn: a bold or hashed bond reaches further than a plain one, a double bond's second line
// further again.
{
  const w = (b: Partial<Mol["bonds"][number]>) => bondInk({ ...ch2o, bonds: [{ type: 1, atoms: [0, 2], ...b }] }, 0, LS).segs[0].w;
  assert.ok(w({ display: "bold" }) > w({}) && w({ stereo: 6 }) > w({ display: "bold" }) && w({ type: 2 }) > w({}), "bond widths");
  // Every bond round a carbon in a chain: an arrow coming in between two bonds is aimed into the open side.
  const chain: Mol = { atoms: [{ label: "C", location: [0, 0, 0] }, { label: "C", location: [0.87, -0.5, 0] }, { label: "C", location: [-0.87, -0.5, 0] }, { label: "O", location: [0, 1, 0] }],
    bonds: [{ type: 1, atoms: [0, 1] }, { type: 1, atoms: [0, 2] }, { type: 2, atoms: [0, 3] }] };
  const dc = ink(chain), a = linkEnds(chain, { kind: "curved", from: [0.5, 2.0], to: [0, 0], bend: 0.02 } as Omit<Arrow, "id">, undefined, { on: { atom: 0 }, at: [0, 0] });
  assert.ok(touches(reconcileLinks(undefined, addArrow(chain, a)[0], dc, LS).arrows![0], bondInk(chain, 0, LS).segs, LS).head, "as drawn, the head lies on the C=O bond's lines");
  const aimed = aimHead(chain, a, dc, LS), r = reconcileLinks(undefined, addArrow(chain, aimed)[0], dc, LS).arrows![0];
  assert.ok(!touches(r, bondInk(chain, 0, LS).segs, LS).head, "between a C=O and a C–C bond, the head finds the gap");
}
console.log("arrowaim.check: all ok");
