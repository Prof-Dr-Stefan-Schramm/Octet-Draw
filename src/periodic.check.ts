// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), src/app/palettes.rs (the atom palette's layout), MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// Run: node src/periodic.check.ts. Fails loudly if the periodic table window (issue 71) loses an element, puts one in the
// wrong place, names it wrongly, stops moving with the keys, or stops setting atoms; and if the ways to open it go.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cellOf, elementInfo, findSymbol, PERIODIC_ROWS, ROW_NAMES, step } from "./periodic.ts";
import { ELEMENTS as SYMBOLS } from "./labels.ts";
import { ELEMENTS as NAMES } from "./metals.ts";
import { elementAt, keyElement } from "./edit.ts";
import type { Mol } from "./render.ts";

// The layout: 9 rows of 18, 118 different elements, each one Octet knows as a symbol and by name.
assert.equal(PERIODIC_ROWS.length, 9);
assert.equal(ROW_NAMES.length, 9);
for (const row of PERIODIC_ROWS) assert.equal(row.length, 18);
const all = PERIODIC_ROWS.flat().filter(Boolean);
assert.equal(all.length, 118);
assert.equal(new Set(all).size, 118);
for (const s of all) {
  assert.ok(SYMBOLS.has(s), s);
  assert.ok(NAMES.has(s), s);
}
assert.ok(!all.includes("D") && !all.includes("T"), "isotopes are not elements of the table");
// Each element in its period and group: the main table's cells read in order give atomic numbers 1-118, with the
// f-block rows put in after La and Ac.
const order: string[] = [];
for (let r = 0; r < 7; r++) for (const s of PERIODIC_ROWS[r]) if (s) { order.push(s); if (s === "La") order.push(...PERIODIC_ROWS[7].filter(Boolean)); if (s === "Ac") order.push(...PERIODIC_ROWS[8].filter(Boolean)); }
order.forEach((s, k) => assert.equal(elementInfo(s)?.number, k + 1, s));
assert.deepEqual(cellOf("Fe"), [3, 7], "iron: period 4, group 8");
assert.deepEqual(cellOf("La"), [5, 2], "La in group 3, as ReShiki and ChemDraw");
assert.deepEqual(cellOf("Lu"), [7, 15]);
assert.deepEqual(cellOf("Og"), [6, 17]);

// What the window says: British and IUPAC names, and the mean atomic mass from Octet's isotope table.
assert.equal(elementInfo("Al")?.name, "aluminium");
assert.equal(elementInfo("Cs")?.name, "caesium");
assert.equal(elementInfo("S")?.name, "sulfur");
assert.equal(elementInfo("Fe")?.mass?.toFixed(3), "55.845");
assert.equal(elementInfo("C")?.mass?.toFixed(2), "12.01");
assert.equal(elementInfo("Tc")?.mass, undefined, "no mean mass for an element with no natural isotopes");
assert.equal(elementInfo("Xx"), undefined);

// Keys: along the period, and up and down the group, over gaps, into and out of the f-block rows; stops at an edge.
const at = (s: string) => cellOf(s)!, sym = (c: [number, number]) => PERIODIC_ROWS[c[0]][c[1]];
assert.equal(sym(step(at("H"), "ArrowRight")), "He");
assert.equal(sym(step(at("He"), "ArrowLeft")), "H");
assert.equal(sym(step(at("Be"), "ArrowRight")), "B");
assert.equal(sym(step(at("H"), "ArrowDown")), "Li");
assert.equal(sym(step(at("He"), "ArrowDown")), "Ne");
assert.equal(sym(step(at("B"), "ArrowUp")), "B", "nothing above boron");
assert.equal(sym(step(at("Sc"), "ArrowUp")), "Sc");
assert.equal(sym(step(at("Ra"), "ArrowDown")), "Ra", "nothing under radium");
assert.equal(sym(step(at("Ac"), "ArrowDown")), "Ce");
assert.equal(sym(step(at("Ce"), "ArrowDown")), "Th");
assert.equal(sym(step(at("Ce"), "ArrowUp")), "Ac");
assert.equal(sym(step(at("Lu"), "ArrowUp")), "Lv", "up from Lu to the cell above it");
assert.equal(sym(step(at("Og"), "ArrowRight")), "Og");
assert.equal(sym(step(at("Fe"), "Home")), "K");
assert.equal(sym(step(at("Fe"), "End")), "Kr");
assert.equal(sym(step(at("Nd"), "Home")), "Ce");
assert.equal(sym(step(at("Nd"), "End")), "Lu");
// Typed symbols.
assert.equal(findSymbol("fe"), "Fe");
assert.equal(findSymbol("C"), "C");
assert.equal(findSymbol("cl"), "Cl");
assert.equal(findSymbol("z"), "Zn");
assert.equal(findSymbol("q"), undefined);

// Setting atoms: ethanol's O to sulfur, a carbon shown (as an element key does), Ac is actinium (not acetyl), and with
// the Text tool, empty space gets a lone atom with its label shown. Nothing but the usual atom fields, so .oct, CDXML,
// copy and Undo treat it as any atom.
const ethanol: Mol = { atoms: [{ label: "C", location: [0, 0, 0] }, { label: "C", location: [0.866, 0.5, 0] }, { label: "O", location: [1.732, 0, 0] }], bonds: [{ type: 1, atoms: [0, 1] }, { type: 1, atoms: [1, 2] }] } as Mol;
assert.equal(keyElement(ethanol, 2, "S").atoms[2].label, "S");
assert.equal(keyElement(ethanol, 2, "Ac").atoms[2].label, "Ac");
assert.equal(keyElement(ethanol, 0, "C").atoms[0].shown, true);
{
  const [m, i] = elementAt(ethanol, [5, 5], "Fe");
  assert.equal(i, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(m.atoms[3])), { label: "Fe", location: [5, 5, 0] });
  assert.equal(m.bonds.length, 2);
  const [onAtom, j] = elementAt(ethanol, [1.75, 0.02], "Se");
  assert.equal(j, 2, "a click on an atom changes it");
  assert.equal(onAtom.atoms.length, 3);
  assert.equal(onAtom.atoms[2].label, "Se");
  assert.equal(elementAt(ethanol, [5, 5], "C")[0].atoms[3].shown, true, "a lone carbon shows as CH4");
}

// Wiring: View menu, command palette, the Actions panel's element chips; the editor sets the selected atoms in one step,
// else the Text tool holds the element; the element is let go when the window closes or the tool changes.
const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
const editor = src("Editor.tsx"), table = src("PeriodicTable.tsx"), mainRs = src("../src-tauri/src/main.rs");
assert.match(mainRs, /&item\("periodic_table", "Show or Hide Periodic Table", ""\)\?/);
assert.match(editor, /periodic_table: \(\) => setPeriodic\(\(o\) => !o\)/);
assert.match(editor, /periodic_table: \[periodic \? "Hide periodic table" : "Periodic table"/);
assert.match(src("Actions.tsx"), /onClick=\{\(\) => run\("periodic_table"\)\}/);
assert.match(editor, /set\(atoms\.reduce\(\(m, i\) => keyElement\(m, i, symbol\), doc\), true\)/);
assert.match(editor, /if \(!periodic \|\| tool !== "text"\) setHeldElement\(undefined\)/);
assert.match(editor, /if \(tool === "text" && heldElement && t\.caption === undefined\)/);
// Screen reader and keyboard: a named dialog, a named group per row, each element by name and number, its pressed state,
// one button in the tab order, a live status line; Escape closes.
assert.match(table, /role="dialog" aria-label="Periodic table"/);
assert.match(table, /role="group" aria-label=\{ROW_NAMES\[r\]\}/);
assert.match(table, /aria-label=\{`\$\{capital\(el\.name\)\}, \$\{el\.number\}`\}/);
assert.match(table, /aria-pressed=\{symbol === current\}/);
assert.match(table, /tabIndex=\{on \? 0 : -1\}/);
assert.match(table, /role="status"/);
assert.match(table, /if \(e\.key !== "Escape"/);
// Licence: no Jmol colour table (the window has no element colours).
assert.doesNotMatch(table + src("periodic.ts"), /jmol/i);

console.log("periodic: ok");
