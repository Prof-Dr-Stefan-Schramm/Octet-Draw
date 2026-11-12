// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/model/src/arrow_labels.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// Conditions text on a straight arrow (Caption.on), moved by hand. Free text dragged (or nudged) beside the middle part
// of a straight arrow attaches to it (dropSlot). Attached text dragged away from or towards its arrow keeps its place
// along the arrow and takes the gap it is dropped at, or the other side when dragged across; dragged past the arrow's
// end it comes away as free text (draggedOn). The gap (Caption.on.gap, pt at the arrow's scale, from the arrow's line
// to the near edge of the text box) is Octet's GAP_ARROW_PT when unset.
// Octet lays conditions out as placeCaptions does (render.ts): over or under the middle of an arrow within 60° of
// level, left (above) or right (below) of a steeper one. So "across" here is up and down the page, or left and right,
// not square to the arrow as in ReShiki; and several texts on a side stack outwards (ReShiki has one per side).
import type { Arrow, Box, Caption, Mol } from "./render.ts";
import { GAP_ARROW_PT, scaleOf, straightArrow } from "./render.ts";

type P = [number, number];
export type Side = "above" | "below";
// The largest gap kept (pt). A text dragged further from its arrow comes away as free text.
export const MAX_GAP_PT = 100;

// Text can sit on an arrow that is straight (one bent at its point cannot).
export const takesConditions = (a: Arrow) => straightArrow(a) && !(a.point && a.bend) && Math.hypot(a.to[0] - a.from[0], a.to[1] - a.from[1]) > 1e-9;

// The arrow as placeCaptions lays its conditions out (px, y down; k px per bond length): its middle, whether it is
// within 60° of level (text over and under it) or steeper (text left and right of it), and half its span that way.
export function conditionsFrame(a: Arrow, k: number): { mid: P; flat: boolean; half: number } {
  const s: P = [a.from[0] * k, -a.from[1] * k], t: P = [a.to[0] * k, -a.to[1] * k], len = Math.hypot(t[0] - s[0], t[1] - s[1]) || 1;
  const flat = Math.abs(t[0] - s[0]) / len >= 0.5;
  return { mid: [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2], flat, half: Math.abs(flat ? t[0] - s[0] : t[1] - s[1]) / 2 };
}

// Where text with this box (px, y down) is beside an arrow: the side its middle is on, and its gap (px) from the
// arrow's line to its near edge (below 0 when it reaches over the line). Undefined when it is past the arrow's end:
// its middle beyond the arrow's span, and the text not over the arrow's middle (ReShiki's slot).
export function besideArrow(a: Arrow, box: Box, k: number): { side: Side; gap: number } | undefined {
  if (!takesConditions(a)) return undefined;
  const f = conditionsFrame(a, k), c: P = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  const along = Math.abs(f.flat ? c[0] - f.mid[0] : c[1] - f.mid[1]), halfText = (f.flat ? box[2] - box[0] : box[3] - box[1]) / 2;
  if (along > f.half && along > halfText) return undefined;
  if (f.flat) return c[1] < f.mid[1] ? { side: "above", gap: f.mid[1] - box[3] } : { side: "below", gap: box[1] - f.mid[1] };
  return c[0] < f.mid[0] ? { side: "above", gap: f.mid[0] - box[2] } : { side: "below", gap: box[0] - f.mid[0] };
}

// How far (px) from an arrow's line its text on a side reaches: the far edge of the furthest box, else the automatic gap.
export function sideReach(a: Arrow, side: Side, boxes: Box[], k: number, pt: number): number {
  const f = conditionsFrame(a, k), far = (b: Box) => (f.flat ? (side === "above" ? f.mid[1] - b[1] : b[3] - f.mid[1]) : side === "above" ? f.mid[0] - b[0] : b[2] - f.mid[0]);
  return Math.max(GAP_ARROW_PT * scaleOf(a) * pt, ...boxes.map(far));
}

// The arrow and side free text dropped with this box attaches to: the nearest arrow whose slot holds it, no further
// out than a bond length (k) past what that side already holds (reach, px; sideReach). Undefined: it stays free.
export function dropSlot(arrows: Arrow[], box: Box, k: number, reach: (a: Arrow, side: Side) => number): { arrow: number; side: Side } | undefined {
  let best: { arrow: number; side: Side; gap: number } | undefined;
  for (const a of arrows) {
    const s = besideArrow(a, box, k);
    if (s && s.gap <= reach(a, s.side) + k && (!best || s.gap < best.gap)) best = { arrow: a.id, ...s };
  }
  return best && { arrow: best.arrow, side: best.side };
}

// A gap in px as the pt kept in Caption.on.gap (at the arrow's scale), to 0.01 pt.
const gapPt = (px: number, a: Arrow, pt: number) => Math.round((Math.max(0, px) / (pt * scaleOf(a))) * 100) / 100;

// Attached text dragged on its own (its arrow staying), from the box start to the box now (px, y down): its new
// on, or undefined when it comes away as free text (dragged past the arrow's end, or more than MAX_GAP_PT out).
// A drag with no part across the arrow keeps the gap as it was; text placed by hand (from a ChemDraw file) is laid out
// by Octet from now on, at the gap it is dropped at.
export function draggedOn(c: Pick<Caption, "on" | "placed">, a: Arrow, start: Box, now: Box, k: number, pt: number): Caption["on"] | undefined {
  const s = besideArrow(a, now, k), s0 = besideArrow(a, start, k);
  if (!c.on || !s) return undefined;
  if (!c.placed && s0 && s0.side === s.side && Math.abs(s.gap - s0.gap) < 1e-6) return c.on;
  const g = gapPt(s.gap, a, pt);
  if (g > MAX_GAP_PT) return undefined;
  const { gap: _g, ...on } = c.on;
  return { ...on, side: s.side, ...(c.on.gap === undefined && Math.abs(g - GAP_ARROW_PT) < 1e-6 ? {} : { gap: g }) };
}

// A caption moved on its own by d (drawing units, y up), its arrow (if any) staying: what the Editor's move does to it.
// at: its anchor moved by d; start: its box as drawn before the move (px, y down, k px per bond length); arrows: the
// arrows that stay, as drawn; others: every other caption's box as drawn, and its on. Conditions text keeps to its arrow
// (draggedOn), else comes away as free text where it is dropped, lined up as it was drawn (lined). Free text attaches
// when attach is set (text moved on its own, ⌘ not held) and it lands in a slot (dropSlot). Undefined: none of this
// applies (the caller moves it as before).
export function movedText(c: Caption, at: P, start: Box, d: P, arrows: Arrow[], others: { box: Box; on?: Caption["on"] }[], k: number, pt: number, attach: boolean, lined?: Caption["align"]): Caption | undefined {
  const now: Box = [start[0] + d[0] * k, start[1] - d[1] * k, start[2] + d[0] * k, start[3] - d[1] * k];
  if (c.on) {
    const a = arrows.find((q) => q.id === c.on!.arrow), on = a && takesConditions(a) ? draggedOn(c, a, start, now, k, pt) : undefined;
    if (on) { const { placed: _p, ...rest } = c; return { ...rest, on, x: at[0], y: at[1] }; }
    const { under: _u, on: _o, placed: _p, ...free } = c;
    return { ...free, x: at[0], y: at[1], ...(lined ? { align: lined } : {}) };
  }
  if (!attach || c.under || c.cycle || !c.text.trim()) return undefined;
  const slot = dropSlot(arrows.filter(takesConditions), now, k, (a, side) => sideReach(a, side, others.filter((o) => o.on?.arrow === a.id && o.on.side === side).map((o) => o.box), k, pt));
  return slot ? { ...c, x: at[0], y: at[1], on: slot } : undefined;
}

// The gap (pt) set on the picked conditions texts (undefined: Automatic), in one change. Text placed by hand is laid
// out by Octet from now on. A gap outside 0 to MAX_GAP_PT, or not a number, changes nothing.
export function setGap(m: Mol, ids: Set<number>, gap: number | undefined): Mol {
  if (gap !== undefined && !(Number.isFinite(gap) && gap >= 0 && gap <= MAX_GAP_PT)) return m;
  const value = gap === undefined ? undefined : Math.round(gap * 100) / 100;
  if (!m.captions?.some((c) => ids.has(c.id) && c.on && (c.on.gap !== value || c.placed))) return m;
  return {
    ...m,
    captions: m.captions.map((c) => {
      if (!ids.has(c.id) || !c.on) return c;
      const { gap: _g, ...on } = c.on, { placed: _p, ...rest } = c;
      return { ...rest, on: value === undefined ? on : { ...on, gap: value } };
    }),
  };
}

// A gap read from a file: a number from 0 to MAX_GAP_PT, else none (Automatic).
export const readGap = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_GAP_PT ? v : undefined);
