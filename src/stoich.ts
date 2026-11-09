// Stoichiometry, as ChemDraw's Analyze Stoichiometry grid works it out: for each reactant, what was typed (mass,
// moles, equivalents, volume with density or molarity, purity) gives its moles and the rest; equivalents are counted
// against the limiting reactant, as the scheme's coefficients are; each product's expected amount follows from the limiting reactant times the product's
// equivalents (its coefficient, 1 unless typed, as ChemDraw's product Equivalents row), and a measured mass gives its
// yield. Amounts are kept in base units: g, mol, mL, g/mL, mol/L, and fractions for purity.

import type { Box, Grid, Mol } from "./render.ts";
import { addCaption, deleteGraphics } from "./edit.ts";

export type Field = "mass" | "moles" | "equiv" | "volume" | "density" | "molarity" | "purity" | "measured";
export type Typed = Partial<Record<Field, number>>;
// coef: the coefficient written in front of it in the scheme (2 in "2 A + B → C"), 1 unless written. hint: what its
// text says of it ("K2CO3 (2 eq.)", "1 M NaOH", "30% H2O2"), used where nothing is typed. side: a reagent written over
// or under the arrow, which is not in the equation, so the coefficients say nothing of it. A product's typed mass is
// the mass wanted (issue 136): with no reactant amount typed, it sets the scale. literature: a product's yield in the
// literature, a fraction (0.85 is 85%), which its own yield is compared with.
export type Component = { key: string; mw: number; product: boolean; typed: Typed; coef?: number; hint?: Typed; side?: boolean; literature?: number };
export type Solved = {
  mass?: number; moles?: number; equiv?: number; volume?: number; density?: number; molarity?: number; purity: number;
  expectedMass?: number; expectedMoles?: number; measured?: number; productMoles?: number; yield?: number;
  literature?: number; ofLiterature?: number; // the literature yield, and the yield as a fraction of it
};

// Each component's amounts. limiting: the reactant the others are measured against (the first one when unset).
// Equivalents are counted as the scheme's coefficients are: one equivalent is the limiting reactant's moles over its own
// equivalents, so in 2 A + B → C with A limiting, A is 2 equivalents, B 1 and C 1. Equivalents not typed follow the
// scheme: the hint's, else the coefficient. The limiting reactant's equivalents can be typed too, as its coefficient.
export function solve(components: Component[], limiting?: string): Record<string, Solved> {
  const out: Record<string, Solved> = {};
  const reactants = components.filter((c) => !c.product), lim = reactants.find((c) => c.key === limiting) ?? reactants[0];
  const amounts = (c: Component): Typed => ({ ...c.hint, ...c.typed });
  // Equivalents given for a component: typed, in its text, or its coefficient (1 for one of the equation without one,
  // once any has one). Undefined when nothing gives them; a reagent over the arrow has no coefficient.
  const given = (c: Component) => c.typed.equiv ?? c.hint?.equiv ?? (!c.side && (c.coef !== undefined || lim?.coef !== undefined) ? c.coef ?? 1 : undefined);
  const equivOf = (c: Component) => given(c) ?? 1;
  const ref = (lim ? equivOf(lim) : 1) || 1;
  // A reactant's moles from what was typed: moles, mass, volume with density, or volume with molarity.
  const own = (c: Component): number | undefined => {
    const t = amounts(c), purity = t.purity ?? 1;
    if (t.moles !== undefined) return t.moles;
    if (t.mass !== undefined && c.mw > 0) return (t.mass * purity) / c.mw;
    if (t.volume !== undefined && t.density !== undefined && c.mw > 0) return (t.volume * t.density * purity) / c.mw;
    if (t.volume !== undefined && t.molarity !== undefined) return (t.volume / 1000) * t.molarity;
    return undefined;
  };
  // The moles of one equivalent: from the limiting reactant's amount; with that unknown, from another reactant with an
  // amount by its equivalents, or else from the product mass wanted by the product's equivalents.
  const limOwn = lim ? own(lim) : undefined;
  let unit = limOwn !== undefined ? limOwn / ref : undefined;
  if (unit === undefined) for (const c of reactants) { const m = own(c), e = given(c); if (m !== undefined && e) { unit = m / e; break; } }
  if (unit === undefined) for (const c of components.filter((x) => x.product)) { const e = equivOf(c); if (c.typed.mass !== undefined && c.mw > 0 && e > 0) { unit = c.typed.mass / c.mw / e; break; } }
  for (const c of reactants) {
    const t = amounts(c), purity = t.purity ?? 1;
    let moles = own(c);
    if (moles === undefined && unit !== undefined) moles = unit * equivOf(c);
    const mass = moles !== undefined && c.mw > 0 ? (moles * c.mw) / purity : t.mass;
    const volume = t.volume ?? (mass !== undefined && t.density ? mass / t.density : moles !== undefined && t.molarity ? (moles / t.molarity) * 1000 : undefined);
    out[c.key] = { moles, mass, volume, purity, density: t.density, molarity: t.molarity, equiv: moles !== undefined && unit ? moles / unit : given(c) };
  }
  for (const c of components.filter((x) => x.product)) {
    const purity = c.typed.purity ?? 1, equiv = equivOf(c), expectedMoles = unit !== undefined ? unit * equiv : undefined, expectedMass = expectedMoles !== undefined ? expectedMoles * c.mw : undefined;
    const productMoles = c.typed.measured !== undefined && c.mw > 0 ? (c.typed.measured * purity) / c.mw : undefined;
    const got = productMoles !== undefined && expectedMoles ? productMoles / expectedMoles : undefined;
    out[c.key] = { purity, equiv, expectedMoles, expectedMass, measured: c.typed.measured, productMoles, yield: got, literature: c.literature, ofLiterature: got !== undefined && c.literature ? got / c.literature : undefined };
  }
  return out;
}

// Units each field can be typed and shown in, as multiples of its base unit.
const UNITS: Record<Field, Record<string, number>> = {
  mass: { kg: 1000, g: 1, mg: 1e-3, µg: 1e-6, ug: 1e-6 },
  measured: { kg: 1000, g: 1, mg: 1e-3, µg: 1e-6, ug: 1e-6 },
  moles: { mol: 1, mmol: 1e-3, µmol: 1e-6, umol: 1e-6, nmol: 1e-9 },
  volume: { L: 1000, l: 1000, mL: 1, ml: 1, µL: 1e-3, uL: 1e-3, ul: 1e-3 },
  density: { "g/mL": 1, "g/ml": 1, "g/cm3": 1, "kg/L": 1 },
  molarity: { M: 1, "mol/L": 1, mM: 1e-3 },
  equiv: { eq: 1, equiv: 1, "": 1 },
  purity: { "%": 0.01 },
};
// A typed amount in base units: "250 mg", "1.2 eq", "0.5 mL", "98%". A bare number is taken in the field's usual unit
// (g, mmol, mL, g/mL, M, eq, %; a mass in g, as weighed in a synthesis lab, issue 134). Undefined when it is not a finite number of 0 or more, with a unit the field takes.
// Greek mu (μ, as \mu types it) is the micro sign.
export function parseAmount(text: string, field: Field): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)(?:e([+-]?\d+))?\s*([a-zA-Zµ%/0-9]*)\s*$/.exec(text.replace(",", ".").replace(/\u03bc/g, "µ"));
  if (!m) return undefined;
  const value = Number(m[1]) * 10 ** Number(m[2] ?? 0), unit = m[3], units = UNITS[field];
  const plain: Record<Field, string> = { mass: "g", measured: "g", moles: "mmol", volume: "mL", density: "g/mL", molarity: "M", equiv: "eq", purity: "%" };
  const k = unit === "" ? units[plain[field]] : units[unit];
  return k === undefined || !(value >= 0) || !Number.isFinite(value * k) ? undefined : value * k;
}
// An amount for the grid in the unit that reads best (250 mg, 1.25 mmol, 0.50 mL), three significant figures.
export function formatAmount(value: number | undefined, field: Field | "mw" | "yield"): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  const sig = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  if (field === "mw") return value.toFixed(2);
  if (field === "yield" || field === "purity") return `${sig(value * 100)}%`;
  if (field === "equiv") return value.toFixed(2);
  const ladders: Partial<Record<Field, [string, number][]>> = {
    mass: [["kg", 1000], ["g", 1], ["mg", 1e-3], ["µg", 1e-6]], measured: [["kg", 1000], ["g", 1], ["mg", 1e-3], ["µg", 1e-6]],
    moles: [["mol", 1], ["mmol", 1e-3], ["µmol", 1e-6], ["nmol", 1e-9]], volume: [["L", 1000], ["mL", 1], ["µL", 1e-3]],
  };
  const ladder = ladders[field as Field];
  if (!ladder) return `${sig(value)} ${field === "density" ? "g/mL" : "M"}`;
  const [unit, k] = ladder.find(([, f]) => value >= f) ?? ladder[ladder.length - 1];
  return `${sig(value / k)} ${unit}`;
}

// Standard atomic weights (IUPAC 2021, abridged), for reagents written as formulas (H2O, NaBH4).
const WEIGHT: Record<string, number> = {
  H: 1.008, Li: 6.94, B: 10.81, C: 12.011, N: 14.007, O: 15.999, F: 18.998, Na: 22.99, Mg: 24.305, Al: 26.982, Si: 28.085,
  P: 30.974, S: 32.06, Cl: 35.45, K: 39.098, Ca: 40.078, Ti: 47.867, Cr: 51.996, Mn: 54.938, Fe: 55.845, Co: 58.933,
  Ni: 58.693, Cu: 63.546, Zn: 65.38, Se: 78.971, Br: 79.904, Rb: 85.468, Ru: 101.07, Rh: 102.91, Pd: 106.42, Ag: 107.87,
  Sn: 118.71, I: 126.9, Cs: 132.91, Ir: 192.22, Pt: 195.08, Au: 196.97, Hg: 200.59, Pb: 207.2, Os: 190.23, W: 183.84,
  Be: 9.0122, Sc: 44.956, V: 50.942, Ga: 69.723, Ge: 72.63, As: 74.922, Sr: 87.62, Y: 88.906, Zr: 91.224, Mo: 95.95,
  Cd: 112.41, In: 114.82, Sb: 121.76, Te: 127.6, Ba: 137.33, La: 138.91, Ce: 140.12, Sm: 150.36, Eu: 151.96, Gd: 157.25,
  Yb: 173.05, Hf: 178.49, Ta: 180.95, Re: 186.21, Tl: 204.38, Bi: 208.98, Nb: 92.906,
};
// A line of conditions as its items: split at commas, semicolons and line breaks outside brackets, so
// "toluene/EtOH/H2O (4:1:1, 30 mL)" stays one item.
export function conditionItems(text: string): string[] {
  const out: string[] = [];
  let depth = 0, item = "";
  for (const ch of text) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    if (!depth && /[,;\n]/.test(ch)) { out.push(item.trim()); item = ""; } else item += ch;
  }
  out.push(item.trim());
  return out.filter(Boolean);
}
// The gas a reaction runs under (N2, Ar, air): not a reagent, so it has no column in the table.
export const inert = (text: string) => /^(?:under\s+)?(?:N2|N₂|Ar|argon|nitrogen|He|helium|air)(?:\s*\(?(?:atm|balloon)\)?)?$/i.test(text.trim());
// A formula's molar mass, brackets and dots allowed ("Cu(OAc)2" is not a formula; "Pd(PPh3)4" needs its groups
// written out). Undefined if it has anything unknown.
export function formulaWeight(text: string): number | undefined {
  const s = text.replace(/\s+/g, "").replace(/[₀-₉]/g, (d) => String("₀₁₂₃₄₅₆₇₈₉".indexOf(d)));
  let i = 0;
  const dot = () => s[i] === "·" || s[i] === ".";
  // part: one part after a dot (the 5H2O of CuSO4·5H2O·NH3), so its number counts it alone.
  const group = (part = false): number | undefined => {
    let total = 0;
    while (i < s.length && s[i] !== ")" && !(part && dot())) {
      if (dot()) { i++; const k = /^\d+/.exec(s.slice(i))?.[0]; if (k) i += k.length; const w = group(true); if (w === undefined) return undefined; total += (k ? Number(k) : 1) * w; continue; }
      let w: number | undefined;
      if (s[i] === "(") { i++; w = group(); if (s[i] !== ")") return undefined; i++; }
      else { const el = /^[A-Z][a-z]?/.exec(s.slice(i))?.[0]; if (!el || WEIGHT[el] === undefined) return undefined; i += el.length; w = WEIGHT[el]; }
      const n = /^\d+/.exec(s.slice(i))?.[0];
      if (n) i += n.length;
      if (w === undefined) return undefined;
      total += w * (n ? Number(n) : 1);
    }
    return total;
  };
  const w = group();
  return w !== undefined && i === s.length && w > 0 ? w : undefined;
}

// A coefficient written in front of a compound in a scheme: 2, 0.5, 1/2, ½. Undefined for anything else.
const FRACTIONS: Record<string, number> = { "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4 };
export function coefficientOf(text: string): number | undefined {
  const t = text.trim().replace(",", "."), f = /^(\d{1,3})\s*\/\s*(\d{1,3})$/.exec(t);
  const v = FRACTIONS[t] ?? (f ? Number(f[1]) / Number(f[2]) : /^(?:\d{1,4}(?:\.\d+)?|\.\d+)$/.test(t) ? Number(t) : NaN);
  return v > 0 && v <= 1000 ? v : undefined;
}

// A reagent written as text, as it is written over an arrow (issue 131): what it is (its name), the coefficient in
// front of it ("2 HCl", issue 133), and what the text says of its amount (hint): equivalents ("K2CO3 (2 eq.)",
// "1.5 equiv NaBH4", "10 mol%"), molarity ("1 M NaOH", "nBuLi (2.5 M in hexanes)") and purity ("30% H2O2"). Words
// for how it is used ("cat.", "conc.", "aq.", "sat.", "dry") and other notes in brackets ("(aq)", "(cat.)") are left
// out. Undefined when nothing is left.
const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const EQUIV = new RegExp(String.raw`\b${NUM}\s*(?:eq|equiv|equivs|equivalents?)\b\.?`, "i");
const MOLPC = new RegExp(String.raw`\b${NUM}\s*mol\s*%`, "i");
const MOLAR = new RegExp(String.raw`\b${NUM}\s*(?:M|mol\s*/\s*L|mol\s*L[-−]1|mol\s*L⁻¹)(?=[\s,;)]|$)(?:\s+in\s+[^,;)]+)?`);
const NORMAL = new RegExp(String.raw`^${NUM}\s*N\s+(?=\S)`);
const PERCENT = new RegExp(String.raw`\b${NUM}\s*%(?:\s*(?:w/w|wt\.?|aq\.?))?`, "i");
const USE = String.raw`(?:cat(?:alytic)?|conc|concd|concentrated|aq|aqueous|sat|satd|saturated|dil|dilute|dry|anhydrous|abs|absolute|glacial|fuming|excess|xs|neat|then)\.?`;
const USE_BEFORE = new RegExp(String.raw`^${USE}\s+`, "i"), USE_AFTER = new RegExp(String.raw`\s+${USE}$`, "i");
export function readReagent(item: string): { name: string; coefficient?: number; hint: Typed } | undefined {
  let t = item.trim();
  const hint: Typed = {}, num = (s: string) => Number(s.replace(",", "."));
  const take = (re: RegExp, put: (v: number) => void) => { const m = re.exec(t); if (m) { put(num(m[1])); t = (t.slice(0, m.index) + " " + t.slice(m.index + m[0].length)).trim(); } };
  take(MOLPC, (v) => (hint.equiv = v / 100));
  take(EQUIV, (v) => (hint.equiv = v));
  take(MOLAR, (v) => (hint.molarity = v));
  take(NORMAL, () => {});
  take(PERCENT, (v) => { if (v > 0 && v <= 100) hint.purity = v / 100; });
  // Notes in brackets after the name (and a state written on, HCl(aq)); a formula's own brackets, Pd(PPh3)4, stay.
  for (let was = ""; was !== t; ) { was = t; t = t.replace(/\s+\([^()]*\)\s*$|\s*\(\s*\)|\((?:aq|s|l|g|cat|sol|soln)\.?\)$/i, "").trim().replace(/^[,;:\s]+|[,;:\s]+$/g, ""); }
  for (let was = ""; was !== t; ) { was = t; t = t.replace(USE_BEFORE, "").replace(USE_AFTER, "").trim(); }
  let coefficient: number | undefined;
  const c = /^(\d{1,3}\s*\/\s*\d{1,3}|\d{1,4}(?:[.,]\d+)?|[½⅓⅔¼¾])\s+(?=\S)/.exec(t);
  if (c) { coefficient = coefficientOf(c[1]); t = t.slice(c[0].length).trim(); }
  return t ? { name: t, ...(coefficient !== undefined ? { coefficient } : {}), hint } : undefined;
}

// A formula with a charge written after it, as text: H+, OH−, Cu2+, SO4 2-, SO4^2-, NH4⁺, PO4³⁻. The charge's digits are
// its own when written raised (²⁺), set apart (SO4 2-, SO4^2-), on one element (Cu2+, Fe3+) or after another digit
// (SO42-); otherwise they are the formula's (NH4+). Its molar mass is the formula's (an electron's mass left out).
export function ionWeight(text: string): { formula: string; weight: number } | undefined {
  const t = text.replace(/\s+$/, "");
  const raised = /^(.*?)[⁰¹²³⁴⁵⁶⁷⁸⁹]*[⁺⁻]$/.exec(t), apart = /^(.*?)(?:\s+|\^)\d*[+\-−]$/.exec(t), plain = /^(.*?)(\d*)[+\-−]$/.exec(t);
  let base: string | undefined;
  if (raised) base = raised[1];
  else if (apart) base = apart[1];
  else if (plain) {
    const [, f, d] = plain;
    base = !d ? f : /^[A-Z][a-z]?$/.test(f) ? f : /\d$/.test(f + d.slice(0, -1)) && d.length > 1 ? f + d.slice(0, -1) : f + d;
  }
  if (!base?.trim() || /[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]/.test(base)) return undefined;
  const weight = formulaWeight(base.trim());
  return weight === undefined ? undefined : { formula: t.replace(/\s+/g, ""), weight };
}

// Species often written as a word. Other names come from Octet's names (the editor asks them).
const WORDS: Record<string, string> = {
  proton: "H+", hydron: "H+", hydroxide: "OH-", hydronium: "H3O+", oxonium: "H3O+", hydride: "H-", water: "H2O",
  hydrogen: "H2", dihydrogen: "H2", oxygen: "O2", dioxygen: "O2", ozone: "O3",
};
// Words that say how a reaction is run, never a reagent, so no name is looked up for them.
export const CONDITION_WORDS = /^(?:reflux|rt|r\.t\.|room temp(?:erature)?|overnight|o\/n|heat|heating|light|dark|stir|stirring|sonication|ultrasound|microwave|MW|hν|hv|Δ|then|workup|work-up|quench|filter|filtration)$/i;

// A written reagent's formula and molar mass: a word above, a formula with or without a charge, or an abbreviation
// Octet knows (abbreviations: name to standard InChI, src/abbreviations.json reversed). Undefined otherwise.
export function textWeight(name: string, abbreviations?: Map<string, string>): { formula: string; weight: number } | undefined {
  const t = name.trim(), word = WORDS[t.toLowerCase()];
  if (word) return textWeight(word);
  const w = formulaWeight(t);
  if (w !== undefined) return { formula: t.replace(/\s+/g, "").replace(/[₀-₉]/g, (d) => String("₀₁₂₃₄₅₆₇₈₉".indexOf(d))), weight: w };
  const inchi = abbreviations?.get(t);
  return (inchi ? inchiWeight(inchi) : undefined) ?? ionWeight(t);
}
// The formula and molar mass in a standard InChI: its formula layer (parts after dots, each with its count, 2Na), with
// protons added or taken by its /p layer. Undefined with an element Octet has no weight for.
export function inchiWeight(inchi: string): { formula: string; weight: number } | undefined {
  const layers = inchi.split("/"), formula = layers[1];
  if (!/^InChI=1S?$/.test(layers[0] ?? "") || !formula) return undefined;
  // Each element's count, as one formula in Hill order (C, H, then the rest A to Z): Pd(OAc)2 is C4H6O4Pd.
  const count = new Map<string, number>();
  for (const part of formula.split(".")) {
    const m = /^(\d*)((?:[A-Z][a-z]?\d*)+)$/.exec(part);
    if (!m) return undefined;
    for (const [, el, n] of m[2].matchAll(/([A-Z][a-z]?)(\d*)/g)) count.set(el, (count.get(el) ?? 0) + (m[1] ? Number(m[1]) : 1) * (n ? Number(n) : 1));
  }
  const p = layers.find((l) => /^p[+-]\d+$/.test(l));
  if (p) count.set("H", (count.get("H") ?? 0) + Number(p.slice(1)));
  if ([...count.values()].some((n) => n < 0) || [...count.keys()].some((el) => WEIGHT[el] === undefined)) return undefined;
  const rank = (el: string) => (!count.has("C") ? 0 : el === "C" ? -2 : el === "H" ? -1 : 0), order = [...count.keys()].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const hill = order.filter((el) => count.get(el)).map((el) => el + (count.get(el)! > 1 ? count.get(el) : "")).join("");
  const weight = order.reduce((w, el) => w + WEIGHT[el] * count.get(el)!, 0);
  return weight > 0 ? { formula: hill, weight } : undefined;
}
// The abbreviations by name, from src/abbreviations.json (standard InChI to name).
export const abbreviationNames = (table: Record<string, string>) => new Map(Object.entries(table).map(([inchi, name]) => [name, inchi]));

// A saved grid read as a hostile file is: typed amounts finite and not negative under known fields, keys short, at most
// 60 components and the rows Octet has, and a layout only when it is "rows"; undefined when it is damaged.
const FIELDS = ["mass", "moles", "equiv", "volume", "density", "molarity", "purity", "measured"];
const KEY = /^(?:[rp]\d{1,2}|[rp]:[^\n\r]{1,80})$/;
export const GRID_ROW_IDS = ["formula", "mw", "limiting", "equiv", "mass", "moles", "volume", "density", "molarity", "purity", "expected", "expectedMoles", "measured", "yield", "literature", "ofLiterature"];
export function readGrid(raw: unknown, arrow: number): Grid | undefined {
  const g = raw as Record<string, unknown> | undefined, typed = g?.typed as Record<string, Record<string, unknown>> | undefined;
  if (!g || typeof typed !== "object" || !typed || Array.isArray(typed) || Object.keys(typed).length > 60) return undefined;
  if (!Object.entries(typed).every(([k, v]) => KEY.test(k) && typeof v === "object" && v && !Array.isArray(v) && Object.entries(v).every(([f, x]) => FIELDS.includes(f) && typeof x === "number" && Number.isFinite(x) && x >= 0 && x < 1e9))) return undefined;
  if (g.limiting !== undefined && !(typeof g.limiting === "string" && KEY.test(g.limiting) && g.limiting.startsWith("r"))) return undefined;
  // Literature yields: a product's key and a fraction above 0 and at most 1. Kept beside what was typed, so a version of
  // Octet from before reads the rest of the grid.
  const lit = g.literature as Record<string, unknown> | undefined;
  if (lit !== undefined && (typeof lit !== "object" || !lit || Array.isArray(lit) || Object.keys(lit).length > 60 || !Object.entries(lit).every(([k, x]) => KEY.test(k) && k.startsWith("p") && typeof x === "number" && x > 0 && x <= 1))) return undefined;
  const h = g.hidden as { rows?: unknown; cols?: unknown } | undefined;
  const rows = Array.isArray(h?.rows) ? (h!.rows as unknown[]).filter((x): x is string => typeof x === "string" && GRID_ROW_IDS.includes(x)).slice(0, 20) : [];
  const cols = Array.isArray(h?.cols) ? (h!.cols as unknown[]).filter((x): x is string => typeof x === "string" && KEY.test(x)).slice(0, 60) : [];
  const colour = typeof g.colour === "string" && /^#[0-9a-f]{6}$/i.test(g.colour) ? g.colour : undefined;
  return { arrow, typed: typed as Grid["typed"], ...(g.limiting ? { limiting: g.limiting as string } : {}), ...(rows.length || cols.length ? { hidden: { ...(rows.length ? { rows } : {}), ...(cols.length ? { cols } : {}) } } : {}), ...(colour ? { colour } : {}), ...(g.layout === "rows" ? { layout: "rows" as const } : {}), ...(lit && Object.keys(lit).length ? { literature: lit as Record<string, number> } : {}) };
}

// Each grid column's key (its side and what it is: "r:C7H8O", 'r:"NaBH4"', and "#2" on the next one the same) and what
// was typed for it: by its key, or else, for typed values whose key names no column (a compound redrawn, or a grid
// from before keys named compounds, "r0"), by order: the first column on the same side with nothing of its own. The
// limiting reactant follows its values.
export function keyColumns<T extends { product: boolean; what: string }>(cols: T[], typed: Grid["typed"], limiting?: string): { cols: (T & { key: string; typed: Typed })[]; limiting?: string } {
  const count = new Map<string, number>();
  const keyed = cols.map((c) => { const base = `${c.product ? "p" : "r"}:${c.what}`, n = (count.get(base) ?? 0) + 1; count.set(base, n); return { ...c, key: n > 1 ? `${base}#${n}` : base, typed: typed[n > 1 ? `${base}#${n}` : base] ?? {} }; });
  const keys = new Set(keyed.map((c) => c.key)), moved = new Map<string, string>();
  const old = (k: string) => /^[rp]\d+$/.test(k);
  const orphans = Object.keys(typed).filter((k) => !keys.has(k)).sort((a, b) => (old(a) && old(b) ? Number(a.slice(1)) - Number(b.slice(1)) : Number(old(b)) - Number(old(a))));
  for (const k of orphans) {
    const c = keyed.find((x) => (x.product ? "p" : "r") === k[0] && !Object.keys(x.typed).length && ![...moved.values()].includes(x.key));
    if (!c || !Object.keys(typed[k]).length) continue;
    c.typed = typed[k];
    moved.set(k, c.key);
  }
  const lim = limiting && (keys.has(limiting) ? limiting : moved.get(limiting) ?? (old(limiting) ? keyed.filter((c) => !c.product)[Number(limiting.slice(1))]?.key : undefined));
  return { cols: keyed, limiting: lim };
}

// A coefficient at the start of a reagent's text ("2 HCl", "0.5 H2", "½ O2").
export const COEFFICIENT = /^(?:\d{1,3}\s*\/\s*\d{1,3}|\d{1,4}(?:[.,]\d+)?|[½⅓⅔¼¾])\s+(?=\S)/;
// Where a compound of the equation has its coefficient: its box, the text holding the number (a "2" before it), and
// for a reagent written as text in the row, that text (the number may be its start, "2 HCl").
export type CoefSpot = { box: Box; coefId?: number; textId?: number };
// Equivalents typed in the grid written in front of a compound in the scheme (issue 133, both ways): the number before
// it changed, or taken away for 1; else, for text, put at its start ("HCl" to "2 HCl"); else a new number written just
// left of the structure, level with its middle, close enough to be read as its coefficient. size: the text size, in
// bond lengths.
export const coefficientText = (v: number) => String(Number(v.toFixed(2)));
export function writeCoefficient(m: Mol, spot: CoefSpot, v: number, o: { size: number }): Mol {
  const one = Math.abs(v - 1) < 1e-9, t = coefficientText(v), caption = (id?: number) => m.captions?.find((c) => c.id === id);
  if (caption(spot.coefId)) return one ? deleteGraphics(m, new Set([spot.coefId!])) : { ...m, captions: m.captions!.map((c) => (c.id === spot.coefId ? { ...c, text: t, runs: undefined } : c)) };
  const c = caption(spot.textId);
  if (c) {
    const lead = COEFFICIENT.exec(c.text)?.[0].length ?? 0, add = one ? "" : `${t} `, text = add + c.text.slice(lead);
    // Its styled runs keep their styles: the old number cut from the front, the new one put there.
    let cut = lead;
    const runs = c.runs?.flatMap((r) => { const k = Math.min(cut, r.text.length); cut -= k; return r.text.length > k ? [{ ...r, text: r.text.slice(k) }] : []; });
    return { ...m, captions: m.captions!.map((x) => (x === c ? { ...x, text, ...(runs ? { runs: add ? [{ text: add }, ...runs] : runs } : {}) } : x)) };
  }
  if (one) return m;
  // Right-aligned, a little clear of the structure, its digits' middle level with the structure's.
  const mid = (spot.box[1] + spot.box[3]) / 2, gap = 0.12;
  return addCaption(m, { text: t, x: spot.box[0] - gap, y: mid - 0.36 * o.size, align: "right" })[0];
}
