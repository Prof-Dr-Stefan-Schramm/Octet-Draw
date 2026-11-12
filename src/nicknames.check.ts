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
