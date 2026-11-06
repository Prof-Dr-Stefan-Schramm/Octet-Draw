// The library's structures drawn in perspective, each atom at its x and y on the page and its depth z (bond lengths,
// towards the viewer), as Octet keeps a structure turned in 3D (decision 0012): chairs, Newman and sawhorse
// projections, Haworth and chair forms of hexoses, Fischer projections and paddlewheels. Clean Up leaves a structure
// with depth as drawn, and Octet reads its stereochemistry from the atoms' places. All of it is worked out here from
// simple geometry; nothing comes from another program's files.
//
// Where a stereocentre's substituent goes up or down (or axial or equatorial) the build tries each way and keeps the
// one whose InChI is the named compound's (pick, from build.mjs), so the drawing cannot be the wrong isomer.
import { chairPoints } from "../../src/edit.ts";
import { isElement } from "../../src/labels.ts";
import { clashes } from "./clashes.mjs";

const deg = Math.PI / 180;
const add = (a, b) => a.map((v, k) => v + b[k]), sub = (a, b) => a.map((v, k) => v - b[k]), mul = (a, s) => a.map((v) => v * s);
const len = (a) => Math.hypot(...a), unit = (a) => mul(a, 1 / len(a));
// Turns about the page's x axis (positive tips the top towards the viewer: seen from above) and its y axis.
const rotX = ([x, y, z], t) => [x, y * Math.cos(t) - z * Math.sin(t), y * Math.sin(t) + z * Math.cos(t)];
const rotY = ([x, y, z], t) => [x * Math.cos(t) + z * Math.sin(t), y, -x * Math.sin(t) + z * Math.cos(t)];
const r3 = (v) => Math.round(v * 1000) / 1000 + 0;

// A structure being drawn: atoms (an element, or a written label such as CH2OH) at [x, y, z], and bonds.
export class Drawing {
  constructor() { this.atoms = []; this.bonds = []; this.pairs = []; }
  atom(label, at, more = {}) {
    const element = isElement(label);
    this.atoms.push({ label: element ? label : "C", location: [at[0], at[1], at[2] ?? 0], ...(element ? {} : { text: label }), ...more });
    return this.atoms.length - 1;
  }
  bond(a, b, type = 1, more = {}) { this.bonds.push({ type, atoms: [a, b], ...more }); return this; }
  // Substituents whose labels would clash (clashes.mjs: with each other, or with a bond that is not their own, as the
  // app draws them) drawn longer or shorter along their own bonds, and a label on an upright bond read the other way
  // (HO for OH), whichever clashes least, then changes least. Each substituent in turn, a few rounds. Only lengths
  // change, so the stereochemistry stays; keep(mol) also turns down a change that a reader of 3D places (Indigo's
  // InChI) would read otherwise. The substituents: the [atom, substituent] pairs noted as they were drawn.
  spread(keep = () => true, pairs = this.pairs) {
    const base = pairs.map(([c, s]) => sub(this.atoms[s].location, this.atoms[c].location));
    const upright = (k) => Math.abs(base[k][0]) < 0.3 * Math.abs(base[k][1]);
    const away = (k) => Math.sign(base[k][0]) || 1; // 1: the label reads to the right
    const set = (fs) => pairs.forEach(([c, s], k) => {
      const a = this.atoms[s];
      a.location = add(this.atoms[c].location, mul(base[k], Math.abs(fs[k])));
      // Read the other way: HO ends at its O (right-aligned), OH starts at it.
      if (fs[k] < 0) a.align = away(k) > 0 ? "right" : "left"; else delete a.align;
    });
    const cost = (fs) => { set(fs); const m = this.done(); return keep(m) ? clashes(m).length + fs.filter((f) => f !== 1).length * 1e-3 : Infinity; };
    const options = (k) => [1, 0.8, 1.25, 0.65, 1.5, 1.8, 2.1].flatMap((f) => (upright(k) ? [f, -f] : [f]));
    let best = pairs.map(() => 1), most = cost(best);
    const better = (fs) => { const c = cost(fs); if (c < most - 1e-9) { best = fs; most = c; } };
    for (let round = 0; round < 3 && most >= 1; round++) pairs.forEach((_, k) => { for (const f of options(k)) better(best.map((x, j) => (j === k ? f : x))); });
    // Two at a time, where one at a time leaves a clash (a label that must move out of the way of another's bond).
    for (let k = 0; k < pairs.length && most >= 1; k++) for (let j = k + 1; j < pairs.length && most >= 1; j++)
      for (const f of options(k)) for (const g of options(j)) better(best.map((x, i) => (i === k ? f : i === j ? g : x)));
    set(best);
    return this;
  }
  // The drawing centred on its atoms (x and y on the middle of their box, z on their mean), rounded.
  done() {
    const xs = this.atoms.map((a) => a.location[0]), ys = this.atoms.map((a) => a.location[1]);
    const c = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, this.atoms.reduce((s, a) => s + a.location[2], 0) / this.atoms.length];
    return { atoms: this.atoms.map((a) => ({ ...a, location: sub(a.location, c).map(r3) })), bonds: this.bonds };
  }
}

// ——— Chairs ———
// The textbook chair (edit.ts chairPoints, as the Ring tool draws it): three pairs of parallel bonds, each one bond
// long. Atoms 0, 2 and 4 are up (their axial bonds point up), 1, 3 and 5 down. Its depths are a real chair's (bond
// angles 109.5°) seen from 15° above, with the ends (0 and 3) at the sides, 1 and 2 in front and 4 and 5 behind.
// flipped: the other chair (the Ring tool's Chair (flipped)), which is this one upside down.
// Each atom's axial bond is vertical; its equatorial bond is parallel to the ring bonds one removed, pointing out.
const RING = (() => {
  const r = 0.943, h = 0.1667, e = 15 * deg;
  // The real chair: atom j at 180° + 60°j round the vertical axis, up for even j. Textbook atom k is real atom (6 - k) % 6.
  const real = [0, 1, 2, 3, 4, 5].map((j) => [r * Math.cos((180 + 60 * j) * deg), j % 2 ? -h : h, r * Math.sin((180 + 60 * j) * deg)]);
  const seen = (v) => v[1] * Math.sin(e) + v[2] * Math.cos(e); // depth towards the viewer
  return [0, 1, 2, 3, 4, 5].map((k) => {
    const j = (6 - k) % 6, up = j % 2 ? -1 : 1, p = real[j];
    const near = [real[(j + 1) % 6], real[(j + 5) % 6]].map((q) => unit(sub(q, p)));
    const axial = [0, up, 0], equatorial = unit(mul(add(add(near[0], near[1]), axial), -1));
    return { z: seen(p), up, axialZ: seen(axial), equatorialZ: seen(equatorial) };
  });
})();
export function chair(flipped = false) {
  const P = chairPoints(1).map(([x, y]) => [x, flipped ? -y : y]);
  const c = mul(P.reduce((s, p) => add(s, p), [0, 0]), 1 / 6);
  return P.map((p, k) => {
    const { z, up, axialZ, equatorialZ } = RING[k], s = flipped ? -up : up;
    let eq = unit(sub(P[(k + 2) % 6], P[(k + 1) % 6]));
    if ((p[0] - c[0]) * eq[0] + (p[1] - c[1]) * eq[1] < 0) eq = mul(eq, -1);
    // Flipped upside down, up is down: a depth stays where it is, so the chair turns over in 3D as a mirror image.
    return { at: [p[0], p[1], z], axial: [0, s, axialZ], equatorial: [eq[0], eq[1], equatorialZ] };
  });
}
// A chair with a substituent (or none) in each atom's axial and equatorial places: subs[k] = [axial, equatorial].
// size: the ring's bonds this many bond lengths (a sugar's chair is drawn larger, to leave room for its labels).
function chairWith(ring, subs, flipped = false, size = 1) {
  const d = new Drawing(), at = chair(flipped).map((p) => ({ ...p, at: mul(p.at, size) }));
  const ids = at.map((p, k) => d.atom(ring[k], p.at));
  for (let k = 0; k < 6; k++) d.bond(ids[k], ids[(k + 1) % 6]);
  at.forEach((p, k) => (subs[k] ?? []).forEach((label, w) => { if (label) { const s = d.atom(label, add(p.at, w ? p.equatorial : p.axial)); d.bond(ids[k], s); d.pairs.push([ids[k], s]); } }));
  return d;
}

// ——— Newman and sawhorse projections ———
// Two carbons one behind the other down the page's z axis, each with three substituents at the angles given (degrees
// clockwise from up, as seen), leaning out of the plane as at a tetrahedral carbon: a Newman projection, which Octet
// draws with the back carbon as a circle 0.4 bond lengths across. The substituents reach 1.25 bond lengths out on the
// page, so the back bonds show clear of the circle; back: how far the back ones reach (further for an eclipsed pair,
// so the two can be told apart). turn: turned (about y, then x, radians) for a sawhorse projection, its C-C bond cc
// long and its substituents one bond length (at the tetrahedral angle).
function ethane(front, back, { reach, turn, cc = 1 } = {}) {
  const d = new Drawing(), f = d.atom("C", [0, 0, cc / 2]), b = d.atom("C", [0, 0, -cc / 2]);
  d.bond(f, b);
  const r = turn ? 0.943 : 1.25, lean = turn ? 0.333 : 0.35;
  const out = (t, r, z) => [r * Math.sin(t * deg), r * Math.cos(t * deg), z];
  const label = (s) => (s === "CH3" ? ["C", { shown: true }] : [s, {}]);
  for (const [t, s] of front) { const [l, more] = label(s); d.bond(f, d.atom(l, out(t, r, cc / 2 + lean), more)); }
  for (const [t, s] of back) { const [l, more] = label(s); d.bond(b, d.atom(l, out(t, reach ?? r, -cc / 2 - lean), more)); }
  if (turn) for (const a of d.atoms) a.location = rotX(rotY(a.location, turn[0]), turn[1]);
  return d.done();
}
const STAGGERED = [[0, 120, 240], [60, 180, 300]], ECLIPSED = [[0, 120, 240], [20, 140, 260]];
const SAWHORSE = { turn: [-48 * deg, 40 * deg], cc: 1.6 };
export function conformers() {
  const H3 = (ts, first = "H") => ts.map((t, k) => [t, k ? "H" : first]);
  return [
    { name: "Cyclohexane chair", also: "conformer", mol: chairWith(Array(6).fill("C"), []).done() },
    { name: "Cyclohexane chair (flipped)", also: "conformer, ring flip", mol: chairWith(Array(6).fill("C"), [], true).done() },
    { name: "Chair, axial and equatorial H", also: "cyclohexane chair, conformer", mol: chairWith(Array(6).fill("C"), Array(6).fill(["H", "H"])).spread().done() },
    { name: "Chair, axial and equatorial H (flipped)", also: "cyclohexane chair, conformer, ring flip", mol: chairWith(Array(6).fill("C"), Array(6).fill(["H", "H"]), true).spread().done() },
    { name: "Newman projection, staggered", also: "ethane, conformer", mol: ethane(H3(STAGGERED[0]), H3(STAGGERED[1])) },
    { name: "Newman projection, eclipsed", also: "ethane, conformer", mol: ethane(H3(ECLIPSED[0]), H3(ECLIPSED[1]), { reach: 1.9 }) },
    { name: "Newman projection, anti", also: "butane, staggered, conformer", mol: ethane(H3(STAGGERED[0], "CH3"), H3([180, 300, 60], "CH3")) },
    { name: "Newman projection, gauche", also: "butane, staggered, conformer", mol: ethane(H3(STAGGERED[0], "CH3"), H3([60, 180, 300], "CH3")) },
    // The methyls point left, so the back one's bond passes the short side of the front one's label.
    { name: "Newman projection, syn", also: "butane, eclipsed, conformer", mol: ethane(H3([270, 30, 150], "CH3"), H3([290, 50, 170], "CH3"), { reach: 1.9 }) },
    { name: "Sawhorse projection, staggered", also: "ethane, conformer", mol: ethane(H3(STAGGERED[0]), H3(STAGGERED[1]), SAWHORSE) },
    { name: "Sawhorse projection, eclipsed", also: "ethane, conformer", mol: ethane(H3(ECLIPSED[0]), H3([10, 130, 250]), SAWHORSE) },
    { name: "Sawhorse projection, anti", also: "butane, staggered, conformer", mol: ethane(H3(STAGGERED[0], "CH3"), H3([180, 300, 60], "CH3"), SAWHORSE) },
  ];
}

// ——— Hexoses ———
// A ring in a Haworth projection: a regular ring flat in its plane, its bonds 1.45 bond lengths and drawn 1.3 times as
// wide (as a Haworth ring is, which leaves room for the labels inside it; a stretch keeps the stereochemistry), seen
// from 35° above, the ring O at the back right and the three front bonds bold. Substituents go straight up or down,
// 1.2 bond lengths (spread then fits each one's length).
function haworth(ring, subs, choice) {
  const n = ring.length, R = 1.45 / (2 * Math.sin(Math.PI / n)), e = 35 * deg;
  // The ring O (atom 0) at the back right, then round clockwise as seen from above: right, front right, front left...
  const start = n === 6 ? 60 : 90, at = ring.map((_, k) => rotX([1.3 * R * Math.cos((start - (360 / n) * k) * deg), 0, -R * Math.sin((start - (360 / n) * k) * deg)], e));
  const d = new Drawing(), ids = ring.map((l, k) => d.atom(l, at[k]));
  // The front bonds: those with neither atom at the back of the ring.
  for (let k = 0; k < n; k++) { const j = (k + 1) % n, front = Math.min(at[k][2], at[j][2]) > -0.5 * R * Math.cos(e); d.bond(ids[k], ids[j], 1, front ? { display: "bold" } : {}); }
  const up = rotX([0, 1.2, 0], e);
  subs.forEach((s, k) => s.forEach((label, w) => { if (label) { const a = d.atom(label, add(at[k], mul(up, (choice[k] ^ w) ? -1 : 1))); d.bond(ids[k], a); d.pairs.push([ids[k], a]); } }));
  return d;
}
// A hexose in a chair: subs[k] the substituents of ring atom k, and choice[k] whether the first goes axial.
function sugarChair(ring, subs, choice, flipped) {
  const place = subs.map((s, k) => (s.length ? (choice[k] ? [s[0], s[1]] : [s[1], s[0]]) : []));
  return chairWith(ring, place, flipped, 1.3);
}
// Each way of placing the substituents (one bit per ring atom with any), as a list of choices.
const ways = (subs) => {
  const free = subs.map((s, k) => (s.length ? k : -1)).filter((k) => k >= 0), out = [];
  for (let bits = 0; bits < 1 << free.length; bits++) { const c = subs.map(() => 0); free.forEach((k, b) => { c[k] = (bits >> b) & 1; }); out.push(c); }
  return out;
};
// Pyranoses: ring O5, C1 ... C5, with OH on C1 to C4 and CH2OH on C5. Furanoses: O5, C2 (OH and CH2OH), C3, C4, C5
// (CH2OH). Fructopyranose: O6, C2 (OH and CH2OH), C3, C4, C5 (OH), C6.
const PYRANOSE = { ring: ["O", "C", "C", "C", "C", "C"], subs: [[], ["O", null], ["O", null], ["O", null], ["O", null], ["CH2OH", null]] };
const FURANOSE = { ring: ["O", "C", "C", "C", "C"], subs: [[], ["O", "CH2OH"], ["O", null], ["O", null], ["CH2OH", null]] };
const KETOPYRANOSE = { ring: ["O", "C", "C", "C", "C", "C"], subs: [[], ["O", "CH2OH"], ["O", null], ["O", null], ["O", null], []] };
// The textbook chair's places for the ring atoms: O5 at the back right (4), C1 at the right end (3), C2 and C3 in
// front (2, 1), C4 at the left end (0) and C5 at the back left (5).
const CHAIR_ORDER = [4, 3, 2, 1, 0, 5];
const toChair = (list) => { const out = Array(6); CHAIR_ORDER.forEach((p, k) => { out[p] = list[k]; }); return out; };
// A hexose's drawing, its Haworth projection or its chair (of the two chairs, the one with more of its substituents
// equatorial), and how many substituents are equatorial. pick(list, mol) keeps the drawing that is the named compound.
export function hexose(form, pick, kind) {
  // The labels are spread on the drawing kept (spreading changes no stereochemistry).
  if (kind === "haworth") {
    const d = pick(ways(form.subs).map((c) => haworth(form.ring, form.subs, c)), (x) => x.done());
    return d && { mol: d.spread((m) => !!pick([m])).done() };
  }
  const subs = toChair(form.subs), ring = toChair(form.ring);
  let best;
  for (const flipped of [false, true]) {
    const found = pick(ways(subs).map((c) => ({ c, d: sugarChair(ring, subs, c, flipped) })), (x) => x.d.done());
    // Equatorial places taken by a substituent other than H.
    const equatorial = found && subs.reduce((t, s, k) => t + (s.length && (found.c[k] ? s[1] : s[0]) ? 1 : 0), 0);
    if (found && (!best || equatorial > best.equatorial)) best = { equatorial, d: found.d };
  }
  return best && { equatorial: best.equatorial, mol: best.d.spread((m) => !!pick([m])).done() };
}
export const HEXOSES = [
  ["α-D-Glucopyranose", "alpha-D-glucopyranose", PYRANOSE, "glucose"], ["β-D-Glucopyranose", "beta-D-glucopyranose", PYRANOSE, "glucose"],
  ["α-D-Galactopyranose", "alpha-D-galactopyranose", PYRANOSE, "galactose"], ["β-D-Galactopyranose", "beta-D-galactopyranose", PYRANOSE, "galactose"],
  ["α-D-Mannopyranose", "alpha-D-mannopyranose", PYRANOSE, "mannose"], ["β-D-Mannopyranose", "beta-D-mannopyranose", PYRANOSE, "mannose"],
];
export const FRUCTOSES = [
  ["α-D-Fructofuranose", "alpha-D-fructofuranose", FURANOSE, "haworth"], ["β-D-Fructofuranose", "beta-D-fructofuranose", FURANOSE, "haworth"],
  ["α-D-Fructopyranose", "alpha-D-fructopyranose", KETOPYRANOSE, "chair"], ["β-D-Fructopyranose", "beta-D-fructopyranose", KETOPYRANOSE, "chair"],
];

// ——— Fischer projections ———
// The carbon chain down the page, each centre's two other groups across it and a bond length nearer the viewer, as a
// Fischer projection means: Octet reads each centre from its atoms' places, so the bonds are drawn plain. top and
// bottom: the chain's end groups; centres: each centre's [left, right] groups.
export function fischer(top, centres, bottom) {
  const d = new Drawing(), n = centres.length;
  let prev = d.atom(top, [0, n + 1, 0]);
  centres.forEach(([left, right], k) => {
    const c = d.atom("C", [0, n - k, 0]);
    d.bond(prev, c);
    d.bond(c, d.atom(left, [-1, n - k, 0.5])).bond(c, d.atom(right, [1, n - k, 0.5]));
    prev = c;
  });
  d.bond(prev, d.atom(bottom, [0, 0, 0]));
  return d.done();
}
// ——— Generic stereocentres ———
// A carbon with its four bonds as IUPAC's graphical recommendations draw a stereocentre (ST-1.1): two plain bonds
// 120° apart in the plane of the page, and a wedge and a hash 70° apart in the space opposite them, turned four ways
// (the plain bonds up, down, left and right of the carbon); the same with three bonds (two plain bonds and one wedge,
// or one hash, the H left out); and one Fischer projection, its across bonds nearer the viewer. The ends are bare
// carbons, for labels to go on (issue 36).
export function stereocentres() {
  const at = (t, r = 1) => [r * Math.cos(t * deg), r * Math.sin(t * deg), 0];
  const star = (bonds) => {
    const d = new Drawing(), c = d.atom("C", [0, 0, 0]);
    for (const [t, more] of bonds) d.bond(c, d.atom("C", at(t)), 1, more);
    return d.done();
  };
  const WEDGE = { stereo: 1 }, HASH = { stereo: 6 };
  const four = (up) => star([[up + 60, {}], [up - 60, {}], [up + 215, WEDGE], [up + 145, HASH]]);
  const cross = new Drawing(), c = cross.atom("C", [0, 0, 0]);
  for (const p of [[0, 1, 0], [0, -1, 0], [-1, 0, 0.5], [1, 0, 0.5]]) cross.bond(c, cross.atom("C", p));
  const also = "stereocenter, tetrahedral carbon, wedge, hash";
  return [
    { name: "Stereocentre, plain bonds up", also, mol: four(90) },
    { name: "Stereocentre, plain bonds down", also, mol: four(270) },
    { name: "Stereocentre, plain bonds left", also, mol: four(180) },
    { name: "Stereocentre, plain bonds right", also, mol: four(0) },
    { name: "Stereocentre, three bonds, wedge", also: `${also}, implicit hydrogen`, mol: star([[210, {}], [330, {}], [90, WEDGE]]) },
    { name: "Stereocentre, three bonds, hash", also: `${also}, implicit hydrogen`, mol: star([[210, {}], [330, {}], [90, HASH]]) },
    { name: "Fischer projection, one centre", also: "stereocentre, stereocenter, Fischer cross", mol: cross.done() },
  ];
}

// Each way of putting the OH (or NH2) of each centre on the left or right.
export function fischerWays(top, n, group, bottom) {
  const out = [];
  for (let bits = 0; bits < 1 << n; bits++) out.push(fischer(top, Array.from({ length: n }, (_, k) => ((bits >> k) & 1 ? ["H", group] : [group, "H"])), bottom));
  return out;
}

// ——— Cubane ———
// A cube of carbons one bond on a side, turned 25° about the vertical and seen from 15° above.
export function cube() {
  const d = new Drawing(), at = [];
  for (let k = 0; k < 8; k++) at.push(d.atom("C", rotX(rotY([(k & 1) - 0.5, ((k >> 1) & 1) - 0.5, ((k >> 2) & 1) - 0.5], 25 * deg), 15 * deg)));
  for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if (!(a & bit)) d.bond(at[a], at[a | bit]);
  return d.done();
}

// ——— Paddlewheels ———
// Two metal atoms up the page, 1.5 bond lengths apart, bridged by four carboxylates: each blade (M, O, C, O, M) in a
// plane through the M-M axis, its M-O and O-C bonds one bond length and its O-C-O angle 120°, the blades 90° apart,
// with R on each carboxylate C. Turned 45° about the axis and seen from 30° above, so two blades lean out on each
// side and none lies across the M-M bond: a lantern, as an organometallic chemist draws one. order: the M-M bond's
// type (14 quadruple for Mo2). axial: a ligand on each metal, out along the axis.
// size: every length times this. Of the views and sizes tried (smallest first, then nearest 45° and 30°), the first
// whose labels are all clear (clashes.mjs) is kept.
export function paddlewheel(metal, r, { order = 1, axial } = {}) {
  const drawn = (spin, tilt, mm, size) => {
    const d = new Drawing(), view = (p) => rotX(rotY(mul(p, size), spin * deg), tilt * deg);
    const m1 = d.atom(metal, view([0, mm / 2, 0])), m2 = d.atom(metal, view([0, -mm / 2, 0]));
    d.bond(m1, m2, order);
    const c = 0.5 + Math.sqrt(1 - (0.866 - mm / 2) ** 2), o1 = [c - 0.5, 0.866];
    for (let k = 0; k < 4; k++) {
      const t = (90 * k) * deg, at = ([rr, y]) => view([rr * Math.cos(t), y, rr * Math.sin(t)]);
      const a = d.atom("O", at(o1)), b = d.atom("O", at([o1[0], -o1[1]])), cc = d.atom("C", at([c, 0])), g = d.atom(r, at([c + 1, 0]));
      d.bond(m1, a).bond(m2, b).bond(a, cc).bond(cc, b, 2).bond(cc, g);
    }
    if (axial) d.bond(m1, d.atom(axial, view([0, mm / 2 + 1, 0]))).bond(m2, d.atom(axial, view([0, -mm / 2 - 1, 0])));
    return d.done();
  };
  for (const size of [1, 1.15, 1.3, 1.45, 1.6]) for (const mm of [1.5, 1.8]) for (const tilt of [30, 25, 35, 40, 20, 45]) for (const spin of [45, 40, 50, 35, 55, 30, 60]) {
    const mol = drawn(spin, tilt, mm, size);
    if (!clashes(mol).length) return mol;
  }
  throw new Error(`no clear view of the ${metal}2 paddlewheel`);
}
export const PADDLEWHEELS = [
  ["Rh2(OAc)4", "Rh", "C", { also: "rhodium(II) acetate, dirhodium tetraacetate" }],
  ["Rh2(O2CR)4", "Rh", "R", { also: "rhodium(II) carboxylate" }],
  ["Rh2(TFA)4", "Rh", "CF3", { also: "rhodium(II) trifluoroacetate" }],
  ["Rh2(piv)4", "Rh", "tBu", { also: "Rh2(OPiv)4, rhodium(II) pivalate" }],
  ["Rh2(oct)4", "Rh", "C7H15", { also: "rhodium(II) octanoate" }],
  ["Rh2(O2CR)4L2", "Rh", "R", { also: "rhodium(II) carboxylate, axial ligands", axial: "L" }],
  ["Cu2(OAc)4", "Cu", "C", { also: "copper(II) acetate" }],
  ["Mo2(OAc)4", "Mo", "C", { also: "molybdenum(II) acetate, quadruple bond", order: 14 }],
];
