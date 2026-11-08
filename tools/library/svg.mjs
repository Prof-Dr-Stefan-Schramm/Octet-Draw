// Reads the glassware drawings in tools/library/glassware/ into Octet's own pen curves. The drawings are plain SVG
// line art: nested <g> with translate, rotate and scale, <path> and <ellipse>, one ink colour and a stroke width per
// part. Nothing here knows about Octet: it gives back each shape as cubic Bézier points in the drawing's own units
// (y down, as SVG has it), with the stroke width it is drawn at. glassware.mjs turns those into library items.
//
// Only what these drawings use is read, and anything else is reported rather than quietly dropped, so a drawing that
// grows a feature this cannot carry fails the build instead of coming out wrong.

// ----------------------------------------------------------------------------- transforms
// SVG's matrix [a b c d e f]: (x, y) goes to (a x + c y + e, b x + d y + f).
const ID = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
// How much a transform scales a length. The drawings scale evenly, so one number says it.
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

function parseTransform(text) {
  let m = ID;
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  for (let f; (f = re.exec(text)); ) {
    const n = f[2].trim().split(/[\s,]+/).filter((s) => s !== "").map(Number);
    if (n.some((v) => !Number.isFinite(v))) throw new Error(`transform ${f[0]}`);
    if (f[1] === "translate") m = mul(m, [1, 0, 0, 1, n[0], n[1] ?? 0]);
    else if (f[1] === "scale") m = mul(m, [n[0], 0, 0, n[1] ?? n[0], 0, 0]);
    else if (f[1] === "rotate") {
      const t = (n[0] * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
      const r = [c, s, -s, c, 0, 0];
      m = n.length > 1 ? mul(mul(mul(m, [1, 0, 0, 1, n[1], n[2]]), r), [1, 0, 0, 1, -n[1], -n[2]]) : mul(m, r);
    } else if (f[1] === "matrix") m = mul(m, n);
    else throw new Error(`transform ${f[1]}() is not read`);
  }
  return m;
}

// ----------------------------------------------------------------------------- path data
// A path's "d" as subpaths of cubic Béziers: { points: [{ at, c1, c2 }], closed }. Quadratics and arcs become cubics,
// so everything downstream has one kind of segment. c1 is a point's incoming handle and c2 its outgoing one, which is
// how Octet keeps a pen curve.
export function parsePath(d) {
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const subs = [];
  let i = 0, cmd = "", pts = null, start = [0, 0], at = [0, 0], prevC = null, prevQ = null;
  const num = () => { const v = Number(tokens[i++]); if (!Number.isFinite(v)) throw new Error(`path number at ${i}`); return v; };
  const rel = (x, y) => (cmd === cmd.toLowerCase() ? [at[0] + x, at[1] + y] : [x, y]);
  const finish = (close) => { if (pts && pts.length) subs.push({ points: pts, closed: !!close }); pts = null; };
  // A segment to p with the handles h1 (leaving the point before) and h2 (arriving at p); no handles is a straight line.
  const seg = (p, h1, h2) => {
    if (h1) pts[pts.length - 1].c2 = h1;
    pts.push(h2 ? { at: p, c1: h2 } : { at: p });
    at = p;
  };
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    else if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";
    const c = cmd.toUpperCase();
    if (c === "M") {
      finish(false);
      at = rel(num(), num());
      pts = [{ at }]; start = at; prevC = prevQ = null;
    } else if (c === "Z") {
      // Z shuts the subpath. A point on top of the first is the same point: Octet's closed curve joins the last back
      // to the first by itself, keeping the handles on either side.
      if (pts && pts.length > 1 && Math.hypot(at[0] - start[0], at[1] - start[1]) < 1e-9) {
        const last = pts.pop();
        if (last.c1) pts[0].c1 = last.c1;
      }
      finish(true);
      at = start; prevC = prevQ = null;
    } else if (c === "L") { seg(rel(num(), num())); prevC = prevQ = null; }
    else if (c === "H") { const x = num(); seg(cmd === "h" ? [at[0] + x, at[1]] : [x, at[1]]); prevC = prevQ = null; }
    else if (c === "V") { const y = num(); seg(cmd === "v" ? [at[0], at[1] + y] : [at[0], y]); prevC = prevQ = null; }
    else if (c === "C" || c === "S") {
      const h1 = c === "C" ? rel(num(), num()) : (prevC ? [2 * at[0] - prevC[0], 2 * at[1] - prevC[1]] : at);
      const h2 = rel(num(), num()), p = rel(num(), num());
      seg(p, h1, h2); prevC = h2; prevQ = null;
    } else if (c === "Q" || c === "T") {
      const q = c === "Q" ? rel(num(), num()) : (prevQ ? [2 * at[0] - prevQ[0], 2 * at[1] - prevQ[1]] : at);
      const p = c === "Q" ? rel(num(), num()) : at.slice();
      const end = c === "Q" ? p : rel(num(), num());
      const a = at;
      seg(end, [a[0] + (2 / 3) * (q[0] - a[0]), a[1] + (2 / 3) * (q[1] - a[1])],
        [end[0] + (2 / 3) * (q[0] - end[0]), end[1] + (2 / 3) * (q[1] - end[1])]);
      prevQ = q; prevC = null;
    } else if (c === "A") {
      const rx = num(), ry = num(), rot = num(), large = num(), sweep = num(), p = rel(num(), num());
      for (const s of arcToCubics(at, rx, ry, rot, large, sweep, p)) seg(s[2], s[0], s[1]);
      prevC = prevQ = null;
    } else throw new Error(`path command ${cmd} is not read`);
  }
  finish(false);
  return subs;
}

// An elliptical arc as cubic segments, each [outgoing handle, incoming handle, end point] (SVG's own formulas).
function arcToCubics(from, rx, ry, rot, large, sweep, to) {
  if (!rx || !ry) return [[null, null, to]];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const t = (rot * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const dx = (from[0] - to[0]) / 2, dy = (from[1] - to[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const over = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (over > 1) { rx *= Math.sqrt(over); ry *= Math.sqrt(over); }
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const k = Math.sqrt(Math.max(0, (rx * rx * ry * ry - den) / den)) * (large === sweep ? -1 : 1);
  const cx1 = (k * rx * y1) / ry, cy1 = (-k * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from[0] + to[0]) / 2, cy = sin * cx1 + cos * cy1 + (from[1] + to[1]) / 2;
  const ang = (ux, uy) => Math.atan2(uy, ux);
  let a0 = ang((x1 - cx1) / rx, (y1 - cy1) / ry);
  let a1 = ang((-x1 - cx1) / rx, (-y1 - cy1) / ry);
  let da = a1 - a0;
  if (!sweep && da > 0) da -= 2 * Math.PI;
  if (sweep && da < 0) da += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(da) / (Math.PI / 2) - 1e-9)), step = da / n;
  const point = (a) => [cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos];
  const slope = (a) => [-rx * Math.sin(a) * cos - ry * Math.cos(a) * sin, -rx * Math.sin(a) * sin + ry * Math.cos(a) * cos];
  const h = (4 / 3) * Math.tan(step / 4);
  const out = [];
  for (let j = 0; j < n; j++) {
    const b0 = a0 + j * step, b1 = b0 + step, p0 = point(b0), p1 = point(b1), s0 = slope(b0), s1 = slope(b1);
    out.push([[p0[0] + h * s0[0], p0[1] + h * s0[1]], [p1[0] - h * s1[0], p1[1] - h * s1[1]], p1]);
  }
  return out;
}

// An ellipse as four cubic quarters, a closed curve.
function ellipsePath(cx, cy, rx, ry) {
  const k = 0.5522847498307936, p = (x, y) => [x, y];
  return [{ closed: true, points: [
    { at: p(cx + rx, cy), c1: p(cx + rx, cy + k * ry), c2: p(cx + rx, cy - k * ry) },
    { at: p(cx, cy - ry), c1: p(cx + k * rx, cy - ry), c2: p(cx - k * rx, cy - ry) },
    { at: p(cx - rx, cy), c1: p(cx - rx, cy - k * ry), c2: p(cx - rx, cy + k * ry) },
    { at: p(cx, cy + ry), c1: p(cx - k * rx, cy + ry), c2: p(cx + k * rx, cy + ry) },
  ] }];
}

// ----------------------------------------------------------------------------- the document
const ATTR = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
const attrs = (text) => { const o = {}; ATTR.lastIndex = 0; for (let m; (m = ATTR.exec(text)); ) o[m[1]] = m[2]; return o; };

// Every drawn shape of an SVG, in the order it is drawn, with its points in the drawing's own units (y down):
//   { id, points, closed, stroke, fill, clipped }
// id is the nearest <g id="..."> above it, which is how the drawings name their sub-assemblies; stroke is the width
// the shape is drawn at, after the transforms; fill is a colour or null; clipped says the shape sits in a clip path.
// base is the drawing's own line weight, the stroke width its outermost group sets. Each drawing is drawn at the size
// that suits it on the page, not to one scale across the set, so base is what says how big the thing really is: a
// piece drawn with a finer line is a piece shown larger. glassware.mjs scales by it to put the set back in proportion.
export function readSvg(text) {
  const head = attrs(text.slice(0, text.indexOf(">") + 1));
  const box = (head.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  if (box.length !== 4 || box[0] !== 0 || box[1] !== 0) throw new Error(`viewBox ${head.viewBox}`);
  const shapes = [];
  let base = null, baseDepth = Infinity; // the drawing's own line weight: the outermost stroke width it sets
  // Inherited down the tree: the transform, the paint, the stroke width and the names.
  const stack = [{ m: ID, stroke: 1, paint: { fill: "black", stroke: "none" }, id: null, clipped: false }];
  const body = text.slice(text.indexOf(">") + 1);
  const tag = /<(\/)?([a-zA-Z]+)((?:"[^"]*"|[^>])*?)(\/)?>/g;
  let skip = 0; // inside <defs> or <clipPath>, where nothing is drawn
  for (let m; (m = tag.exec(body)); ) {
    const [whole, close, name, rest, selfClose] = m;
    const top = stack[stack.length - 1];
    if (skip) {
      if (close && (name === "defs" || name === "clipPath")) skip--;
      else if (!close && !selfClose && (name === "defs" || name === "clipPath")) skip++;
      continue;
    }
    if (name === "defs" || name === "clipPath") { if (!close && !selfClose) skip++; continue; }
    if (close) { if (name === "g" || name === "svg") stack.pop(); continue; }
    const a = attrs(rest);
    const here = {
      m: a.transform ? mul(top.m, parseTransform(a.transform)) : top.m,
      stroke: a["stroke-width"] !== undefined ? Number(a["stroke-width"]) : top.stroke,
      paint: { fill: a.fill ?? top.paint.fill, stroke: a.stroke ?? top.paint.stroke },
      id: a.id ?? top.id,
      clipped: top.clipped || a["clip-path"] !== undefined,
    };
    if (a["stroke-width"] !== undefined && stack.length < baseDepth) { base = here.stroke * scaleOf(here.m); baseDepth = stack.length; }
    if (name === "g" || name === "svg") { if (!selfClose) stack.push(here); continue; }
    let subs;
    if (name === "path") subs = parsePath(a.d ?? "");
    else if (name === "ellipse") subs = ellipsePath(Number(a.cx), Number(a.cy), Number(a.rx), Number(a.ry));
    else throw new Error(`<${name}> is not read`);
    const width = here.stroke * scaleOf(here.m);
    for (const s of subs) {
      shapes.push({
        id: here.id, closed: s.closed, clipped: here.clipped,
        stroke: here.paint.stroke !== "none" ? width : null,
        fill: here.paint.fill !== "none" ? here.paint.fill : null,
        points: s.points.map((q) => ({
          at: apply(here.m, q.at),
          ...(q.c1 ? { c1: apply(here.m, q.c1) } : {}),
          ...(q.c2 ? { c2: apply(here.m, q.c2) } : {}),
        })),
      });
    }
    void whole;
  }
  return { width: box[2], height: box[3], base, shapes };
}

// The box a list of shapes covers, handles and all.
export function bounds(shapes) {
  const qs = shapes.flatMap((s) => s.points.flatMap((q) => [q.at, q.c1 ?? q.at, q.c2 ?? q.at]));
  const xs = qs.map((q) => q[0]), ys = qs.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
