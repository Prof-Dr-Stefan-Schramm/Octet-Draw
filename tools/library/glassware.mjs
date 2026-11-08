// The library's Glassware group: 48 pieces of laboratory glassware, each one integral group of Octet's own pen curves
// and lines, as the Lab group's items are. The drawings are our own line art, kept in tools/library/glassware/ as
// plain SVG (one ink colour, no fills, no text), and read by svg.mjs. Nothing comes from another program.
//
// The set is drawn to one scale. Each SVG is drawn at whatever size suits it on its own page, so the only thing that
// says how big a piece really is is the line it is drawn with: a piece shown larger is drawn with a finer line. So
// every drawing is scaled by its own line weight, which puts the set back in proportion — a test tube beside a flask
// beside a Soxhlet — and one factor (SCALE) then brings the whole set to the library's sizes, the tallest piece at
// 5.2 bond lengths.
import { readdirSync, readFileSync } from "node:fs";
import { detail, item, line, open, closed } from "./lab.mjs";
import { bounds, readSvg } from "./svg.mjs";

// [file, shown name, more words the library search finds it by]. The order is the shelf's order. A name no other
// template in the library uses: where the Lab group already has a plain Round-bottom flask, Beaker, Test tube or
// Separatory funnel, the piece here says which one it is, and the other name is a word the search finds it by.
const PIECES = [
  // Flasks
  ["01-round-bottom-flask", "Round-bottom flask, jointed", "RBF, round-bottomed, boiling flask, ground joint"],
  ["02-flat-bottom-flask", "Flat-bottom flask", "flat-bottomed, Florence flask"],
  ["03-erlenmeyer-flask", "Erlenmeyer flask", "conical flask, Erlenmeyer"],
  ["04-two-neck-round-bottom-flask", "Two-neck flask", "two-necked, round-bottom flask, RBF"],
  ["05-three-neck-round-bottom-flask", "Three-neck flask", "three-necked, round-bottom flask, reaction flask"],
  ["06-evaporation-flask", "Evaporation flask", "rotary evaporator, rotavap, pear-shaped flask"],
  // Beakers, bottles and tubes
  ["07-beaker", "Griffin beaker", "beaker, low form, spout"],
  ["08-beaker-with-handle", "Beaker with handle", "jug beaker, handled beaker"],
  ["09-screw-cap-laboratory-bottle", "Screw-cap bottle", "laboratory bottle, media bottle, reagent bottle, GL45"],
  ["10-beaded-rim-test-tube", "Beaded-rim test tube", "test tube, culture tube"],
  ["11-ground-joint-test-tube", "Ground-joint test tube", "test tube, jointed"],
  ["12-narrow-neck-reagent-bottle", "Narrow-neck reagent bottle", "Enghals bottle, stock bottle, glass stopper"],
  // Volumetric glassware
  ["13-measuring-cylinder", "Measuring cylinder", "graduated cylinder, volume"],
  ["14-volumetric-flask", "Volumetric flask", "standard solution, volumetric"],
  ["15-volumetric-pipette", "Volumetric pipette", "bulb pipette, transfer pipette"],
  ["16-graduated-pipette", "Graduated pipette", "Mohr pipette, serological pipette"],
  ["17-straight-stopcock-burette", "Burette", "straight stopcock, titration"],
  ["18-cylinder-with-foot", "Cylinder with foot", "measuring cylinder, footed cylinder"],
  // Condensers
  ["19-liebig-condenser", "Liebig condenser", "straight condenser, distillation"],
  ["20-allihn-condenser", "Allihn condenser", "bulb condenser, reflux"],
  ["21-graham-condenser", "Graham condenser", "spiral condenser, coil"],
  ["22-dimroth-condenser", "Dimroth condenser", "coil condenser, inner spiral, reflux"],
  ["23-cold-finger-condenser", "Cold-finger condenser", "cold finger, sublimation"],
  ["24-jacketed-coil-condenser", "Jacketed coil condenser", "coil condenser, reflux, Dimroth"],
  // Funnels and filtration
  ["25-separatory-funnel", "Separating funnel", "separatory funnel, sep funnel, extraction"],
  ["26-pear-shaped-addition-funnel", "Pear-shaped addition funnel", "dropping funnel, addition funnel"],
  ["27-conical-addition-funnel", "Conical addition funnel", "dropping funnel, addition funnel"],
  ["28-pressure-equalizing-addition-funnel", "Pressure-equalising addition funnel", "pressure equalizing, dropping funnel"],
  ["29-oblique-stopcock-addition-funnel", "Oblique-stopcock addition funnel", "dropping funnel, addition funnel"],
  ["30-fritted-glass-funnel", "Fritted glass funnel", "sintered funnel, frit, filtration"],
  // Extraction and distillation
  ["31-soxhlet-extractor", "Soxhlet extractor", "Soxhlet, extraction thimble, siphon"],
  ["32-soxhlet-extractor-with-drain", "Soxhlet extractor with drain", "Soxhlet, extraction, drain tap"],
  ["33-soxhlet-with-allihn-condenser", "Soxhlet with Allihn condenser", "Soxhlet, extraction, reflux"],
  ["34-soxhlet-with-dimroth-condenser", "Soxhlet with Dimroth condenser", "Soxhlet, extraction, reflux"],
  ["35-dean-stark-apparatus", "Dean–Stark apparatus", "Dean Stark trap, water separator, azeotropic"],
  ["36-microdistillation-apparatus", "Microdistillation apparatus", "micro distillation, short path, distillation set"],
  // Adapters, joints and columns
  ["37-bent-delivery-adapter", "Bent delivery adapter", "bend, delivery adapter"],
  ["38-bent-vacuum-adapter", "Bent vacuum adapter", "vacuum adapter, take-off adapter, receiver adapter"],
  ["39-claisen-adapter", "Claisen adapter", "Claisen head, two necks from one"],
  ["40-ground-joint-reducer", "Ground-joint reducer", "reduction adapter, expansion adapter"],
  ["41-ground-glass-stopper", "Ground-glass stopper", "stopper, hollow stopper"],
  ["42-vigreux-column", "Vigreux column", "fractionating column, fractionation"],
  // Other laboratory glassware
  ["43-filter-flask", "Filter flask", "Büchner flask, side-arm flask, vacuum filtration"],
  ["44-drechsel-gas-washing-bottle", "Drechsel bottle", "gas-washing bottle, bubbler, dip tube"],
  ["45-schlenk-tube", "Schlenk tube", "Schlenk, inert atmosphere, air-free"],
  ["46-thiele-tube", "Thiele tube", "melting point, Thiele"],
  ["47-distillation-bridge-with-condenser", "Distillation bridge", "still head, distillation set, condenser"],
  ["48-side-arm-distillation-flask", "Side-arm distillation flask", "distilling flask, Würtz flask, retort"],
];

// One bond length per this many of a drawing's own line widths. Chosen so the tallest piece in the set (the Soxhlet
// under a Dimroth condenser) is 5.2 bond lengths, the size the Lab group's tallest items are; everything else follows
// from its own line weight, so the proportions between the pieces are the real ones.
const SCALE = 0.01582;
// A part is left out of the 20 px icon when it is small beside the whole drawing: at icon size a stopcock handle, a
// graduation or a hose barb is a smudge, and the silhouette is what makes the piece recognisable.
const ICON_SHARE = 0.34;

// One drawing as a library item: its shapes scaled, turned the right way up (SVG counts y down, Octet up) and handed
// to lab.mjs's item(), which centres them and makes the integral group.
function piece(file, name, also) {
  const svg = readSvg(readFileSync(new URL(`./glassware/${file}.svg`, import.meta.url), "utf8"));
  const drawn = svg.shapes.filter((s) => s.stroke && !s.clipped);
  if (!drawn.length || drawn.length !== svg.shapes.length) throw new Error(`${file}: it is not line art — ${svg.shapes.length - drawn.length} of ${svg.shapes.length} shapes are a fill or clipped`);
  if (!svg.base) throw new Error(`${file}: no line width to scale it by`);
  const k = SCALE / svg.base;
  const put = ([x, y]) => [x * k, -y * k];
  const whole = bounds(drawn), big = Math.hypot(whole[2] - whole[0], whole[3] - whole[1]);
  const sizes = drawn.map((s) => { const b = bounds([s]); return Math.hypot(b[2] - b[0], b[3] - b[1]); });
  const widest = sizes.indexOf(Math.max(...sizes));
  const parts = drawn.map((s, i) => {
    const ps = s.points.map((q) => ({ at: put(q.at), ...(q.c1 ? { c1: put(q.c1) } : {}), ...(q.c2 ? { c2: put(q.c2) } : {}) }));
    // A straight run between two points is a line, which is what it is and what Octet keeps it as.
    const part = ps.length === 2 && !s.closed && !ps[0].c2 && !ps[1].c1
      ? line(ps[0].at[0], ps[0].at[1], ps[1].at[0], ps[1].at[1])
      : (s.closed ? closed : open)(ps);
    // The widest part is always in the icon, so a drawing made only of small parts still has one.
    return sizes[i] < ICON_SHARE * big && i !== widest ? detail(part) : part;
  });
  return item(name, also, parts);
}

// Every drawing in the folder is on the shelf, so one added and not named above fails the build rather
// than quietly going missing.
const named = new Set(PIECES.map(([f]) => f));
for (const f of readdirSync(new URL("./glassware/", import.meta.url))) {
  if (f.endsWith(".svg") && !named.has(f.slice(0, -4))) throw new Error(`glassware/${f} is not in PIECES`);
}

export const GLASSWARE = PIECES.map(([file, name, also]) => piece(file, name, also));
