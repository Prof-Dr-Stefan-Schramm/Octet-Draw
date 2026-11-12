// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/model/src/chemistry/abbreviations/catalog/tests.rs and crates/model/src/atom_text/tests.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// Run: node src/nicknames.check.ts. Octet's nicknames (nicknamedata.ts, from ReShiki's catalogue): every group's
// formula and mass against Indigo, every spelling typed on an atom as the editor sets it, how each one is drawn, the
// element symbols that ChemDraw reads as nicknames, and Octet's own groups unchanged. ReShiki's catalogue tests,
// re-expressed on our own small structures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const gl = globalThis as Record<string, unknown>;
gl.document = { documentElement: {}, createElement: () => ({ getContext: () => ({}) }) };
gl.getComputedStyle = () => ({ getPropertyValue: () => "10" });
gl.window = globalThis;
gl.self = { location: { origin: "file://" } };
gl.fetch = async (u: URL | string) => new Response(readFileSync(new URL(String(u))), { headers: { "content-type": "application/wasm" } });
const chem = await import("./chem.ts");
await chem.ready;
const { GROUPS, labelSmiles, units, anchorElement } = await import("./labels.ts");
const { BUNDLED, lookupNickname, namedNicknames } = await import("./nicknames.ts");
const { setLabel } = await import("./edit.ts");
const { atomMass, counts } = await import("./mass.ts");
const { fromCdxml, toCdxml, parseXml } = await import("./cdxml.ts");
const { readOct, writeOct } = await import("./oct.ts");
const { DEFAULT_STYLE } = await import("./docstyle.ts");
type Mol = import("./render.ts").Mol;

// ReShiki's formula string: Hill order (C, then H, then A to Z; with no C, A to Z), then the net charge.
const hill = (n: Record<string, number>, charge = 0) => {
  const k = Object.keys(n).filter((e) => n[e]).sort((a, b) => (n.C ? (a === "C" ? -1 : b === "C" ? 1 : a === "H" ? -1 : b === "H" ? 1 : 0) : 0) || (a < b ? -1 : a > b ? 1 : 0));
  return k.map((e) => e + (n[e] > 1 ? n[e] : "")).join("") + (charge ? `${Math.abs(charge) > 1 ? Math.abs(charge) : ""}${charge > 0 ? "+" : "-"}` : "");
};
// CH3–CH2–label, as the editor has it after the label is typed on the end atom.
const ethyl = (): Mol => ({
  atoms: [{ label: "C", location: [0, 0, 0] }, { label: "C", location: [0.866, 0.5, 0] }, { label: "C", location: [1.732, 0, 0] }],
  bonds: [{ type: 1, atoms: [0, 1] }, { type: 1, atoms: [1, 2] }],
});
const typed = (text: string) => setLabel(ethyl(), 2, text);
// A drawing's formula less the ethyl, and its charge: the group's formula as the catalogue writes it.
const groupFormula = (m: Mol) => {
  const x = chem.expandLabels(m), a = chem.analyse(x)?.[0], n = a && counts(a.formula);
  if (!n) return undefined;
  n.C -= 2; n.H -= 5;
  return { formula: hill(n, x.atoms.reduce((t, at) => t + (at.charge ?? 0), 0)), weight: a.weight };
};
const inchi = (smiles: string) => chem.toInchi(`[Xe]${smiles}`);

// The catalogue as ReShiki ships it (ReShiki's bundled_entries_are_complete test), less the 11 groups ChemDraw reads as
// other structures (nicknamedata.ts): each with a formula, a known category and a name, no [H] atoms.
assert.equal(BUNDLED.length, 354);
const CATEGORIES = new Set(["alkyl", "aryl", "heteroaryl", "alkoxy", "carbonyl", "protecting group", "silyl", "sulfonyl", "sulfur", "nitrogen", "phosphorus", "boron", "halogen", "metal"]);
for (const e of BUNDLED) {
  assert.ok(e.formula && CATEGORIES.has(e.category) && e.names.length && !e.smiles.includes("*") && !/\[H\]/.test(e.smiles), e.label);
}

// Every group's formula and mass from Indigo, on an ethyl, against the catalogue's formula (the brief's first "done
// when"). The mass from the formula (deuterium at its own mass) within Indigo's rounding of the atomic weights.
let spellings = 0;
for (const e of BUNDLED) {
  const m = chem.parseStructure(`CC${e.smiles}`, false), got = groupFormula(m)!;
  assert.equal(got.formula, e.formula, `${e.label}: Indigo reads ${got.formula}`);
  // The charge goes (BF3- is BF3 with one negative charge); D atoms weigh as deuterium.
  const d = m.atoms.filter((a) => a.label === "D").length, plain = counts(e.formula.replace(/[+-]$/, ""))!;
  const mass = 2 * atomMass("C")! + 5 * atomMass("H")! + Object.entries(plain).reduce((t, [el, k]) => t + atomMass(el)! * k, 0) + d * (atomMass("H", 2)! - atomMass("H")!);
  assert.ok(Math.abs(mass - got.weight) <= Math.max(0.01, 1e-4 * mass), `${e.label}: mass ${mass} against Indigo's ${got.weight}`);
  // Every spelling typed on the atom (ReShiki's every_bundled_spelling_types_as_its_group): the label as typed, the
  // group's structure.
  for (const s of [e.label, ...(e.aliases ?? []), ...(e.reverse ? [e.reverse] : [])]) {
    const t = typed(s), a = t.atoms[2];
    assert.equal(a.text, s, `${s} keeps its spelling`);
    assert.equal(inchi(labelSmiles(s)!), inchi(e.smiles), `${s} reads as ${e.label}`);
    assert.equal(groupFormula(t)?.formula, e.formula, `${s} on an ethyl`);
    spellings++;
  }
}
assert.ok(spellings > 600);
console.log(`nicknames.check: ${BUNDLED.length} formulas and masses, and ${spellings} typed spellings, ok`);

// ReShiki's formulas_are_hill_order_substituents.
for (const [smiles, formula] of [["C", "CH3"], ["C(F)(F)F", "CF3"], ["[N+](=O)[O-]", "NO2"], ["O[Si](C)(C)C(C)(C)C", "C6H15OSi"], ["S(=O)(=O)C(F)(F)F", "CF3O2S"],
  ["[N+](C)(C)C", "C3H9N+"], ["C(=O)[O-]", "CO2-"], ["Br", "Br"]]) assert.equal(groupFormula(chem.parseStructure(`CC${smiles}`, false))?.formula, formula, smiles);

// The brief's second "done when": each label typed gives the group's formula.
const want: Record<string, string> = { Bpin: "C6H12BO2", TBDPS: "C16H19Si", Pbf: "C13H17O3S", Dipp: "C12H17", NPhth: "C8H4NO2", Morph: "C4H8NO", "2-Py": "C5H4N",
  SF5: "F5S", MeO: "CH3O", AcO: "C2H3O2", BnO: "C7H7O" };
for (const [label, formula] of Object.entries(want)) assert.equal(groupFormula(typed(label))?.formula, formula, label);
// Other spellings keep the typed label and make the same group (ReShiki's catalog_aliases test): TBDMS is TBS, MPM is
// PMB, Trt is Tr. Bzl, OBzl and BzlO are benzyl groups.
for (const [alias, label] of [["TBDMS", "TBS"], ["MPM", "PMB"], ["Trt", "Tr"], ["Bzl", "Bn"], ["OBzl", "OBn"], ["BzlO", "OBn"], ["Tos", "Ts"]]) {
  assert.equal(typed(alias).atoms[2].text, alias);
  assert.equal(inchi(labelSmiles(alias)!), inchi(labelSmiles(label)!), alias);
}
// Case counts: Mes is mesityl, MeS methylthio; meo is nothing.
assert.equal(groupFormula(typed("Mes"))?.formula, "C9H11");
assert.equal(groupFormula(typed("MeS"))?.formula, "CH3S");
assert.equal(lookupNickname("meo"), undefined);
assert.equal(lookupNickname("MeO")?.spelling, "reverse");
assert.equal(lookupNickname("MeO")?.entry.label, "OMe");
console.log("nicknames.check: the brief's labels, other spellings and case ok");

// Element symbols as ChemDraw 25.5 reads them typed as a label (design note): Ac, Np, Pr and Ts are nicknames (acetyl,
// 4-nitrophenyl, propyl, tosyl); Ar, Nb, Cm stay elements. CDXML import already read Ac and Pr as groups.
for (const [label, formula] of [["Ac", "C2H3O"], ["Np", "C6H4NO2"], ["Pr", "C3H7"], ["Ts", "C7H7O2S"]]) {
  const t = typed(label);
  assert.equal(t.atoms[2].text, label, label);
  assert.equal(t.atoms[2].label, "C", `${label} attaches through carbon`);
  assert.equal(groupFormula(t)?.formula, formula, label);
}
assert.equal(inchi(labelSmiles("Np")!), inchi("c1ccc([N+](=O)[O-])cc1"), "Np is 4-nitrophenyl");
for (const el of ["Ar", "Nb", "Cm", "Na", "Si"]) { const t = typed(el); assert.equal(t.atoms[2].label, el); assert.equal(t.atoms[2].text, undefined, el); }
// Ns is 2-nitrobenzenesulfonyl, as ChemDraw and ReShiki have it (Octet had 4-nitro); pNs is 4-nitro.
assert.equal(inchi(labelSmiles("Ns")!), inchi("S(=O)(=O)c1ccccc1[N+](=O)[O-]"));
assert.equal(inchi(labelSmiles("pNs")!), inchi("S(=O)(=O)c1ccc([N+](=O)[O-])cc1"));
// NC and OCN stay isocyanide and cyanate, as ChemDraw reads them (not reverse spellings of CN and NCO).
assert.equal(labelSmiles("NC"), "[N+]#[C-]");
assert.equal(labelSmiles("OCN"), "OC#N");
assert.equal(labelSmiles("Z"), undefined, "Z is not a label in ChemDraw");
console.log("nicknames.check: element symbols, Ns, NC, OCN ok");

// Octet's own groups read exactly as before (Ns apart), and so do labels Octet read right before.
const before: Record<string, string> = { Me: "C", Ph: "c1ccccc1", Ar: "c1ccccc1", Cp: "C1C=CC=C1", Pr: "CCC", Bu: "CCCC", TBS: "[Si](C)(C)C(C)(C)C", Boc: "C(=O)OC(C)(C)C" };
for (const [k, v] of Object.entries(before)) assert.equal(labelSmiles(k), v, k);
for (const k of Object.keys(GROUPS)) if (k !== "Ns") assert.equal(labelSmiles(k), GROUPS[k], k);
for (const [label, smiles] of Object.entries({ OMe: "OC", MeO: "O(C)", CO2Et: "C(=O)OCC", SO2Me: "S(=O)(=O)C", CH2OH: "CO", CF3: "C(F)(F)F", NHBoc: "NC(=O)OC(C)(C)C" }))
  assert.equal(labelSmiles(label), smiles, label);
// Labels Octet read wrongly before are read as the nickname: F3C was F–F–F–C, ClAc was joined through Cl, ONp was O and
// neptunium, TDS was tritium, deuterium and sulfur.
for (const [label, smiles] of Object.entries({ F3C: "C(F)(F)F", ClAc: "C(=O)CCl", ONp: "Oc1ccc([N+](=O)[O-])cc1", TDS: "[Si](C)(C)C(C)(C)C(C)C", OTDS: "O[Si](C)(C)C(C)(C)C(C)C", Im: "n1ccnc1", SePh: "[Se]c1ccccc1" }))
  assert.equal(inchi(labelSmiles(label)!), inchi(smiles), label);
// ChemDraw reads these with another meaning, so they are not Octet's nicknames (nicknamedata.ts): NiPr2 is nickel with
// two propyl groups, OAt O and astatine, ONs O and Ns (2-nitro); Hex, Oct, All, Xyl and Moz are ChemDraw's own.
for (const s of ["NiPr2", "PtBu2", "OAt", "ONs", "Hex", "Oct", "All", "Xyl", "Moz", "Z"]) assert.equal(lookupNickname(s), undefined, s);
assert.equal(labelSmiles("NiPr2"), "[Ni](CCC)(CCC)");
assert.equal(inchi(labelSmiles("ONs")!), inchi("OS(=O)(=O)c1ccccc1[N+](=O)[O-]"));
// A nickname inside a longer label: CH2Bpin, NHPbf, CH2Morph.
for (const [label, smiles] of Object.entries({ CH2Bpin: "CB1OC(C)(C)C(C)(C)O1", NHPbf: "NS(=O)(=O)c1c(C)c2CC(C)(C)Oc2c(C)c1C", CH2Morph: "CN1CCOCC1" }))
  assert.equal(inchi(labelSmiles(label)!), inchi(smiles), label);
console.log("nicknames.check: Octet's groups unchanged, old misreadings put right ok");

// How a nickname is drawn: its units, read right to left when the bond comes from the right. A formula's units as
// before (SF5 reads F5S); a label with a reverse spelling in its two parts (Bpin reads pinB, NiPr2 iPr2N, OTDS TDSO);
// other nicknames whole (TDS, Morph, 2-Py), never letter by letter.
const shown = (label: string) => units(label).map((u) => u.text + (u.count ?? "")).join("|");
const back = (label: string) => [...units(label)].reverse().map((u) => u.text + (u.count ?? "")).join("");
for (const [label, u, b] of [["SF5", "S|F5", "F5S"], ["Bpin", "B|pin", "pinB"], ["NEt2", "N|Et2", "Et2N"], ["OTDS", "O|TDS", "TDSO"], ["TDS", "TDS", "TDS"], ["Morph", "Morph", "Morph"],
  ["2-Py", "2-Py", "2-Py"], ["ODMT", "O|DMT", "DMTO"], ["NPhth", "N|Phth", "PhthN"], ["CD3", "C|D3", "D3C"], ["B(OH)2", "B|(OH)2", "(OH)2B"]] as const) {
  assert.equal(shown(label), u, label);
  assert.equal(back(label), b, label);
}
// Each reverse spelling read back is its label, for every nickname with one and two parts: the drawing shows the
// reverse spelling where ReShiki does.
for (const e of BUNDLED) if (e.reverse && units(e.label).length === 2 && units(e.label).every((u) => u.kind !== "bracket")) assert.equal(back(e.label), e.reverse, e.label);
assert.equal(anchorElement("Bpin"), "B");
assert.equal(anchorElement("Morph"), undefined);
// Names are never labels: morpholino suggests Morph; acetyl gives Ac and COMe.
assert.deepEqual(namedNicknames("Morpholino"), ["Morph"]);
assert.ok(namedNicknames("acetyl").includes("Ac"));
assert.equal(labelSmiles("morpholino"), undefined);
console.log("nicknames.check: drawing and names ok");

// No two nicknames ReShiki contracts share a structure (ReShiki's detectable_groups_have_distinct_structures), so
// Contract Label's suggestion is one label.
const contracted = new Map<string, string>();
for (const e of BUNDLED.filter((x) => x.contract !== false)) {
  const k = inchi(e.smiles)!;
  assert.ok(!contracted.has(k), `${e.label} and ${contracted.get(k)}`);
  contracted.set(k, e.label);
}

// Files and the clipboard: CDXML (and the .oct file, CDXML inside) writes a new nickname as a ChemDraw fragment with its
// atoms, and reads back the label. ChemDraw's own nickname node (NodeType Nickname) labelled Ac is acetyl, as a
// Fragment is.
{
  let m = typed("Bpin");
  m = setLabel(m, 0, "Morph");
  const expand = (t: string) => { const s = labelSmiles(t); return s ? chem.parseStructure(s) : undefined; };
  const x = toCdxml(m, DEFAULT_STYLE, { expand });
  const nodes: { attrs: Record<string, string>; kids: unknown[] }[] = [];
  const walk = (n: { name: string; attrs: Record<string, string>; kids: unknown[] }) => { if (n.name === "n") nodes.push(n); (n.kids as typeof n[]).forEach(walk); };
  walk(parseXml(x) as never);
  assert.equal(nodes.filter((n) => n.attrs.NodeType === "Fragment").length, 2, "Bpin and Morph are written with their atoms");
  const back = fromCdxml(x).mol;
  assert.deepEqual(back.atoms.filter((a) => a.text).map((a) => a.text).sort(), ["Bpin", "Morph"]);
  assert.equal(groupFormula({ ...back, atoms: back.atoms.map((a) => (a.text === "Morph" ? { ...a, text: undefined, label: "C", inner: undefined } : a)) })?.formula, "C6H12BO2");
  const oct = readOct(writeOct(m, DEFAULT_STYLE, { expand })).mol;
  assert.deepEqual(oct.atoms.map((a) => a.text), m.atoms.map((a) => a.text));
  assert.equal(chem.analyse(chem.expandLabels(oct))?.[0].formula, chem.analyse(chem.expandLabels(m))?.[0].formula);
  const cd = `<?xml version="1.0"?><CDXML><page id="1"><fragment id="2"><n id="3" p="100 100"/><n id="4" p="114.4 108.3"/>` +
    `<n id="5" p="128.8 100" NodeType="Nickname"><fragment id="10"><n id="11" p="128.8 100"/><n id="12" p="141.2 107.2"/><n id="13" p="141.2 121.6" Element="8"/>` +
    `<n id="14" p="153.7 100"/><n id="15" p="116 100" NodeType="ExternalConnectionPoint"/><b id="16" B="11" E="12"/><b id="17" B="12" E="13" Order="2"/><b id="18" B="12" E="14"/><b id="19" B="15" E="11"/></fragment>` +
    `<t p="125 104"><s font="3" size="10" face="96">Ac</s></t></n><b id="6" B="3" E="4"/><b id="7" B="4" E="5"/></fragment></page></CDXML>`;
  const ac = fromCdxml(cd).mol.atoms.find((a) => a.text === "Ac" || a.label === "Ac");
  assert.equal(ac?.text, "Ac", "ChemDraw's nickname Ac is acetyl, never actinium");
}
console.log("nicknames.check: CDXML, .oct and ChemDraw's nickname nodes ok");

// ——— The user's own nicknames (Structure > Define Nickname, Settings > Dictionary > Nicknames) ———
const nick = await import("./nicknames.ts");
const { checkNickname, nicknameFormula, nicknameFromSelection, reservedSpelling } = await import("./nicknamedefine.ts");
const { contractLabel } = await import("./edit.ts");
const read = (groups: unknown[]) => nick.readNicknamesFile(JSON.stringify({ format: 1, groups }), (e) => checkNickname(e));

// A file with good and bad groups (ReShiki's invalid_entries_are_reported_and_valid_ones_kept): the good ones load, each
// bad one is named with the reason.
{
  const { nicknames, errors } = read([
    { label: "Good", smiles: "*CC(C)(C)C", formula: "C5H11" }, { label: "Two", smiles: "*CC*" }, { label: "Late", smiles: "C*" }, { label: "Bad", smiles: "*C((" },
    { label: "Wrong", smiles: "*CC", formula: "C3H7" }, { label: "Good", smiles: "*C" }, { label: "has space", smiles: "*C" }, { label: "Chiral", smiles: "*[C@H](F)Cl" },
    { label: "Alias", smiles: "*CC", aliases: ["Good"] }, { label: "Ring", smiles: "*C1CC1", contract: false }, { label: "Double", smiles: "*=CC" }, { label: "Radical", smiles: "*[CH2]" },
    { label: "A,B", smiles: "*C" }, { label: "Heavy", smiles: "*[13CH3]" }, { label: "Typo", smile: "*C" }, { label: "Late2", smiles: "*CC" }, { label: "Azide", smiles: "*C", aliases: ["N3"] },
    { label: "GoodO", smiles: "*CC", reverse: "Late2" }, { label: "ExplicitH", smiles: "*C[H]" },
  ]);
  assert.deepEqual(nicknames.map((e) => e.label), ["Good", "Ring", "Late2"]);
  assert.equal(nicknames[1].contract, false);
  assert.equal(nicknames[0].smiles, "CC(C)(C)C", "kept without the *");
  const want = ["Group 2 (Two): The SMILES must start", "Group 3 (Late): The SMILES must start", "Group 4 (Bad): Octet cannot read the SMILES", "Group 5 (Wrong): The formula C3H7 is not the structure's (C2H5)",
    "Group 6 (Good): \"Good\" is defined twice", "Group 7 (has space): Label \"has space\" must have", "Group 8 (Chiral): A nickname cannot keep stereochemistry", "Group 9 (Alias): \"Good\" is defined twice",
    "Group 11 (Double): The group must join the drawing by a single bond", "Group 12 (Radical): A nickname cannot have radicals", "Group 13 (A,B): Label \"A,B\" must have 1 to 32 characters, with no spaces or commas",
    "Group 14 (Heavy): A nickname with isotopes must have contract set to false", "Group 15 (Typo): Octet does not know the field \"smile\"", "Group 17 (Azide): \"N3\" means an element",
    "Group 18 (GoodO): \"Late2\" is defined twice", "Group 19 (ExplicitH): Write hydrogens in the atoms"];
  assert.equal(errors.length, want.length, errors.join("\n"));
  errors.forEach((e, k) => assert.ok(e.startsWith(want[k]), e));
  assert.ok(nick.readNicknamesFile("{", checkNickname).errors[0].includes("not a nicknames file"));
  assert.ok(nick.readNicknamesFile(`{"format": 2, "groups": []}`, checkNickname).errors[0].includes("format 2"));
}
// Spellings a user's nickname cannot take (ReShiki's reserved test): elements, Octet's groups that are not nicknames,
// formulas Octet reads its own way, isotopes and amino acids. Octet's nicknames (TBS) can be taken.
for (const s of ["N3", "MgBr", "Cp", "OCH3", "C2H5", "Fe", "Np", "Ac", "*", "D", "T", "13C", "¹⁸O", "Ala", "D-Ala", "Gly", "R", "ALK", "NO2"]) {
  assert.ok(reservedSpelling(s), s);
  const { nicknames, errors } = read([{ label: s, smiles: "*OC" }, { label: "Fine", smiles: "*OC", aliases: [s] }]);
  assert.equal(nicknames.length, 0, s);
  assert.ok(errors.length === 2 && errors.every((e) => e.includes("means an element")), `${s}: ${errors}`);
}
assert.ok(!reservedSpelling("TBS") && !reservedSpelling("Bpin") && !reservedSpelling("Mine"));
// Isotope groups load only with contract false and keep their formula (D as H, as ReShiki writes it).
for (const [smiles, formula] of [["*C([2H])([2H])[2H]", "CH3"], ["*OC([2H])([2H])[2H]", "CH3O"], ["*O[2H]", "HO"]]) {
  const { nicknames, errors } = read([{ label: "Heavy", smiles, formula, contract: false }]);
  assert.deepEqual(errors, []);
  assert.equal(nicknames[0].formula, formula);
}
assert.equal(nicknameFormula("[N+](C)(C)C"), "C3H9N+");
console.log("nicknames.check: a nicknames file read, reserved spellings ok");

// The user's nicknames come first and keep Octet's order (ReShiki's user_groups_win_label_clashes and
// reverse_spellings_follow_labels_and_aliases): a user TBS takes the place of Octet's, a user alias TBDMS wins over
// Octet's; a user label MeO wins over Octet's reverse spelling; Octet's label TBS wins over a user reverse spelling;
// a user reverse spelling TBSO wins over Octet's.
{
  const { nicknames, errors } = read([{ label: "TBS", smiles: "*[Si](CC)(CC)CC" }, { label: "Mine", smiles: "*CC(F)(F)F", aliases: ["TBDMS"] }]);
  assert.deepEqual(errors, []);
  nick.setUserNicknames(nicknames);
  assert.equal(nick.allNicknames().length, BUNDLED.length + 1);
  assert.equal(nick.allNicknames().findIndex((e) => e.label === "TBS"), BUNDLED.findIndex((e) => e.label === "TBS"));
  assert.equal(nick.allNicknames().at(-1)!.label, "Mine");
  assert.ok(nick.lookupNickname("TBS")!.entry.user);
  assert.equal(nick.lookupNickname("TBDMS")!.entry.label, "Mine");
  // A user's nickname is read first, also over Octet's own groups, and the drawing reads it at once.
  assert.equal(labelSmiles("TBS"), "[Si](CC)(CC)CC");
  assert.equal(groupFormula(typed("TBS"))?.formula, "C6H15Si");
  assert.equal(groupFormula(typed("Mine"))?.formula, "C2H2F3");
  const second = read([{ label: "MeO", smiles: "*CF" }, { label: "Mine", reverse: "TBS", smiles: "*CCl" }, { label: "Yours", reverse: "TBSO", smiles: "*CBr" }]);
  assert.deepEqual(second.errors, []);
  nick.setUserNicknames(second.nicknames);
  assert.ok(nick.lookupNickname("MeO")!.entry.user && nick.lookupNickname("MeO")!.spelling === "label");
  assert.ok(!nick.lookupNickname("TBS")!.entry.user);
  assert.deepEqual([nick.lookupNickname("TBSO")!.entry.label, nick.lookupNickname("TBSO")!.spelling], ["Yours", "reverse"]);
  assert.equal(labelSmiles("TBS"), GROUPS.TBS, "back to Octet's TBS");
  assert.equal(groupFormula(typed("MeO"))?.formula, "CH2F");
  nick.setUserNicknames([]);
  assert.equal(groupFormula(typed("MeO"))?.formula, "CH3O");
  assert.equal(lookupNickname("Mine"), undefined);
}
console.log("nicknames.check: the user's nicknames first ok");

// Define Nickname from the selection (ReShiki's define tests). CH3–O–C(=O)–C(CH3)3 with the methyl outside: the group is
// pivaloyloxy, its SMILES from the O, its formula C5H9O2.
const pivalate = (): Mol => ({
  atoms: [[0, 0], [1, 0], [2, 0], [2, 1], [3, 0], [4, 0], [3, 1], [3, -1]].map(([x, y], k) => ({ label: k === 1 || k === 3 ? "O" : "C", location: [x, y, 0] as [number, number, number] })),
  bonds: [[0, 1, 1], [1, 2, 1], [2, 3, 2], [2, 4, 1], [4, 5, 1], [4, 6, 1], [4, 7, 1]].map(([a, b, t]) => ({ type: t, atoms: [a, b] as [number, number] })),
});
{
  const m = pivalate(), members = new Set([1, 2, 3, 4, 5, 6, 7]);
  const d = nicknameFromSelection(m, members, " OPv ", "PvO");
  assert.ok(typeof d !== "string", String(d));
  assert.deepEqual([d.entry.label, d.entry.reverse, d.entry.formula, d.entry.category, d.keep], ["OPv", "PvO", "C5H9O2", "user", 1]);
  assert.ok(d.entry.smiles.startsWith("O"), d.entry.smiles);
  assert.equal(inchi(d.entry.smiles), inchi("OC(=O)C(C)(C)C"));
  assert.deepEqual(d.group.sort(), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(checkNickname(d.entry), undefined);
  // Contracted to the label (as Define Nickname does once it is saved), the drawing keeps its formula.
  nick.setUserNicknames([d.entry]);
  const c = contractLabel(m, d.keep, new Set(d.group), "OPv");
  assert.equal(c.atoms.length, 2);
  assert.equal(chem.analyse(chem.expandLabels(c))?.[0].formula, chem.analyse(m)?.[0].formula);
  assert.equal(labelSmiles("PvO"), d.entry.smiles, "its reverse spelling reads too");
  // Saved in the settings and in a file, it reads back the same.
  const back = nick.readNicknamesFile(nick.nicknamesFile([d.entry]), checkNickname);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.nicknames, [d.entry]);
  assert.deepEqual(nick.readNicknameList(JSON.parse(JSON.stringify([d.entry]))), [d.entry]);
  assert.deepEqual(nick.readNicknameList([{ label: "x y", smiles: "C" }, { smiles: "C" }, 5]), []);
  // CDXML: a user nickname is written with its atoms, so ChemDraw and another Octet read the structure.
  const expand = (t: string) => { const s = labelSmiles(t); return s ? chem.labelFragment(s) : undefined; };
  const x = toCdxml(c, DEFAULT_STYLE, { expand });
  assert.ok(x.includes(`NodeType="Fragment"`));
  nick.setUserNicknames([]);
}
// A selected attachment point on one single bond is where the group joins.
{
  const m: Mol = { atoms: [{ label: "C", location: [0, 0, 0], attach: true }, { label: "C", location: [1, 0, 0] }, { label: "F", location: [2, 0, 0] }], bonds: [{ type: 1, atoms: [0, 1] }, { type: 1, atoms: [1, 2] }] };
  const d = nicknameFromSelection(m, new Set([0, 1, 2]), "CH2F2x");
  assert.ok(typeof d !== "string", String(d));
  assert.equal(d.entry.formula, "CH2F");
  assert.deepEqual(d.group.sort(), [1, 2]);
}
// Refused: two bonds out, no bond out, nothing selected, a bad label, a double bond out, a wavy bond, a wedge, a label
// Octet cannot read, a spelling that is an element.
{
  const m = pivalate(), members = [1, 2, 3, 4, 5, 6, 7];
  for (const [ids, label] of [[[1, 2], "X1"], [[0, ...members], "X1"], [[], "X1"]] as const) assert.equal(typeof nicknameFromSelection(m, new Set(ids), label), "string");
  assert.match(nicknameFromSelection(m, new Set(members), "two words") as string, /no spaces/);
  assert.match(nicknameFromSelection(m, new Set(members), "Fe") as string, /means an element/);
  const dbl: Mol = { ...m, bonds: m.bonds.map((b, k) => (k === 0 ? { ...b, type: 2 } : b)) };
  assert.match(nicknameFromSelection(dbl, new Set(members), "X1") as string, /one single bond/);
  const wavy: Mol = { ...m, bonds: m.bonds.map((b, k) => (k === 5 ? { ...b, display: "wavy" as const } : b)) };
  assert.match(nicknameFromSelection(wavy, new Set(members), "OPv") as string, /stereochemistry/);
  const wedge: Mol = { ...m, bonds: m.bonds.map((b, k) => (k === 5 ? { ...b, stereo: 1 } : b)) };
  assert.match(nicknameFromSelection(wedge, new Set(members), "OPv") as string, /stereochemistry/);
  const unknown: Mol = { ...m, atoms: m.atoms.map((a, k) => (k === 5 ? { ...a, text: "Qzx" } : a)) };
  assert.match(nicknameFromSelection(unknown, new Set(members), "OPv") as string, /cannot read a label/);
  // A label inside the group is drawn out: OMe in place of a methyl gives the group's full formula.
  const labelled: Mol = { ...m, atoms: m.atoms.map((a, k) => (k === 5 ? { ...a, text: "OMe", label: "O" } : a)) };
  const d = nicknameFromSelection(labelled, new Set(members), "OPvOMe");
  assert.ok(typeof d !== "string", String(d));
  assert.equal(d.entry.formula, "C5H9O3");
  // A ring keeps its bonds: 4-fluorophenyl from a drawn ring.
  const ring = chem.parseStructure("Cc1ccc(F)cc1");
  const r = nicknameFromSelection(ring, new Set(ring.atoms.map((_, i) => i).filter((i) => i)), "FPh4");
  assert.ok(typeof r !== "string", String(r));
  assert.equal(inchi(r.entry.smiles), inchi("c1ccc(F)cc1"));
  assert.equal(r.entry.formula, "C6H4F");
  // E/Z drawn on a double bond is refused, as the nickname keeps no stereochemistry.
  const ez = chem.parseStructure("C/C=C/CC");
  assert.match(String(nicknameFromSelection(ez, new Set([0, 1, 2, 3]), "Pent")), /stereochemistry/);
}
// Changes to the list: added, replaced by label, removed, merged from a file (the user's own kept).
{
  const a = { label: "A1", smiles: "C", formula: "CH3", category: "user", names: [] }, b = { ...a, label: "B1", smiles: "CC", formula: "C2H5" };
  let list = nick.withNickname([], a);
  list = nick.withNickname(list, b);
  list = nick.withNickname(list, { ...a, smiles: "CCC", formula: "C3H7" });
  assert.deepEqual(list.map((e) => [e.label, e.smiles]), [["A1", "CCC"], ["B1", "CC"]]);
  assert.deepEqual(nick.withoutNickname(list, "A1").map((e) => e.label), ["B1"]);
  const merged = nick.mergeNicknames(list, [{ ...a, smiles: "N", formula: "H2N" }, { ...a, label: "C1" }]);
  assert.deepEqual([merged.added, merged.kept, merged.list.map((e) => e.label).join()], [1, 1, "A1,B1,C1"]);
  assert.equal(merged.list[0].smiles, "CCC");
  // The file has one group a line, as ReShiki writes it, with ReShiki's "*".
  const text = nick.nicknamesFile(list);
  assert.equal(text.split("\n").filter(Boolean).length, 7);
  assert.ok(text.includes(`"smiles":"*CCC"`));
}
console.log("nicknames.check: Define Nickname, the list and the file ok");
