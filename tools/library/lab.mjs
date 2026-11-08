// The library's Lab group: glassware and lamps drawn as Octet's own pen curves and lines (bond lengths, y up), each
// one integral group, as ChemDraw's clip art is: a click picks all of it, and Ungroup (or Pick as one off) frees its
// parts. Outlines take the document's line width; liquids are closed curves filled in one blue tint, drawn
// behind them. Every shape here is drawn from simple geometry in this file, not taken from another program.
const LIQUID = "#A0B7EC", LIQUID_LIGHT = "#C9D6F4"; // OKLCH 0.78 and 0.87 lightness at the logo's hue
const LIP = 0.09; // the outward turn at the top of every open vessel
const r3 = (v) => Math.round(v * 1000) / 1000 + 0;
const at = (x, y) => [x, y];

// A path of curve points: l draws a line, c a cubic Bézier, a an arc of a circle, corner a line into a rounded corner.
class Path {
  constructor(x, y) { this.p = [{ at: at(x, y) }]; }
  get end() { return this.p[this.p.length - 1].at; }
  l(x, y) { this.p.push({ at: at(x, y) }); return this; }
  c(x1, y1, x2, y2, x, y) { this.p[this.p.length - 1].c2 = at(x1, y1); this.p.push({ at: at(x, y), c1: at(x2, y2) }); return this; }
  // Round the circle about (cx, cy) from the end of the path to the angle a1 (degrees; larger is anticlockwise).
  a(cx, cy, a1) {
    const [x, y] = this.end, r = Math.hypot(x - cx, y - cy), t0 = Math.atan2(y - cy, x - cx), t1 = (a1 * Math.PI) / 180;
    const n = Math.max(1, Math.ceil(Math.abs(t1 - t0) / (Math.PI / 2) - 1e-9)), dt = (t1 - t0) / n, k = (4 / 3) * Math.tan(dt / 4);
    for (let i = 1; i <= n; i++) {
      const a = t0 + (i - 1) * dt, b = t0 + i * dt;
      this.c(cx + r * (Math.cos(a) - k * Math.sin(a)), cy + r * (Math.sin(a) + k * Math.cos(a)), cx + r * (Math.cos(b) + k * Math.sin(b)), cy + r * (Math.sin(b) - k * Math.cos(b)), cx + r * Math.cos(b), cy + r * Math.sin(b));
    }
    return this;
  }
  // A line towards the corner (x, y) that turns there, with radius about r, towards (nx, ny).
  corner(x, y, nx, ny, r) {
    const [px, py] = this.end, d1 = Math.hypot(x - px, y - py), d2 = Math.hypot(nx - x, ny - y);
    const u = [(x - px) / d1, (y - py) / d1], v = [(nx - x) / d2, (ny - y) / d2], k = 0.45;
    this.l(x - u[0] * r, y - u[1] * r);
    return this.c(x - u[0] * r * k, y - u[1] * r * k, x + v[0] * r * k, y + v[1] * r * k, x + v[0] * r, y + v[1] * r);
  }
  // The lip at the top of a wall at x (dir 1 on the right, -1 on the left), the wall ending at top.
  lip(x, top, dir) { return this.l(x, top - LIP).c(x, top - LIP * 0.45, x + dir * LIP * 0.45, top, x + dir * LIP, top); }
}
const mirror = (ps) => ps.map((q) => ({ at: [-q.at[0], q.at[1]], ...(q.c1 ? { c1: [-q.c1[0], q.c1[1]] } : {}), ...(q.c2 ? { c2: [-q.c2[0], q.c2[1]] } : {}) }));
const reverse = (ps) => [...ps].reverse().map((q) => ({ at: q.at, ...(q.c2 ? { c1: q.c2 } : {}), ...(q.c1 ? { c2: q.c1 } : {}) }));
// Two paths end to end: where the first ends on the second's start, the two points become one.
function join(a, b) {
  const p = a[a.length - 1], q = b[0];
  if (Math.hypot(p.at[0] - q.at[0], p.at[1] - q.at[1]) > 1e-9) return [...a, ...b];
  return [...a.slice(0, -1), { at: p.at, ...(p.c1 ? { c1: p.c1 } : {}), ...(q.c2 ? { c2: q.c2 } : {}) }, ...b.slice(1)];
}
// A shape that is the same both sides: the right half (from the middle at the bottom), mirrored for the left.
const both = (half) => join(reverse(mirror(half)), half);

// The part of a half outline (rising from the bottom) between the levels y0 and y1, its Béziers cut where they cross.
function between(half, y0, y1) {
  const out = [];
  for (let i = 0; i + 1 < half.length; i++) {
    const a = half[i], b = half[i + 1], P = [a.at, a.c2 ?? a.at, b.c1 ?? b.at, b.at];
    const y = (t) => { const u = 1 - t; return u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1]; };
    const lo = Math.min(P[0][1], P[3][1]), hi = Math.max(P[0][1], P[3][1]);
    if (hi < y0 - 1e-9 || lo > y1 + 1e-9) continue;
    // Where y(t) reaches a level, by halving (each segment here rises or stays level).
    const tAt = (level) => { if (level <= lo) return 0; if (level >= hi) return 1; let p = 0, q = 1; for (let k = 0; k < 50; k++) { const m = (p + q) / 2; if (y(m) < level) p = m; else q = m; } return (p + q) / 2; };
    const seg = cut(P, tAt(y0), tAt(y1)), straight = !a.c2 && !b.c1;
    const first = { at: seg[0], ...(straight ? {} : { c2: seg[1] }) }, last = { at: seg[3], ...(straight ? {} : { c1: seg[2] }) };
    if (!out.length) out.push(first);
    else out[out.length - 1] = { ...out[out.length - 1], ...(straight ? {} : { c2: seg[1] }) };
    out.push(last);
  }
  return out;
}
// The piece of a cubic Bézier from t0 to t1 (de Casteljau).
function cut(P, t0, t1) {
  const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const split = (Q, t) => { const a = lerp(Q[0], Q[1], t), b = lerp(Q[1], Q[2], t), c = lerp(Q[2], Q[3], t), d = lerp(a, b, t), e = lerp(b, c, t), f = lerp(d, e, t); return [[Q[0], a, d, f], [f, e, c, Q[3]]]; };
  const right = split(P, t0)[1];
  return split(right, t0 < 1 ? (t1 - t0) / (1 - t0) : 0)[0];
}

// An item's objects: outlines (open or closed) at the document's width, fills behind them, and straight lines. Its
// icon (20 px, in the tool icons' strokes) shows the outlines that are not details: fine parts would run together.
function item(name, also, parts) {
  let id = 1;
  const arrows = [], icon = [];
  for (const [kind, ps, more = {}, fine] of parts) {
    if (kind !== "fill" && !fine) icon.push(id);
    const points = ps.map((q) => ({ at: q.at.map(r3), ...(q.c1 ? { c1: q.c1.map(r3) } : {}), ...(q.c2 ? { c2: q.c2.map(r3) } : {}) }));
    if (kind === "line") arrows.push({ id: id++, kind: "line", from: points[0].at, to: points[1].at });
    else arrows.push({ id: id++, kind: "curve", from: points[0].at, to: points[points.length - 1].at, curve: { points, ...(kind === "open" ? {} : { closed: true }) }, ...more });
  }
  // Centred on the middle of its box, as the library's structures are.
  const xs = arrows.flatMap((a) => (a.curve ? a.curve.points.map((q) => q.at[0]) : [a.from[0], a.to[0]])), ys = arrows.flatMap((a) => (a.curve ? a.curve.points.map((q) => q.at[1]) : [a.from[1], a.to[1]]));
  const dx = (Math.min(...xs) + Math.max(...xs)) / 2, dy = (Math.min(...ys) + Math.max(...ys)) / 2, move = (q) => [r3(q[0] - dx), r3(q[1] - dy)];
  for (const a of arrows) {
    a.from = move(a.from);
    a.to = move(a.to);
    if (a.curve) a.curve.points = a.curve.points.map((q) => ({ at: move(q.at), ...(q.c1 ? { c1: move(q.c1) } : {}), ...(q.c2 ? { c2: move(q.c2) } : {}) }));
  }
  return { name, ...(also ? { also } : {}), atoms: [], bonds: [], arrows, groups: [{ id, atoms: [], items: arrows.map((a) => a.id), integral: true }], icon };
}
const fill = (ps, colour = LIQUID) => ["fill", ps, { fill: "solid", colour }];
const solid = (ps) => ["fill", ps, { fill: "solid" }]; // in the ink colour
const open = (ps) => ["open", ps];
const closed = (ps) => ["closed", ps];
const line = (x0, y0, x1, y1) => ["line", [{ at: at(x0, y0) }, { at: at(x1, y1) }]];
const detail = ([kind, ps, more = {}]) => [kind, ps, more, true]; // left out of the icon
// glassware.mjs builds its items from the same pieces, so both halves of the Lab shelf are made the same way.
export { item, open, closed, fill, solid, line, detail };

// Round-bottom flask: a sphere, a neck with a lip, and liquid in the bottom of the sphere.
function roundBottomFlask() {
  const R = 0.95, neck = 0.2, top = 1.75, s = (68 * Math.PI) / 180, sx = R * Math.cos(s), sy = R * Math.sin(s);
  const half = new Path(0, -R).a(0, 0, 68).c(sx - 0.1 * Math.sin(s), sy + 0.1 * Math.cos(s), neck, 0.98, neck, 1.1).lip(neck, top, 1).p;
  return item("Round-bottom flask", "RBF", [fill(both(between(half, -R, -0.25))), open(both(half))]);
}
// Beaker: straight sides, a flat bottom with round corners, a spout on the left and three graduation marks.
function beaker() {
  const w = 0.8, bottom = -1, top = 1, r = 0.12;
  const right = new Path(0, bottom).corner(w, bottom, w, top, r).lip(w, top, 1).p;
  const left = new Path(0, bottom).corner(-w, bottom, -w, top, r).l(-w, top - 0.16).c(-w, top - 0.07, -w - 0.08, top - 0.02, -w - 0.17, top + 0.02).p;
  return item("Beaker", "", [
    fill(join(reverse(between(left, bottom, -0.1)), between(right, bottom, -0.1))),
    open(join(reverse(left), right)),
    ...[line(-0.56, 0.7, -0.26, 0.7), line(-0.56, 0.45, -0.4, 0.45), line(-0.56, 0.2, -0.26, 0.2)].map(detail),
  ]);
}
// Conical (Erlenmeyer) flask: a neck with a lip on sloping sides and a wide flat bottom.
function conicalFlask() {
  const neck = 0.2, top = 1.5, shoulder = 0.55, w = 1.05, bottom = -1.4;
  const half = new Path(0, bottom).corner(w, bottom, neck, shoulder, 0.16).corner(neck, shoulder, neck, top, 0.14).lip(neck, top, 1).p;
  return item("Conical flask", "Erlenmeyer flask", [fill(both(between(half, bottom, -0.55))), open(both(half))]);
}
// Test tube: a long tube with a round bottom and a lip.
function testTube() {
  const w = 0.22, top = 1.35, bottom = -1.35;
  const half = new Path(0, bottom).a(0, bottom + w, 0).lip(w, top, 1).p;
  return item("Test tube", "", [fill(both(between(half, bottom, -0.45))), open(both(half))]);
}
// Separatory funnel: a stopper, a pear-shaped body with two liquid layers, a stopcock on the stem, a bevelled tip.
// The lines meet end to end and never lie on each other: the body's outline closes across the neck under the stopper
// and across the stem at the top of the stopcock.
function separatoryFunnel() {
  const neck = 0.14, stem = 0.065, cock = -1.22, ch = 0.075, top = 1.66, cap = 0.18;
  const half = new Path(stem, cock + ch).l(stem, -0.92).c(0.2, -0.62, 0.6, 0.32, 0.6, 0.78).c(0.6, 1.14, 0.36, 1.38, neck, 1.44).l(neck, top).p;
  const body = half.slice(1); // from the top of the stem
  return item("Separatory funnel", "sep funnel", [
    fill(both(between(body, -0.92, -0.08))),
    fill(both(between(body, -0.08, 0.5)), LIQUID_LIGHT),
    closed([...half, ...reverse(mirror(half))]),
    open(new Path(-neck, top).l(-cap, top).corner(-cap, 1.94, cap, 1.94, 0.08).corner(cap, 1.94, cap, top, 0.08).l(neck, top).p),
    // The stopcock: a barrel across the stem (its top closed by the body's outline), and its handle.
    open(new Path(-stem, cock + ch).l(-0.3, cock + ch).l(-0.3, cock - ch).l(0.3, cock - ch).l(0.3, cock + ch).l(stem, cock + ch).p),
    detail(line(-0.3, cock, -0.42, cock)), detail(line(-0.42, cock - 0.13, -0.42, cock + 0.13)),
    open(new Path(-stem, cock - ch).l(-stem, -1.96).l(stem, -1.86).l(stem, cock - ch).p),
  ]);
}
// Reflux condenser (Allihn): an inner tube with five bulbs inside a water jacket, two hose arms on the right, a lip
// at the top and a cone at the bottom that fits the flasks' necks.
function refluxCondenser() {
  const tube = 0.12, waist = 0.1, bulb = 0.22, jacket = 0.3, j0 = -1.5, j1 = 1.5, top = 2.4, arm = 0.075, armEnd = 0.62;
  // The inner wall on the right in three parts: the cone and tube up to the jacket, the bulbs inside it, and the tube
  // from the jacket up to the lip. The parts meet end to end where the jacket meets the tube.
  const foot0 = j0 - 0.28, head0 = j1 + 0.28;
  const cone = new Path(0.15, -2.62).l(0.19, -2.1).c(0.19, -2.0, tube, -2.02, tube, -1.92).l(tube, foot0).p;
  const bulbs = new Path(tube, foot0).l(tube, j0 - 0.2).c(tube, j0 - 0.12, waist, j0 - 0.08, waist, j0);
  const n = 5, h = (j1 - j0) / n;
  for (let k = 0; k < n; k++) { const y = j0 + k * h; bulbs.c(bulb, y + h * 0.08, bulb, y + h * 0.92, waist, y + h); }
  bulbs.c(waist, j1 + 0.08, tube, j1 + 0.12, tube, j1 + 0.2).l(tube, head0);
  const neck = new Path(tube, head0).lip(tube, top, 1).p;
  // The jacket on the right: from the tube at its foot up to the lower arm, between the arms, and from the upper arm to the tube.
  const lower = j0 + 0.38, upper = j1 - 0.38;
  const foot = new Path(tube, foot0).c(tube + 0.1, j0 - 0.2, jacket, j0 - 0.16, jacket, j0 - 0.02).l(jacket, lower - arm).l(armEnd, lower - arm).p;
  const middle = new Path(armEnd, lower + arm).l(jacket, lower + arm).l(jacket, upper - arm).l(armEnd, upper - arm).p;
  const head = new Path(armEnd, upper + arm).l(jacket, upper + arm).l(jacket, j1 + 0.02).c(jacket, j1 + 0.16, tube + 0.1, j1 + 0.2, tube, head0).p;
  const left = (ps) => open(mirror(ps));
  return item("Reflux condenser", "Allihn condenser", [
    open(cone), left(cone), detail(open(bulbs.p)), detail(left(bulbs.p)), open(neck), left(neck),
    open(foot), open(middle), open(head),
    left(new Path(tube, foot0).c(tube + 0.1, j0 - 0.2, jacket, j0 - 0.16, jacket, j0 - 0.02).l(jacket, j1 + 0.02).c(jacket, j1 + 0.16, tube + 0.1, j1 + 0.2, tube, head0).p),
  ]);
}
// Light bulb: a round glass on a screw base, a filament on two wires, a glint on the glass and five rays.
function lightBulb() {
  const R = 0.78, cy = 0.55, neck = 0.33, base = -0.62, s = (-35 * Math.PI) / 180, px = R * Math.cos(s), py = cy + R * Math.sin(s);
  const half = new Path(0, cy + R).a(0, cy, -35).c(px - 0.3 * Math.sin(-s), py - 0.3 * Math.cos(s), neck, -0.3, neck, -0.5).l(neck, base).p;
  const glass = both(half), glint = 0.58;
  const rays = [10, 50, 90, 130, 170].map((d) => { const t = (d * Math.PI) / 180; return line(0.98 * Math.cos(t), cy + 0.98 * Math.sin(t), 1.24 * Math.cos(t), cy + 1.24 * Math.sin(t)); });
  return item("Light bulb", "lamp, photochemistry", [
    open(glass),
    // The screw base: its outline, two threads and the contact at the foot.
    closed(new Path(-neck, base).l(neck, base).corner(neck, -1.1, -0.15, -1.1, 0.1).corner(-neck, -1.1, -neck, base, 0.1).p),
    detail(line(-neck, -0.78, neck, -0.82)), detail(line(-neck, -0.92, neck, -0.96)),
    solid(new Path(-0.13, -1.1).l(0.13, -1.1).corner(0.13, -1.24, -0.13, -1.24, 0.08).corner(-0.13, -1.24, -0.13, -1.1, 0.08).p),
    // The filament: two wires up from the base and a coil across their tops.
    detail(open(new Path(-0.1, base).l(-0.24, 0.42).p)), detail(open(new Path(0.1, base).l(0.24, 0.42).p)),
    detail(open(new Path(-0.24, 0.42).c(-0.2, 0.56, -0.12, 0.56, -0.08, 0.42).c(-0.04, 0.28, 0.04, 0.28, 0.08, 0.42).c(0.12, 0.56, 0.2, 0.56, 0.24, 0.42).p)),
    detail(open(new Path(glint * Math.cos((115 * Math.PI) / 180), cy + glint * Math.sin((115 * Math.PI) / 180)).a(0, cy, 150).p)),
    ...rays,
  ]);
}
// LED: a lens with a round top on a rim, the cathode's cup and the anode's post inside, two leads (the anode's longer)
// and three rays.
function led() {
  const w = 0.34, dome = 0.6, rim = 0.42, r0 = -0.25, r1 = -0.4, cy = dome;
  const outline = new Path(-w, r0).l(-w, dome).a(0, dome, 0).l(w, r0).l(rim, r0).l(rim, r1).l(-rim, r1).l(-rim, r0).p;
  const rays = [50, 90, 130].map((d) => { const t = (d * Math.PI) / 180; return line(0.52 * Math.cos(t), cy + 0.52 * Math.sin(t), 0.77 * Math.cos(t), cy + 0.77 * Math.sin(t)); });
  return item("LED", "light-emitting diode, photochemistry", [
    fill(outline),
    closed(outline),
    // The leads below the rim, then inside the lens: the cathode's cup, and the anode's post with its wire to the cup.
    open(new Path(-0.15, -1.3).l(-0.15, r1).p), open(new Path(0.15, -1.5).l(0.15, r1).p),
    detail(open(new Path(-0.15, r1).l(-0.15, 0.13).p)), detail(closed(new Path(-0.21, 0.13).l(-0.09, 0.13).l(-0.03, 0.24).l(-0.27, 0.24).p)),
    detail(open(new Path(0.15, r1).l(0.15, 0.3).c(0.13, 0.42, -0.04, 0.42, -0.1, 0.24).p)),
    ...rays,
  ]);
}

// Schlenk flask: a round-bottom flask with a side arm off its neck, a stopcock on the arm and a hose barb at its end.
function schlenkFlask() {
  const R = 0.95, neck = 0.2, top = 2.15, s = (68 * Math.PI) / 180, sx = R * Math.cos(s), sy = R * Math.sin(s), arm = 1.45, w = 0.07, end = 1.15, cock = 0.62;
  const half = new Path(0, -R).a(0, 0, 68).c(sx - 0.1 * Math.sin(s), sy + 0.1 * Math.cos(s), neck, 0.98, neck, 1.1).lip(neck, top, 1).p;
  return item("Schlenk flask", "Schlenk tube, inert atmosphere", [
    fill(both(between(half, -R, -0.25))),
    // The left wall whole; the right wall broken where the arm leaves it.
    open(reverse(mirror(half))), open(between(half, -R, arm - w)), open(between(half, arm + w, top + 0.1)),
    open(new Path(neck, arm + w).l(cock - 0.13, arm + w).p), open(new Path(neck, arm - w).l(cock - 0.13, arm - w).p),
    // The stopcock's barrel across the arm, its handle, and the arm on to a barb.
    closed(new Path(cock - 0.13, arm - 0.17).l(cock + 0.13, arm - 0.17).l(cock + 0.13, arm + 0.17).l(cock - 0.13, arm + 0.17).p),
    detail(line(cock, arm + 0.17, cock, arm + 0.36)),
    open(new Path(cock + 0.13, arm + w).l(end, arm + w).l(end + 0.12, arm + 0.12).p), open(new Path(cock + 0.13, arm - w).l(end, arm - w).l(end + 0.12, arm - 0.12).p),
  ]);
}
// Vial: a short tube with a flat bottom and a screw cap with grip ridges.
function vial() {
  const w = 0.36, bottom = -1, top = 0.6, cap = 0.42;
  const right = new Path(0, bottom).corner(w, bottom, w, top, 0.08).l(w, top).p;
  return item("Vial", "sample vial, screw cap", [
    fill(join(reverse(mirror(between(right, bottom, -0.2))), between(right, bottom, -0.2))),
    open(join(reverse(mirror(right)), right)),
    closed(new Path(-w - 0.05, top).l(w + 0.05, top).l(w + 0.05, top + cap).l(-w - 0.05, top + cap).p),
    ...[-0.2, 0, 0.2].map((x) => detail(line(x, top + 0.08, x, top + cap - 0.08))),
  ]);
}
// Syringe: a barrel with finger flanges and graduations, a plunger with a thumb rest, and a needle on a hub.
function syringe() {
  const w = 0.24, b0 = -0.9, b1 = 1.1, rod = 1.75;
  return item("Syringe", "needle, plunger", [
    fill(new Path(-w, b0).l(w, b0).l(w, 0.2).l(-w, 0.2).p),
    closed(new Path(-w, b0).l(w, b0).l(w, b1).l(-w, b1).p),
    line(-w - 0.22, b1, w + 0.22, b1),
    // The plunger: its seal at the top of the liquid, the rod, and the thumb rest.
    closed(new Path(-w, 0.2).l(w, 0.2).l(w, 0.32).l(-w, 0.32).p),
    line(0, 0.32, 0, rod), line(-0.2, rod, 0.2, rod),
    // The hub and the needle.
    open(new Path(-0.1, b0).l(-0.05, b0 - 0.2).l(0.05, b0 - 0.2).l(0.1, b0).p),
    line(0, b0 - 0.2, 0, -2.3),
    ...[-0.65, -0.4, -0.15, 0.1, 0.35, 0.6, 0.85].map((y, k) => detail(line(w - (k % 2 ? 0.08 : 0.14), y, w, y))),
  ]);
}
// Chromatography column: a long tube with a lip, silica in its lower part under a layer of solvent, a band on the
// silica, and a stopcock and tip at the foot.
function column() {
  const w = 0.22, foot = -1.9, top = 2.3, silica = 0.6, solvent = 1.2, stem = 0.05, cock = -2.2;
  const tube = new Path(stem, cock + 0.06).l(stem, foot - 0.12).c(0.1, foot - 0.04, w, foot - 0.02, w, foot + 0.1).lip(w, top, 1).p;
  return item("Chromatography column", "flash column, silica", [
    fill(both(between(tube, foot + 0.1, silica)), LIQUID_LIGHT),
    fill(both(between(tube, silica, solvent))),
    open(both(tube)),
    detail(line(-w, -0.2, w, -0.2)), detail(line(-w, -0.32, w, -0.32)),
    open(new Path(-stem, cock + 0.06).l(-0.22, cock + 0.06).l(-0.22, cock - 0.06).l(0.22, cock - 0.06).l(0.22, cock + 0.06).l(stem, cock + 0.06).p),
    open(new Path(-stem, cock - 0.06).l(-stem, -2.7).l(stem, -2.62).l(stem, cock - 0.06).p),
    detail(line(-0.22, cock, -0.34, cock)),
  ]);
}
// Heating mantle: a bowl that a round-bottom flask sits in (its well and outer wall joined at the rim), on a base
// with a dial, and three heating marks in the well.
function heatingMantle() {
  const R = 1.2, r = 1.0, rim = 0.2, foot = rim - R;
  return item("Heating mantle", "heating, reflux", [
    // Round the bottom: from the left (180°) down to the foot (270°), then from the foot (-90°) up to the right (0°).
    closed([...new Path(-R, rim).a(0, rim, 270).a(0, rim, 0).p, ...reverse(new Path(-r, rim).a(0, rim, 270).a(0, rim, 0).p)]),
    closed(new Path(-1.45, foot - 0.5).l(1.45, foot - 0.5).l(1.45, foot).l(-1.45, foot).p),
    detail(closed(new Path(1.05, foot - 0.37).a(1.05, foot - 0.25, 270).p)),
    ...[-0.5, 0, 0.5].map((x) => detail(open(new Path(x - 0.12, -0.45).c(x - 0.04, -0.33, x + 0.04, -0.57, x + 0.12, -0.45).p))),
  ]);
}
// Stirrer bar: a capsule with a band round its middle, about a third of a flask across.
function stirrerBar() {
  const w = 0.6, h = 0.16;
  return item("Stirrer bar", "stir bar, magnetic stirring", [
    closed(new Path(-w + h, -h).l(w - h, -h).a(w - h, 0, 90).l(-w + h, h).a(-w + h, 0, 270).p),
    detail(line(-0.05, -h, -0.05, h)), detail(line(0.05, -h, 0.05, h)),
  ]);
}
// Hotplate stirrer: a flat plate on a body with two dials.
function hotplate() {
  return item("Hotplate stirrer", "stirrer, heating, magnetic stirring", [
    closed(new Path(-1.5, 0.35).l(1.5, 0.35).l(1.5, 0.5).l(-1.5, 0.5).p),
    open(new Path(-1.3, 0.35).l(-1.3, -0.75).l(1.3, -0.75).l(1.3, 0.35).p),
    ...[-0.55, 0.55].map((x) => closed(new Path(x, -0.42).a(x, -0.2, 270).p)),
    ...[-0.55, 0.55].map((x) => detail(line(x, -0.2, x, -0.05))),
  ]);
}

export const LAB = [lightBulb(), led(), roundBottomFlask(), beaker(), conicalFlask(), refluxCondenser(), separatoryFunnel(), testTube(),
  schlenkFlask(), vial(), syringe(), column(), heatingMantle(), hotplate(), stirrerBar()];
// TLC plate: Octet's own TLC object (the TLC tool's), three lanes (starting material, co-spot, product).
export const TLC = { name: "TLC plate", also: "thin-layer chromatography, Rf", mol: { atoms: [], bonds: [], shapes: [{ id: 1, kind: "tlc", from: [-1.5, -2.1], to: [1.5, 2.1], tlc: { lanes: 3, spots: [{ lane: 0, rf: 0.62 }, { lane: 1, rf: 0.62 }, { lane: 1, rf: 0.3 }, { lane: 2, rf: 0.3 }] } }] } };
