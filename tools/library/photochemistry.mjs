// The library's Photochemistry group: the notation photochemistry and photophysics are
// written in, which no drawing program ships and which everyone in the field redraws by
// hand (issue #43).
//
// Octet can already express all of it — LineStyle has "wavy", so a non-radiative transition
// is a wavy arrow, and a caption's runs take a superscript, so ¹O₂ is one caption. What was
// missing is that the pieces were never assembled, and nobody finds `style: "wavy"` by
// looking at a toolbar. These are those pieces, drawn here from simple geometry.
//
// Everything is in bond lengths with y up, as the rest of the library is, and each item is
// one integral group: a click picks all of it, Ungroup frees the parts.
//
// The conventions are the ones used in the photochemistry literature (IUPAC's glossary of
// terms used in photochemistry, 3rd edition): a straight arrow for a radiative transition,
// a wavy one for a non-radiative one, levels drawn as horizontal lines with the ground state
// at the bottom and the triplet to the right of the singlets and lower.
//
// No label here is placed by hand. Every one is pushed out from its arrow until its ink is
// clear of the arrow's ink (place.mjs), because placing them by eye put every single one of
// them on top of its arrow: an offset that looks right measured from an arrow's centre line
// is not one, once the wave's swing and the arrowhead's width are counted.
import { beside, DROP } from "./place.mjs";

const r3 = (v) => Math.round(v * 1000) / 1000 + 0;
const xy = (x, y) => [r3(x), r3(y)];

// An item from arrows and captions, centred on its box and grouped as one, the way lab.mjs
// builds the glassware. `parts` are arrows; `labels` are [text, x, y] or [runs, x, y, more].
// Arrows and captions share one id space, which is what a group's `items` indexes.
function item(name, also, parts, labels = []) {
  let id = 1;
  const arrows = parts.map((p) => ({ id: id++, ...p }));
  const captions = labels.map(([text, x, y, more = {}]) => ({
    id: id++,
    ...(typeof text === "string" ? { text } : { text: text.map((r) => r.text).join(""), runs: text }),
    x, y, ...more,
  }));
  // A condition on an arrow is laid out from the arrow, so its own point is only a seed and
  // must not drag the item's centre about.
  const free = captions.filter((c) => !c.on);
  const xs = [...arrows.flatMap((a) => [a.from[0], a.to[0]]), ...free.map((c) => c.x)];
  const ys = [...arrows.flatMap((a) => [a.from[1], a.to[1]]), ...free.map((c) => c.y)];
  const dx = (Math.min(...xs) + Math.max(...xs)) / 2, dy = (Math.min(...ys) + Math.max(...ys)) / 2;
  for (const a of arrows) {
    a.from = xy(a.from[0] - dx, a.from[1] - dy);
    a.to = xy(a.to[0] - dx, a.to[1] - dy);
  }
  for (const c of captions) { c.x = r3(c.x - dx); c.y = r3(c.y - dy); }
  return {
    name,
    ...(also ? { also } : {}),
    mol: {
      atoms: [], bonds: [],
      ...(arrows.length ? { arrows } : {}),
      ...(captions.length ? { captions } : {}),
      // A group of one object groups nothing — a click on the caption already picks it — and
      // CDXML drops it, so the species are shipped without one.
      ...(arrows.length + captions.length > 1
        ? { groups: [{ id, atoms: [], items: [...arrows, ...captions].map((o) => o.id), integral: true }] }
        : {}),
    },
  };
}

// Every arrow here keeps Octet's own head — the notched one it gives a reaction arrow, as
// ChemDraw does — and sets no size of its own. Heads drawn specially for one template would
// not match the arrows a chemist draws beside them in the same document, and what made these
// look wrong was never the head's shape: it was the wavy shaft still swinging where the head
// began, so the head sat on the shaft askew (render.ts, waveAlong's settle).

// A radiative transition: a straight arrow. Absorption goes up, emission down.
const radiative = (x, y0, y1) => ({ kind: "reaction", from: xy(x, y0), to: xy(x, y1) });
// A non-radiative transition: a wavy arrow, as the literature draws internal conversion,
// intersystem crossing and vibrational relaxation.
const nonRadiative = (x0, y0, x1, y1) => ({ kind: "reaction", from: xy(x0, y0), to: xy(x1, y1), style: "wavy" });
// An energy level: a plain horizontal line, no heads.
const level = (x0, x1, y) => ({ kind: "line", from: xy(x0, y), to: xy(x1, y) });

const sup = (text) => ({ text, script: "super" });
const sub = (text) => ({ text, script: "sub" });
// A state label: the number is a real subscript run, never the Unicode subscript character.
// U+2080 and U+2081 are drawn as small full-height digits rather than as subscripts, and
// they stay those characters in CDXML and in Word, where nobody can restyle them and a
// search for "S1" misses them.
const state = (letter, index) => [{ text: letter }, sub(index)];

// hν, with the nu in a face that draws it as a Greek letter.
//
// Arial — the document font — draws a Greek nu as a plain v: side by side with the Latin
// letter the two are the same glyph, so "hν" reads as "hv" and the notation is lost. Times
// New Roman draws it Greek, narrower than a v with a curving left stroke, and it is one of
// the fonts Octet already offers (docstyle.ts FONTS), so a drawing carrying it asks for
// nothing new.
//
// The whole label changes face, not only the nu. Setting the nu alone in a serif, the way
// ChemDraw sets Greek in the Symbol font, leaves a sans-serif h beside a serif nu and the
// two do not belong together on the page. Upright, not italic: an italic serif nu leans back
// towards a v, which is the thing being fixed.
const QUANTITY = { font: "Times New Roman" };
const nu = (after = "") => `hν${after}`;

// A label pushed clear of the arrows it belongs to, from `start` along `dir`.
const at = (parts, text, start, dir, more) => {
  const [x, y] = beside(parts, text, start, dir);
  return more ? [text, x, y, more] : [text, x, y];
};
// The direction at right angles to an arrow, on the side `turn` gives (+1 to the left of the
// way it points, -1 to the right), for a label beside a slanted transition.
const across = (a, turn) => {
  const [dx, dy] = [a.to[0] - a.from[0], a.to[1] - a.from[1]];
  return [-dy * turn, dx * turn];
};
// An arrow's middle, dropped to a baseline that puts the label level with it.
const middleOf = (a) => [(a.from[0] + a.to[0]) / 2, (a.from[1] + a.to[1]) / 2 - DROP];

// A reaction arrow with hν or Δ written over it — the one piece of photochemical notation
// that goes in nearly every scheme. The label is a condition on the arrow, so Octet keeps it
// over the arrow's middle when the arrow is moved, lengthened or turned, and lays it out.
const over = (label, name, also, more = {}) =>
  item(name, also, [{ kind: "reaction", from: xy(0, 0), to: xy(2, 0) }], [[label, 1, 0.4, { on: { arrow: 1, side: "above" }, ...more }]]);

// The vertical transitions of a state diagram, each on its own, to drop into a scheme or
// beside a structure.
function transitions() {
  const one = (name, also, arrow, text, more, turn = 1) => item(name, also, [arrow], [at([arrow], text, middleOf(arrow), across(arrow, turn), more)]);
  const absorption = radiative(0, 0, 2), fluorescence = radiative(0, 2, 0), phosphorescence = radiative(0, 2, 0);
  const isc = nonRadiative(0, 1, 1.6, 0), ic = nonRadiative(0, 2, 0, 0);
  // Longer than one bond length so the wave reads as a wave: shorter than this, a
  // vibrational relaxation is hard to tell from a straight arrow at a glance.
  const vr = nonRadiative(0, 1.4, 0, 0), ent = nonRadiative(0, 0, 2.2, 0);
  return [
    over(nu(), "Reaction arrow, hν", "photochemical, irradiation, light, photolysis, hv", QUANTITY),
    over("Δ", "Reaction arrow, Δ", "thermal, heat, delta, reflux"),
    one("Absorption (hν)", "excitation, photon, light, vertical, hv", absorption, nu(), QUANTITY),
    one("Fluorescence", "emission, radiative, singlet, hv", fluorescence, nu("′"), QUANTITY),
    one("Phosphorescence", "emission, triplet, radiative, hv", phosphorescence, nu("″"), QUANTITY),
    one("Intersystem crossing", "ISC, non-radiative, singlet to triplet", isc, "ISC"),
    one("Internal conversion", "IC, non-radiative, same multiplicity", ic, "IC"),
    one("Vibrational relaxation", "VR, non-radiative, cascade", vr, "VR"),
    // Horizontal, so its label goes above it rather than beside it.
    item("Energy transfer", "EnT, sensitisation, Förster, Dexter, quenching", [ent], [at([ent], "EnT", [1.1, 0], [0, 1])]),
  ];
}

// The species, written as photochemistry writes them: the multiplicity as a left
// superscript, the excited state starred. Each is one caption, ready to be retyped for
// another molecule.
const species = () => [
  item("Singlet oxygen", "1O2, singlet dioxygen, reactive oxygen species", [], [[[sup("1"), { text: "O" }, sub("2")], 0, 0]]),
  item("Triplet oxygen", "3O2, ground state dioxygen", [], [[[sup("3"), { text: "O" }, sub("2")], 0, 0]]),
  item("Excited singlet state", "1X*, S1, singlet excited state", [], [[[sup("1"), { text: "X" }, sup("*")], 0, 0]]),
  item("Excited triplet state", "3X*, T1, triplet excited state", [], [[[sup("3"), { text: "X" }, sup("*")], 0, 0]]),
  item("Excited sensitiser", "Sens*, photosensitiser, photocatalyst", [], [[[{ text: "Sens" }, sup("*")], 0, 0]]),
];

// A Jablonski diagram, ready to relabel: the ground state, the first excited singlet and the
// first triplet, with the transitions between them that every photochemistry paper draws.
const S0 = 0, T1 = 2, S1 = 3;
const SING = [0, 2.4], TRIP = [3, 5.4]; // the singlet column and the triplet column

function jablonski() {
  const ground = level(SING[0], TRIP[1], S0); // the ground state runs under both columns
  const singlet = level(SING[0], SING[1], S1), triplet = level(TRIP[0], TRIP[1], T1);
  const absorption = radiative(0.55, S0, S1), fluorescence = radiative(1.85, S1, S0);
  const isc = nonRadiative(SING[1], S1, TRIP[0], T1), phosphorescence = radiative(4.2, T1, S0);
  const parts = [ground, singlet, triplet, absorption, fluorescence, isc, phosphorescence];
  return item(
    "Jablonski diagram",
    "energy level scheme, state diagram, photophysics, S0 S1 T1",
    parts,
    [
      at(parts, state("S", "0"), [SING[0], S0 - DROP], [-1, 0]),
      at(parts, state("S", "1"), [SING[0], S1 - DROP], [-1, 0]),
      at(parts, state("T", "1"), [TRIP[1], T1 - DROP], [1, 0]),
      // Absorption's label to the left of it and emission's to the right, so neither sits
      // between the two arrows where it would read as belonging to both.
      at(parts, nu(), [0.55, 1.5 - DROP], [-1, 0], QUANTITY),
      at(parts, nu("′"), [1.85, 1.5 - DROP], [1, 0], QUANTITY),
      at(parts, "ISC", middleOf(isc), across(isc, 1)),
      at(parts, nu("″"), [4.2, 1 - DROP], [1, 0], QUANTITY),
    ],
  );
}

// The same with the vibrational sub-levels a fuller diagram shows: three thinner lines over
// each electronic state, absorption into the top one of S1 and relaxation down to its
// origin, which is what makes the Stokes shift visible. Labelled S0, S1 and T1 only, since a
// figure this size is relabelled anyway.
function jablonskiVibrational() {
  const gap = 0.22;
  const subs = (x0, x1, y) => [1, 2, 3].map((k) => level(x0 + 0.3, x1 - 0.3, y + k * gap));
  const parts = [
    level(SING[0], TRIP[1], S0), ...subs(SING[0], TRIP[1], S0),
    level(SING[0], SING[1], S1), ...subs(SING[0], SING[1], S1),
    level(TRIP[0], TRIP[1], T1), ...subs(TRIP[0], TRIP[1], T1),
    radiative(0.55, S0, S1 + 3 * gap), // absorption, into a vibrationally excited level
    nonRadiative(0.9, S1 + 3 * gap, 0.9, S1), // relaxation to the origin of S1, beside the absorption
    radiative(1.85, S1, S0 + 2 * gap), // fluorescence, to a vibrationally excited level
    nonRadiative(SING[1], S1, TRIP[0], T1),
    radiative(4.2, T1, S0 + gap),
  ];
  return item(
    "Jablonski diagram with vibrational levels",
    "energy level scheme, vibrational, manifold, Stokes shift, photophysics",
    parts,
    [
      at(parts, state("S", "0"), [SING[0], S0 - DROP], [-1, 0]),
      at(parts, state("S", "1"), [SING[0], S1 - DROP], [-1, 0]),
      at(parts, state("T", "1"), [TRIP[1], T1 - DROP], [1, 0]),
    ],
  );
}

export const PHOTOCHEMISTRY = [...transitions(), ...species(), jablonski(), jablonskiVibrational()];
