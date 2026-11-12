// Run: node src/ortep.check.ts. Fails loudly if ORTEP ellipsoids (a crystal model's Ellipsoids style) stop matching
// their displacement parameters, or stop drawing as they should. ReShiki's ellipsoid and ORTEP tests
// (crates/model/src/models3d/ellipsoids/tests.rs, ortep_tests.rs), rewritten with our own small structures and U values.
import assert from "node:assert/strict";
import { cartesianU, eigenSym3, ellipseExit, ellipsoidOf, ellipsoidSections, FIXED_RADIUS, PROBABILITY_SCALE, projectEllipsoid, radiusAlong, rotatedEllipsoid, sphere, type Ellipsoid } from "./ortep.ts";
import { crystalView, setCrystal } from "./crystalcell.ts";
import { describeModel, modelPrimitives, primitiveNodes, project, readModel, rotate, viewOf, svgText, writeModel, type Model3d, type Prim3d, type V3 } from "./model3d.ts";
import { parse, serialize } from "./file.ts";
import type { Mol } from "./render.ts";

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
type M3 = [V3, V3, V3];
const mul = (a: number[][], b: number[][]) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
const T = (a: number[][]) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[j][i]));
const same = (a: number[][], b: number[][], tol: number) => a.every((r, i) => r.every((v, j) => near(v, b[i][j], tol)));

// ---- U to Cartesian ----
{
  const u: [number, number, number, number, number, number] = [0.02, 0.03, 0.04, 0.005, -0.004, 0.003];
  const sym = [[0.02, 0.005, -0.004], [0.005, 0.03, 0.003], [-0.004, 0.003, 0.04]];
  for (const cell of [[[3, 0, 0], [0, 3, 0], [0, 0, 3]], [[3, 0, 0], [0, 5, 0], [0, 0, 7]]] as M3[]) assert.ok(same(cartesianU(u, cell), sym, 1e-12), "an orthogonal cell leaves U as it is");
  // A skew cell: A N U N Aᵀ, with A the vectors as columns and N their reciprocal lengths (here √2, 1, 1).
  const skew: M3 = [[1, 0, 0], [1, 1, 0], [0, 0, 1]], A = T(skew), N = [[Math.SQRT2, 0, 0], [0, 1, 0], [0, 0, 1]];
  assert.ok(same(cartesianU(u, skew), mul(mul(mul(mul(A, N), sym), N), T(A)), 5e-6));
  assert.ok(same(cartesianU([1, 1, 1, 0, 0, 0], skew), [[3, 1, 0], [1, 1, 0], [0, 0, 1]], 1e-12));
}

// ---- Jacobi ----
{
  const m: M3 = [[2, 1, 0], [1, 2, 0], [0, 0, 4]], { values, vectors } = eigenSym3(m);
  assert.deepEqual([...values].sort().map((v) => Math.round(v * 1e9) / 1e9), [1, 3, 4]);
  assert.ok(same(mul(vectors, T(vectors)), [[1, 0, 0], [0, 1, 0], [0, 0, 1]], 1e-12), "orthonormal");
  assert.ok(same(mul(mul(T(vectors), values.map((v, i) => [0, 1, 2].map((j) => (i === j ? v : 0)))), vectors), m, 1e-12), "V Λ Vᵀ = M");
}

// ---- Probability ----
{
  for (const p of [30, 50, 70, 90] as const) {
    const e = ellipsoidOf({ iso: 0.04 }, undefined, p)!;
    assert.ok(e.axes.every((a, i) => near(a[i], 0.2 * PROBABILITY_SCALE[p], 1e-12)) && !e.anisotropic);
  }
  assert.ok(near(ellipsoidOf({ iso: 0.04 })!.axes[0][0], 0.2 * 1.5381722), "50% by default");
  const cell: M3 = [[5, 0, 0], [0, 5, 0], [0, 0, 5]];
  for (const bad of [[0.01, 0.01, -0.01, 0, 0, 0], [0.01, 0.01, 0.01, 0.02, 0, 0], [0, 0, 0, 0, 0, 0]] as const) assert.equal(ellipsoidOf({ aniso: [...bad] }, cell), undefined, "not positive definite");
  assert.equal(ellipsoidOf({ iso: 0 }), undefined);
  assert.equal(ellipsoidOf({ iso: -0.01 }), undefined);
  assert.equal(ellipsoidOf({ aniso: [0.01, 0.02, 0.03, 0, 0, 0] }, undefined), undefined, "an anisotropic U needs its cell");
  const e = ellipsoidOf({ aniso: [0.01, 0.04, 0.09, 0, 0, 0] }, cell, 50)!;
  assert.ok(e.anisotropic);
  assert.deepEqual(e.axes.map((a) => Math.round(Math.hypot(...a) * 1e6) / 1e6).sort(), [0.1, 0.2, 0.3].map((r) => Math.round(r * 1.5381722 * 1e6) / 1e6));
  assert.ok(near(radiusAlong(e, [0, 0, 1]), 0.3 * 1.5381722, 1e-9));
}

// ---- Silhouettes ----
{
  const e: Ellipsoid = { axes: [[2, 0, 0], [0, 1, 0], [0, 0, 0.5]], anisotropic: true }, r = (p: { axes: [number, number][] }) => p.axes.map((a) => Math.hypot(...a));
  const flat = projectEllipsoid(e, [0, 0, 0], { scale: 10, origin: [30, 40] })!;
  assert.deepEqual(flat.c, [30, -40]);
  assert.ok(near(r(flat)[0], 20, 1e-9) && near(r(flat)[1], 10, 1e-9));
  const deep = projectEllipsoid(e, [0, 0, 0], { scale: 10, origin: [30, 40], camera: 10 })!, k = 1 / Math.sqrt(1 - 0.25 / 100);
  assert.ok(near(r(deep)[0], 20 * k, 1e-9) && near(r(deep)[1], 10 * k, 1e-9));
  const off = projectEllipsoid(sphere(1), [3, 0, 0], { scale: 10, origin: [30, 40], camera: 10 })!;
  assert.ok(near(off.c[0], 30 + 3000 / 99, 1e-9), "the perspective moves the outline off the centre");
  assert.equal(projectEllipsoid(sphere(2), [0, 0, 9], { scale: 10, origin: [0, 0], camera: 10 }), undefined, "behind the camera");
  assert.ok(near(ellipseExit(flat, flat.c, [1, 0])!, 20, 1e-9));
  assert.ok(near(ellipseExit(flat, flat.c, [0, 1])!, 10, 1e-9));
}

// ---- Every perspective rim ray touches the ellipsoid ----
{
  const turn = (v: V3): V3 => rotate([0.9, 0.3, -0.2, 0.25].map((x, _, q) => x / Math.hypot(...q)) as [number, number, number, number], v);
  const e = rotatedEllipsoid({ axes: [[1.2, 0, 0], [0, 0.7, 0], [0, 0, 0.4]], anisotropic: true }, turn), c: V3 = [0.8, -0.5, 1.1], K = 12, lens = { scale: 7, origin: [3, 4] as [number, number], camera: K };
  const p = projectEllipsoid(e, c, lens)!, B = [0, 1, 2].map((i) => [0, 1, 2].map((j) => e.axes.reduce((s, a) => s + a[i] * a[j], 0)));
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const inv = (m: number[][]) => { const d = det(m); return [0, 1, 2].map((i) => [0, 1, 2].map((j) => { const r = [0, 1, 2].filter((x) => x !== j), s = [0, 1, 2].filter((x) => x !== i); return ((i + j) % 2 ? -1 : 1) * (m[r[0]][s[0]] * m[r[1]][s[1]] - m[r[0]][s[1]] * m[r[1]][s[0]]) / d; })); };
  const Q = inv(B);
  for (let k = 0; k < 24; k++) {
    const t = (2 * Math.PI * k) / 24, q = [p.c[0] + p.axes[0][0] * Math.cos(t) + p.axes[1][0] * Math.sin(t), p.c[1] + p.axes[0][1] * Math.cos(t) + p.axes[1][1] * Math.sin(t)];
    // The camera ray through the page point: (X s, Y s, K − K s) for s ≥ 0, with X, Y the point on the plane z = 0.
    const X = (q[0] - lens.origin[0]) / lens.scale, Y = (-q[1] - lens.origin[1]) / lens.scale, d: V3 = [X, Y, -K], o: V3 = [-c[0], -c[1], K - c[2]];
    const quad = (u: V3, v: V3) => [0, 1, 2].reduce((s, i) => s + [0, 1, 2].reduce((r, j) => r + u[i] * Q[i][j] * v[j], 0), 0);
    const a = quad(d, d), b = 2 * quad(o, d), cc = quad(o, o) - 1, disc = (b * b - 4 * a * cc) / (a * a);
    assert.ok(Math.abs(disc) < 2e-5, `rim ray ${k} is tangent (${disc})`);
  }
}

// ---- Sections ----
{
  const e: Ellipsoid = { axes: [[0.3, 0.1, 0.05], [-0.1, 0.25, 0.1], [0.02, -0.08, 0.2]], anisotropic: true };
  const s = ellipsoidSections(e, [0, 0, 0], { scale: 10, origin: [0, 0] });
  assert.equal(s.arcs.length, 3);
  assert.ok(s.arcs.every((a) => a.length === 65));
  assert.equal(s.octant.length, 72);
}

// ---- The painter: ellipsoids from ADPs, fixed spheres for the rest ----
// A small cubic cell (8 Å) holding one molecule of our own: C (anisotropic), O (isotropic), H, N with a bad tensor and
// F with no displacement parameters. All listed input sites.
const ortepMol = (crystal: Partial<NonNullable<Model3d["crystal"]>> = {}, style: Model3d["style"] = "ellipsoids"): Mol => {
  const xyz: V3[] = [[4, 4, 4], [5.25, 4, 4], [3.6, 4.95, 4], [3.5, 3.1, 4.6], [3.4, 3.4, 3.1]], elements = ["C", "O", "H", "N", "F"];
  const bonds: [number, number][] = [[0, 1], [0, 2], [0, 3], [0, 4]];
  const model: Model3d = { sources: [0, 1, 2, 3, 4], elements, xyz, bonds, fingerprint: "", rotation: [1, 0, 0, 0], offset: [0, 0], size: 4, display: "3d", style,
    crystal: { vectors: [[8, 0, 0], [0, 8, 0], [0, 0, 8]], sites: [{ atom: 0, adp: { aniso: [0.03, 0.02, 0.015, 0.004, 0.002, -0.003] }, asymmetric: true }, { atom: 1, adp: { iso: 0.025 }, asymmetric: true }, { atom: 2, adp: { iso: 0.04 }, asymmetric: true }, { atom: 3, adp: { aniso: [0.01, 0.01, -0.02, 0, 0, 0] }, asymmetric: true }, { atom: 4, asymmetric: true }], moleculeOnly: true, ...crystal } };
  return { atoms: elements.map((label, i) => ({ label, location: [xyz[i][0], xyz[i][1], 0], implicitHCount: 0 })), bonds: bonds.map((atoms) => ({ type: 1, atoms })), models: [model] };
};
{
  const m = ortepMol(), prims = modelPrimitives(m, m.models![0], { paper: "#ffffff" });
  const ells = prims.filter((p): p is Extract<Prim3d, { kind: "ellipsoid" }> => p.kind === "ellipsoid"), balls = prims.filter((p): p is Extract<Prim3d, { kind: "sphere" }> => p.kind === "sphere");
  assert.equal(ells.length, 2, "C and O have ellipsoids");
  assert.equal(ells.filter((e) => e.section).length, 1, "only the anisotropic one has its sections");
  assert.equal(balls.length, 3, "H, the bad tensor and the atom without ADPs are fixed spheres");
  assert.ok(balls.every((b) => near(b.r, balls[0].r, 0.15 * balls[0].r)), "of one size (but for the perspective)");
  const { view } = crystalView(m, m.models![0], [0, 0]);
  assert.ok(near(balls[0].r, FIXED_RADIUS * view.scale * (view.camera / (view.camera - view.rotated[2][2])), 0.2 * balls[0].r));
  // 50% to 90%: every ellipsoid grows by the ratio of their scales, against the view's own scale.
  const at90 = setCrystal(m, 0, { probability: 90 }), v90 = crystalView(at90, at90.models![0], [0, 0]).view;
  const radii = (x: Mol, v: typeof view) => modelPrimitives(x, x.models![0], { paper: "#ffffff" }).filter((p): p is Extract<Prim3d, { kind: "ellipsoid" }> => p.kind === "ellipsoid").map((e) => Math.hypot(...e.axes[0]) / v.scale);
  radii(at90, v90).forEach((r, k) => assert.ok(near(r / radii(m, view)[k], 2.5002778 / 1.5381722, 0.03), `${r / radii(m, view)[k]}`));
  assert.deepEqual(at90.atoms, m.atoms, "atoms unchanged");
  assert.deepEqual(at90.bonds, m.bonds);
  // The SVG of an ellipsoid: a gradient in its own frame, and its section's lines.
  const svg = svgText(primitiveNodes(prims, "o"));
  assert.ok(svg.includes("<ellipse") && svg.includes("gradientTransform=\"scale(") && svg.includes("rotate("));
  assert.equal((svg.match(/<path/g) ?? []).length >= 2, true, "octant and arcs");
  // Bonds start at the atom centres.
  const quads = prims.filter((p): p is Extract<Prim3d, { kind: "quad" }> => p.kind === "quad");
  assert.ok(quads.length >= 4);
  const shownView = viewOf(m, m.models![0])!, centres = shownView.rotated.map((r) => project(shownView, r)[0]);
  for (const q of quads) {
    const start: [number, number] = [(q.corners[0][0] + q.corners[3][0]) / 2, (q.corners[0][1] + q.corners[3][1]) / 2];
    assert.ok(centres.some((c) => Math.hypot(c[0] - start[0], c[1] - start[1]) < 1e-6), "a half-bond starts at its atom's centre");
  }
  assert.equal(describeModel(m.models![0]), "3D model, 50% probability ellipsoids");
}
{
  // Where the two surfaces touch or overlap, no bond is drawn.
  for (const gap of [0, 0.1]) {
    const m = ortepMol();
    m.models![0].xyz[1] = [4 + gap, 4, 4];
    const quads = modelPrimitives(m, m.models![0], { paper: "#ffffff" }).filter((p) => p.kind === "quad");
    assert.equal(quads.length, 6, `the C–O bond at ${gap} Å is left out`);
  }
}
{
  // Molecule only: atoms it hides do not move the frame, however far away.
  const m = ortepMol();
  const far = { ...m, atoms: [...m.atoms, { label: "Cl", location: [0, 0, 0] as V3, implicitHCount: 0 }], models: [{ ...m.models![0], sources: [...m.models![0].sources, 5], elements: [...m.models![0].elements, "Cl"], xyz: [...m.models![0].xyz, [900, 900, 900] as V3] }] };
  const a = crystalView(m, m.models![0], [0, 0]).view, b = crystalView(far, far.models![0], [0, 0]).view;
  assert.ok(near(a.reach, b.reach, 1e-9) && a.centre.every((v, k) => near(v, b.centre[k], 1e-9)));
  // The packing view (Molecule only off) holds the cell as well.
  const packed = setCrystal(m, 0, { moleculeOnly: undefined });
  assert.ok(crystalView(packed, packed.models![0], [0, 0]).view.reach > a.reach);
}
{
  // Settings: defaults are not written; the others are saved and read back; damaged ones fall back to defaults.
  const m = ortepMol({ moleculeOnly: undefined }), x = writeModel(m.models![0]) as { crystal: Record<string, unknown> };
  for (const key of ["probability", "moleculeOnly", "includeSolvent", "repeat", "copyOpacity", "along"]) assert.ok(!(key in x.crystal) || x.crystal[key] === undefined, key);
  const set = ortepMol({ probability: 70, includeSolvent: false });
  const back = parse(serialize(set)).models![0];
  assert.equal(back.style, "ellipsoids");
  assert.equal(back.crystal!.probability, 70);
  assert.equal(back.crystal!.moleculeOnly, true);
  assert.equal(back.crystal!.includeSolvent, false);
  const bad = readModel({ ...writeModel(set.models![0]), crystal: { ...writeModel(set.models![0]).crystal as object, probability: 40, repeat: [9, 1, 1], copyOpacity: 2 } }, 5)!;
  assert.equal(bad.crystal!.probability, undefined);
  assert.equal(bad.crystal!.repeat, undefined);
  assert.equal(bad.crystal!.copyOpacity, undefined);
  // An ellipsoids style without a cell is not a style a plain model has.
  const plain = readModel({ ...writeModel(set.models![0]), crystal: undefined }, 5)!;
  assert.equal(plain.style, undefined);
  // An unsound cell leaves a plain model.
  assert.equal(readModel({ ...writeModel(set.models![0]), crystal: { vectors: [[1, 0, 0], [0, 1, 0]] } }, 5)!.crystal, undefined);
  assert.equal(readModel({ ...writeModel(set.models![0]), crystal: { vectors: [[8, 0, 0], [0, 8, 0], [0, 0, 8]], sites: [{ atom: 99 }] } }, 5)!.crystal, undefined);
}

console.log("ortep.check: all passed");
