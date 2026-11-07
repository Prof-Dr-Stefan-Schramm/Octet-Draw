// Where a label goes beside the arrows it belongs to, measured rather than guessed.
//
// The first try at the Photochemistry set placed every label by hand, at offsets that looked
// about right in a sketch, and every one of them ended up sitting ON its arrow: the offsets
// were measured from the arrow's centre line, while what a label has to clear is the arrow's
// INK — a wavy shaft swings 0.06 bond lengths each side of that line, and an arrowhead is
// wider still. This measures both.
//
// The arrow's ink is Octet's own drawn geometry (render.ts arrowShapes), and the label's is
// Arial's advances and cap height at the caption size, the same metrics clashes.mjs uses for
// atom labels. The label is pushed out along a direction until the two no longer touch.
import { arrowShapes } from "../../src/render.ts";
import { arialGlyph } from "../../src/cdxml.ts";
import { DEFAULT_STYLE, frameStyle } from "../../src/docstyle.ts";

const STYLE = frameStyle(DEFAULT_STYLE, (DEFAULT_STYLE.bond * 4) / 3);
const BOND = STYLE.bond; // px per bond length
// The caption size in the same px as BOND. Taking it as the bare point size was a quarter
// too small (the drawing frame is 4/3 px to the point), so every label measured narrower and
// shorter than it draws, and every one of them was placed that much too close to its arrow.
const CAPTION = (DEFAULT_STYLE.captionSize * 4 * STYLE.k) / 3;
// Arial's cap height, as render.check.ts measures it. A caption's y is its baseline, so a
// label level with a line has its baseline this far below it.
export const CAP = (0.716 * CAPTION) / BOND;
export const DROP = CAP / 2;
// A script run is set smaller and shifted, as render.ts sets it.
const SCRIPT = 0.68;

// A text's width in bond lengths. Runs with a script are set smaller.
export function widthOf(text) {
  const runs = typeof text === "string" ? [{ text }] : text;
  let w = 0;
  for (const run of runs) {
    const size = run.script ? CAPTION * SCRIPT : CAPTION;
    for (const ch of run.text) w += (arialGlyph(ch)[0] * size) / 1000;
  }
  return w / BOND;
}

// A label's ink box in bond lengths (y up), centred on x with its baseline at y. A
// superscript reaches higher than the cap height, a subscript lower than the baseline.
export function inkOf(text, x, y) {
  const runs = typeof text === "string" ? [{ text }] : text;
  const w = widthOf(text);
  const high = runs.some((r) => r.script === "super") ? CAP + (0.33 * CAPTION) / BOND : CAP;
  const low = runs.some((r) => r.script === "sub") ? (0.212 * CAPTION) / BOND : 0;
  return [x - w / 2, y - low, x + w / 2, y + high];
}

// Every edge of every polygon an arrow draws, in bond lengths with y up.
export function inkOfArrows(arrows) {
  const edges = [];
  for (const a of arrows) {
    for (const shape of arrowShapes(a, STYLE, BOND)) {
      const points = shape.map(([x, y]) => [x / BOND, -y / BOND]);
      for (let i = 0; i < points.length; i++) edges.push([points[i], points[(i + 1) % points.length]]);
    }
  }
  return edges;
}

const inside = (p, b) => p[0] > b[0] && p[0] < b[2] && p[1] > b[1] && p[1] < b[3];
const side = (a, c, e) => Math.sign((c[0] - a[0]) * (e[1] - a[1]) - (c[1] - a[1]) * (e[0] - a[0]));
const cross = (p, q, r, s) => side(p, q, r) * side(p, q, s) < 0 && side(r, s, p) * side(r, s, q) < 0;
// An edge runs through a box: either end inside it, or it cuts one of the box's sides.
const through = ([p, q], b) =>
  inside(p, b) || inside(q, b) ||
  [[[b[0], b[1]], [b[2], b[1]]], [[b[2], b[1]], [b[2], b[3]]], [[b[2], b[3]], [b[0], b[3]]], [[b[0], b[3]], [b[0], b[1]]]]
    .some(([r, s]) => cross(p, q, r, s));

// Whether a label at this point is clear of the arrows by `gap` bond lengths all round.
export const clears = (edges, text, x, y, gap) => {
  const [x0, y0, x1, y1] = inkOf(text, x, y);
  const box = [x0 - gap, y0 - gap, x1 + gap, y1 + gap];
  return !edges.some((e) => through(e, box));
};

/// Where to put a label so it clears the arrows: from `start`, stepped along `dir` until its
/// ink is `gap` bond lengths clear of every arrow's ink. Returns [x, y] in bond lengths.
///
/// `gap` is 0.15 bond lengths, about 2 pt at the ACS 1996 style: enough that a label reads as
/// beside its arrow rather than touching it, and not so much that it drifts off on its own.
export function beside(arrows, text, start, dir, gap = 0.15) {
  const edges = inkOfArrows(arrows);
  const length = Math.hypot(dir[0], dir[1]) || 1;
  const step = [dir[0] / length, dir[1] / length];
  for (let k = 0; k <= 80; k++) {
    const x = start[0] + step[0] * k * 0.025, y = start[1] + step[1] * k * 0.025;
    if (clears(edges, text, x, y, gap)) return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
  }
  throw new Error(`cannot place ${JSON.stringify(typeof text === "string" ? text : text.map((r) => r.text).join(""))} clear of its arrows`);
}
