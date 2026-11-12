// Run: node src/model3d.check.ts. Fails loudly if 3D models (Show as 3D Model) stop drawing, turning, keeping with
// their structure or saving as they should. ReShiki's model and painter tests (crates/model/src/models3d/tests.rs,
// opening_tests.rs, polish/tests.rs), rewritten on Octet's own small molecules.
import assert from "node:assert/strict";
import { DEFAULT_STYLE } from "./docstyle.ts";
import { addRing, deleteAtoms, EMPTY, extractSelection, insertMol, rotateAtoms, tiltAtoms } from "./edit.ts";
import { parse, serialize } from "./file.ts";
import { toCdxml } from "./cdxml.ts";
import {
  bondsOf, colourOf, describeModel, drawnGeometry, fingerprintOf, frameOf, isStale, modelOf, modelPrimitives, newModel, openingRotation, paintScene, pointsOf, primitiveNodes, project, radiusOf,
  readModel, remapModels, rollQuat, rotate, scaleModels, sceneView, setDisplay, shownAs3d, shownOf, svgText, turn, viewOf, viewFrame, writeModel,
  type Model3d, type Prim3d, type Quat, type V3,
} from "./model3d.ts";
import type { Atom, Mol } from "./render.ts";
import { structureText } from "./access.ts";

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const atom = (label: string, x: number, y: number, extra: Partial<Atom> = {}): Atom => ({ label, location: [x, y, 0], ...extra });
// Ethanol drawn with its OH hydrogen and one CH hydrogen (ReShiki's fixture: C–C–O and two H).
const ethanolMol = (): Mol => ({
  atoms: [atom("C", 0, 0), atom("C", 0.866, 0.5), atom("O", 1.732, 0), atom("H", 2.598, 0.5), atom("H", -0.866, 0.5)],
  bonds: [{ type: 1, atoms: [0, 1] }, { type: 1, atoms: [1, 2] }, { type: 1, atoms: [2, 3] }, { type: 1, atoms: [0, 4] }],
});
// Its 3D shape (Å), staggered.
const ETHANOL: V3[] = [[-1.25, -0.1, 0.05], [0.25, 0.2, -0.1], [1.0, -0.95, 0.15], [1.92, -0.7, 0.1], [-1.75, 0.85, -0.2]];
const ethanol = (extra: Partial<Model3d> = {}): Mol => {
  const m = ethanolMol(), model = newModel(m, [0, 1, 2, 3, 4], { xyz: ETHANOL }, "3d");
  return { ...m, models: [{ ...model, ...extra }] };
};
const prims = (m: Mol, o: Parameters<typeof modelPrimitives>[2] = { paper: "#ffffff" }) => modelPrimitives(m, m.models![0], o);
const kinds = (p: Prim3d[]) => p.reduce((s, x) => ({ ...s, [x.kind]: (s[x.kind] ?? 0) + 1 }), {} as Record<string, number>);
const unitQ = (q: Quat) => near(Math.hypot(...q), 1, 1e-9);

// The opening view is a proper rotation that shows the principal face; odd inputs stay finite and repeatable.
{
  const q = openingRotation(ETHANOL.map((p) => [p[0] - 0.034, p[1] + 0.06, p[2]] as V3));
  assert.ok(unitQ(q), "the opening view is a unit quaternion");
  for (const pts of [[], [[0, 0, 0]], [[1, 0, 0], [-1, 0, 0]], [[0, 0, 0], [0, 0, 0], [0, 0, 0]]] as V3[][]) {
    const a = openingRotation(pts), b = openingRotation(pts);
    assert.ok(a.every(Number.isFinite) && unitQ(a), "a degenerate molecule still gets a rotation");
    assert.deepEqual(a, b, "the same input gives the same view");
  }
}

// The opening view follows a flat drawing in each of its four mirror layouts.
{
  const flat: V3[] = [[0, 0, 0], [1.3, 0.75, 0], [2.6, 0, 0], [3.9, 0.75, 0], [5.2, 0, 0], [1.3, 2.2, 0]];
  const c = flat.reduce((s, p) => [s[0] + p[0] / 6, s[1] + p[1] / 6, 0], [0, 0, 0]);
  const centred = flat.map((p): V3 => [p[0] - c[0], p[1] - c[1], 0]);
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const drawn = centred.map((p): [number, number] => [p[0] * sx, p[1] * sy]), q = openingRotation(centred.map((p): V3 => [p[0] * sx, p[1] * sy, 0]), drawn);
    const score = centred.reduce((s, p, i) => { const r = rotate(q, [p[0] * sx, p[1] * sy, 0]); return s + r[0] * drawn[i][0] + r[1] * drawn[i][1]; }, 0);
    assert.ok(score > 0, `the opening view faces like the drawing (${sx}, ${sy})`);
  }
}

// Ball and stick: five balls and eight half-bonds, back to front, in the flat look's colours and outline.
{
  const m = ethanol(), p = prims(m, {}), k = kinds(p); // no depth fade: exact colours
  assert.equal(k.sphere, 5, "five balls");
  assert.equal(k.quad, 8, "eight half-bonds");
  assert.equal(p.length, 13);
  const o = p.find((x) => x.kind === "sphere" && x.r > 0 && x.stops.length === 3 && x.stops[1][1] === colourOf("O"));
  assert.ok(o && o.kind === "sphere", "the oxygen ball has its colour in the middle stop");
  assert.deepEqual(o.stops.map((s) => s[0]), [0, 0.6, 1]);
  assert.equal(o.outline?.colour, "#1e2226");
  assert.equal(o.outline?.alpha, 0.85);
  // The balls are sorted by depth: each later ball is no further back.
  const v = viewOf(m, m.models![0])!, zs = p.filter((x) => x.kind === "sphere").map((x) => { const c = (x as { c: [number, number] }).c; return v.rotated.findIndex((r) => { const [q] = project(v, r); return near(q[0], c[0], 1e-9) && near(q[1], c[1], 1e-9); }); }).map((i) => v.rotated[i][2]);
  assert.ok(zs.every((z, i) => i === 0 || z >= zs[i - 1] - 1e-9), "balls go back to front");
}

// Each ball covers its own half-bonds, but a half-bond can pass in front of a farther atom.
{
  const pts = [{ symbol: "C", xyz: [0, 0, 0] as V3 }, { symbol: "O", xyz: [1.4, 0, -1] as V3 }];
  const v = sceneView(pts, [true, true], [[0, 1]], "ballStick", [1, 0, 0, 0], [0, 0], 4);
  const p = paintScene(v, { size: 4, paper: "#ffffff" });
  const order = p.map((x) => (x.kind === "sphere" ? `ball${x.c[0] < 0 ? "C" : "O"}` : "half"));
  const carbon = order.indexOf("ballC"), oxygen = order.indexOf("ballO");
  assert.ok(oxygen < carbon, "the far oxygen first");
  assert.ok(order.indexOf("half") < oxygen, "the oxygen covers its own half");
  assert.ok(order.lastIndexOf("half") > oxygen && order.lastIndexOf("half") < carbon, "carbon's half passes in front of the farther oxygen, under the carbon");
}

// The SVG: user-space radial gradients with a focal circle and three stops; a half-bond's outline is its two long sides.
{
  const svg = svgText(primitiveNodes(prims(ethanol()), "t"));
  assert.ok(svg.includes('gradientUnits="userSpaceOnUse"') && /<radialGradient[^>]* fr="/.test(svg), "a ball's gradient");
  const radial = svg.match(/<radialGradient.*?<\/radialGradient>/)![0];
  assert.equal((radial.match(/<stop /g) ?? []).length, 3);
  assert.ok(radial.includes('offset="0.6"'));
  const outline = svg.match(/<path d="(M[^"]*)" fill="none" stroke/)![1];
  assert.equal((outline.match(/M/g) ?? []).length, 2, "two long sides");
  assert.ok(!/<script|on\w+=/.test(svg));
  const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((x) => x[1]);
  assert.equal(new Set(ids).size, ids.length, "gradient ids are unique");
}

// The frame is a square that holds the model in every turn, the same size while turning; without perspective it is
// 0.88 of the size across. With full perspective it is larger, but less than twice.
{
  const m = ethanol(), model = m.models![0];
  for (const persp of [0, 1]) {
    let q = model.rotation, first: number | undefined;
    for (let k = 0; k < 40; k++) {
      q = turn(q, 17, -11);
      const v = sceneView(pointsOf(model), shownOf(model), bondsOf(model), "ballStick", q, [0, 0], model.size, persp), [lo, hi] = viewFrame(v);
      assert.ok(near(hi[0] - lo[0], hi[1] - lo[1], 1e-9), "a square");
      first ??= hi[0] - lo[0];
      assert.ok(near(hi[0] - lo[0], first, 1e-9), "constant while turning");
      if (persp === 0) assert.ok(near(first, 0.88 * model.size, 1e-9), "0.88 of the size");
      else assert.ok(first > 0.88 * model.size && first < 2 * 0.88 * model.size, "larger with perspective, less than twice");
      for (const x of paintScene(v, { size: model.size })) if (x.kind === "sphere") {
        assert.ok(x.c[0] - x.r >= lo[0] - 1e-9 && x.c[0] + x.r <= hi[0] + 1e-9 && -x.c[1] - x.r >= lo[1] - 1e-9 && -x.c[1] + x.r <= hi[1] + 1e-9, "every ball inside the frame");
      }
    }
  }
}

// A drag turns about y by dx and about x by dy; Shift rolls; 500 turns stay a unit quaternion.
{
  const q = turn([1, 0, 0, 0], 100, 0);
  const x = rotate(q, [1, 0, 0]);
  assert.ok(near(x[0], Math.cos(1), 1e-9) && near(x[2], -Math.sin(1), 1e-9), "across turns about the vertical axis");
  const y = rotate(turn([1, 0, 0, 0], 0, 100), [0, 1, 0]);
  assert.ok(near(y[1], Math.cos(1), 1e-9) && near(y[2], Math.sin(1), 1e-9), "down turns about the horizontal axis");
  const r = rotate(turn([1, 0, 0, 0], 100, 0, true), [1, 0, 0]);
  assert.ok(near(r[1], -Math.sin(1), 1e-9) && near(r[2], 0, 1e-9), "Shift rolls about the line of sight");
  let many: Quat = [1, 0, 0, 0];
  for (let k = 0; k < 500; k++) many = turn(many, 7.3, -3.1, k % 3 === 0);
  assert.ok(unitQ(many));
}

// A quarter roll turns (x, y) to (−y, x), as a 2D turn anticlockwise.
{
  const p = rotate(rollQuat([1, 0, 0, 0], 90), [1, 2, 0]);
  assert.ok(near(p[0], -2, 1e-9) && near(p[1], 1, 1e-9));
  // Rotate the structure 90°: a model shown in 3D turns with it, its atoms' depth is unchanged.
  const m = ethanol(), turned = rotateAtoms(m, new Set([0, 1, 2, 3, 4]), 90);
  const a = rotate(m.models![0].rotation, [1, 0, 0]), b = rotate(turned.models![0].rotation, [1, 0, 0]);
  assert.ok(near(b[0], -a[1], 1e-9) && near(b[1], a[0], 1e-9) && near(b[2], a[2], 1e-9), "the model rolls with its structure");
}

// Structure Perspective turns a shown model in the drawing's sense, not its atoms.
{
  const m = ethanol(), flat = ethanolMol(), ids = new Set([0, 1, 2, 3, 4]);
  const turned = tiltAtoms(m, ids, [0.866, 0.25, 0], 30, 0), plain = tiltAtoms(flat, ids, [0.866, 0.25, 0], 30, 0);
  assert.deepEqual(turned.atoms.map((a) => a.location), m.atoms.map((a) => a.location), "the atoms stay as drawn");
  // A point on the right goes back (z down) in both.
  const q0 = m.models![0].rotation, q1 = turned.models![0].rotation;
  const inv = (q: Quat): Quat => [q[0], -q[1], -q[2], -q[3]];
  const right = rotate(q1, rotate(inv(q0), [1, 0, 0]));
  assert.ok(right[2] < 0 && plain.atoms[2].location[2] < 0, "yaw sends the right side back in both");
  const down = tiltAtoms(m, ids, [0.866, 0.25, 0], 0, 30).models![0].rotation, up = rotate(down, rotate(inv(q0), [0, 1, 0]));
  const plainUp = tiltAtoms(flat, ids, [0.866, 0.25, 0], 0, 30);
  assert.ok(up[2] > 0 === plainUp.atoms[1].location[2] > 0, "pitch turns the top the same way");
  // Shown as 2D, the structure turns as before.
  const asFlat = tiltAtoms(setDisplay(m, 0, "2d"), ids, [0.866, 0.25, 0], 30, 0);
  assert.notDeepEqual(asFlat.atoms[2].location, m.atoms[2].location);
}

// Scaling a structure in proportion scales its model about it; the size has limits.
{
  const m = ethanol(), s = scaleModels(m, new Set([0]), 2);
  assert.ok(near(s.models![0].size, 2 * m.models![0].size, 1e-12));
  assert.equal(scaleModels(m, new Set([7]), 2), m, "another structure's scale leaves it");
  assert.equal(scaleModels(m, new Set([0]), 1e9).models![0].size, 1e5);
}

// The morph starts flat on the drawn atoms with the added hydrogens hidden, and ends on the model.
{
  const m = ethanol({ hydrogens: [{ parent: 0, xyz: [-1.6, -0.6, 0.9] }] });
  const start = prims(m, { paper: "#ffffff", morph: 0 }), end = prims(m, { paper: "#ffffff", morph: 1 }), settled = prims(m);
  assert.deepEqual(end, settled, "morph 1 is the settled model");
  const v = viewOf(m, m.models![0])!;
  const balls = start.filter((x) => x.kind === "sphere") as Extract<Prim3d, { kind: "sphere" }>[];
  for (const i of [0, 1, 2, 3, 4]) {
    const a = m.atoms[i].location;
    assert.ok(balls.some((b) => near(b.c[0], a[0], 1e-6) && near(b.c[1], -a[1], 1e-6)), `atom ${i} starts on its drawn place`);
  }
  assert.ok(start.some((x) => x.kind === "opacity" && x.alpha === 0), "the added hydrogen is hidden at the start");
  assert.ok(v);
  assert.ok(!JSON.stringify(writeModel(m.models![0])).includes("morph"), "a morph is never saved");
}

// Each style draws its own shapes.
{
  const stick = kinds(prims(ethanol({ style: "stick" })));
  assert.equal(stick.quad, 8, "stick: eight halves");
  assert.equal(stick.contour, 1, "stick: one outline behind all");
  const wire = prims(ethanol({ style: "wireframe" }), {}), wires = wire.filter((x) => x.kind === "wire") as Extract<Prim3d, { kind: "wire" }>[];
  assert.equal(wires.length, 8, "wireframe: eight wires");
  assert.equal(new Set(wires.map((w) => w.width.toFixed(9))).size, 1, "one width");
  const lum = (c: string) => parseInt(c.slice(1, 3), 16) + parseInt(c.slice(3, 5), 16) + parseInt(c.slice(5, 7), 16);
  const m = ethanol({ style: "wireframe" }), v = viewOf(m, m.models![0])!, cIdx = 0, [cStart] = project(v, v.rotated[cIdx]);
  const cWire = wires.find((w) => near(w.from[0], cStart[0], 1e-9) && near(w.from[1], cStart[1], 1e-9))!;
  assert.ok(lum(cWire.colour) < lum(colourOf("C")) * 0.7, "carbon's wire is darker than its ball");
  const space = prims(ethanol({ style: "spaceFilling" })), spheres = space.filter((x) => x.kind === "sphere") as Extract<Prim3d, { kind: "sphere" }>[];
  assert.equal(space.length, 5, "space-filling: five balls and nothing else");
  assert.equal(spheres.length, 5);
  assert.ok(near(radiusOf("H", "spaceFilling") / radiusOf("C", "spaceFilling"), 1.1 / 1.7, 1e-12));
}

// Hydrogens: all, polar (on N, O or S) or none.
{
  const count = (m: Mol) => { const k = kinds(prims(m)); return [k.sphere ?? 0, k.quad ?? 0]; };
  assert.deepEqual(count(ethanol()), [5, 8]);
  assert.deepEqual(count(ethanol({ hydrogensShown: "polar" })), [4, 6]);
  assert.deepEqual(count(ethanol({ hydrogensShown: "none" })), [3, 4]);
  const h2 = { atoms: [atom("H", 0, 0), atom("H", 1, 0)], bonds: [{ type: 1, atoms: [0, 1] as [number, number] }] } as Mol;
  const model = newModel(h2, [0, 1], { xyz: [[0, 0, 0], [0.74, 0, 0]] }, "3d", { hydrogensShown: "none" } as Partial<Model3d>);
  assert.deepEqual(shownOf({ ...model, hydrogensShown: "none" }), [true, true], "a molecule of hydrogen only stays shown");
}

// A wireframe atom with no shown bond is a flat dot.
{
  const water = { atoms: [atom("O", 0, 0)], bonds: [] } as Mol, model = newModel(water, [0], { xyz: [[0, 0, 0]], hydrogens: [{ parent: 0, xyz: [0.96, 0, 0] }, { parent: 0, xyz: [-0.24, 0.93, 0] }] }, "3d");
  const p = modelPrimitives({ ...water, models: [{ ...model, style: "wireframe", hydrogensShown: "none" }] }, { ...model, style: "wireframe", hydrogensShown: "none" });
  assert.equal(p.length, 1);
  const dot = p[0] as Extract<Prim3d, { kind: "sphere" }>;
  assert.ok(dot.kind === "sphere" && dot.stops.every((s) => s[1] === dot.stops[0][1]) && !dot.outline, "one flat colour, no outline");
}

// Glossy: brighter highlights and no outlines.
{
  const p = prims(ethanol({ look: "glossy" }));
  const ball = p.find((x) => x.kind === "sphere") as Extract<Prim3d, { kind: "sphere" }>, half = p.find((x) => x.kind === "quad") as Extract<Prim3d, { kind: "quad" }>;
  assert.deepEqual(ball.stops.map((s) => s[0]), [0, 0.18, 0.75, 1]);
  assert.equal(half.stops[1][0], 0.3);
  assert.ok(p.every((x) => !("outline" in x) || x.outline === undefined), "no outlines");
}

// Both halves of a bond meet in the middle, with one shading line across them.
{
  const m = ethanol(), v = viewOf(m, m.models![0])!, p = prims(m).filter((x) => x.kind === "quad") as Extract<Prim3d, { kind: "quad" }>[];
  const [c0] = project(v, v.rotated[0]), [c1] = project(v, v.rotated[1]), mid = [(v.rotated[0][0] + v.rotated[1][0]) / 2, (v.rotated[0][1] + v.rotated[1][1]) / 2, (v.rotated[0][2] + v.rotated[1][2]) / 2] as V3;
  const [middle] = project(v, mid);
  const halves = p.filter((q) => [c0, c1].some((c) => near((q.corners[0][0] + q.corners[3][0]) / 2, c[0], 1e-9) && near((q.corners[0][1] + q.corners[3][1]) / 2, c[1], 1e-9)) && near((q.from[0] + q.to[0]) / 2, middle[0], 1e-9));
  assert.equal(halves.length, 2, "two halves of the C–C bond");
  assert.ok(near(halves[0].from[0], halves[1].from[0], 1e-9) && near(halves[0].to[1], halves[1].to[1], 1e-9), "the same gradient line");
}

// Labels: none by default; heteroatoms leave out C and H; all shows every shown atom, at its own depth.
{
  const texts = (m: Mol) => prims(m).filter((x) => x.kind === "text").map((x) => (x as { text: string }).text).sort();
  assert.deepEqual(texts(ethanol()), []);
  assert.deepEqual(texts(ethanol({ labels: "heteroatoms" })), ["O"]);
  assert.deepEqual(texts(ethanol({ labels: "all" })), ["C", "C", "H", "H", "O"]);
  assert.deepEqual(texts(ethanol({ labels: "all", hydrogensShown: "none" })), ["C", "C", "O"]);
}

// The fingerprint ignores moves and colours; charges, bond orders, wedges and new atoms change it.
{
  const m = ethanol(), model = m.models![0];
  assert.ok(!isStale(m, model));
  const moved = { ...m, atoms: m.atoms.map((a) => ({ ...a, location: [a.location[0] + 3, a.location[1] - 1, 0.5] as [number, number, number], colour: "#ff0000" })) };
  assert.ok(!isStale(moved, model), "moving and colouring keep it current");
  assert.ok(isStale({ ...m, atoms: m.atoms.map((a, i) => (i === 2 ? { ...a, charge: -1 } : a)) }, model), "a charge");
  assert.ok(isStale({ ...m, bonds: m.bonds.map((b, i) => (i === 0 ? { ...b, type: 2 } : b)) }, model), "a bond order");
  assert.ok(isStale({ ...m, bonds: m.bonds.map((b, i) => (i === 0 ? { ...b, stereo: 1 } : b)) }, model), "a wedge");
  assert.ok(isStale({ ...m, atoms: [...m.atoms, atom("Cl", 3, 3)], bonds: [...m.bonds, { type: 1, atoms: [1, 5] }] }, model), "a new atom on the structure");
  assert.equal(fingerprintOf(m, model.sources), model.fingerprint);
  assert.ok(model.fingerprint.length < 400, "small");
}

// Deleting an atom keeps the model (stale); other edits keep it current. Atoms of other structures renumber it.
{
  const m = ethanol(), gone = deleteAtoms(m, new Set([3]));
  assert.equal(gone.models?.length, 1, "the model stays");
  assert.deepEqual(gone.models![0].sources, [0, 1, 2, null, 3], "renumbered, the deleted one null");
  assert.ok(isStale(gone, gone.models![0]));
  const before = { ...m, atoms: [atom("Br", -5, -5), ...m.atoms], bonds: m.bonds.map((b) => ({ ...b, atoms: [b.atoms[0] + 1, b.atoms[1] + 1] as [number, number] })), models: remapModels(m.models, (i) => i + 1) };
  assert.deepEqual(before.models![0].sources, [1, 2, 3, 4, 5]);
  const after = deleteAtoms(before, new Set([0]));
  assert.deepEqual(after.models![0].sources, [0, 1, 2, 3, 4], "renumbered when another atom goes");
  assert.ok(!isStale(after, after.models![0]));
  assert.equal(deleteAtoms(m, new Set([0, 1, 2, 3, 4])).models, undefined, "the whole structure gone takes its model");
}

// Copy and paste carry the model with its whole structure, renumbered; a part of it leaves the model behind.
{
  const m = { ...ethanol(), atoms: [...ethanol().atoms, atom("Br", -5, -5)] };
  const copy = extractSelection(m, new Set([0, 1, 2, 3, 4]), new Set());
  assert.equal(copy.models?.length, 1);
  assert.equal(extractSelection(m, new Set([0, 1, 2]), new Set()).models, undefined);
  const { mol } = insertMol(m, copy, [5, 0]);
  assert.equal(mol.models?.length, 2);
  assert.deepEqual(mol.models![1].sources, [6, 7, 8, 9, 10]);
  assert.ok(!isStale(mol, mol.models![1]));
  assert.equal(modelOf(mol, [8]), 1);
  // The pasted model is drawn at its own structure, 5 bond lengths to the right.
  const f0 = frameOf(mol, mol.models![0])!, f1 = frameOf(mol, mol.models![1])!;
  assert.ok(near(f1[0][0] - f0[0][0], 5, 1e-9));
}

// Show as 3D, both and 2D: the 2D drawing is hidden only for 3D; both puts the model beside the structure.
{
  const m = ethanol();
  assert.deepEqual([...shownAs3d(m)], [0, 1, 2, 3, 4]);
  const both = setDisplay(m, 0, "both");
  assert.equal(shownAs3d(both).size, 0);
  const f = frameOf(both, both.models![0])!;
  assert.ok(f[0][0] > Math.max(...m.atoms.map((a) => a.location[0])), "beside, to the right");
  assert.deepEqual(setDisplay(both, 0, "3d").models![0].offset, [0, 0]);
  assert.equal(describeModel(both.models![0]), "3D model, ball and stick, beside its structure");
}

// A new model of a drawn ring: Octet's 3D Clean Up gives a chair, a C–C bond about 1.52 Å.
{
  const ring = addRing(EMPTY, 6, false, { point: [0, 0] }), ids = ring.atoms.map((_, i) => i), g = drawnGeometry(ring, ids);
  const d = Math.hypot(g.xyz[0][0] - g.xyz[1][0], g.xyz[0][1] - g.xyz[1][1], g.xyz[0][2] - g.xyz[1][2]);
  assert.ok(near(d, 1.52, 0.08), `C–C ${d}`);
  const zs = g.xyz.map((p) => p[2]);
  assert.ok(Math.max(...zs) - Math.min(...zs) > 0.3, "puckered");
  const model = newModel(ring, ids, g, "3d");
  assert.ok(unitQ(model.rotation) && model.size > 1);
}

// Octet's file keeps models (and an old file without them opens); a damaged model is left out, the structure kept.
{
  const m = ethanol({ style: "stick", look: "glossy", hydrogensShown: "polar", labels: "heteroatoms", scheme: "vesta", field: "MMFF94s", seed: 12 });
  const back = parse(serialize(m));
  assert.deepEqual(back.models, m.models?.map((x) => readModel(writeModel(x), 5)));
  assert.equal(back.models![0].style, "stick");
  assert.equal(back.models![0].scheme, "vesta");
  assert.ok(near(back.models![0].xyz[2][0], 1.0, 1e-9));
  const old = JSON.parse(serialize(m));
  delete old.models;
  assert.equal(parse(JSON.stringify(old)).models, undefined);
  for (const bad of [{ ...writeModel(m.models![0]), sources: [0, 1, 2, 3, 99] }, { ...writeModel(m.models![0]), rotation: [2, 0, 0, 0] }, { ...writeModel(m.models![0]), xyz: [[0, 0]] }, { ...writeModel(m.models![0]), display: "4d" }, "x"]) {
    const j = JSON.parse(serialize(m));
    j.models = [bad];
    const read = parse(JSON.stringify(j));
    assert.equal(read.models, undefined, "a damaged model is left out");
    assert.equal(read.atoms.length, 5);
  }
}

// CDXML (and so CDX and the clipboard) keeps the 2D structure only.
{
  const xml = toCdxml(ethanol(), DEFAULT_STYLE);
  assert.equal((xml.match(/<n\s/g) ?? []).length, 5);
  assert.ok(!/model|radialGradient/i.test(xml));
}

// Colour schemes: Octet's own, VESTA and Jmol (pymatgen's tables).
{
  assert.equal(colourOf("O"), "#e0483d");
  assert.equal(colourOf("O", "jmol"), "#ff0d0d");
  assert.equal(colourOf("O", "vesta"), "#fe0300");
  assert.equal(colourOf("Fe"), colourOf("Fe", "jmol"), "Octet's own falls back to Jmol's");
  assert.equal(colourOf("Xx"), "#999999");
}

// A screen reader hears that a structure shows as a 3D model.
{
  assert.match(structureText(ethanol(), [0, 1, 2, 3, 4], {}).name, /3D model, ball and stick$/);
  assert.doesNotMatch(structureText(setDisplay(ethanol(), 0, "2d"), [0, 1, 2, 3, 4], {}).name, /3D/);
}

console.log("model3d checks pass");
