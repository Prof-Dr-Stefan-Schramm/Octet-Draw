// Run: node src/stoich.check.ts. Fails loudly if the stoichiometry sums break.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { abbreviationNames, coefficientOf, writeCoefficient, conditionItems, CONDITION_WORDS, inchiWeight, inert, ionWeight, keyColumns, readGrid, readReagent, formatAmount, formulaWeight, parseAmount, solve, textWeight } from "./stoich.ts";
import { fromCdxml, toCdxml } from "./cdxml.ts";
import { parse, serialize } from "./file.ts";
import { DEFAULT_STYLE } from "./docstyle.ts";
import type { Mol } from "./render.ts";

const near = (a: number | undefined, b: number, what: string) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b)), `${what}: ${a} for ${b}`);
// Benzaldehyde (106.12) 1.06 g is 10 mmol and limiting; NaBH4 (37.83) at 1.5 eq is 15 mmol, 567 mg; benzyl alcohol
// (108.14) expected 10 mmol, 1.081 g; 0.973 g measured is a 90% yield.
const s = solve([
  { key: "a", mw: 106.12, product: false, typed: { mass: 1.0612 } },
  { key: "b", mw: 37.83, product: false, typed: { equiv: 1.5 } },
  { key: "p", mw: 108.14, product: true, typed: { measured: 0.97326 } },
]);
near(s.a.moles, 0.01, "limiting moles");
near(s.b.moles, 0.015, "NaBH4 moles");
near(s.b.mass, 0.015 * 37.83, "NaBH4 mass");
near(s.p.expectedMass, 1.0814, "expected mass");
near(s.p.yield, 0.9, "yield");
// A liquid by volume and density; purity counts.
const l = solve([{ key: "x", mw: 100, product: false, typed: { volume: 2, density: 0.8, purity: 0.5 } }]);
near(l.x.moles, 0.008, "moles from volume, density and purity");
// A solution by volume and molarity.
near(solve([{ key: "y", mw: 50, product: false, typed: { volume: 5, molarity: 2 } }]).y.moles, 0.01, "moles from molarity");
// Typing units, and showing them.
near(parseAmount("250 mg", "mass"), 0.25, "mg");
near(parseAmount("250", "mass"), 250, "bare mass is g (issue 134)");
near(parseAmount("5", "measured"), 5, "bare measured mass is g");
near(parseAmount("1.2", "equiv"), 1.2, "eq");
near(parseAmount("98%", "purity"), 0.98, "%");
assert.equal(parseAmount("lots", "mass"), undefined);
assert.equal(parseAmount("5 mL", "mass"), undefined, "a volume is not a mass");
assert.equal(parseAmount("1e999", "mass"), undefined, "an amount too large to be a number");
assert.equal(formatAmount(0.25, "mass"), "250 mg");
assert.equal(formatAmount(0.0125, "moles"), "12.5 mmol");
assert.equal(formatAmount(0.9, "yield"), "90.0%");
// Formulas written as text.
near(formulaWeight("H2O"), 18.015, "water");
near(formulaWeight("NaBH₄"), 22.99 + 10.81 + 4 * 1.008, "subscript digits");
near(formulaWeight("Ca(OH)2"), 40.078 + 2 * (15.999 + 1.008), "brackets");
// Each part after a dot has its own number (issue 2): CuSO4·5H2O·NH3 is CuSO4 + 5 H2O + NH3.
const cuso4 = 63.546 + 32.06 + 4 * 15.999, water = 2 * 1.008 + 15.999, ammonia = 14.007 + 3 * 1.008;
near(formulaWeight("CuSO4·5H2O"), cuso4 + 5 * water, "a hydrate");
near(formulaWeight("CuSO4.5H2O"), cuso4 + 5 * water, "a hydrate with a full stop");
near(formulaWeight("CuSO4·5H2O·NH3"), cuso4 + 5 * water + ammonia, "two dots");
near(formulaWeight("CuSO4·5H2O"), 63.546 + 32.06 + 4 * 15.999 + 5 * 18.015, "hydrate");
assert.equal(formulaWeight("THF"), undefined, "an abbreviation is not a formula");
// A product's equivalents are its coefficient: two moles of product for each mole of the limiting reactant.
{
  const two = solve([{ key: "r", mw: 100, product: false, typed: { moles: 0.01 } }, { key: "p", mw: 50, product: true, typed: { equiv: 2, measured: 0.5 } }]);
  near(two.p.expectedMoles, 0.02, "two equivalents of product");
  near(two.p.expectedMass, 1, "their mass");
  near(two.p.yield, 0.5, "the yield against them");
}
// Columns keyed by compound (CH-22): typed values stay with their compound when a structure is added in front, follow
// by order a compound that was redrawn, and come from a grid saved with "r0", "p0" keys.
{
  const col = (product: boolean, what: string) => ({ product, what });
  const first = keyColumns([col(false, "C7H6O"), col(false, '"NaBH4"'), col(true, "C7H8O")], { "r:C7H6O": { mass: 1 }, 'r:"NaBH4"': { equiv: 1.5 } }, "r:C7H6O");
  assert.deepEqual(first.cols.map((c) => c.key), ["r:C7H6O", 'r:"NaBH4"', "p:C7H8O"]);
  const added = keyColumns([col(false, "C2H6"), col(false, "C7H6O"), col(false, '"NaBH4"'), col(true, "C7H8O")], { "r:C7H6O": { mass: 1 }, 'r:"NaBH4"': { equiv: 1.5 } }, "r:C7H6O");
  assert.deepEqual(added.cols.map((c) => c.typed), [{}, { mass: 1 }, { equiv: 1.5 }, {}], "a structure added in front takes nothing");
  assert.equal(added.limiting, "r:C7H6O");
  const redrawn = keyColumns([col(false, "C8H8O"), col(false, '"NaBH4"'), col(true, "C8H10O")], { "r:C7H6O": { mass: 1 }, 'r:"NaBH4"': { equiv: 1.5 }, "p:C7H8O": { measured: 0.9 } }, "r:C7H6O");
  assert.deepEqual(redrawn.cols.map((c) => c.typed), [{ mass: 1 }, { equiv: 1.5 }, { measured: 0.9 }], "a redrawn compound keeps its values by order");
  assert.equal(redrawn.limiting, "r:C8H8O");
  const old = keyColumns([col(false, "C7H6O"), col(false, "BH4Na"), col(true, "C7H8O")], { r0: { mass: 1 }, r1: { equiv: 1.5 }, p0: { measured: 0.9 } }, "r1");
  assert.deepEqual(old.cols.map((c) => c.typed), [{ mass: 1 }, { equiv: 1.5 }, { measured: 0.9 }], "a grid from before keys named compounds");
  assert.equal(old.limiting, "r:BH4Na");
  const twins = keyColumns([col(false, "C7H6O"), col(false, "C7H6O")], {});
  assert.deepEqual(twins.cols.map((c) => c.key), ["r:C7H6O", "r:C7H6O#2"]);
  // A saved grid read as a hostile file is.
  assert.ok(readGrid({ typed: { "r:C7H6O": { mass: 1 } }, limiting: "r:C7H6O", hidden: { rows: ["mw", "bogus"], cols: ["p:C7H8O"] }, colour: "#213C99" }, 3));
  assert.deepEqual(readGrid({ typed: {}, hidden: { rows: ["mw", "bogus"] } }, 3)?.hidden, { rows: ["mw"] });
  assert.equal(readGrid({ typed: { "r:x": { mass: -1 } } }, 3), undefined, "a negative amount");
  assert.equal(readGrid({ typed: { "x\ny": { mass: 1 } } }, 3), undefined, "a key with a line break");
  assert.equal(readGrid({ typed: {}, limiting: "p:C7H8O" }, 3), undefined, "a product cannot be limiting");
  // A table of rows (issue 34) is kept; any other layout reads as the columns ChemDraw's grid has.
  assert.equal(readGrid({ typed: {}, layout: "rows" }, 3)?.layout, "rows");
  for (const other of ["columns", "ROWS", 1, {}]) assert.equal(readGrid({ typed: {}, layout: other }, 3)?.layout, undefined, String(other));
  assert.ok(!("layout" in readGrid({ typed: {} }, 3)!));
}
// The layout goes through Octet's own file and through CDXML (Octet's data on the arrow), with what was typed.
{
  const m: Mol = { atoms: [], bonds: [], arrows: [{ id: 4, kind: "reaction", from: [0, 0], to: [3, 0] }], grids: [{ arrow: 4, typed: { "r:C7H6O": { mass: 1.06 } }, layout: "rows" }] };
  const opened = parse(serialize(m));
  assert.deepEqual(opened.grids, [{ arrow: opened.arrows![0].id, typed: { "r:C7H6O": { mass: 1.06 } }, layout: "rows" }]);
  const back = fromCdxml(toCdxml(m, DEFAULT_STYLE)).mol;
  assert.deepEqual(back.grids, [{ arrow: back.arrows![0].id, typed: { "r:C7H6O": { mass: 1.06 } }, layout: "rows" }]);
  assert.equal(fromCdxml(toCdxml({ ...m, grids: [{ arrow: 4, typed: {} }] }, DEFAULT_STYLE)).mol.grids?.[0].layout, undefined, "columns stay the default");
}
// The editor lays out a table of rows from the same sums (solve) as the columns, with the reagents and the products in
// sections of their own, and Hide row hides what shows as a row.
{
  const editor = readFileSync(new URL("Editor.tsx", import.meta.url), "utf8");
  assert.match(editor, /if \(g\.layout === "rows"\) \{/);
  assert.match(editor, /\[\[false, "Reagents"\], \[true, "Products"\]\]/);
  assert.match(editor, /if \(what === "layout"\) return changeGrid\(arrow, \(g\) => \(\{ layout: g\.layout \? undefined : "rows" \}\)\);/);
  assert.match(editor, /hideKey = what === \(rowsLayout \? "hide\.row" : "hide\.col"\)/);
  assert.match(readFileSync(new URL("Actions.tsx", import.meta.url), "utf8"), /context\.rows \? "Show as columns" : "Show as rows", "grid\.layout"/);
}
// A line of conditions splits at commas outside brackets; the atmosphere's gas is not a reagent.
assert.deepEqual(conditionItems("toluene/EtOH/H2O (4:1:1, 30 mL), 80 °C; 12 h"), ["toluene/EtOH/H2O (4:1:1, 30 mL)", "80 °C", "12 h"]);
for (const gas of ["N2", "Ar", "argon", "air", "under N2"]) assert.ok(inert(gas), gas);
for (const reagent of ["H2", "O2", "CO", "NH3"]) assert.ok(!inert(reagent), reagent);

// Reagents as they are written over an arrow (issue 131): amounts and how they are used read past, what the text says
// of the amount kept as a hint.
{
  const read = (t: string) => readReagent(t);
  assert.deepEqual(read("K2CO3 (2 eq.)"), { name: "K2CO3", hint: { equiv: 2 } });
  assert.deepEqual(read("K2CO3 (2 equiv)"), { name: "K2CO3", hint: { equiv: 2 } });
  assert.deepEqual(read("1.5 equiv NaBH4"), { name: "NaBH4", hint: { equiv: 1.5 } });
  assert.deepEqual(read("Pd(PPh3)4 (5 mol%)"), { name: "Pd(PPh3)4", hint: { equiv: 0.05 } }, "a formula's own brackets stay");
  for (const t of ["cat. H2SO4", "H2SO4 (cat.)", "conc. H2SO4"]) assert.equal(read(t)?.name, "H2SO4", t);
  for (const t of ["aq. HCl", "HCl (aq)", "HCl(aq)", "6 N HCl", "then HCl"]) assert.equal(read(t)?.name, "HCl", t);
  assert.deepEqual(read("1 M NaOH"), { name: "NaOH", hint: { molarity: 1 } });
  assert.deepEqual(read("nBuLi (2.5 M in hexanes)"), { name: "nBuLi", hint: { molarity: 2.5 } });
  assert.deepEqual(read("30% H2O2"), { name: "H2O2", hint: { purity: 0.3 } });
  // A coefficient in front (issue 133).
  assert.deepEqual(read("2 HCl"), { name: "HCl", coefficient: 2, hint: {} });
  assert.deepEqual(read("0.5 H2"), { name: "H2", coefficient: 0.5, hint: {} });
  assert.deepEqual(read("½ O2"), { name: "O2", coefficient: 0.5, hint: {} });
  assert.equal(read("1,4-dioxane")?.name, "1,4-dioxane", "a locant is not a coefficient");
  assert.equal(coefficientOf("2"), 2);
  assert.equal(coefficientOf("1/2"), 0.5);
  for (const t of ["2a", "0", "-1", "H2", "1e9"]) assert.equal(coefficientOf(t), undefined, t);
  for (const t of ["reflux", "rt", "overnight", "MW", "hν", "Δ"]) assert.ok(CONDITION_WORDS.test(t), t);
  assert.ok(!CONDITION_WORDS.test("pyridine"));
}
// Ions and words (issue 132), and Octet's reagent abbreviations by name, with their formulas in Hill order.
{
  const table: Record<string, string> = JSON.parse(readFileSync(new URL("abbreviations.json", import.meta.url), "utf8"));
  const abbr = abbreviationNames(table), w = (t: string) => textWeight(t, abbr);
  for (const [t, mass] of [["H+", 1.008], ["H⁺", 1.008], ["OH-", 17.007], ["OH−", 17.007], ["HO-", 17.007], ["OH⁻", 17.007], ["H3O+", 19.023], ["NH4+", 18.039],
    ["Cu2+", 63.546], ["Fe3+", 55.845], ["SO42-", 96.056], ["SO4 2-", 96.056], ["SO4^2-", 96.056], ["SO₄²⁻", 96.056], ["proton", 1.008], ["Proton", 1.008],
    ["hydroxide", 17.007], ["water", 18.015], ["THF", 72.107], ["DMF", 73.095], ["DCM", 84.927], ["AcOH", 60.052], ["Pd(OAc)2", 224.508], ["nBuLi", 64.056]] as const) near(w(t)?.weight, mass, t);
  assert.equal(w("Pd(OAc)2")?.formula, "C4H6O4Pd");
  assert.equal(w("nBuLi")?.formula, "C4H9Li");
  assert.equal(w("Et3N·HCl")?.formula, "C6H16ClN");
  for (const t of ["e-", "reflux", "p-TsOH", "2+", "+"]) assert.equal(w(t), undefined, t);
  assert.equal(ionWeight("H2O"), undefined, "no charge, no ion");
  assert.equal(inchiWeight("InChI=1S/C4H8O/c1-2-4-5-3-1/h1-4H2")?.formula, "C4H8O");
  assert.equal(inchiWeight("not an InChI"), undefined);
  // Every abbreviation of reagents and solvents reads (ligands for metals and residues may use elements Octet has no weight for).
  for (const name of ["THF", "DMSO", "MeCN", "EtOAc", "DMAP", "DBU", "Et3N", "DIPEA", "TFA", "TsOH", "mCPBA", "NBS", "LDA", "DIBAL", "KOtBu", "Pd(PPh3)4", "Pd2(dba)3"]) assert.ok(w(name), name);
}
// Coefficients and hints in the sums (issue 133): equivalents are the coefficients. 2 A + B → C with B limiting gives A
// 2 equivalents; with A limiting, A is still 2 equivalents and B 1, at half A's moles; a product's coefficient sets its
// expected moles; a hint gives equivalents where none are typed; a typed value wins.
{
  const r = (key: string, typed: object, extra: object = {}) => ({ key, mw: 100, product: false, typed, ...extra });
  const p = (key: string, typed: object, extra: object = {}) => ({ key, mw: 50, product: true, typed, ...extra });
  const bLim = solve([r("a", {}, { coef: 2 }), r("b", { moles: 0.01 }), p("c", {})], "b");
  near(bLim.a.moles, 0.02, "two of A to one of B");
  near(bLim.a.equiv, 2, "A's equivalents");
  const aLim = solve([r("a", { moles: 0.02 }, { coef: 2 }), r("b", {}), p("c", {})], "a");
  near(aLim.b.moles, 0.01, "one of B to two of A");
  near(aLim.a.equiv, 2, "the limiting reactant shows its coefficient");
  near(aLim.b.equiv, 1, "B is one equivalent");
  near(aLim.c.expectedMoles, 0.01, "one of C to two of A");
  // The limiting reactant's equivalents typed, as a coefficient not drawn: the same sums.
  const typed = solve([r("a", { moles: 0.02, equiv: 2 }), r("b", {}), p("c", {})], "a");
  near(typed.b.moles, 0.01, "A typed as 2 equivalents");
  near(typed.a.equiv, 2, "and shown as 2");
  // 2 benzene + COCl2 → benzophenone, 5 g wanted (MW 182.22): 27.4 mmol, so 54.9 mmol of benzene and 27.4 of phosgene,
  // phosgene typed as 1 equivalent.
  const bp = solve([{ key: "bz", mw: 78.11, product: false, typed: {}, coef: 2 }, { key: "ph", mw: 98.91, product: false, typed: { equiv: 1 } }, { key: "p", mw: 182.22, product: true, typed: { mass: 5 } }], "bz");
  near(bp.bz.moles, (2 * 5) / 182.22, "benzene");
  near(bp.ph.moles, 5 / 182.22, "phosgene");
  near(bp.bz.equiv, 2, "benzene's equivalents");
  near(solve([r("a", { moles: 0.01 }), p("c", {}, { coef: 2 })]).c.expectedMoles, 0.02, "A → 2 C");
  near(solve([r("a", { moles: 0.01 }), r("k", {}, { hint: { equiv: 2 } })]).k.moles, 0.02, "K2CO3 (2 eq.)");
  near(solve([r("a", { moles: 0.01 }), r("k", { equiv: 3 }, { hint: { equiv: 2 } })]).k.moles, 0.03, "typed equivalents win");
  near(solve([r("a", { moles: 0.01 }), r("k", {}, { coef: 2, hint: { equiv: 1.2 } })]).k.equiv, 1.2, "a hint wins over a coefficient");
  assert.equal(solve([r("a", {}), r("b", {})]).b.equiv, undefined, "no equivalents shown where nothing says them");
  near(solve([r("a", {}), r("b", { volume: 10 }, { hint: { molarity: 1 } })]).b.moles, 0.01, "1 M NaOH, 10 mL");
}
// The mass of product wanted (issue 136) sets the scale when no reactant has an amount: 5 g of C (MW 50) is 0.1 mol, so
// 0.1 mol of A, and 0.2 mol of B at 2 equivalents; by A → 2 C, 0.05 mol of A.
{
  const s = solve([{ key: "a", mw: 100, product: false, typed: {} }, { key: "b", mw: 10, product: false, typed: { equiv: 2, density: 0.8 } }, { key: "c", mw: 50, product: true, typed: { mass: 5 } }]);
  near(s.a.moles, 0.1, "limiting moles from the target");
  near(s.a.mass, 10, "limiting mass");
  near(s.b.mass, 2, "B's mass");
  near(s.b.volume, 2.5, "B's volume from its density (issue 135)");
  near(s.c.expectedMass, 5, "the expected mass is the target");
  near(solve([{ key: "a", mw: 100, product: false, typed: {} }, { key: "c", mw: 50, product: true, typed: { mass: 5 }, coef: 2 }]).a.moles, 0.05, "A → 2 C");
  near(solve([{ key: "a", mw: 100, product: false, typed: { mass: 1 } }, { key: "c", mw: 50, product: true, typed: { mass: 5 } }]).c.expectedMass, 0.5, "a reactant's amount wins");
  // Older Octet reads a target as a product's mass it ignores, so the grid is kept (readGrid takes mass on any column).
  assert.ok(readGrid({ typed: { "p:C2H4": { mass: 5 } } }, 0));
}
// The editor's grid: Volume and Density always offered (issue 135), Expected mass typed on a product (issue 136).
{
  const editor = readFileSync(new URL("Editor.tsx", import.meta.url), "utf8");
  assert.match(editor, /\{ id: "volume", name: "Volume", field: "volume", product: false \}, \{ id: "density", name: "Density", field: "density", product: false \}/);
  assert.match(editor, /\{ id: "expected", name: "Expected mass", field: "mass", product: true \}/);
  // Typing the limiting reactant's equivalents keeps its amount.
  assert.match(editor, /const how: Field\[\] = g\.limiting === w\.key \? \["mass", "moles", "volume"\] : \["mass", "moles", "volume", "equiv"\];/);
}
// A reagent over the arrow is not in the equation: it takes 1 equivalent, as any reagent with nothing typed does,
// unless its text says otherwise.
{
  const s = solve([{ key: "a", mw: 100, product: false, typed: { moles: 0.02 }, coef: 2 }, { key: "b", mw: 100, product: false, typed: {} }, { key: "cat", mw: 98, product: false, typed: {}, side: true }, { key: "k", mw: 138, product: false, typed: {}, side: true, hint: { equiv: 2 } }], "a");
  near(s.b.equiv, 1, "B in the equation");
  near(s.b.moles, 0.01, "at half A's moles");
  near(s.cat.equiv, 1, "a reagent over the arrow");
  near(s.k.moles, 0.02, "K2CO3 (2 eq.) over the arrow");
}

// Equivalents typed in the grid are written into the scheme (issue 133, both ways): a new number left of a structure,
// level with it; the number before it changed, or taken away for 1; and at the start of a reagent written as text.
{
  const base: Mol = { atoms: [], bonds: [], captions: [{ id: 1, text: "2", x: -1, y: 0 }, { id: 2, text: "HCl", x: 5, y: 0 }, { id: 3, text: "2 H2O", x: 9, y: 0, runs: [{ text: "2 " }, { text: "H2O", bold: true }] }] };
  const o = { size: 0.69 };
  const added = writeCoefficient(base, { box: [0, -0.5, 2, 0.5] }, 3, o).captions!.at(-1)!;
  assert.equal(added.text, "3");
  assert.equal(added.align, "right");
  assert.ok(added.x < 0 && added.x > -0.3, "close enough to the structure to be its own");
  near(added.y, -0.36 * 0.69, "level with the structure's middle");
  assert.equal(writeCoefficient(base, { box: [0, -0.5, 2, 0.5] }, 1, o), base, "1 is not written");
  assert.equal(writeCoefficient(base, { box: [0, 0, 1, 1], coefId: 1 }, 1.5, o).captions![0].text, "1.5", "the number changed");
  assert.ok(!writeCoefficient(base, { box: [0, 0, 1, 1], coefId: 1 }, 1, o).captions!.some((c) => c.id === 1), "taken away for 1");
  assert.equal(writeCoefficient(base, { box: [0, 0, 1, 1], textId: 2 }, 2, o).captions![1].text, "2 HCl", "put in front of text");
  const water = writeCoefficient(base, { box: [0, 0, 1, 1], textId: 3 }, 3, o).captions![2];
  assert.equal(water.text, "3 H2O", "a number in the text replaced");
  assert.deepEqual(water.runs, [{ text: "3 " }, { text: "H2O", bold: true }], "its styles kept");
  assert.equal(writeCoefficient(base, { box: [0, 0, 1, 1], textId: 3 }, 1, o).captions![2].text, "H2O", "and taken away for 1");
  assert.equal(writeCoefficient(base, { box: [0, 0, 1, 1], textId: 2 }, 0.333333, o).captions![1].text, "0.33 HCl", "two decimals at most");
}
// A literature yield: the yield as a fraction of it, kept with the grid beside what was typed, and read as hostile.
{
  const s = solve([{ key: "a", mw: 100, product: false, typed: { moles: 0.01 } }, { key: "p", mw: 100, product: true, typed: { measured: 0.6 }, literature: 0.8 }]);
  near(s.p.yield, 0.6, "the yield");
  near(s.p.ofLiterature, 0.75, "60% against 80% in the literature");
  assert.equal(solve([{ key: "a", mw: 100, product: false, typed: { moles: 0.01 } }, { key: "p", mw: 100, product: true, typed: {}, literature: 0.8 }]).p.ofLiterature, undefined, "nothing measured yet");
  assert.deepEqual(readGrid({ typed: {}, literature: { "p:C2H4": 0.85 } }, 0)?.literature, { "p:C2H4": 0.85 });
  for (const bad of [{ "r:C2H4": 0.5 }, { "p:C2H4": 1.5 }, { "p:C2H4": 0 }, { "p:C2H4": "85%" }, [0.5]]) assert.equal(readGrid({ typed: {}, literature: bad }, 0), undefined, JSON.stringify(bad));
  const m: Mol = { atoms: [], bonds: [], arrows: [{ id: 4, kind: "reaction", from: [0, 0], to: [3, 0] }], grids: [{ arrow: 4, typed: {}, literature: { "p:C2H4": 0.85 } }] };
  assert.deepEqual(parse(serialize(m)).grids![0].literature, { "p:C2H4": 0.85 }, "through Octet's file");
  assert.deepEqual(fromCdxml(toCdxml(m, DEFAULT_STYLE)).mol.grids![0].literature, { "p:C2H4": 0.85 }, "through CDXML");
  const editor = readFileSync(new URL("Editor.tsx", import.meta.url), "utf8");
  assert.match(editor, /\{ id: "literature", name: "Literature yield", product: true \}, \{ id: "ofLiterature", name: "Yield \/ literature", product: true \}/);
}
console.log("stoich.check: ok");
