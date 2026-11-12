// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/model/src/arrow_labels/tests.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// Run: node src/arrowlabels.check.ts. Conditions text dragged onto, along and off a straight arrow, and its gap
// (arrowlabels.ts). ReShiki's behaviour tests, re-expressed for Octet's layout (placeCaptions) on our own small
// drawings. A drag is modelled as the Editor's moveAll does it for one caption moved on its own: movedText with the
// caption's box as drawn before the move.
import assert from "node:assert/strict";
import { MAX_GAP_PT, besideArrow, draggedOn, movedText, readGap, setGap } from "./arrowlabels.ts";
import { EMPTY, addArrow, addCaption, addRing, deleteGraphics, extractSelection, insertMol, pos, updateArrow } from "./edit.ts";
import { cleanUpReaction, findReaction, gapFor } from "./reaction.ts";
import { history } from "./history.ts";
import { parse, serialize } from "./file.ts";
import { readOct, writeOct } from "./oct.ts";
import { toCdxml } from "./cdxml.ts";
import { DEFAULT_STYLE } from "./docstyle.ts";
import { describe } from "./access.ts";
import { ASCENT, DESCENT, GAP_ARROW_PT, LINE, fitArrows, placeCaptions, type Arrow, type Box, type Caption, type Mol } from "./render.ts";

type P = [number, number];
const pt = 4 / 3, L = 14.4 * pt, size = 10 * pt;
const width = (t: string) => t.length * 6;
const fitted = (m: Mol) => fitArrows(m, L, (c) => Math.max(...c.text.split("\n").map(width)), pt);
const lay = (m: Mol) => placeCaptions(m, { ink: [], scale: L }, (t) => width(t), fitted(m), pt, 10);
const boxOf = (m: Mol, id: number) => lay(m).find((x) => x.id === id)!.box;
const cap = (m: Mol, id: number) => m.captions!.find((c) => c.id === id)!;
const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;
// The arrow's middle on the page (px, y down).
const midOf = (a: Arrow): P => [((a.from[0] + a.to[0]) / 2) * L, -((a.from[1] + a.to[1]) / 2) * L];
const centre = (b: Box): P => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
// One caption dragged on its own by d (bond lengths, y up), as the Editor's moveAll does it.
function drag(m: Mol, id: number, d: P, keepFree = false): Mol {
  const drawn = lay(m), arrows = fitted(m), p = drawn.find((x) => x.id === id)!, c = cap(m, id);
  // Its anchor (the Editor's anchorOf), moved by d.
  const ax = p.anchor === "start" ? p.box[0] : p.anchor === "end" ? p.box[2] : (p.box[0] + p.box[2]) / 2, at: P = [ax / L + d[0], -p.lines[0].y / L + d[1]];
  const others = drawn.filter((x) => x.id !== id).map((x) => ({ box: x.box, on: cap(m, x.id).on }));
  const lined = c.on ? ({ start: "left", middle: "centre", end: "right" } as const)[p.anchor] : undefined;
  const moved = movedText(c, at, p.box, d, arrows, others, L, pt, !keepFree, lined);
  return moved ? { ...m, captions: m.captions!.map((x) => (x.id === id ? moved : x)) } : { ...m, captions: m.captions!.map((x) => (x.id === id ? { ...x, x: x.x + d[0], y: x.y + d[1] } : x)) };
}
// Free text whose box is centred on p (bond lengths, y up), as text the user typed somewhere and then drags: it is
// laid out where it is (centred), then dragged by a hair so the drop rule runs.
function dropText(m: Mol, text: string, p: P): [Mol, number] {
  const [n, id] = addCaption(m, { text, x: p[0], y: p[1] - ((ASCENT - DESCENT) * size) / 2 / L, align: "centre" });
  return [drag(n, id, [0, 0]), id];
}

// A reaction arrow 6 bond lengths long, left to right, through the origin's level.
let base: Mol, ARROW: number;
[base, ARROW] = addArrow(EMPTY, { kind: "reaction", from: [0, 0], to: [6, 0] });
const arrowOf = (m: Mol) => fitted(m).find((a) => a.id === ARROW)!;
const auto = GAP_ARROW_PT * pt;

// ——— typed_text_in_a_slot_attaches_centred_and_widens_the_arrow ———
{
  let m: Mol, above: number, below: number;
  [m, above] = dropText(base, "Pd(PPh3)4, K2CO3, toluene/H2O, 80 °C, 12 h", [2, 0.6]);
  [m, below] = dropText(m, "92%", [3.6, -0.7]);
  assert.deepEqual(cap(m, above).on, { arrow: ARROW, side: "above" }, "dropped above: attached above, Automatic gap");
  assert.deepEqual(cap(m, below).on, { arrow: ARROW, side: "below" }, "dropped below: attached below");
  const mid = midOf(arrowOf(m)), a = boxOf(m, above), b = boxOf(m, below);
  assert.ok(close(centre(a)[0], mid[0]) && close(centre(b)[0], mid[0]), "centred on the arrow's middle");
  assert.ok(close(mid[1] - a[3], auto) && close(b[1] - mid[1], auto), "3 pt from the arrow's line");
  const w = a[2] - a[0], drawn = arrowOf(m);
  assert.ok(w > 6 * L, "wide text");
  assert.ok(close((drawn.to[0] - drawn.from[0]) * L, w + 2 * 6 * pt), "the arrow is drawn long enough for its text (fitArrows)");
  assert.ok(close((drawn.from[0] + drawn.to[0]) / 2, 3), "grown about its middle");
}

// ——— unattached_text_keeps_its_existing_behaviour ———
{
  let m: Mol, far: number, plus: number;
  [m, far] = dropText(base, "note", [3, 10]);
  [m, plus] = dropText(m, "+", [-2, 0]);
  assert.equal(cap(m, far).on, undefined, "far above stays free");
  assert.equal(cap(m, plus).on, undefined, "beside the arrow's start stays free");
  // ⌘ (Ctrl) held keeps text free.
  let n: Mol, id: number;
  [n, id] = addCaption(base, { text: "heat", x: 3, y: 2, align: "centre" });
  assert.equal(cap(drag(n, id, [0, -1.5], true), id).on, undefined, "⌘ held: free");
  assert.equal(cap(drag(n, id, [0, -1.5]), id).on?.side, "above", "without ⌘: attached");
}

// ——— dragging_text_away_detaches_and_across_changes_side ———
{
  let m: Mol, id: number;
  [m, id] = dropText(base, "hν", [3, 0.6]);
  const before = boxOf(m, id);
  // Perpendicular movement (with some along) changes the gap and keeps it centred.
  m = drag(m, id, [10 / L, 3 / L]);
  assert.equal(cap(m, id).on?.side, "above");
  assert.ok(close(cap(m, id).on!.gap!, GAP_ARROW_PT + 3 / pt, 0.01), "gap grew by the 3 px moved up");
  assert.ok(close(centre(boxOf(m, id))[0], centre(before)[0]), "still centred");
  assert.ok(close(boxOf(m, id)[3], before[3] - 3, 0.02), "and 3 px further up");
  // Across the arrow.
  m = drag(m, id, [0, -2]);
  assert.equal(cap(m, id).on?.side, "below", "dragged across: the other side");
  assert.ok(close(centre(boxOf(m, id))[0], centre(before)[0]));
  // A large perpendicular movement still sets the gap; past MAX_GAP_PT it comes away.
  m = drag(m, id, [0, -3]);
  assert.equal(cap(m, id).on?.side, "below");
  assert.ok(cap(m, id).on!.gap! > 50, "a large gap");
  const away = drag(m, id, [0, -(MAX_GAP_PT * pt) / L]);
  assert.equal(cap(away, id).on, undefined, "too far: free text");
  // Sideways past the end: free text, where it is dropped.
  const side = drag(m, id, [20, 0]), b = boxOf(m, id), freeBox = boxOf(side, id);
  assert.equal(cap(side, id).on, undefined, "sideways past the end: free");
  assert.ok(close(freeBox[0], b[0] + 20 * L, 1e-3) && close(freeBox[1], b[1], 1e-3), "it stays where it is dropped");
  // A sideways nudge within the span sets no gap.
  let n: Mol, k: number;
  [n, k] = dropText(base, "Δ", [3, 0.6]);
  n = drag(n, k, [1 / 14.4, 0]);
  assert.deepEqual(cap(n, k).on, { arrow: ARROW, side: "above" }, "nudged along: Automatic still");
}

// ——— wide_text_started_mid_arrow_attaches ———
{
  const wide = "Pd(PPh3)4, K2CO3, toluene/H2O, 80 °C", w = width(wide) / L;
  // The left edge just before the arrow's middle: its own middle is past the arrow's end, but the text is over the middle.
  const [m, id] = dropText(base, wide, [2.95 + w / 2, 0.6]);
  assert.equal(cap(m, id).on?.side, "above");
  assert.ok(close(centre(boxOf(m, id))[0], midOf(arrowOf(m))[0]));
}

// ——— an_occupied_slot (Octet stacks: several texts on a side) ———
{
  let m: Mol, first: number, second: number;
  [m, first] = dropText(base, "a", [3, 0.6]);
  [m, second] = dropText(m, "b", [1.5, 1.4]);
  assert.equal(cap(m, first).on?.side, "above");
  assert.equal(cap(m, second).on?.side, "above", "joins the stack (Octet keeps several texts on a side)");
  const a = boxOf(m, first), b = boxOf(m, second), mid = midOf(arrowOf(m));
  assert.ok(close(mid[1] - a[3], auto), "the first stays at the arrow");
  assert.ok(close(mid[1] - b[3], auto + (LINE + 0.2) * size), "the second stacks out past it, as before");
  // dragging_onto_an_occupied_side_keeps_the_label_already_there: the text already there keeps its place.
  let n: Mol, up: number, down: number;
  [n, down] = dropText(base, "b", [3, -0.7]);
  [n, up] = dropText(n, "a", [3, 0.6]);
  n = drag(n, up, [0, -1.6]);
  assert.equal(cap(n, up).on?.side, "below");
  assert.ok(close(boxOf(n, down)[1] - midOf(arrowOf(n))[1], auto), "the text already below stays next to the arrow");
}

// ——— vertical_arrows_take_labels_on_the_left_and_right ———
{
  let m: Mol, v: number, left: number, right: number;
  [m, v] = addArrow(EMPTY, { kind: "reaction", from: [0, 0], to: [0, -6] });
  [m, left] = dropText(m, "KOH", [-1, -3]);
  [m, right] = dropText(m, "EtOH", [1, -3]);
  assert.equal(cap(m, left).on?.side, "above", "left of a vertical arrow is above");
  assert.equal(cap(m, right).on?.side, "below", "right is below");
  const a = fitted(m).find((x) => x.id === v)!, mid = midOf(a), l = boxOf(m, left), r = boxOf(m, right);
  assert.ok(close(mid[0] - l[2], auto) && close(r[0] - mid[0], auto), "3 pt left and right of the line");
  m = drag(m, left, [-0.5, 0]);
  assert.ok(close(mid[0] - boxOf(m, left)[2], auto + 0.5 * L, 0.02), "dragged left: a larger gap");
}

// ——— custom_gap_survives_arrow_edits_and_multiline_format_changes ———
{
  let m: Mol, id: number, below: number;
  [m, id] = dropText(base, "H2, Pd/C\nEtOH, rt", [3, 1]);
  [m, below] = dropText(m, "92%", [3, -0.7]);
  m = setGap(m, new Set([id]), 12);
  m = setGap(m, new Set([below]), 5);
  const gapOf = (x: Mol, c: number) => { const a = fitted(x).find((q) => q.id === ARROW)!, s = besideArrow(a, boxOf(x, c), L)!; return [s.side, s.gap / pt] as const; };
  for (const degrees of [0, 30, 45, 90, 135, 180, 225, 270, 315]) {
    const t = (degrees * Math.PI) / 180, turned = updateArrow(m, ARROW, { from: [1, 2], to: [1 + 8 * Math.cos(t), 2 + 8 * Math.sin(t)] });
    const [s1, g1] = gapOf(turned, id), [s2, g2] = gapOf(turned, below);
    assert.equal(s1, "above", `${degrees}°: above`);
    assert.ok(close(g1, 12, 1e-6), `${degrees}°: 12 pt (${g1})`);
    assert.equal(s2, "below", `${degrees}°: below`);
    assert.ok(close(g2, 5, 1e-6), `${degrees}°: 5 pt`);
  }
  const restyled = { ...m, captions: m.captions!.map((c) => (c.id === id ? { ...c, text: "H2 (1 atm), Pd/C\nEtOH, room temperature, 2 h", size: 18 } : c)) };
  assert.ok(close(gapOf(restyled, id)[1], 12), "new text and size keep the gap");
  const moved = updateArrow(m, ARROW, { from: [5, -3], to: [11, -3] });
  assert.ok(close(gapOf(moved, id)[1], 12), "moving the arrow keeps the gap");
  // A larger gap on the first moves the stack out; a smaller one on the second cannot push it into the first.
  let s: Mol, a: number, b: number;
  [s, a] = dropText(base, "a", [3, 0.6]);
  [s, b] = dropText(s, "b", [3, 1.4]);
  s = setGap(s, new Set([a]), 20);
  const mid = midOf(arrowOf(s));
  assert.ok(close(mid[1] - boxOf(s, a)[3], 20 * pt) && close(mid[1] - boxOf(s, b)[3], 20 * pt + (LINE + 0.2) * size), "the stack goes out with the first");
  s = setGap(s, new Set([b]), 0);
  assert.ok(close(mid[1] - boxOf(s, b)[3], 20 * pt + (LINE + 0.2) * size), "a small gap stays past the text before it");
}

// ——— setGap: values, Automatic, hand-placed text ———
{
  let m: Mol, id: number;
  [m, id] = dropText(base, "heat", [3, 0.6]);
  assert.equal(setGap(m, new Set([id]), undefined), m, "already Automatic: nothing to change");
  for (const bad of [-1, NaN, Infinity, MAX_GAP_PT + 1]) assert.equal(setGap(m, new Set([id]), bad), m, `${bad} refused`);
  const set = setGap(m, new Set([id]), 0);
  assert.equal(cap(set, id).on?.gap, 0, "a zero gap is a gap");
  assert.ok(close(midOf(arrowOf(set))[1] - boxOf(set, id)[3], 0), "the text touches the line");
  assert.equal(cap(setGap(set, new Set([id]), undefined), id).on?.gap, undefined, "Automatic again");
  // Conditions placed by hand (a ChemDraw file's) are laid out by Octet once a gap is set, or once dragged.
  const hand: Mol = { ...m, captions: m.captions!.map((c) => (c.id === id ? { ...c, placed: { at: [-1, 1.5], arrow: [6, 0] } } : c)) };
  assert.equal(cap(setGap(hand, new Set([id]), 6), id).placed, undefined, "a gap clears the hand placing");
  const dragged = drag(hand, id, [0, 0.1]);
  assert.equal(cap(dragged, id).placed, undefined, "a drag clears it too");
  assert.ok(close(centre(boxOf(dragged, id))[0], midOf(arrowOf(dragged))[0]), "and Octet centres it");
  // draggedOn on its own: no on, no change.
  assert.equal(draggedOn({}, arrowOf(m), [0, 0, 1, 1], [0, 0, 1, 1], L, pt), undefined);
}

// ——— Undo and Redo: one change each ———
{
  let m: Mol, id: number;
  [m, id] = dropText(base, "heat", [3, 0.6]);
  let h = history({ stack: [m], at: 0 }, { type: "set", mol: setGap(m, new Set([id]), 8) });
  assert.equal(cap(h.stack[h.at], id).on?.gap, 8);
  h = history(h, { type: "undo" });
  assert.equal(cap(h.stack[h.at], id).on?.gap, undefined, "Undo: Automatic");
  h = history(h, { type: "redo" });
  assert.equal(cap(h.stack[h.at], id).on?.gap, 8, "Redo: 8 pt");
}

// ——— Delete, copy and paste ———
{
  let m: Mol, id: number, free: number;
  [m, id] = dropText(base, "Δ", [3, 0.6]);
  [m, free] = addCaption(m, { text: "note", x: 3, y: -20 });
  m = setGap(m, new Set([id]), 9);
  // Octet keeps the text when its arrow goes (issue 12), as free text: no gap.
  const gone = deleteGraphics(m, new Set([ARROW]));
  assert.equal(cap(gone, id).on, undefined, "deleting the arrow leaves free text");
  assert.ok(cap(gone, free), "other text stays");
  // Copying the arrow copies its text, gap and all.
  const part = extractSelection(m, new Set(), new Set([ARROW]));
  assert.equal(part.captions?.length, 1);
  const pasted = insertMol(m, part, [0, -5]).mol, copy = pasted.captions!.filter((c) => c.on?.gap === 9);
  assert.equal(copy.length, 2, "the pasted text keeps its gap");
  assert.notEqual(copy[1].on!.arrow, ARROW, "on the pasted arrow");
  // Copying the text alone gives free text.
  assert.equal(extractSelection(m, new Set(), new Set([id])).captions?.[0].on, undefined);
}

// ——— Files: .oct (Octet's JSON inside), CDXML, bad values ———
{
  let m: Mol, id: number, plain: number;
  [m, id] = dropText(base, "heat", [3, 0.6]);
  [m, plain] = dropText(m, "2 h", [3, -0.7]);
  m = setGap(m, new Set([id]), 12.5);
  const back = parse(serialize(m));
  assert.equal(back.captions!.find((c) => c.text === "heat")!.on?.gap, 12.5, "the gap is saved");
  assert.equal(back.captions!.find((c) => c.text === "2 h")!.on?.gap, undefined, "Automatic is not written");
  const oct = readOct(writeOct(m, DEFAULT_STYLE), true).mol;
  assert.equal(oct.captions!.find((c) => c.text === "heat")!.on?.gap, 12.5, ".oct keeps the gap");
  // A bad gap is left out; the text stays on its arrow.
  const json = JSON.parse(serialize(m));
  for (const bad of [-1, "12", 1e9, null]) {
    json.captions[0].on.gap = bad;
    const read = parse(JSON.stringify(json)).captions![0];
    assert.equal(read.on?.gap, undefined, `${String(bad)}: Automatic`);
    assert.equal(read.on?.side, "above", `${String(bad)}: still on its arrow`);
  }
  assert.equal(readGap(0), 0);
  assert.equal(readGap(MAX_GAP_PT), MAX_GAP_PT);
  // CDXML has the text where Octet draws it: 9.5 pt further up with a 12.5 pt gap than with 3 pt.
  const yOf = (x: Mol, text: string) => { const xml = toCdxml(x, DEFAULT_STYLE), at = xml.indexOf(`>${text}</s>`), t = xml.lastIndexOf("<t\n", at), p = /p="([-\d.]+) ([-\d.]+)"/.exec(xml.slice(t, at))!; return Number(p[2]); };
  const plainY = yOf(setGap(m, new Set([id]), undefined), "heat"), gappedY = yOf(m, "heat");
  assert.ok(close(plainY - gappedY, 9.5, 0.02), `CDXML text moves up by the gap (${plainY - gappedY})`);
  assert.ok(close(yOf(m, "2 h"), yOf(setGap(m, new Set([id]), undefined), "2 h"), 1e-6), "the other side is unchanged");
  void plain;
}

// ——— Clean Up Reaction keeps a gap set on the conditions ———
{
  let t: Mol = addRing(EMPTY, 6, false, { point: [0, 0.6] }), rxn: number, id: number, plain: number;
  [t, rxn] = addArrow(t, { kind: "reaction", from: [3, 0], to: [6, 0] });
  t = addRing(t, 5, false, { point: [8.4, -0.5] });
  [t, id] = addCaption(t, { text: "heat", x: 0, y: 0, on: { arrow: rxn, side: "above", gap: 7 } });
  [t, plain] = addCaption(t, { text: "2 h", x: 0, y: 0, on: { arrow: rxn, side: "below" } });
  const toDoc = (b: Box): Box => [b[0] / L, -b[3] / L, b[2] / L, -b[1] / L];
  const captionBox = (c: number) => { const p = lay(t).find((x) => x.id === c); return p && toDoc(p.box); };
  const ink = (atoms: number[]): Box => { const ps = atoms.map((i) => pos(t, i)); return [Math.min(...ps.map((q) => q[0])), Math.min(...ps.map((q) => q[1])), Math.max(...ps.map((q) => q[0])), Math.max(...ps.map((q) => q[1]))]; };
  const r = findReaction(t, rxn, fitted(t), ink, captionBox)!;
  assert.ok(r, "a reaction");
  const done = cleanUpReaction(t, r, fitted(t), { gap: gapFor(10, 14.4), captionBox, plusBox: [-0.25, -0.15, 0.25, 0.45], captionPt: 10, bondPt: 14.4 });
  assert.equal(cap(done, id).on?.gap, 7, "the gap stays");
  assert.equal(cap(done, plain).on?.gap, undefined, "Automatic stays Automatic");
}

// ——— Screen readers: the conditions are still read with their arrow ———
{
  let m: Mol, id: number;
  [m, id] = dropText(base, "heat", [3, 0.6]);
  m = setGap(m, new Set([id]), 10);
  const items = describe(m, { box: () => [0, 0, 1, 1] }), text = items.map((x) => x.name).join(" | ");
  assert.ok(/heat/.test(text), `the text is read (${text})`);
}

console.log("arrowlabels.check: all ok");
