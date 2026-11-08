// Run: node src/glassware.check.ts. The library's Glassware group (tools/library/glassware/*.svg, read by
// tools/library/glassware.mjs): each piece is one integral group of pen curves and lines that goes where it is
// placed, takes the document's line width, and comes back whole from CDXML and from a .oct file. The group is drawn
// to one scale, so a test tube beside a beaker beside a Soxhlet are the sizes they really are.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fromCdxml, toCdxml } from "./cdxml.ts";
import { DEFAULT_STYLE } from "./docstyle.ts";
import { addRing, addTemplate, EMPTY } from "./edit.ts";
import { readOct, writeOct } from "./oct.ts";
import type { Arrow, Group, Mol } from "./render.ts";

type Item = { name: string; also?: string; atoms: unknown[]; bonds: unknown[]; arrows: Arrow[]; groups: Group[]; icon: number[] };
const library: { name: string; items: Item[] }[] = JSON.parse(readFileSync(new URL("./library.json", import.meta.url), "utf8"));
const shelf = library.find((c) => c.name === "Glassware")!;
assert.deepEqual(shelf.items.map((t) => t.name), [
  "Round-bottom flask, jointed", "Flat-bottom flask", "Erlenmeyer flask", "Two-neck flask", "Three-neck flask", "Evaporation flask",
  "Griffin beaker", "Beaker with handle", "Screw-cap bottle", "Beaded-rim test tube", "Ground-joint test tube",
  "Narrow-neck reagent bottle",
  "Measuring cylinder", "Volumetric flask", "Volumetric pipette", "Graduated pipette", "Burette", "Cylinder with foot",
  "Liebig condenser", "Allihn condenser", "Graham condenser", "Dimroth condenser", "Cold-finger condenser",
  "Jacketed coil condenser",
  "Separating funnel", "Pear-shaped addition funnel", "Conical addition funnel", "Pressure-equalising addition funnel",
  "Oblique-stopcock addition funnel", "Fritted glass funnel",
  "Soxhlet extractor", "Soxhlet extractor with drain", "Soxhlet with Allihn condenser", "Soxhlet with Dimroth condenser",
  "Dean–Stark apparatus", "Microdistillation apparatus",
  "Bent delivery adapter", "Bent vacuum adapter", "Claisen adapter", "Ground-joint reducer", "Ground-glass stopper", "Vigreux column",
  "Filter flask", "Drechsel bottle", "Schlenk tube", "Thiele tube", "Distillation bridge", "Side-arm distillation flask",
]);
// Nothing here takes a name the rest of the library already uses, so every template still answers to one name.
const others = library.filter((c) => c !== shelf).flatMap((c) => c.items.map((t) => t.name));
for (const t of shelf.items) assert.ok(!others.includes(t.name), `${t.name} is a name another set already uses`);

const points = (a: Arrow) => (a.curve ? a.curve.points.map((p) => p.at) : [a.from, a.to]);
const box = (arrows: Arrow[]) => {
  const qs = arrows.flatMap(points), xs = qs.map((q) => q[0]), ys = qs.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const size = (t: Item) => { const [x0, y0, x1, y1] = box(t.arrows); return [x1 - x0, y1 - y0]; };
const near = (a: number, b: number, d = 1e-3) => Math.abs(a - b) <= d;
// Two curves are the same when their points (and handles) are within d bond lengths.
const sameArrow = (a: Arrow, b: Arrow, d: number) => {
  assert.equal(b.kind, a.kind);
  assert.equal(!!b.curve?.closed, !!a.curve?.closed);
  const qs = (x: Arrow) => (x.curve ? x.curve.points.flatMap((p) => [p.at, p.c1 ?? p.at, p.c2 ?? p.at]) : [x.from, x.to]);
  const [p, q] = [qs(a), qs(b)];
  assert.equal(q.length, p.length);
  p.forEach((v, i) => assert.ok(near(v[0], q[i][0], d) && near(v[1], q[i][1], d), `${a.kind} point ${i}: ${v} came back as ${q[i]}`));
};

for (const t of shelf.items) {
  const mol: Mol = { atoms: [], bonds: [], arrows: t.arrows, groups: t.groups };
  // Drawn with Octet's own objects, all in one group, centred like every template.
  assert.equal(t.atoms.length + t.bonds.length, 0, t.name);
  assert.ok(t.arrows.length > 0 && t.arrows.every((a) => a.kind === "curve" || a.kind === "line"), t.name);
  assert.deepEqual(t.groups.map((g) => [g.atoms.length, [...g.items].sort((x, y) => x - y), g.integral]), [[0, t.arrows.map((a) => a.id).sort((x, y) => x - y), true]], t.name);
  const [x0, y0, x1, y1] = box(t.arrows);
  assert.ok(near((x0 + x1) / 2, 0, 0.002) && near((y0 + y1) / 2, 0, 0.002), `${t.name} is centred`);
  // Line art, nothing else: one line width (no object sets its own), no fills and no colours of their own, so every
  // piece takes the document's line width and its ink colour.
  assert.ok(t.arrows.every((a) => a.width === undefined && a.scale === undefined), `${t.name} sets its own line width`);
  assert.ok(t.arrows.every((a) => a.fill === undefined && a.colour === undefined), `${t.name} has a fill or a colour`);
  // Big enough to read and short enough to place: the tallest piece in the set is the Soxhlet under a condenser.
  const [w, h] = [x1 - x0, y1 - y0];
  assert.ok(Math.max(w, h) >= 1.2 && h <= 5.25, `${t.name} is ${w.toFixed(2)} by ${h.toFixed(2)} bond lengths`);
  // Its icon draws some of its lines, and a piece with fine parts leaves them out, or at 20 px it is a smudge.
  assert.ok(t.icon.length && t.icon.every((id) => t.arrows.some((a) => a.id === id)), t.name);
  if (t.arrows.length > 12) assert.ok(t.icon.length < t.arrows.length, `${t.name} puts all ${t.arrows.length} of its parts in its icon`);

  // Placed at a point, its middle is there, with new ids in a new group.
  const placed = addTemplate(addRing(EMPTY, 6, false, { point: [-6, 0] }), mol, { point: [10, 5] });
  const ids = new Set(placed.arrows!.map((a) => a.id));
  const [a0, b0, a1, b1] = box(placed.arrows!);
  assert.ok(near((a0 + a1) / 2, 10, 0.002) && near((b0 + b1) / 2, 5, 0.002), `${t.name} goes where it is placed`);
  // It keeps its way up: every point moves by the same step, so a flask's neck stays above its body.
  placed.arrows!.forEach((a, i) => assert.ok(near(a.from[0], t.arrows[i].from[0] + 10) && near(a.from[1], t.arrows[i].from[1] + 5), `${t.name} keeps its way up`));
  assert.equal(placed.groups?.length, 1);
  assert.deepEqual(new Set(placed.groups![0].items), ids);
  // A click on a bond or atom with it in hand puts it at the click, not at the drawing's origin.
  const onBond = addTemplate(placed, mol, { bond: 0, point: [20, -5] }), mine = onBond.arrows!.filter((a) => !ids.has(a.id));
  const [c0, d0, c1, d1] = box(mine);
  assert.ok(near((c0 + c1) / 2, 20, 0.002) && near((d0 + d1) / 2, -5, 0.002), `${t.name} on a bond goes to the click`);

  // CDXML (as ChemDraw reads it): every curve and line, and the group, come back.
  const read = fromCdxml(toCdxml(placed, DEFAULT_STYLE));
  assert.deepEqual(read.lost, {}, t.name);
  assert.equal(read.mol.atoms.length, 6);
  assert.equal(read.mol.arrows?.length, placed.arrows!.length, `${t.name}: every object comes back`);
  // The writer may put the objects in another order, and a piece has many parts that look alike (the ridges of a cap,
  // the turns of a coil), so each object is paired with the one that came back nearest it and that pairing is used up.
  const left = [...read.mol.arrows!];
  const far = (a: Arrow, b: Arrow) => {
    const p = points(a), q = points(b);
    return Math.max(...p.map((v, i) => Math.hypot(v[0] - q[i][0], v[1] - q[i][1])));
  };
  for (const a of placed.arrows!) {
    const like = left.filter((b) => b.kind === a.kind && !!b.curve?.closed === !!a.curve?.closed && (b.curve?.points.length ?? 2) === (a.curve?.points.length ?? 2));
    const best = like.sort((p, q) => far(a, p) - far(a, q))[0] ?? assert.fail(`${t.name}: a ${a.kind} is lost`);
    sameArrow(a, best, 0.002);
    left.splice(left.indexOf(best), 1);
  }
  // A piece of more than one part keeps its group through CDXML. A piece drawn in one line (the graduated pipette) is
  // written without one: a group of one object says nothing, and the one object is picked by a click either way.
  if (placed.arrows!.length > 1) {
    assert.equal(read.mol.groups?.length, 1, `${t.name}: one group`);
    assert.equal(read.mol.groups![0].items.length, placed.arrows!.length);
    assert.ok(read.mol.groups![0].integral, "a click picks all of it, as ChemDraw's clip art");
  }
  // A .oct file gives it back as it was.
  const oct = readOct(writeOct(placed, DEFAULT_STYLE)).mol;
  assert.equal(oct.arrows?.length, placed.arrows!.length);
  placed.arrows!.forEach((a, i) => { assert.equal(oct.arrows![i].id, a.id); sameArrow(a, oct.arrows![i], 1e-9); });
  if (placed.arrows!.length > 1) assert.deepEqual(oct.groups, placed.groups);
}

// The set is drawn to one scale, not each piece to the same height. Each drawing is scaled by the line it is drawn
// with, so the sizes are the real ones beside each other: were that dropped and every drawing simply fitted to the
// same box, these would all come out alike.
const byName = (n: string) => shelf.items.find((t) => t.name === n)!;
const tall = (n: string) => size(byName(n))[1], wide = (n: string) => size(byName(n))[0];
assert.ok(tall("Soxhlet with Dimroth condenser") > 2 * tall("Griffin beaker"), "a Soxhlet under a condenser stands over twice a beaker");
assert.ok(tall("Volumetric pipette") > 1.5 * tall("Erlenmeyer flask"), "a pipette is far longer than a flask is tall");
assert.ok(wide("Beaded-rim test tube") < wide("Griffin beaker") / 4, "a test tube is a fraction of a beaker across");
assert.ok(wide("Microdistillation apparatus") > 3, "a whole apparatus is wider than it is in its own drawing");
// Drawn the right way up: SVG counts y downwards and Octet upwards, so a flask read in upside down would put its
// neck under its body. The flask's top is narrower than its middle.
for (const n of ["Round-bottom flask, jointed", "Erlenmeyer flask", "Volumetric flask", "Side-arm distillation flask"]) {
  const t = byName(n), [bx0, by0, bx1, by1] = box(t.arrows);
  const across = (lo: number, hi: number) => {
    const xs = t.arrows.flatMap(points).filter((q) => q[1] >= lo && q[1] <= hi).map((q) => q[0]);
    return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  };
  const third = (by1 - by0) / 3;
  assert.ok(across(by1 - third, by1) < across(by0, by0 + third), `${n} stands the right way up`);
  void bx0; void bx1;
}
// Search words for the names other labs use.
assert.match(byName("Erlenmeyer flask").also ?? "", /conical/);
assert.match(byName("Separating funnel").also ?? "", /separatory/);
console.log(`glassware.check: ${shelf.items.length} glassware templates place, keep one line width and round-trip through CDXML and .oct ok`);
