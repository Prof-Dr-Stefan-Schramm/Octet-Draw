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
// a wavy arrow for a non-radiative one, levels drawn as horizontal lines with the ground
// state at the bottom and the triplet to the right of the singlets and lower.

const r3 = (v) => Math.round(v * 1000) / 1000 + 0;
const xy = (x, y) => [r3(x), r3(y)];
// A caption's y is its baseline (cdxml.ts), so a label meant to sit level with a point goes
// this far below it: about half the cap height of 10 pt text at bond length 14.4 pt.
const DROP = 0.24;

// An item from arrows and captions, centred on its box and grouped as one, the way lab.mjs
// builds the glassware. `parts` are arrows; `labels` are [text, x, y] or [runs, x, y].
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
// U+2080 and U+2081 look like small full-height digits in Arial rather than subscripts, and
// they are not subscripts to anything downstream either — they go into CDXML and into Word
// as the characters they are, so a reader cannot restyle them and a search for "S1" misses
// them. S, T and the multiplicity of a state are set this way everywhere in the field.
const state = (letter, index) => [{ text: letter }, sub(index)];
// Planck's constant and a frequency are both physical quantities, so hv is set in italic, as
// the literature sets it. The nu is a real Greek nu (U+03BD), not a Latin vee; in italic it
// reads as the Greek letter it is rather than as a narrow v.
const QUANTITY = { italic: true };

// A reaction arrow with hν or Δ written over it — the one piece of photochemical notation
// that goes in nearly every scheme. The label is a condition on the arrow, so Octet keeps it
// over the arrow's middle when the arrow is moved, lengthened or turned.
const over = (label, name, also, more = {}) =>
  item(name, also, [{ kind: "reaction", from: xy(0, 0), to: xy(2, 0) }], [[label, 1, 0.4, { on: { arrow: 1, side: "above" }, ...more }]]);

// The vertical transitions of a state diagram, each on its own, to drop into a scheme or
// beside a structure.
const transitions = () => [
  over("hν", "Reaction arrow, hν", "photochemical, irradiation, light, photolysis, hv", QUANTITY),
  over("Δ", "Reaction arrow, Δ", "thermal, heat, delta, reflux"),
  item("Absorption (hν)", "excitation, photon, light, vertical, hv", [radiative(0, 0, 2)], [["hν", 0.6, 1 - DROP, QUANTITY]]),
  item("Fluorescence", "emission, radiative, singlet, hv", [radiative(0, 2, 0)], [["hν′", 0.65, 1 - DROP, QUANTITY]]),
  item("Phosphorescence", "emission, triplet, radiative, hv", [radiative(0, 2, 0)], [["hν″", 0.65, 1 - DROP, QUANTITY]]),
  item("Intersystem crossing", "ISC, non-radiative, singlet to triplet", [nonRadiative(0, 1, 1.6, 0)], [["ISC", 1.35, 0.85 - DROP]]),
  item("Internal conversion", "IC, non-radiative, same multiplicity", [nonRadiative(0, 2, 0, 0)], [["IC", 0.6, 1 - DROP]]),
  item("Vibrational relaxation", "VR, non-radiative, cascade", [nonRadiative(0, 1, 0, 0)], [["VR", 0.6, 0.5 - DROP]]),
  item("Energy transfer", "EnT, sensitisation, Förster, Dexter, quenching", [nonRadiative(0, 0, 2.2, 0)], [["EnT", 1.1, 0.3]]),
];

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

const jablonski = () => item(
  "Jablonski diagram",
  "energy level scheme, state diagram, photophysics, S0 S1 T1",
  [
    level(SING[0], TRIP[1], S0), // the ground state runs under both columns
    level(SING[0], SING[1], S1),
    level(TRIP[0], TRIP[1], T1),
    radiative(0.55, S0, S1), // absorption
    radiative(1.85, S1, S0), // fluorescence
    nonRadiative(SING[1], S1, TRIP[0], T1), // intersystem crossing
    radiative(4.2, T1, S0), // phosphorescence
  ],
  [
    [state("S", "0"), -0.75, S0 - DROP],
    [state("S", "1"), -0.75, S1 - DROP],
    [state("T", "1"), 6.15, T1 - DROP],
    ["hν", 0, 1.5 - DROP, QUANTITY],
    ["hν′", 2.5, 1.5 - DROP, QUANTITY],
    ["ISC", 3.5, 2.65 - DROP],
    ["hν″", 4.85, 1 - DROP, QUANTITY],
  ],
);

// The same with the vibrational sub-levels a fuller diagram shows: three thinner lines over
// each electronic state, absorption into the top one of S₁ and vibrational relaxation down
// to its origin, which is what makes the Stokes shift visible. Labelled S0, S1 and T1 only,
// since a figure this size is relabelled anyway.
function jablonskiVibrational() {
  const gap = 0.22;
  const subs = (x0, x1, y) => [1, 2, 3].map((k) => level(x0 + 0.3, x1 - 0.3, y + k * gap));
  return item(
    "Jablonski diagram with vibrational levels",
    "energy level scheme, vibrational, manifold, Stokes shift, photophysics",
    [
      level(SING[0], TRIP[1], S0), ...subs(SING[0], TRIP[1], S0),
      level(SING[0], SING[1], S1), ...subs(SING[0], SING[1], S1),
      level(TRIP[0], TRIP[1], T1), ...subs(TRIP[0], TRIP[1], T1),
      radiative(0.55, S0, S1 + 3 * gap), // absorption, into a vibrationally excited level
      nonRadiative(0.55, S1 + 3 * gap, 0.55, S1), // relaxation to the origin of S₁
      radiative(1.85, S1, S0 + 2 * gap), // fluorescence, to a vibrationally excited level
      nonRadiative(SING[1], S1, TRIP[0], T1),
      radiative(4.2, T1, S0 + gap),
    ],
    [[state("S", "0"), -0.75, S0 - DROP], [state("S", "1"), -0.75, S1 - DROP], [state("T", "1"), 6.15, T1 - DROP]],
  );
}

export const PHOTOCHEMISTRY = [...transitions(), ...species(), jablonski(), jablonskiVibrational()];
