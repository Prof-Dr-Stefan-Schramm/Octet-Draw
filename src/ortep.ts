// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/model/src/models3d/ellipsoids.rs and crates/model/src/scene/svg.rs (Primitive::Ellipsoid), MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// ORTEP displacement ellipsoids: a crystal's displacement parameters (U, in Å²) as Cartesian ellipsoids at a chosen
// probability, and their exact outlines, principal-plane lines and front octant on the page. Pure maths; the 3D
// model painter (model3d.ts paintScene) draws them.

import type { Adp, V3 } from "./model3d.ts";

type P = [number, number];
type M3 = [V3, V3, V3];
export type Probability = 30 | 50 | 70 | 90;
// The square root of the chi-square quantile with three degrees of freedom: the semi-axis of an ellipsoid that holds
// the atom with this probability is √λ times it.
export const PROBABILITY_SCALE: Record<Probability, number> = { 30: 1.193169, 50: 1.5381722, 70: 1.9143852, 90: 2.5002778 };
// The radius (Å) of the small fixed sphere for hydrogens, atoms without displacement parameters and bad tensors.
export const FIXED_RADIUS = 0.18;
const FOCAL_RADIUS = 0.05;

// Orthogonal principal semi-axis vectors, already scaled to the probability.
export type Ellipsoid = { axes: M3; anisotropic: boolean };
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export const sphere = (r: number): Ellipsoid => ({ axes: [[r, 0, 0], [0, r, 0], [0, 0, r]], anisotropic: false });
// The ellipsoid of a displacement parameter, or none for a non-positive-definite one. cell: the lattice vectors (Å),
// needed for an anisotropic U.
export function ellipsoidOf(adp: Adp, cell: M3 | undefined, p: Probability = 50): Ellipsoid | undefined {
  const k = PROBABILITY_SCALE[p];
  if ("iso" in adp) return Number.isFinite(adp.iso) && adp.iso > 0 ? sphere(Math.sqrt(adp.iso) * k) : undefined;
  if (!cell) return undefined;
  const { values, vectors } = eigenSym3(cartesianU(adp.aniso, cell));
  if (values.some((v) => !Number.isFinite(v) || v <= 0)) return undefined;
  return { axes: vectors.map((v, i) => v.map((x) => x * Math.sqrt(values[i]) * k)) as M3, anisotropic: true };
}
export const rotatedEllipsoid = (e: Ellipsoid, turn: (v: V3) => V3): Ellipsoid => ({ ...e, axes: e.axes.map(turn) as M3 });
export const ellipsoidRadius = (e: Ellipsoid) => Math.max(...e.axes.map(len));
// The distance from the centre to the surface along a direction.
export function radiusAlong(e: Ellipsoid, d: V3): number {
  const inverse = e.axes.reduce((s, a) => s + (dot(a, d) / dot(a, a)) ** 2, 0);
  return len(d) / Math.sqrt(inverse);
}

// CIF U is in the basis of the reciprocal-length-scaled lattice vectors: U_cart = A N U N Aᵀ, with A the lattice
// vectors as columns and N = diag(|a*|, |b*|, |c*|).
export function cartesianU(u: [number, number, number, number, number, number], v: M3): M3 {
  const volume = dot(v[0], cross(v[1], v[2]));
  const n = [cross(v[1], v[2]), cross(v[2], v[0]), cross(v[0], v[1])].map((a) => len(a) / volume);
  const [xx, yy, zz, xy, xz, yz] = u, m = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]];
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => {
    let s = 0;
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) s += v[a][i] * n[a] * m[a][b] * n[b] * v[b][j];
    return s;
  })) as M3;
}
// Cyclic Jacobi on a symmetric 3×3: eigenvalues and eigenvectors (as rows).
export function eigenSym3(input: M3): { values: V3; vectors: M3 } {
  const a = input.map((r) => [...r]), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 32; it++) {
    let [p, q] = [0, 1];
    for (const [i, j] of [[0, 2], [1, 2]]) if (Math.abs(a[i][j]) > Math.abs(a[p][q])) [p, q] = [i, j];
    if (Math.abs(a[p][q]) <= Number.EPSILON * Math.max(Math.abs(a[0][0]), Math.abs(a[1][1]), Math.abs(a[2][2]))) break;
    const angle = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), s = Math.sin(angle), c = Math.cos(angle);
    const [pp, qq, pq] = [a[p][p], a[q][q], a[p][q]];
    a[p][p] = c * c * pp - 2 * s * c * pq + s * s * qq;
    a[q][q] = s * s * pp + 2 * s * c * pq + c * c * qq;
    a[p][q] = a[q][p] = 0;
    for (let k = 0; k < 3; k++) {
      if (k !== p && k !== q) {
        const [kp, kq] = [a[k][p], a[k][q]];
        a[k][p] = a[p][k] = c * kp - s * kq;
        a[k][q] = a[q][k] = s * kp + c * kq;
      }
      const [kp, kq] = [v[k][p], v[k][q]];
      v[k][p] = c * kp - s * kq;
      v[k][q] = s * kp + c * kq;
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: [0, 1, 2].map((i) => [v[0][i], v[1][i], v[2][i]]) as M3 };
}

// How the painter projects: scale (drawing units per Å), origin (drawing units, y up), and with perspective the
// camera's distance (Å, on the view's z axis). Projected points are in drawing units with y down.
export type Lens = { scale: number; origin: P; camera?: number };
const projectPoint = (l: Lens, p: V3): P => { const f = l.camera ? l.camera / (l.camera - p[2]) : 1; return [l.origin[0] + p[0] * l.scale * f, -(l.origin[1] + p[1] * l.scale * f)]; };
// An ellipse on the page: its centre and two orthogonal semi-axis vectors (y down).
export type Ellipse = { c: P; axes: [P, P] };
// The exact outline of an ellipsoid whose centre is at `centre` in view space (x right, y up, z towards the viewer):
// the dual quadric projected, then its conic's centre and shape, with the perspective's shift off the atom's centre.
export function projectEllipsoid(e: Ellipsoid, centre: V3, l: Lens): Ellipse | undefined {
  const b = [0, 1, 2].map((i) => [0, 1, 2].map((j) => e.axes.reduce((s, a) => s + a[i] * a[j], 0)));
  const [x, y, z] = centre;
  let c: P, shape: V3;
  if (l.camera) {
    const k = l.camera, h = k - z, den = h * h - b[2][2];
    if (den <= 0) return undefined;
    c = [(k * (b[0][2] + x * h)) / den, (k * (b[1][2] + y * h)) / den];
    shape = [c[0] * c[0] + (k * k * (b[0][0] - x * x)) / den, c[0] * c[1] + (k * k * (b[0][1] - x * y)) / den, c[1] * c[1] + (k * k * (b[1][1] - y * y)) / den];
  } else { c = [x, y]; shape = [b[0][0], b[0][1], b[1][1]]; }
  const s2 = l.scale * l.scale, [xx, xy, yy] = [shape[0] * s2, -shape[1] * s2, shape[2] * s2];
  const theta = 0.5 * Math.atan2(2 * xy, xx - yy), spread = Math.sqrt((xx - yy) ** 2 + 4 * xy * xy);
  const r = [(xx + yy + spread) / 2, (xx + yy - spread) / 2];
  if (r.some((v) => !Number.isFinite(v) || v <= 0)) return undefined;
  const [s, ct] = [Math.sin(theta), Math.cos(theta)], [r0, r1] = r.map(Math.sqrt);
  return { c: [l.origin[0] + c[0] * l.scale, -(l.origin[1] + c[1] * l.scale)], axes: [[r0 * ct, r0 * s], [-r1 * s, r1 * ct]] };
}
// How far a ray from `from` along the unit `dir` runs before it leaves the ellipse.
export function ellipseExit(p: Ellipse, from: P, dir: P): number | undefined {
  const w = [from[0] - p.c[0], from[1] - p.c[1]];
  let [a, b, c] = [0, 0, -1];
  for (const ax of p.axes) {
    const n = ax[0] * ax[0] + ax[1] * ax[1], d = (dir[0] * ax[0] + dir[1] * ax[1]) / n, q = (w[0] * ax[0] + w[1] * ax[1]) / n;
    a += d * d; b += 2 * d * q; c += q * q;
  }
  const root = Math.sqrt(b * b - 4 * a * c);
  return a > 0 && Number.isFinite(root) ? (root - b) / (2 * a) : undefined;
}
// The visible halves of the three principal ellipses (64 steps each) and the front octant (three quarter arcs of 24
// points: one closed patch), on the page. Only an anisotropic ellipsoid has them.
export function ellipsoidSections(e: Ellipsoid, centre: V3, l: Lens): { octant: P[]; arcs: P[][] } {
  const eye: V3 = l.camera ? [-centre[0], -centre[1], l.camera - centre[2]] : [0, 0, 1], threshold = l.camera ? 1 : 0;
  const pairs = [[0, 1], [1, 2], [2, 0]];
  const at = (a: V3, b: V3, t: number) => projectPoint(l, [0, 1, 2].map((i) => centre[i] + a[i] * Math.cos(t) + b[i] * Math.sin(t)) as V3);
  const sample = (a: V3, b: V3, start: number, end: number, steps: number) => Array.from({ length: steps + 1 }, (_, i) => at(a, b, start + ((end - start) * i) / steps));
  const arcs = pairs.flatMap(([i, j]) => {
    const [a, b] = [e.axes[i], e.axes[j]], x = dot(a, eye) / dot(a, a), y = dot(b, eye) / dot(b, b), r = Math.hypot(x, y);
    if (r <= threshold) return [];
    const middle = Math.atan2(y, x), half = Math.acos(threshold / r);
    return [sample(a, b, middle - half, middle + half, 64)];
  });
  const facing = e.axes.map((a) => (dot(a, eye) < 0 ? (a.map((v) => -v) as V3) : a));
  const octant = pairs.flatMap(([i, j]) => sample(facing[i], facing[j], 0, Math.PI / 2, 24).slice(0, 24));
  return { octant, arcs };
}
export { FOCAL_RADIUS };
