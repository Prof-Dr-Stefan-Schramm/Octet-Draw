// Picture to structure (decision 0023): where the structures are in a picture of a scheme, a figure or a page. No
// model: the ink is split into connected pieces, the size of a letter is measured, and each structure is a large
// piece (its bonds, which join) with the letters near it (its atom labels). Long thin pieces are arrows or rules and
// start no structure; a run of letters far from any bond is text. Each structure found goes to the models alone.
import { type Box, grey, type Pixels } from "./recognise-image.ts";

// spread: how far the ink lies from the piece's own long axis (the root mean square, in pixels): small for an arrow or
// a rule, large for a ring. straight: the share of its ink on horizontal or vertical lines at least 12 pixels long,
// nearly all of it for a frame or a branched arrow, less than half for a structure.
// angle: the direction of its long axis, in degrees from the horizontal (0 to 180).
export type Piece = Box & { pixels: number; spread: number; straight: number; angle: number };
export type Found = { box: Box; letter: number };

// The lightest grey that is still ink: Otsu's threshold between ink and paper, moved 60% of the way to the paper's own
// grey, so the faint pixels of a smoothed line (the narrow end of a hashed wedge) still count. Kept between 100 and
// 225, so a grey page background stays paper.
export function paperLevel(g: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of g) hist[v]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let best = 0, at = 160, w0 = 0, s0 = 0;
  for (let t = 0; t < 256; t++) {
    w0 += hist[t]; s0 += t * hist[t];
    const w1 = g.length - w0;
    if (!w0 || !w1) continue;
    const between = w0 * w1 * (s0 / w0 - (sum - s0) / w1) ** 2;
    if (between > best) { best = between; at = t; }
  }
  let paper = at;
  for (let v = at; v < 256; v++) if (hist[v] > hist[paper]) paper = v;
  return Math.round(Math.min(225, Math.max(100, at + 0.6 * (paper - at))));
}

// The pieces of ink, each the pixels joined to each other (8 neighbours).
export const pieces = (p: Pixels, level?: number): Piece[] => inkPieces(p, level).all;
// The same, with each pixel's piece (its number in the list, from 1; 0 for paper).
export function inkPieces(p: Pixels, level?: number): { all: Piece[]; labels: Int32Array } {
  const g = grey(p), cut = level ?? paperLevel(g), { width: w, height: h } = p, seen = new Int32Array(w * h), out: Piece[] = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || g[start] > cut) continue;
    let top = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    const id = out.length + 1;
    stack[top++] = start; seen[start] = id;
    while (top) {
      const i = stack[--top], x = i % w, y = (i - x) / w;
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, j = yy * w + xx;
          if (xx < 0 || xx >= w || seen[j] || g[j] > cut) continue;
          seen[j] = id; stack[top++] = j;
        }
      }
    }
    const cxx = sxx / n - (sx / n) ** 2, cyy = syy / n - (sy / n) ** 2, cxy = sxy / n - (sx / n) * (sy / n);
    const minor = (cxx + cyy) / 2 - Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy ** 2);
    const angle = ((Math.atan2(2 * cxy, cxx - cyy) / 2) * 180) / Math.PI;
    out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, pixels: n, spread: Math.sqrt(Math.max(0, minor)), straight: 0, angle: (angle + 180) % 180 });
  }
  // Straight ink: runs of one piece's pixels along a row, then along a column, each pixel counted once.
  const counted = new Uint8Array(w * h), straight = new Float64Array(out.length + 1), RUN = 12;
  const runs = (n: number, m: number, at: (a: number, b: number) => number) => {
    for (let a = 0; a < n; a++)
      for (let b = 0; b < m; ) {
        const id = seen[at(a, b)];
        let e = b + 1;
        while (e < m && id && seen[at(a, e)] === id) e++;
        if (id && e - b >= RUN) for (let k = b; k < e; k++) { const i = at(a, k); if (!counted[i]) { counted[i] = 1; straight[id]++; } }
        b = e;
      }
  };
  runs(h, w, (y, x) => y * w + x);
  runs(w, h, (x, y) => y * w + x);
  out.forEach((c, k) => { c.straight = straight[k + 1] / c.pixels; });
  return { all: out, labels: seen };
}

const gap = (a: Box, b: Box) => Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)));
const join = (a: Box, b: Box): Box => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };

// The height of a letter: the median height of the small pieces (letters, digits, short bond lines).
export function letterHeight(all: Piece[], p: Pixels): number {
  const small = all.filter((c) => c.h >= 4 && c.h <= p.height / 8 && c.w <= 2 * c.h && c.pixels >= 6).map((c) => c.h).sort((a, b) => a - b);
  return small.length >= 3 ? small[small.length >> 1] : Math.max(8, Math.min(p.width, p.height) / 15);
}

// Every structure in the picture, in reading order (rows from the top, left to right in a row).
export const findStructures = (p: Pixels): Found[] => findScheme(p).structures;

// A reaction arrow in the picture (pixels): from its tail to its head, and the lines of text above and below it (its
// conditions), nearest the arrow first. kind: reaction (one head), resonance (a head at each end), equilibrium (two
// half-headed arrows, the upper one's way).
export type FoundArrow = { from: [number, number]; to: [number, number]; kind: "reaction" | "resonance" | "equilibrium"; above: Box[]; below: Box[] };

// The structures, and the reaction arrows with their conditions.
export function findScheme(p: Pixels): { structures: Found[]; arrows: FoundArrow[]; letter: number } {
  // Every piece counts, down to a pixel: the narrow end of a hashed wedge is dashes of one or two pixels.
  const { all, labels } = inkPieces(p), letter = letterHeight(all, p);
  const big = (c: Box) => Math.max(c.w, c.h) > 2.5 * letter;
  // An arrow, a rule or a bracket: its ink lies along one line (an arrowhead adds little). A frame round a panel or a
  // branched arrow: large, and nearly all horizontal and vertical lines (a cyclobutane square is too small to be one).
  const thin = (c: Piece) => big(c) && (c.spread < 0.25 * letter || c.straight > 0.85 && Math.max(c.w, c.h) > 6 * letter);
  // A word of a scanned text: letters run together into one piece, a letter high, mostly ink. It never starts a
  // structure (it may be a label: COOH scanned as one piece).
  const word = (c: Piece) => c.h <= 1.4 * letter && c.w > 2 * letter && c.pixels > 0.15 * c.w * c.h;
  // A bond stroke: a short straight line, longer than a letter (an old formula's bonds between written atoms).
  const stroke = (c: Piece) => !big(c) && c.spread < 0.2 * letter && Math.hypot(c.w, c.h) >= 1.3 * letter;
  const bond = (c: Piece) => (big(c) && !thin(c) && !word(c)) || stroke(c);
  // Seeds: the large pieces first (most ink first), then single strokes.
  const seeds = all.filter(bond).sort((a, b) => Number(stroke(a)) - Number(stroke(b)) || b.pixels - a.pixels);
  const taken = new Set<Piece>(), found: Box[] = [];
  const near = (c: Piece, xs: Piece[], d: number) => xs.some((t) => gap(c, t) <= d);
  for (const seed of seeds) {
    if (taken.has(seed)) continue;
    taken.add(seed);
    let box: Box = seed, grew = true;
    const parts: Piece[] = [seed], bonds: Piece[] = [seed];
    while (grew) {
      grew = false;
      for (const c of all) {
        if (taken.has(c) || gap(c, box) > 1.3 * letter) continue;
        // A bond piece joins when it comes within 1.3 letters of a piece of the structure (a ring broken by a label, a
        // chain through NH and C=O, a bond a scan broke, a salt's ions drawn close); a long arrow never does. A letter
        // joins when it comes within 0.9 letters of a piece and three letters of a bond: text further along a line
        // does not.
        const ok = bond(c) ? near(c, parts, 1.3 * letter) : !(thin(c) && Math.max(c.w, c.h) > 8 * letter) && near(c, parts, 0.9 * letter) && near(c, bonds, 3 * letter);
        if (!ok) continue;
        taken.add(c); parts.push(c); box = join(box, c); grew = true;
        if (bond(c)) bonds.push(c);
      }
    }
    // A structure has bonds: a large piece, or three strokes at least, two of them slanted (a ring's sides). Straight
    // letters in a text (l, d, 1) stand upright.
    const slanted = bonds.filter((b) => { const a = b.angle % 90; return a > 20 && a < 70; }).length;
    if (bonds.some((b) => big(b)) || (bonds.length >= 3 && slanted >= 2)) found.push(box);
    else for (const c of parts) taken.delete(c); // straight letters of a text: they stay free for an arrow's conditions
  }
  // Parts of one structure that grew apart (two rings joined through a label on each side) are one structure: boxes
  // that overlap or nearly touch are joined.
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < found.length && !merged; i++)
      for (let j = i + 1; j < found.length && !merged; j++)
        if (gap(found[i], found[j]) <= 0.5 * letter) { found[i] = join(found[i], found[j]); found.splice(j, 1); merged = true; }
  }
  // A structure is more than a letter or two: at least three letters high or wide, and not a lone word. A small
  // picture with no piece that large (cisplatin, a short chain) is one structure, all of it.
  const pad = Math.round(0.4 * letter), ink = all.length ? all.reduce<Box>((b, c) => join(b, c), all[0]) : undefined;
  let kept = found.filter((b) => Math.max(b.w, b.h) > 3 * letter);
  if (!kept.length && ink) kept = [ink];
  const boxes = kept.map((b) => {
    const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
    return { x, y, w: Math.min(p.width, b.x + b.w + pad) - x, h: Math.min(p.height, b.y + b.h + pad) - y };
  });
  // Reading order: a box is in the row of the first box above it that it overlaps by more than half its height.
  boxes.sort((a, b) => a.y - b.y);
  const rows: Box[][] = [];
  for (const b of boxes) {
    const row = rows.find((r) => r.some((o) => Math.min(o.y + o.h, b.y + b.h) - Math.max(o.y, b.y) > 0.5 * Math.min(o.h, b.h)));
    if (row) row.push(b); else rows.push([b]);
  }
  const structures = rows.flatMap((r) => r.sort((a, b) => a.x - b.x)).map((box) => ({ box, letter }));
  const free = all.filter((c) => !taken.has(c) && !boxes.some((b) => inside(c, b)));
  // A scan's dark edge is no arrow: nothing that touches the picture's border is one.
  const edge = (c: Piece) => c.x === 0 || c.y === 0 || c.x + c.w >= p.width || c.y + c.h >= p.height;
  return { structures, arrows: findArrows(all, labels, p.width, free.filter((c) => !edge(c)), letter), letter };
}

const inside = (c: Box, b: Box) => c.x >= b.x && c.y >= b.y && c.x + c.w <= b.x + b.w && c.y + c.h <= b.y + b.h;

// Reaction arrows: long straight pieces with a head at one end (or both). The head is where the ink stands furthest
// off the line, near an end. Two half-headed arrows close together, pointing opposite ways, are an equilibrium.
function findArrows(all: Piece[], labels: Int32Array, width: number, free: Piece[], letter: number): FoundArrow[] {
  type Line = { from: [number, number]; to: [number, number]; heads: number; piece: Piece };
  const lines: Line[] = [], number = new Map(all.map((c, i) => [c, i + 1]));
  for (const c of free) {
    if (Math.hypot(c.w, c.h) < 3 * letter || c.spread > 0.25 * letter) continue;
    const id = number.get(c)!, th = (c.angle * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th);
    const xs: number[] = [], ys: number[] = [];
    for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) if (labels[y * width + x] === id) { xs.push(x); ys.push(y); }
    const cx = xs.reduce((u, v) => u + v, 0) / xs.length, cy = ys.reduce((u, v) => u + v, 0) / ys.length;
    const ts = xs.map((x, k) => (x - cx) * cos + (ys[k] - cy) * sin), ds = xs.map((x, k) => Math.abs(-(x - cx) * sin + (ys[k] - cy) * cos));
    let t0 = Infinity, t1 = -Infinity;
    for (const t of ts) { if (t < t0) t0 = t; if (t > t1) t1 = t; }
    const end = Math.min(1.2 * letter, 0.3 * (t1 - t0)), shaft = [...ds].sort((u, v) => u - v)[ds.length >> 1];
    let w0 = 0, w1 = 0;
    ts.forEach((t, k) => { if (t < t0 + end) w0 = Math.max(w0, ds[k]); if (t > t1 - end) w1 = Math.max(w1, ds[k]); });
    const head = (wd: number) => wd > 2.5 * shaft + 1.5 && wd > 0.12 * letter;
    const a: [number, number] = [cx + t0 * cos, cy + t0 * sin], b: [number, number] = [cx + t1 * cos, cy + t1 * sin], h0 = head(w0), h1 = head(w1);
    if (!h0 && !h1) continue; // a rule or an underline
    lines.push(h1 || !h0 ? { from: a, to: b, heads: h0 && h1 ? 2 : 1, piece: c } : { from: b, to: a, heads: 1, piece: c });
  }
  // Equilibrium: two parallel arrows, opposite ways, less than a letter apart and side by side along their length.
  const arrows: (FoundArrow & { pieces: Piece[] })[] = [], used = new Set<Line>();
  const dir = (l: Line) => Math.atan2(l.to[1] - l.from[1], l.to[0] - l.from[0]);
  const span = (l: Line): [number, number] => [Math.min(l.from[0], l.to[0]), Math.max(l.from[0], l.to[0])];
  for (const l of lines) {
    if (used.has(l)) continue;
    used.add(l);
    const mate = lines.find((m) => {
      if (used.has(m) || Math.abs(Math.cos(dir(l) - dir(m)) + 1) > 0.02 || gap(l.piece, m.piece) > letter) return false;
      const [a0, a1] = span(l), [b0, b1] = span(m);
      return Math.min(a1, b1) - Math.max(a0, b0) > 0.5 * Math.min(a1 - a0, b1 - b0);
    });
    if (mate) {
      used.add(mate);
      const upper = l.from[1] + l.to[1] <= mate.from[1] + mate.to[1] ? l : mate, other = upper === l ? mate : l;
      arrows.push({ from: [(upper.from[0] + other.to[0]) / 2, (upper.from[1] + other.to[1]) / 2], to: [(upper.to[0] + other.from[0]) / 2, (upper.to[1] + other.from[1]) / 2], kind: "equilibrium", above: [], below: [], pieces: [l.piece, mate.piece] });
    } else arrows.push({ from: l.from, to: l.to, kind: l.heads === 2 ? "resonance" : "reaction", above: [], below: [], pieces: [l.piece] });
  }
  // Conditions: the text lines over and under a lying arrow, each piece with the nearest arrow. The first line starts
  // within 1.5 letters of the arrow, each next one within 1.2 letters of the last. Words may reach past the arrow's ends.
  const lying = (a: FoundArrow) => Math.abs(a.to[1] - a.from[1]) < 0.45 * Math.abs(a.to[0] - a.from[0]);
  const shafts = new Set(arrows.flatMap((a) => a.pieces));
  const text = free.filter((c) => !shafts.has(c) && !(Math.max(c.w, c.h) > 2.5 * letter && c.spread < 0.25 * letter));
  const middle = (c: Box): [number, number] => [c.x + c.w / 2, c.y + c.h / 2];
  const lineY = (a: FoundArrow, x: number) => a.from[1] + ((a.to[1] - a.from[1]) * (x - a.from[0])) / (a.to[0] - a.from[0] || 1);
  const owner = new Map<Piece, FoundArrow>();
  for (const c of text) {
    const [x, y] = middle(c);
    let best: FoundArrow | undefined, bestD = 8 * letter;
    for (const a of arrows) {
      if (!lying(a)) continue;
      const d = Math.abs(y - lineY(a, x));
      if (x >= Math.min(a.from[0], a.to[0]) - letter && x <= Math.max(a.from[0], a.to[0]) + letter && d < bestD) { best = a; bestD = d; }
    }
    if (best) owner.set(c, best);
  }
  const overlap = (b: Box, c: Box) => Math.min(b.y + b.h, c.y + c.h) - Math.max(b.y, c.y) > Math.min(b.h, c.h) / 3;
  for (const a of arrows) {
    if (!lying(a)) continue;
    const mid = lineY(a, (a.from[0] + a.to[0]) / 2);
    for (const side of ["above", "below"] as const) {
      const sign = side === "above" ? -1 : 1, mine = text.filter((c) => owner.get(c) === a && sign * (middle(c)[1] - mid) > 0);
      // Lines: pieces that overlap in height by a third of the smaller one, nearest the arrow first.
      const rowsOf: Box[] = [];
      for (const c of [...mine].sort((u, v) => sign * (middle(u)[1] - middle(v)[1]))) {
        const r = rowsOf.findIndex((b) => overlap(b, c));
        if (r >= 0) rowsOf[r] = join(rowsOf[r], c); else rowsOf.push({ x: c.x, y: c.y, w: c.w, h: c.h });
      }
      // Words that run on past the arrow's ends, beside a line, join it.
      for (let r = 0; r < rowsOf.length; r++)
        for (let grew = true; grew; ) {
          grew = false;
          for (const c of text) {
            const b = rowsOf[r];
            if ((owner.has(c) && owner.get(c) !== a) || inside(c, b) || !overlap(b, c) || gap(c, b) > 0.8 * letter) continue;
            rowsOf[r] = join(b, c); owner.set(c, a); grew = true;
          }
        }
      let edge = mid;
      for (const [k, b] of rowsOf.entries()) {
        const d = side === "above" ? edge - (b.y + b.h) : b.y - edge;
        if (d > (k ? 1.2 : 1.5) * letter || b.h > 2.5 * letter) break;
        a[side].push(b);
        edge = side === "above" ? b.y : b.y + b.h;
      }
    }
  }
  return arrows.map(({ pieces: _, ...a }) => a);
}
