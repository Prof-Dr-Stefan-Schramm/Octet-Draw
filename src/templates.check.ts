// Run: node src/templates.check.ts. The user's own templates (templates.ts): adding a selection to My templates or
// to a set, naming, renaming, moving, removing, the sets themselves, built-in templates kept apart, a built-in copied
// into My templates, and every kind of structure coming back whole from the settings.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { addCaption, extractSelection } from "./edit.ts";
import type { Atom, Bond, Mol } from "./render.ts";
import { addSet, addSetOf, addTo, changePalette, closePalette, duplicateTemplate, freeSetName, loadTemplates, MOST_PALETTES, moveTemplate, MY_SET, newTemplate, openPalette, ownId, PALETTE_COLUMNS, placeTemplate,
  readPalettes, readSize, removeSet, removeTemplate, renameSet, renameTemplate, TEMPLATE_SIZES, templateKind, templateToEnd, templateToStart, updateTemplate, legible, type Kept, type TemplateSize } from "./templates.ts";

const atom = (label: string, x: number, y: number, more: Partial<Atom> = {}): Atom => ({ label, location: [x, y, 0], ...more });
const bond = (a: number, b: number, type = 1, more: Partial<Bond> = {}): Bond => ({ atoms: [a, b], type, ...more });
// A drawing with every kind of structure a template can hold: a ring with a heteroatom label, a chain with a charge
// and a wedge, and a second fragment (a counter-ion) with a caption under it.
const ring: Mol = { atoms: [0, 1, 2, 3, 4].map((k) => atom(k ? "C" : "O", Math.cos((2 * Math.PI * k) / 5), Math.sin((2 * Math.PI * k) / 5))), bonds: [bond(0, 1), bond(1, 2, 2), bond(2, 3), bond(3, 4, 2), bond(4, 0)] };
const drawing: Mol = (() => {
  const m: Mol = {
    atoms: [...ring.atoms, atom("C", 3, 0), atom("C", 4, 0.5), atom("N", 5, 0, { charge: 1, text: "NH3" }), atom("Cl", 7, 0, { charge: -1 })],
    bonds: [...ring.bonds, bond(5, 6, 1, { stereo: 1 }), bond(6, 7)],
  };
  return addCaption(m, { text: "salt", x: 7, y: -1, under: [8] })[0];
})();
const all = new Set(drawing.atoms.map((_, i) => i));
const empty: Kept = { templates: [], templateSets: [] };

// Adding: a selection goes into My templates, with its name ready to change, and every part of it comes back from the
// settings (which keep JSON).
const whole = extractSelection(drawing, all, new Set(drawing.captions!.map((c) => c.id)));
let s = addTo(empty, newTemplate("  Template 1  ", whole));
assert.equal(s.templates.length, 1);
assert.equal(s.templates[0].name, "Template 1", "the name is trimmed");
assert.equal(s.templates[0].set, undefined, "no set is My templates");
const back = (k: Kept) => loadTemplates(JSON.parse(JSON.stringify(k.templates)));
const t = back(s)[0];
assert.equal(t.mol.atoms.length, drawing.atoms.length);
assert.equal(t.mol.bonds.length, drawing.bonds.length);
assert.deepEqual(t.mol.atoms.map((a) => [a.label, a.charge ?? 0]), drawing.atoms.map((a) => [a.label, a.charge ?? 0]), "labels and charges stay");
assert.equal(t.mol.bonds.find((b) => b.stereo)?.stereo, 1, "the wedge stays");
assert.equal(t.mol.atoms[7].text, "NH3", "a typed label stays");
assert.equal(t.mol.captions?.[0]?.text, "salt", "a caption under the structure stays");
assert.equal(new Set(t.mol.bonds.flatMap((b) => b.atoms)).size, drawing.atoms.length - 1, "two fragments: the chloride has no bond");

// Each kind on its own: a ring, a chain, one charged atom.
for (const part of [new Set([0, 1, 2, 3, 4]), new Set([5, 6, 7]), new Set([8])]) {
  const one = extractSelection(drawing, part, new Set());
  const got = back(addTo(empty, newTemplate("Part", one)))[0];
  assert.equal(got.mol.atoms.length, part.size);
  assert.equal(got.mol.bonds.length, one.bonds.length);
}

// A set: added, and a template added to it. A set that does not exist (or My templates) is My templates.
s = addSet(s, " Mine ");
assert.deepEqual(s.templateSets, ["Mine"]);
assert.equal(addSet(s, "Mine"), s, "the same name twice is one set");
assert.equal(addSet(s, MY_SET), s, "My templates is not a set of its own");
assert.equal(addSet(s, "   "), s, "a set needs a name");
assert.equal(freeSetName(s, "mine2"), true);
assert.equal(freeSetName(s, "Mine"), false);
s = addTo(s, newTemplate("Furan", extractSelection(drawing, new Set([0, 1, 2, 3, 4]), new Set())), "Mine");
assert.equal(s.templates[1].set, "Mine");
assert.equal(addTo(empty, newTemplate("X", ring), "Nowhere").templates[0].set, undefined);
assert.equal(addTo(empty, newTemplate("X", ring, "Mine"), MY_SET).templates[0].set, undefined, "addTo decides the set");
assert.equal(back(s)[1].set, "Mine", "the set is kept in the settings");

// Naming: a new name is trimmed, at most 80 characters; an empty one keeps the old name.
const id = s.templates[1].id;
s = renameTemplate(s, id, " Furan ring ");
assert.equal(s.templates[1].name, "Furan ring");
assert.equal(renameTemplate(s, id, "  "), s);
assert.equal(renameTemplate(s, id, "x".repeat(100)).templates[1].name.length, 80);
assert.equal(renameTemplate(s, "lib:Furan", "Mine"), s, "a built-in template has no id here");

// Moving: to My templates and back to a set.
s = moveTemplate(s, id, MY_SET);
assert.equal(s.templates[1].set, undefined);
s = moveTemplate(s, id, "Mine");
assert.equal(s.templates[1].set, "Mine");
assert.equal(moveTemplate(s, id, "Nowhere").templates[1].set, undefined, "a set that does not exist is My templates");

// A set renamed takes its templates; a set removed gives them to My templates.
s = renameSet(s, "Mine", "Heterocycles of mine");
assert.deepEqual(s.templateSets, ["Heterocycles of mine"]);
assert.equal(s.templates[1].set, "Heterocycles of mine");
assert.equal(renameSet(s, "Heterocycles of mine", MY_SET), s);
const two = addSet(s, "Other");
assert.equal(renameSet(two, "Other", "Heterocycles of mine"), two, "two sets cannot share a name");
s = removeSet(s, "Heterocycles of mine");
assert.deepEqual(s.templateSets, []);
assert.equal(s.templates[1].set, undefined);

// Removing a template.
s = removeTemplate(s, id);
assert.equal(s.templates.length, 1);
assert.equal(back(s).length, 1);

// Built-in templates are not the user's: only custom: kinds have an id, so they cannot be renamed, moved or removed.
assert.equal(ownId("lib:Alanine"), undefined);
assert.equal(ownId(templateKind("abc")), "abc");

// A built-in template copied into My templates is the user's own, with the built-in's name and structure.
type Raw = { name: string; items: { name: string; atoms: (string | number)[][]; bonds: number[][] }[] }[];
const lib: Raw = JSON.parse(readFileSync(new URL("./library.json", import.meta.url), "utf8"));
const furan = lib.flatMap((c) => c.items).find((x) => x.name === "Furan")!;
const furanMol: Mol = { atoms: furan.atoms.map(([l, x, y]) => atom(l as string, x as number, y as number)), bonds: furan.bonds.map(([a, b, type]) => bond(a, b, type)) };
const copied = addTo(empty, newTemplate(furan.name, furanMol));
const own = back(copied)[0];
assert.equal(own.name, "Furan");
assert.equal(own.mol.atoms.length, furan.atoms.length);
assert.ok(ownId(templateKind(own.id)), "the copy has an id of its own");

// The settings' list: anything that is not a template is dropped, and so is a template with nothing in it.
assert.deepEqual(loadTemplates([null, 3, { id: "a", name: "b", file: "not a file" }]), []);
assert.deepEqual(loadTemplates("nothing"), []);

console.log("templates: ok");

// ——— Order, Edit and Duplicate (CD-32) ———
// Five templates: A, B and C in a set, D and E in My templates, mixed in the list as they were added.
let o: Kept = addSet(empty, "Rings");
const made: Record<string, string> = {};
for (const [name, set] of [["A", "Rings"], ["D", MY_SET], ["B", "Rings"], ["E", MY_SET], ["C", "Rings"]]) {
  const t = newTemplate(name, ring);
  made[name] = t.id;
  o = addTo(o, t, set);
}
const order = (k: Kept, set?: string) => k.templates.filter((t) => t.set === set).map((t) => t.name).join("");
assert.equal(order(o, "Rings"), "ABC");
assert.equal(order(o), "DE");
// Dragged before another template of its set; dragged to the end; Move to start and Move to end.
o = placeTemplate(o, made.C, made.A);
assert.equal(order(o, "Rings"), "CAB");
assert.equal(order(o), "DE", "the other set keeps its order");
o = placeTemplate(o, made.C);
assert.equal(order(o, "Rings"), "ABC");
o = templateToStart(o, made.B);
assert.equal(order(o, "Rings"), "BAC");
o = templateToEnd(o, made.B);
assert.equal(order(o, "Rings"), "ACB");
assert.equal(templateToStart(o, made.A), o, "the first stays first, and nothing changes");
assert.equal(templateToEnd(o, made.B), o, "the last stays last");
assert.equal(placeTemplate(o, made.A, made.D), o, "a template goes before one of its own set only");
assert.equal(placeTemplate(o, "nobody", made.A), o);
assert.deepEqual(back(o).filter((t) => t.set === "Rings").map((t) => t.name), ["A", "C", "B"], "the order is kept in the settings");
// A template moved to another set goes at its end.
o = moveTemplate(o, made.A, MY_SET);
assert.equal(order(o), "DEA");
o = moveTemplate(o, made.A, "Rings");
assert.equal(order(o, "Rings"), "CBA");

// Edit, then Save: the template's drawing changes; its id, name, set and place stay. An empty drawing changes nothing.
const chain: Mol = { atoms: [atom("C", 0, 0), atom("C", 0.87, 0.5), atom("N", 1.73, 0)], bonds: [bond(0, 1), bond(1, 2, 3)] };
const before = o.templates.map((t) => t.id);
const edited = updateTemplate(o, made.C, chain);
assert.deepEqual(edited.templates.map((t) => t.id), before);
const c = back(edited).find((t) => t.id === made.C)!;
assert.equal(c.name, "C");
assert.equal(c.set, "Rings");
assert.deepEqual(c.mol.atoms.map((a) => a.label), ["C", "C", "N"]);
assert.equal(c.mol.bonds[1].type, 3);
assert.equal(updateTemplate(o, made.C, { atoms: [], bonds: [] }), o, "an empty drawing does not replace a template");
assert.equal(updateTemplate(o, "nobody", chain), o);
// A drawing edited at another size and place is kept at bond length 1, centred, as every template is.
const big: Mol = { atoms: chain.atoms.map((a) => ({ ...a, location: [a.location[0] * 3 + 40, a.location[1] * 3 - 7, 0] as [number, number, number] })), bonds: chain.bonds };
const norm = back(updateTemplate(o, made.C, big)).find((t) => t.id === made.C)!.mol;
assert.ok(Math.abs(Math.hypot(norm.atoms[1].location[0] - norm.atoms[0].location[0], norm.atoms[1].location[1] - norm.atoms[0].location[1]) - 1) < 1e-3, "bond length 1");
assert.ok(Math.abs(Math.min(...norm.atoms.map((a) => a.location[0])) + Math.max(...norm.atoms.map((a) => a.location[0]))) < 1e-3, "centred");
// The same file text gives the same structure, so a thumbnail is drawn once; an edited template is a new structure.
assert.equal(back(o).find((t) => t.id === made.B)!.mol, back(o).find((t) => t.id === made.B)!.mol);
assert.notEqual(back(edited).find((t) => t.id === made.C)!.mol, back(o).find((t) => t.id === made.C)!.mol);
// Duplicate: a copy just after the template, in its set, with an id of its own.
const dup = duplicateTemplate(o, made.B);
assert.equal(dup.templates.filter((t) => t.set === "Rings").map((t) => t.name).join(","), "C,B,B copy,A");
const copy = dup.templates.find((t) => t.name === "B copy")!;
assert.notEqual(copy.id, made.B);
assert.equal(copy.set, "Rings");
assert.equal(duplicateTemplate(o, "nobody"), o);
console.log("templates: order, Edit and Duplicate ok");

// ——— Floating palettes ———
// Opened, brought to the front, moved, made wider, closed; kept in the settings (JSON) and read back with checks.
let pals = openPalette([], "Aromatics", "template");
assert.deepEqual(pals, [{ set: "Aromatics", tool: "template", x: 80, y: 96, columns: PALETTE_COLUMNS, size: "medium" }]);
pals = openPalette(pals, "Rings", "ring");
assert.deepEqual(pals.map((p) => [p.set, p.x, p.y]), [["Aromatics", 80, 96], ["Rings", 104, 120]], "a new palette opens down and right of the last");
pals = openPalette(pals, "Aromatics", "template");
assert.deepEqual(pals.map((p) => p.set), ["Rings", "Aromatics"], "opened again: to the front, not twice");
pals = changePalette(pals, "Rings", { x: 900.4, y: -50, columns: 20 });
assert.deepEqual(pals[0], { set: "Rings", tool: "ring", x: 900, y: 0, columns: 8, size: "medium" }, "moved, kept on the screen and in Octet's limits");
const keptPals = readPalettes(JSON.parse(JSON.stringify(pals)));
assert.deepEqual(keptPals, pals, "the palettes and their places come back after a launch");
assert.deepEqual(readPalettes([null, 4, { set: "" }, { set: "X", tool: "pen", x: "1" }, { set: "X" }]), [{ set: "X", tool: "template", x: 80, y: 96, columns: PALETTE_COLUMNS, size: "medium" }], "damaged entries are dropped or mended");
// The template size: each palette has its own (medium when it opens), changed and kept in the settings, so it comes back
// after a launch; a size Octet does not have reads as medium. The library's size (Settings.librarySize) reads the same way.
const sized = changePalette(pals, "Aromatics", { size: "large" });
assert.deepEqual(sized.map((p) => [p.set, p.size, p.columns]), [["Rings", "medium", 8], ["Aromatics", "large", PALETTE_COLUMNS]], "each palette its own size; the columns stay");
assert.deepEqual(readPalettes(JSON.parse(JSON.stringify(sized))), sized, "sizes come back after a launch");
assert.deepEqual(changePalette(sized, "Rings", { size: "small" }).map((p) => p.size), ["small", "large"]);
assert.equal(changePalette(sized, "Rings", { size: "huge" as TemplateSize })[0].size, "medium", "a size Octet does not have is mended");
assert.deepEqual(readPalettes([{ set: "A", size: "huge" }, { set: "B", size: 3 }, { set: "C", size: "small" }, { set: "D", size: "large" }]).map((p) => p.size), ["medium", "medium", "small", "large"]);
assert.deepEqual(TEMPLATE_SIZES.map(readSize), TEMPLATE_SIZES);
assert.deepEqual([undefined, null, "Large", 2, {}].map(readSize), ["medium", "medium", "medium", "medium", "medium"], "damaged library sizes read as medium");
assert.equal(readPalettes(Array.from({ length: 40 }, (_, k) => ({ set: `S${k}` }))).length, MOST_PALETTES);
assert.deepEqual(closePalette(pals, "Rings").map((p) => p.set), ["Aromatics"]);
// A set of the user's renamed takes its palette with it; removed, its palette closes.
let withPal: Kept = { ...addSet(empty, "Rings"), palettes: pals };
withPal = renameSet(withPal, "Rings", "My rings");
assert.deepEqual(withPal.palettes!.map((p) => p.set), ["My rings", "Aromatics"]);
withPal = removeSet(withPal, "My rings");
assert.deepEqual(withPal.palettes!.map((p) => p.set), ["Aromatics"]);
console.log("templates: floating palettes and template sizes ok");

// ——— ChemDraw template files (.ctp, .cts) ———
// A small template document made here with Octet's own writer (nothing from ChemDraw): a 2 × 3 grid of panes, five
// with structures (two named by a Name annotation, as ChemDraw's Annotate keeps it) and one empty, as CDX and as CDXML.
const { readTemplateFile, isTemplateFile, MOST_PANES, NOT_TEMPLATES } = await import("./ctp.ts");
const { toCdxml, parseXml } = await import("./cdxml.ts");
const { xmlToCdx, toBase64 } = await import("./cdx.ts");
const { DEFAULT_STYLE } = await import("./docstyle.ts");
type X = ReturnType<typeof parseXml>;
const docOf = (m: Mol) => parseXml(toCdxml(m, DEFAULT_STYLE));
const note = (content: string): X => ({ name: "annotation", attrs: { Keyword: "Name", Content: content }, kids: [], text: "" });
const pagesOf = (m: Mol) => docOf(m).kids.filter((k) => k.name === "page");
const panes = [ring, chain, { atoms: [atom("O", 0, 0)], bonds: [] }, undefined, ring, chain];
const names = ["Furan", undefined, "Water\u0007 \n  drop", undefined, undefined, undefined];
const templateDoc = (count = panes.length): X => {
  const head = docOf(ring);
  const pages = Array.from({ length: count }, (_, k) => {
    const m = panes[k % panes.length], page = m ? pagesOf(m)[0] : { name: "page", attrs: {}, kids: [], text: "" };
    return names[k] ? { ...page, kids: [...page.kids, note(names[k]!)] } : page;
  });
  return { ...head, kids: [...head.kids.filter((k) => k.name !== "page"), { name: "templategrid", attrs: { NumRows: "2", NumColumns: "3", extent: "2.75 2.75" }, kids: [], text: "" }, ...pages] };
};
const bytes = xmlToCdx(templateDoc());
for (const [what, file] of [["CDX bytes", bytes], ["CDX in base64, as the app reads it", toBase64(bytes)]] as const) {
  const r = readTemplateFile(file, "My rings.ctp");
  assert.equal(r.set, "My rings", what);
  assert.deepEqual(r.templates.map((t) => t.name), ["Furan", "Template 2", "Water drop", "Template 4", "Template 5"], `${what}: names from annotations, else the place in the set; the empty pane left out`);
  assert.deepEqual(r.templates.map((t) => t.mol.atoms.map((a) => a.label).join("")), ["OCCCC", "CCN", "O", "OCCCC", "CCN"], `${what}: each pane's structure, in order`);
  assert.equal(r.templates[0].mol.bonds.filter((b) => b.type === 2).length, 2, `${what}: bond orders`);
  assert.equal(r.left, 0);
  assert.ok(!r.templates.some((t) => t.mol.annotations?.some((a) => a.keyword === "Name")), "the Name annotation is the template's name, not kept in it");
}
// As CDXML text, and as a set of the user's: a new set named after the file, with a number when the name is taken.
const asXml = (x: X): string => `<${x.name}${Object.entries(x.attrs).map(([k, v]) => ` ${k}="${String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`).join("")}>${x.kids.map(asXml).join("")}${x.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</${x.name}>`;
const fromText = readTemplateFile(`<?xml version="1.0"?>\n${asXml(templateDoc())}`, "Rings.CTS");
assert.equal(fromText.set, "Rings");
assert.equal(fromText.templates.length, 5, "CDXML text reads as CDX does");
let sets: Kept = addSet(empty, "Rings");
const { kept: withFile, set: madeSet } = addSetOf(sets, fromText.set, fromText.templates);
assert.equal(madeSet, "Rings 2");
assert.deepEqual(withFile.templateSets, ["Rings", "Rings 2"]);
assert.deepEqual(back(withFile).filter((t) => t.set === "Rings 2").map((t) => t.name), ["Furan", "Template 2", "Water drop", "Template 4", "Template 5"]);
sets = { ...sets, templateSets: Array.from({ length: 50 }, (_, k) => `S${k}`) };
assert.equal(addSetOf(sets, "One more", fromText.templates).set, undefined, "no set past Octet's 50");
// Hostile files: not a template file, damaged, cut short, too many panes, a pane too big.
assert.ok(isTemplateFile("a.ctp") && isTemplateFile("New Templates.CTS") && !isTemplateFile("a.cdx"));
assert.throws(() => readTemplateFile(xmlToCdx(docOf(ring)), "plain.ctp"), { message: NOT_TEMPLATES }, "a drawing with no template grid");
assert.throws(() => readTemplateFile(bytes.subarray(0, bytes.length - 40), "cut.ctp"), "a file cut short");
assert.throws(() => readTemplateFile(new Uint8Array([1, 2, 3]), "junk.ctp"));
assert.throws(() => readTemplateFile("<CDXML><page>", "junk.ctp"));
const many = readTemplateFile(xmlToCdx(templateDoc(MOST_PANES + 30)), "Many.ctp");
assert.equal(many.templates.length, Math.round((MOST_PANES * 5) / 6), "at most MOST_PANES panes are read");
assert.equal(many.left, 30);
const huge: Mol = { atoms: Array.from({ length: 8000 }, (_, k) => atom("C", k % 90, Math.floor(k / 90))), bonds: [] };
const withHuge = templateDoc();
withHuge.kids.push(...pagesOf(huge));
const r2 = readTemplateFile(xmlToCdx(withHuge), "Big.ctp");
assert.equal(r2.templates.length, 5);
assert.equal(r2.left, 1, "a pane too big for a template is left out and counted");
assert.equal(readTemplateFile(xmlToCdx({ ...templateDoc(), kids: templateDoc().kids.filter((k) => k.name !== "page") }), "New Templates.cts").templates.length, 0, "blank stationery has no templates");
console.log("templates: ChemDraw template files (.ctp, .cts) ok");

// ——— A set saved as a ChemDraw template file (writeTemplateFile) ———
// CDX, as ChemDraw writes its template files: the colours and fonts, one page for each pane, row by row, then the
// TemplateGrid (no id). The grid is the columns given (no wider than the set) and as many rows as it needs; the panes
// after the last template are empty pages; the pane size is the template size's; each pane's name is its page's Name
// annotation; every object's id is its own in the document. Read back, it gives the same templates, names and order.
const { writeTemplateFile, PANE_EXTENT, MOST_TEMPLATE } = await import("./ctp.ts");
const { cdxToXml, isCdx } = await import("./cdx.ts");
const { normalise } = await import("./edit.ts");
const { serialize: write } = await import("./file.ts");
const { LIBRARY: SETS } = await import("./library.ts");
const inSet = (name: string, m: Mol) => ({ name, mol: back(addTo(empty, newTemplate(name, m)))[0].mol }); // as a set keeps it
const mine = [inSet("Salt", whole), ...fromText.templates.map((t) => inSet(t.name, t.mol)), inSet("Odd\u0007 \n name", chain)];
const saved = writeTemplateFile(mine, "Salts", 4, "large");
assert.deepEqual([saved.written, saved.left], [7, 0]);
assert.ok(isCdx(saved.bytes), "CDX, as ChemDraw writes template files");
const tree = cdxToXml(saved.bytes, true), gridOut = tree.kids.find((k) => k.name === "templategrid")!, pagesOut = tree.kids.filter((k) => k.name === "page");
assert.deepEqual(tree.kids.map((k) => k.name).filter((n, k, a) => a[k - 1] !== n), ["colortable", "fonttable", "page", "templategrid"], "ChemDraw's order");
assert.deepEqual({ ...gridOut.attrs }, { PaneHeight: String(Math.round(8.75 * 65536)), NumRows: "2", NumColumns: "4", extent: `${PANE_EXTENT.large} ${PANE_EXTENT.large}` }, "the grid, the pane size and the window; id 0");
assert.equal(pagesOut.length, 8, "rows × columns pages");
assert.deepEqual(pagesOut.map((pg) => pg.kids.find((x) => x.name === "annotation" && x.attrs.Keyword === "Name")?.attrs.Content ?? null),
  ["Salt", "Furan", "Template 2", "Water drop", "Template 4", "Template 5", "Odd name", null], "each pane's name, row by row");
assert.equal(pagesOut[7].kids.length, 0, "the pane after the last template is empty");
const idsOut: string[] = [];
const walkIds = (x: X) => { if (x.attrs.id && x.name !== "font") idsOut.push(x.attrs.id); x.kids.forEach(walkIds); };
walkIds(tree);
assert.equal(new Set(idsOut).size, idsOut.length, "every object's id is its mine in the document");
const readBack = readTemplateFile(saved.bytes, "Salts.ctp");
assert.equal(readBack.left, 0);
assert.deepEqual(readBack.templates.map((x) => x.name), ["Salt", "Furan", "Template 2", "Water drop", "Template 4", "Template 5", "Odd name"], "the same names, in order");
// The same structures: labels, typed labels, charges, wedges and bond orders, places to 0.01 of a bond length (CDX keeps
// points to 0.01 pt), and the caption under the salt.
const shape = (m: Mol) => { const n = normalise(m); return { atoms: n.atoms.map((a) => [a.label, a.text ?? "", a.charge ?? 0]), bonds: n.bonds.map((b) => [b.atoms, b.type, b.stereo ?? 0]), captions: (n.captions ?? []).map((c) => c.text) }; };
readBack.templates.forEach((x, k) => {
  assert.deepEqual(shape(x.mol), shape(mine[k].mol), `${x.name}: the same structure`);
  const a = normalise(x.mol), b = normalise(mine[k].mol);
  assert.ok(a.atoms.every((at, i) => Math.hypot(at.location[0] - b.atoms[i].location[0], at.location[1] - b.atoms[i].location[1]) < 0.01), `${x.name}: atoms in their places`);
});
assert.equal(readBack.templates[0].mol.captions?.[0]?.text, "salt", "the caption stays");
// Saved again from what was read, it reads back the same (a round trip changes nothing more).
const again = readTemplateFile(writeTemplateFile(readBack.templates, "Salts").bytes, "Salts.ctp");
assert.deepEqual(again.templates.map((x) => [x.name, shape(x.mol)]), readBack.templates.map((x) => [x.name, shape(x.mol)]));
// The grid is never wider than the set; medium panes are ChemDraw's 2.75; the window at least ChemDraw's smallest and
// at most six rows tall.
const three = cdxToXml(writeTemplateFile(mine.slice(0, 3), "Three").bytes, true).kids.find((k) => k.name === "templategrid")!;
assert.deepEqual([three.attrs.NumRows, three.attrs.NumColumns, three.attrs.extent], ["1", "3", "2.75 2.75"]);
const tall = cdxToXml(writeTemplateFile(Array.from({ length: 40 }, (_, k) => inSet(`R${k}`, ring)), "Tall", 2, "small").bytes, true).kids.find((k) => k.name === "templategrid")!;
assert.deepEqual([tall.attrs.NumRows, tall.attrs.NumColumns, tall.attrs.extent, tall.attrs.PaneHeight], ["20", "2", "2.25 2.25", String(Math.round(6 * 2.25 * 65536))]);
// Within the reader's limits: a template too big for a template file is left out and counted, and so is every template
// past MOST_PANES; the rest read back, all of them. A set with nothing written is still a template file (one empty pane).
const hugeT = { name: "Huge", mol: huge };
assert.ok(write(hugeT.mol).length > MOST_TEMPLATE);
const withBig = writeTemplateFile([mine[1], hugeT, mine[2]], "Big");
assert.deepEqual([withBig.written, withBig.left], [2, 1]);
assert.deepEqual(readTemplateFile(withBig.bytes, "Big.ctp").templates.map((x) => x.name), ["Furan", "Template 2"]);
const tooMany = writeTemplateFile(Array.from({ length: MOST_PANES + 3 }, (_, k) => ({ name: `O${k}`, mol: { atoms: [atom("O", 0, 0)], bonds: [] } as Mol })), "Many");
assert.deepEqual([tooMany.written, tooMany.left], [MOST_PANES, 3]);
const manyBack = readTemplateFile(tooMany.bytes, "Many.ctp");
assert.deepEqual([manyBack.templates.length, manyBack.left], [MOST_PANES, 0], "every template written reads back");
const none = writeTemplateFile([hugeT], "None");
assert.deepEqual([none.written, none.left, readTemplateFile(none.bytes, "None.cts").templates.length], [0, 1, 0]);
// Octet's mine sets, saved and read back whole (in order, by name).
for (const set of SETS.filter((c) => ["Aromatics", "Metallocenes", "Lab", "Conformers"].includes(c.name))) {
  const r = readTemplateFile(writeTemplateFile(set.items, set.name).bytes, `${set.name}.ctp`);
  assert.deepEqual(r.templates.map((x) => x.name), set.items.map((x) => x.name), `${set.name} saved and read back`);
  r.templates.forEach((x, k) => assert.deepEqual(shape(x.mol), shape(set.items[k].mol), `${set.name}: ${x.name}`));
}
console.log("templates: a set saved as a ChemDraw template file and read back ok");

// ——— Octet's own template library (library.json, built by tools/library/build.mjs) ———
// Every built-in template parses, has a name of its own, has the CIP labels of the compound it is meant to be, gets
// the name Structure to Name gives it as the editor runs it (read back to the same structure), and survives Clean Up:
// one drawn in perspective or with a π ligand is left exactly as drawn, any other keeps its structure and stereo.
const { LIBRARY, libraryItem } = await import("./library.ts");
const items = LIBRARY.flatMap((c) => c.items);
assert.equal(new Set(items.map((t) => t.kind)).size, items.length, "every template has a name of its own");
assert.equal(new Set(items.map((t) => t.name.toLowerCase())).size, items.length, "and not the same name in other capitals");
// The sets the roadmap (CD-32) asks for, and those Octet had.
for (const set of ["Stereocentres", "Conformers", "Cycloalkanes", "Aromatics", "Bicyclics", "Hexoses", "Functional groups", "Cp and arene rings", "Metallocenes", "Paddlewheels", "Lab", "Ligands", "Amino acids", "Sugars", "Nucleobases", "Heterocycles"])
  assert.ok(LIBRARY.find((c) => c.name === set)?.items.length, `the ${set} set`);
// Abbreviations are named as common.ts keys them, so the library's search shows the library's own drawing.
const { COMMON, commonKey } = await import("./common.ts");
const keys = new Set(Object.keys(COMMON).map(commonKey));
for (const name of ["PPh3", "dppe", "dppf", "bpy", "phen", "tpy", "Cp", "Cp*", "acacH", "salen", "BOX", "PyBOX", "H2TPP", "Rh2(OAc)4", "Rh2(TFA)4", "Rh2(piv)4", "Rh2(oct)4"]) {
  assert.ok(libraryItem(`lib:${name}`), `${name} is a template`);
  assert.ok(keys.has(commonKey(name)), `${name} is a common.ts key`);
}
// Templates renamed to those keys are still found by their old names (one kept in the Ring strip stays).
assert.equal(libraryItem("lib:bipy")?.name, "bpy");
assert.equal(libraryItem("lib:pybox")?.name, "PyBOX");
// Each parses back from Octet's own file text as it was: labels, places in 3D, multi-centre points and bond styles.
const { parse, serialize } = await import("./file.ts");
for (const t of items) {
  const back = parse(serialize(t.mol)), look = (m: Mol) => [m.atoms.map((a) => [a.label, a.text, a.charge ?? 0, a.location.map((v) => Math.round(v * 1000)), a.centre?.atoms]), m.bonds.map((b) => [b.atoms, b.type, b.stereo ?? 0, b.display])];
  assert.deepEqual(look(back), look(t.mol), `${t.name} parses`);
  assert.equal((back.arrows ?? []).length + (back.shapes ?? []).length, (t.mol.arrows ?? []).length + (t.mol.shapes ?? []).length, `${t.name}: every object parses`);
}
console.log(`templates: ${items.length} built-in templates in ${LIBRARY.length} sets parse, each with its own name ok`);

// Labels drawn clear: each template drawn by the app's renderer at the default document style with Arial's metrics
// (tools/library/clashes.mjs). No two labels' ink overlaps, and no bond's line runs through a label but those of its
// own atoms. Every template is checked; none is let off.
const { clashes } = await import("../tools/library/clashes.mjs");
const clashing = items.filter((t) => t.mol.atoms.length).flatMap((t) => { const c = clashes(t.mol); return c.length ? [`${t.name}: ${c.join("; ")}`] : []; });
assert.deepEqual(clashing, [], "labels clear of each other and of other atoms' bonds");
console.log(`templates: the labels of all ${items.filter((t) => t.mol.atoms.length).length} structure templates are clear of each other and of other bonds ok`);

// The nucleobases face one way: the N that bonds to the sugar (N9 of a purine, N1 of a pyrimidine) is the NH next to a
// ring CH, the lowest atom, with its two ring bonds level so the sugar's bond would point straight down; the
// Watson-Crick edge's O and NH2 (and every other O and N outside the rings) are on the right; the ring CH atoms of the
// other edge (C8, or C5 and C6) and thymine's methyl are on the left.
{
  const bases = LIBRARY.find((c) => c.name === "Nucleobases")!.items;
  assert.deepEqual(bases.map((t) => t.name), ["Adenine", "Guanine", "Cytosine", "Thymine", "Uracil"]);
  for (const { name, mol } of bases) {
    const near = (i: number) => mol.bonds.filter((b) => b.atoms.includes(i)).map((b) => ({ j: b.atoms[0] === i ? b.atoms[1] : b.atoms[0], order: b.type ?? 1 }));
    const degree = (i: number) => near(i).length, x = (i: number) => mol.atoms[i].location[0], y = (i: number) => mol.atoms[i].location[1];
    const ch = (i: number) => mol.atoms[i].label === "C" && degree(i) === 2;
    const sugar = mol.atoms.flatMap((a, i) => (a.label === "N" && near(i).length === 2 && near(i).every((n) => n.order === 1) && near(i).some((n) => ch(n.j)) ? [i] : []));
    assert.equal(sugar.length, 1, `${name}: one NH next to a ring CH (the 9H purine or 1H pyrimidine)`);
    const n = sugar[0], [p, q] = near(n).map((m) => m.j);
    assert.ok(mol.atoms.every((_, i) => y(i) >= y(n) - 0.005), `${name}: the sugar's N is lowest`);
    assert.ok(Math.abs(y(p) - y(q)) < 0.005 && Math.abs((x(p) + x(q)) / 2 - x(n)) < 0.005 && y(p) > y(n), `${name}: the sugar's bond points straight down`);
    const outside = mol.atoms.flatMap((a, i) => (degree(i) === 1 && a.label !== "C" ? [i] : []));
    assert.ok(outside.length && outside.every((i) => x(i) >= x(n) - 0.005), `${name}: the Watson-Crick edge on the right`);
    assert.ok(outside.some((i) => x(i) > x(n) + 0.5), `${name}: and some of it well to the right`);
    // The ring CH next to the sugar's N (C8, or C6), a ring CH next to that (C5) and a methyl.
    const first = near(n).filter((m) => ch(m.j)).map((m) => m.j), back = [...first, ...first.flatMap((i) => near(i).filter((m) => ch(m.j)).map((m) => m.j)),
      ...mol.atoms.flatMap((a, i) => (a.label === "C" && degree(i) === 1 ? [i] : []))];
    assert.ok(back.length && back.every((i) => x(i) < x(n)), `${name}: the other edge on the left`);
  }
  console.log("templates: the nucleobases face one way (sugar's N down, Watson-Crick edge right) ok");
}

// ——— Where a template attaches, and how it joins (attach.ts, ReShiki WP06) ———
// Ported as behaviour from ReShiki's tests/templates.rs, tests/template_library.rs and placement_parity_tests.rs, with
// Octet's own templates (furan, benzene, purine, adenine, glucose from library.json).
const { addTemplate, pos } = await import("./edit.ts");
const { anchorLabel, attachTemplate, chooseAnchor, chooseMode, outwardDirections, readAttach, templateLocants } = await import("./attach.ts");
const { setTemplateAttach, toggleFavourite, readFavourites, removeTemplate: dropTemplate } = await import("./templates.ts");
{
  const lib = (name: string) => libraryItem(`lib:${name}`)!.mol;
  const fur = lib("Furan"), ben = lib("Benzene"), pur = lib("Purine"), ade = lib("Adenine"), glc = lib("α-D-Glucopyranose"), pyr = lib("Pyridine"), cp = lib("Cyclopentane");
  const ok = (r: ReturnType<typeof attachTemplate>, what: string) => r.mol ?? assert.fail(`${what}: ${r.refusal}`);
  const no = (r: ReturnType<typeof attachTemplate>, why: RegExp, what: string) => { assert.equal(r.mol, undefined, `${what} is refused`); assert.match(r.refusal!, why, what); };
  const at = (name: string, el?: string) => (m: typeof fur) => m.atoms.findIndex((x, i) => templateLocants(m)[i] === name && (!el || x.label === el));
  const bonded = (m: Mol, i: number, j: number) => m.bonds.some((b) => b.atoms.includes(i) && b.atoms.includes(j));
  const cos = (m: Mol, c: number, a: number, b: number) => { const p = pos(m, c), u = [pos(m, a)[0] - p[0], pos(m, a)[1] - p[1]], v = [pos(m, b)[0] - p[0], pos(m, b)[1] - p[1]]; return (u[0] * v[0] + u[1] * v[1]) / Math.hypot(...u) / Math.hypot(...v); };
  const same = (a: Mol, b: Mol, n: number) => a.atoms.slice(0, n).every((x, i) => Math.hypot(x.location[0] - b.atoms[i].location[0], x.location[1] - b.atoms[i].location[1]) < 1e-9);

  // The locants the picker names atoms by: Octet's namer's numbers, and a sugar's carbohydrate numbers.
  assert.deepEqual(templateLocants(fur), ["1", "2", "3", "4", "5"]);
  assert.equal(anchorLabel(fur, { atom: at("3")(fur) }), "Attach at C-3");
  assert.equal(anchorLabel(fur, { bond: fur.bonds.findIndex((b) => b.atoms.includes(at("2")(fur)) && b.atoms.includes(at("3")(fur))) }), "Attach at C-2–C-3");
  assert.equal(anchorLabel(ade, { atom: at("9")(ade) }), "Attach at N-9");
  assert.equal(anchorLabel(glc, { atom: at("1", "C")(glc) }), "Attach at C-1", "glucose's anomeric carbon is C-1, not oxane's C-2");
  assert.equal(anchorLabel(glc, { atom: 0 }), "Attach at O-1");
  assert.equal(anchorLabel(fur, undefined), "Automatic attachment");
  assert.equal(anchorLabel(lib("Alcohol"), { atom: 0 }), "Attach at atom 1 (R)", "no locants: the place in the template");
  assert.equal(anchorLabel(fur, { atom: 9 }), "Automatic attachment", "an anchor out of range is no anchor");

  // Old templates place exactly as before: Automatic with no anchor is addTemplate, on an atom, a bond and a point.
  const methylcyclohexane: Mol = { atoms: [...[0, 1, 2, 3, 4, 5].map((k) => atom("C", Math.cos((k * Math.PI) / 3), Math.sin((k * Math.PI) / 3))), atom("C", 2, 0)], bonds: [0, 1, 2, 3, 4, 5].map((k) => bond(k, (k + 1) % 6)).concat([bond(0, 6)]) };
  for (const t of items.filter((x) => x.mol.atoms.length && x.mol.atoms.length < 40)) for (const target of [{ atom: 6 }, { atom: 2 }, { bond: 1 }, { point: [5, 5] as [number, number] }]) {
    assert.deepEqual(attachTemplate(methylcyclohexane, t.mol, { ...target, mode: "auto" }).mol, addTemplate(methylcyclohexane, t.mol, target), `${t.name} on ${JSON.stringify(target)} as before`);
  }

  // Connect with a bond (tests/templates.rs explicit_atom_connection_keeps_both_rings_and_exact_source_atom): each furan
  // carbon joins a benzene carbon by a new single bond. 11 atoms, 12 bonds, benzene unchanged, the bond to exactly that
  // atom; the O has no free valence and is refused, the drawing unchanged.
  const phenylfurans = [1, 2, 3, 4].map((k) => {
    const m = ok(attachTemplate(ben, fur, { atom: 0, anchor: { atom: k }, mode: "connect" }), `furan atom ${k}`);
    assert.equal(m.atoms.length, 11);
    assert.equal(m.bonds.length, 12);
    assert.ok(same(m, ben, 6), "the benzene stays where it was");
    assert.ok(bonded(m, 0, 6 + k), "the new bond goes to the chosen furan atom");
    assert.equal(m.bonds[m.bonds.length - 1].type, 1);
    return m;
  });
  no(attachTemplate(ben, fur, { atom: 0, anchor: { atom: 0 }, mode: "connect" }), /no free valence/, "furan O");
  // A 120° junction at every source vertex (connected_phenyl_ring_has_120_degree_angles_at_every_source_vertex): benzene
  // connected to a furan carbon turned four ways, with and without a drag; the furan stays as it was.
  for (const turn of [0, 0.4, 1.9, 3.3]) {
    const f: Mol = { ...fur, atoms: fur.atoms.map((a) => ({ ...a, location: [a.location[0] * Math.cos(turn) - a.location[1] * Math.sin(turn), a.location[0] * Math.sin(turn) + a.location[1] * Math.cos(turn), 0] })) };
    // The drag goes out from the ring, off its open side.
    for (const toward of [undefined, [3 * pos(f, 2)[0] + 0.2, 3 * pos(f, 2)[1]] as [number, number]]) {
      const m = ok(attachTemplate(f, ben, { atom: 2, anchor: { atom: 0 }, mode: "connect", toward }), "phenyl");
      assert.ok(same(m, f, 5), "the furan stays");
      const ph = 5, ring = m.bonds.filter((b) => b.atoms.includes(ph) && b.atoms.every((x) => x >= 5)).map((b) => (b.atoms[0] === ph ? b.atoms[1] : b.atoms[0]));
      assert.equal(ring.length, 2);
      for (const r of ring) assert.ok(Math.abs(cos(m, ph, 2, r) + 0.5) < 1e-4, `120° at the phenyl vertex (turn ${turn})`);
      assert.ok(Math.abs(Math.hypot(pos(m, ph)[0] - pos(m, 2)[0], pos(m, ph)[1] - pos(m, 2)[1]) - 1) < 1e-9, "one bond length");
    }
  }
  // A drag sets the new bond's direction in 15° steps.
  const dragged = ok(attachTemplate(methylcyclohexane, ben, { atom: 6, anchor: { atom: 0 }, mode: "connect", toward: [2.9, 1.1] }), "drag");
  const way = Math.atan2(pos(dragged, 7)[1], pos(dragged, 7)[0] - 2) * 180 / Math.PI;
  assert.ok(Math.abs(way - 45) < 1e-6, `snapped to 45°, not ${way}`);
  assert.deepEqual(outwardDirections(ben, 0).length, 1, "a ring atom's open side is one direction");
  assert.deepEqual(outwardDirections({ atoms: [atom("C", 0, 0)], bonds: [] }, 0), [0]);

  // Purine at N-9 (adenine_can_connect_at_n9_without_changing_its_ring_tautomer): Octet's adenine is 9H, so N-9 joins
  // and N-7 keeps its double bond. Octet's purine is drawn 7H (as PubChem has it): there N-9 has no free valence and
  // is refused, never swapped for N-7, and N-7 joins.
  const adeN9 = at("9")(ade), adeN7 = at("7")(ade);
  const ph9 = ok(attachTemplate(ben, ade, { atom: 0, anchor: { atom: adeN9 }, mode: "connect" }), "adenine N-9");
  assert.ok(bonded(ph9, 0, 6 + adeN9));
  assert.ok(ph9.bonds.some((b) => b.type === 2 && b.atoms.includes(6 + adeN7)), "N-7 keeps its double bond");
  no(attachTemplate(ben, pur, { atom: 0, anchor: { atom: at("9")(pur) }, mode: "connect" }), /chosen template atom: N has no free valence/, "7H-purine N-9");
  assert.ok(bonded(ok(attachTemplate(ben, pur, { atom: 0, anchor: { atom: at("7")(pur) }, mode: "connect" }), "purine N-7"), 0, 6 + at("7")(pur)));
  // Glucose at C-1: by a new bond at C-1, and as a glycoside sharing its O-1 with methanol's O.
  const c1 = at("1", "C")(glc), methanol: Mol = { atoms: [atom("C", 0, 0), atom("O", 1, 0)], bonds: [bond(0, 1)] };
  assert.ok(bonded(ok(attachTemplate(ben, glc, { atom: 0, anchor: { atom: c1 }, mode: "connect" }), "glucose C-1"), 0, 6 + c1));
  const glycoside = ok(attachTemplate(methanol, glc, { atom: 1, anchor: { atom: 0 }, mode: "share" }), "methyl glucoside");
  assert.equal(glycoside.atoms.length, 13, "the O is shared");
  assert.ok(bonded(glycoside, 1, 2 + c1 - 1), "methanol's O is O-1 on C-1");
  no(attachTemplate(methanol, glc, { atom: 0, anchor: { atom: 0 }, mode: "share" }), /not the same element/, "O-1 on a carbon");
  // A sugar drawn in perspective keeps its depth: its atoms' z, grown with it.
  const chair = lib("α-D-Glucopyranose (chair)"), onChair = ok(attachTemplate(ben, chair, { atom: 0, anchor: { atom: at("1", "C")(chair) }, mode: "connect" }), "chair");
  assert.ok(chair.atoms.every((a, k) => Math.abs((onChair.atoms[6 + k].location[2] ?? 0) - (a.location[2] ?? 0)) < 1e-9), "the chair keeps its depth");

  // Share an atom: a spiro ring on a CH2, from any compatible atom; a benzene carbon (one H) cannot share two bonds.
  const spiro = ok(attachTemplate(methylcyclohexane, cp, { atom: 2, mode: "share" }), "spiro");
  assert.equal(spiro.atoms.length, 11);
  assert.equal(spiro.bonds.filter((b) => b.atoms.includes(2)).length, 4);
  no(attachTemplate(ben, cp, { atom: 0, anchor: { atom: 0 }, mode: "share" }), /C has no free valence/, "spiro on benzene");
  no(attachTemplate(ben, fur, { bond: 0, anchor: { atom: 2 }, mode: "share" }), /Share an atom: point to an atom/, "Share on a bond");

  // Fuse along a bond: the chosen bond is the shared one (source_bond_is_exact…): pyridine's C-5–C-6 on ethene gives
  // pyridine itself, its N on one of ethene's two atoms, which stay where they were.
  const ethene: Mol = { atoms: [atom("C", 0, 0), atom("C", 1, 0)], bonds: [bond(0, 1, 2)] };
  const c56 = pyr.bonds.findIndex((b) => b.atoms.includes(at("5")(pyr)) && b.atoms.includes(at("6")(pyr)));
  assert.equal(anchorLabel(pyr, { bond: c56 }), "Attach at C-5–C-6");
  const py = ok(attachTemplate(ethene, pyr, { bond: 0, anchor: { bond: c56 }, mode: "fuse" }), "pyridine");
  assert.equal(py.atoms.length, 6);
  assert.equal(py.bonds.length, 6);
  assert.ok(same(py, ethene, 2));
  const n = py.atoms.findIndex((a) => a.label === "N");
  assert.ok(bonded(py, n, 0) || bonded(py, n, 1), "N next to the shared bond");
  // Furan's C-2–C-3 on a benzene bond is benzofuran's ring fusion; every all-carbon furan bond fuses, O–C does not.
  for (const e of [1, 2, 3]) assert.equal(ok(attachTemplate(ben, fur, { bond: 1, anchor: { bond: e }, mode: "fuse" }), `furan bond ${e}`).atoms.length, 9);
  no(attachTemplate(ben, fur, { bond: 1, anchor: { bond: 0 }, mode: "fuse" }), /not the same/, "O–C on C–C");
  // A drag picks the side (dragging_selects_attachment_side_and_invalid_targets_are_unchanged): cyclopentane on the
  // bond along the x axis goes up with a drag up and down with a drag down.
  const ethane: Mol = { atoms: [atom("C", 0, 0), atom("C", 1, 0)], bonds: [bond(0, 1)] };
  const side = (toward: [number, number]) => { const m = ok(attachTemplate(ethane, cp, { bond: 0, anchor: { bond: 0 }, mode: "fuse", toward }), "side"); return Math.sign(m.atoms.slice(2).reduce((s, a) => s + a.location[1], 0)); };
  assert.equal(side([0.5, 1]), 1);
  assert.equal(side([0.5, -1]), -1);
  no(attachTemplate({ ...ethane, bonds: [bond(0, 1, 3)] }, cp, { bond: 0, mode: "fuse" }), /plain single, double or aromatic/, "a triple bond");
  no(attachTemplate({ ...ethane, bonds: [bond(0, 1, 1, { stereo: 1 })] }, cp, { bond: 0, mode: "fuse" }), /plain/, "a wedge");
  no(attachTemplate(ethane, cp, { atom: 0, mode: "fuse" }), /Fuse along a bond: point to a bond/, "Fuse on an atom");
  // Fusing keeps Octet's re-Kekulé rule: a benzene fused onto a benzene is naphthalene, no atom with two double bonds.
  const naph = ok(attachTemplate(ben, ben, { bond: 0, anchor: { bond: 0 }, mode: "fuse" }), "naphthalene");
  assert.ok(naph.atoms.every((_, i) => naph.bonds.filter((b) => b.type === 2 && b.atoms.includes(i)).length <= 1));

  // Error precedence (placement_parity_tests error_precedence): the target's kind first, then the anchor's kind, then
  // the atoms.
  no(attachTemplate(ben, fur, { bond: 0, anchor: { atom: 1 }, mode: "connect" }), /Connect with a bond: point to an atom/, "Connect on a bond");
  no(attachTemplate(ben, fur, { bond: 0, anchor: { atom: 1 } }), /template atom joins an atom/, "atom anchor on a bond");
  no(attachTemplate(ethane, fur, { atom: 0, anchor: { bond: 1 } }), /template bond joins a bond/, "bond anchor on an atom");
  no(attachTemplate(ethane, fur, { atom: 0, anchor: { bond: 1 }, mode: "share" }), /Choose a template atom/, "bond anchor, Share");
  no(attachTemplate({ atoms: [atom("C", 0, 0, { text: "OMe" }), atom("C", 1, 0)], bonds: [bond(0, 1)] }, ben, { atom: 0, mode: "connect" }), /OMe is a label/, "an abbreviation");
  assert.ok(attachTemplate({ atoms: [atom("O", 0, 0, { text: "OH" }), atom("C", 1, 0)], bonds: [bond(0, 1)] }, ben, { atom: 0, mode: "connect" }).mol, "OH typed is a plain O");
  // Automatic with an anchor: an atom anchor shares that atom, a bond anchor fuses along that bond.
  assert.ok(bonded(ok(attachTemplate(ethane, cp, { bond: 0, anchor: { bond: 2 } }), "auto fuse"), 0, 1));
  assert.equal(ok(attachTemplate(methylcyclohexane, cp, { atom: 6, anchor: { atom: 3 } }), "auto share").atoms.length, 11);
  // Empty space: the anchor lands on the point.
  const free = ok(attachTemplate({ atoms: [], bonds: [] }, fur, { point: [4, 2], anchor: { atom: at("3")(fur) } }), "free");
  assert.deepEqual(pos(free, at("3")(fur)), [4, 2]);
  const freeBond = ok(attachTemplate({ atoms: [], bonds: [] }, fur, { point: [4, 2], anchor: { bond: 2 } }), "free bond");
  const [p, q] = fur.bonds[2].atoms.map((k) => pos(freeBond, k));
  assert.ok(Math.hypot((p[0] + q[0]) / 2 - 4, (p[1] + q[1]) / 2 - 2) < 1e-9);
  // The drawing itself is never changed (each placement is a new drawing: one Undo step).
  assert.equal(ben.atoms.length, 6);

  // Anchor and mode kept together (template_library.rs 901-931, 1000-1026).
  assert.deepEqual(chooseAnchor({ mode: "connect" }, { bond: 1 }), { mode: "fuse", anchor: { bond: 1 } }, "a bond switches to Fuse");
  assert.deepEqual(chooseAnchor({ mode: "fuse", anchor: { bond: 1 } }, { atom: 2 }), { mode: "connect", anchor: { atom: 2 } }, "an atom after Fuse is Connect");
  assert.deepEqual(chooseAnchor({}, { bond: 1 }), { anchor: { bond: 1 } }, "Automatic keeps a bond");
  assert.deepEqual(chooseMode({ anchor: { atom: 2 } }, "fuse"), { mode: "fuse" }, "Fuse clears an atom");
  assert.deepEqual(chooseMode({ anchor: { bond: 2 } }, "share"), { mode: "share" }, "Share clears a bond");
  assert.deepEqual(chooseMode({ mode: "share", anchor: { atom: 2 } }, "auto"), { anchor: { atom: 2 } });
  assert.deepEqual(chooseAnchor({ mode: "share", anchor: { atom: 2 } }, undefined), { mode: "share" });
  assert.deepEqual(readAttach(fur, { anchor: { atom: 2 }, mode: "connect" }), { anchor: { atom: 2 }, mode: "connect" });
  assert.deepEqual(readAttach(fur, { anchor: { bond: 2 }, mode: "connect" }), { anchor: { bond: 2 }, mode: "fuse" }, "a bond anchor read back is Fuse");
  for (const bad of [null, 3, "x", { anchor: { atom: 7 } }, { anchor: { atom: -1 } }, { anchor: { atom: 1.5 } }, { mode: "spin" }, { mode: "auto" }]) assert.equal(readAttach(fur, bad), undefined, JSON.stringify(bad));

  // Custom templates remember it (collections_persist_…anchors_and_favorites…): kept in the settings and read back;
  // a damaged one is dropped; Edit then Save drops the anchor (its atoms may be numbered another way) but keeps the join.
  let k: Kept = addTo(empty, newTemplate("Furan copy", fur));
  const fid = k.templates[0].id;
  k = setTemplateAttach(k, fid, { anchor: { atom: 2 }, mode: "connect" });
  assert.deepEqual(back(k)[0].attach, { anchor: { atom: 2 }, mode: "connect" });
  assert.equal(setTemplateAttach(k, fid, { anchor: { atom: 2 }, mode: "connect" }), k, "no change, the same settings");
  assert.equal(back({ ...k, templates: [{ ...k.templates[0], attach: { anchor: { atom: 40 } } }] })[0].attach, undefined, "an anchor not in the template is dropped");
  assert.deepEqual(updateTemplate(k, fid, ben).templates[0].attach, { mode: "connect" }, "Edit drops the anchor");
  assert.equal(setTemplateAttach(k, fid, {}).templates[0].attach, undefined, "Automatic keeps nothing");
  // Favourites: starred and unstarred, kept in order, read back with checks; a template removed is no longer one.
  const favs = toggleFavourite(toggleFavourite([], "lib:Furan"), templateKind(fid));
  assert.deepEqual(favs, ["lib:Furan", templateKind(fid)]);
  assert.deepEqual(toggleFavourite(favs, "lib:Furan"), [templateKind(fid)]);
  assert.deepEqual(readFavourites(JSON.parse(JSON.stringify([...favs, "lib:Furan", 3, "tool:x", "", "lib:"]))), favs, "duplicates and junk dropped");
  assert.deepEqual(readFavourites("lib:Furan"), []);
  assert.equal(readFavourites(Array.from({ length: 600 }, (_, n) => `lib:${n}`)).length, 500);
  assert.deepEqual(dropTemplate({ ...k, favourites: favs }, fid).favourites, ["lib:Furan"], "removed, it is no longer a favourite");
  console.log("templates: attachment by a chosen atom or bond (Connect, Share, Fuse), refusals, locants, anchors kept, favourites ok");
}

const dir = new URL("./vendor/opsin/", import.meta.url);
if (!existsSync(new URL("opsin.js", dir))) { console.log("templates: chemistry skipped (no OPSIN build)"); process.exit(0); }
// chem.ts reads the drawing tokens and loads Indigo's wasm as a browser does; these stand in for the browser.
const gl = globalThis as Record<string, unknown>;
gl.document = { documentElement: {}, createElement: () => ({ getContext: () => ({}) }) };
gl.getComputedStyle = () => ({ getPropertyValue: () => "10" });
gl.window = globalThis;
gl.self = { location: { origin: "file://" } };
gl.fetch = async (u: URL | string) => new Response(readFileSync(new URL(String(u))), { headers: { "content-type": "application/wasm" } });
const chem = await import("./chem.ts");
await chem.ready;
// Every template placed by the Template tool (or Ring tool, or the command palette) keeps its own bonds: a click on
// the canvas, and a click on a methyl carbon, which the template's first atom (R) joins. Azide stays N=N⁺=N⁻ with no
// H on its last two N (it was drawn N=N⁺H–N⁻H, issue: Add Azide), and diazo, isocyanate, isothiocyanate, sulfone and
// the other cumulated or hypervalent groups keep both double bonds. A ring fused onto a ring still never gives an
// atom two double bonds (edit.check.ts, naphthalene).
{
  const { addTemplate } = await import("./edit.ts");
  const { problems } = await import("./check.ts");
  const methyl: Mol = { atoms: [atom("C", 0, 0), atom("C", 1, 0)], bonds: [bond(0, 1)] };
  for (const t of LIBRARY.flatMap((c) => c.items).filter((x) => x.category === "Functional groups" || x.category === "Heterocycles" || x.category === "Ligands")) {
    const types = (m: Mol) => m.bonds.map((b) => b.type).sort().join("");
    const alone = addTemplate({ atoms: [], bonds: [] }, t.mol, { point: [0, 0] });
    assert.equal(types(alone), types(t.mol), `${t.name}: placed on the canvas, its bonds as drawn`);
    if (t.category !== "Functional groups") continue;
    const on = addTemplate(methyl, t.mol, { atom: 1, point: [1, 0] });
    assert.equal(types(on), types({ atoms: [], bonds: [...methyl.bonds, ...t.mol.bonds] }), `${t.name}: on an atom, its bonds as drawn`);
    assert.deepEqual(problems(on).map((p) => p.message), [], `${t.name}: on an atom, no warnings`);
  }
  const azide = addTemplate(methyl, libraryItem("lib:Azide")!.mol, { atom: 1, point: [1, 0] });
  assert.equal(chem.toSmiles(azide), "CCN=[N+]=[N-]");
  assert.equal(chem.analyse(azide)?.[0].formula, "C2H5N3");
  assert.equal(chem.toInchi(azide), "InChI=1S/C2H5N3/c1-2-4-5-3/h2H2,1H3");
  console.log("templates: functional groups, heterocycles and ligands placed keep their bonds (azide N=N+=N-, no stray H) ok");
}
// The chemistry of a chosen attachment, read by Indigo: the chosen furan carbon gives 2- or 3-phenylfuran (two
// compounds, each C10H8O, the same compound from C-2 and C-5); adenine at N-9 is 9-phenyladenine (9H kept); furan's
// C-2–C-3 fused on benzene is benzofuran; glucose's O-1 shared with methanol is a methyl glucoside; the products
// save to Octet's file and read back the same.
{
  const { problems } = await import("./check.ts");
  const { serialize, parse } = await import("./file.ts");
  const lib = (name: string) => libraryItem(`lib:${name}`)!.mol, fur = lib("Furan"), ben = lib("Benzene");
  const ofSmiles = (smiles: string) => chem.toInchi(chem.parseStructure(smiles));
  const put = (m: Mol, t: Mol, target: Parameters<typeof attachTemplate>[2]) => attachTemplate(m, t, target).mol ?? assert.fail(JSON.stringify(target));
  const furans = [1, 2, 3, 4].map((k) => put(ben, fur, { atom: 0, anchor: { atom: k }, mode: "connect" }));
  const keys = furans.map((m) => chem.toInchi(m));
  assert.equal(new Set(keys).size, 2, "two isomers");
  assert.equal(keys[0], keys[3], "C-2 and C-5 give the same compound");
  assert.equal(keys[0], ofSmiles("c1ccc(cc1)-c1ccco1"), "2-phenylfuran");
  assert.equal(keys[1], ofSmiles("c1ccc(cc1)-c1ccoc1"), "3-phenylfuran");
  for (const m of furans) assert.equal(chem.analyse(m)?.[0].formula, "C10H8O");
  const ade = lib("Adenine"), n9 = ade.atoms.findIndex((_, i) => templateLocants(ade)[i] === "9");
  assert.equal(chem.toInchi(put(ben, ade, { atom: 0, anchor: { atom: n9 }, mode: "connect" })), ofSmiles("Nc1ncnc2c1ncn2-c1ccccc1"), "9-phenyladenine");
  const c23 = fur.bonds.findIndex((b) => b.atoms.includes(1) && b.atoms.includes(2));
  const benzofuran = put(ben, fur, { bond: 1, anchor: { bond: c23 }, mode: "fuse" });
  assert.equal(chem.toInchi(benzofuran), ofSmiles("c1ccc2occc2c1"), "benzofuran");
  const glc = lib("α-D-Glucopyranose"), methanol: Mol = { atoms: [atom("C", 0, 0), atom("O", 1, 0)], bonds: [bond(0, 1)] };
  const glycoside = put(methanol, glc, { atom: 1, anchor: { atom: 0 }, mode: "share" });
  assert.equal(chem.analyse(glycoside)?.[0].formula, "C7H14O6", "methyl glucoside");
  for (const m of [...furans, benzofuran, glycoside]) {
    assert.deepEqual(problems(m).map((p) => p.message), [], "no warnings");
    assert.equal(chem.toInchi(parse(serialize(m))), chem.toInchi(m), "saved and read back the same");
  }
  console.log("templates: a chosen attachment gives the compound chosen (phenylfurans, 9-phenyladenine, benzofuran, a glucoside) ok");
}
const pack = readFileSync(new URL("opsin-data.bin", dir)), files = new Map<string, Int8Array>();
for (let p = 0; ; ) {
  const n = pack.readUInt16BE(p); p += 2;
  if (!n) break;
  const name = pack.toString("latin1", p, p + n); p += n;
  const size = pack.readInt32BE(p); p += 4;
  files.set(name, new Int8Array(pack.buffer, pack.byteOffset + p, size)); p += size;
}
gl.opsinResource = (name: string) => files.get(name) ?? null;
const opsin = await import(new URL("opsin.js", dir).href);
opsin.init();
const json = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const { DRUGS } = await import("./drugs.ts");
const { abbreviationOf, attachOpsin, knownName, nameToAtoms, nameToSmiles } = await import("./names.ts");
attachOpsin(opsin, readFileSync(new URL("names.txt", dir), "utf8"), json("./nameindex.json"), DRUGS, json("./abbreviations.json"));
const { checkedName, setComplexNamer, setNamer, withAbbreviation, withoutRingEZ } = await import("./naming.ts");
const { iupacName } = await import("./namer.ts");
const { complexName } = await import("./complexes.ts");
const { sandwichIons } = await import("./metals.ts");
const { messy } = await import("./check.ts");
setNamer(iupacName);
setComplexNamer((m) => complexName(m, { read: nameToSmiles, atoms: nameToAtoms, inchi: chem.toInchi, aux: chem.toInchiAux, cip: chem.cipOf }));
// As the editor takes them (Editor.tsx nameFor): a name's structure drawn as Octet draws SMILES, and a metallocene
// drawn with π ligands named as its ions.
const inchiOf = (s: Mol | string) => { try { return chem.toInchi(typeof s === "string" ? chem.parseStructure(s) : s); } catch { return undefined; } };
const nameFor = (m: Mol) => { const p = sandwichIons(m) ?? m, name = checkedName(p, chem.expandLabels(p), nameToSmiles, inchiOf, chem.cipOf, knownName); return name && withAbbreviation(name, abbreviationOf(inchiOf(p))); };
const labels = (m: Mol) => { const c = chem.cipOf(m); return [...c.atoms, ...c.bonds].filter(Boolean).sort().join(""); };
const molecular = items.filter((t) => t.mol.atoms.length);

// Stereo: each template with R, S, E or Z labels is the compound it is meant to be. Its labels (Octet's CIP labeller,
// read from wedges, or from the atoms' places in 3D for chairs, Haworth and Fischer projections) are the reference
// structure's, drawn from its name; and where there is no R group, its InChI is the reference's, stereo included.
const STEREO: Record<string, string> = {
  "α-D-Glucopyranose": "alpha-D-glucopyranose", "β-D-Glucopyranose": "beta-D-glucopyranose", "β-D-Galactopyranose": "beta-D-galactopyranose",
  "α-D-Mannopyranose": "alpha-D-mannopyranose", "β-D-Fructofuranose": "beta-D-fructofuranose", "β-D-Ribofuranose": "beta-D-ribofuranose",
  "2-Deoxy-β-D-ribofuranose": "2-deoxy-beta-D-ribofuranose", "D-Glucose (open chain)": "D-glucose",
  "(R)-Bromochlorofluoromethane": "(1R)-bromo(chloro)(fluoro)methane", "(S)-Bromochlorofluoromethane": "(1S)-bromo(chloro)(fluoro)methane",
  "(R)-Butan-2-ol": "(2R)-butan-2-ol", "(S)-Butan-2-ol": "(2S)-butan-2-ol", "(R)-Lactic acid": "(2R)-2-hydroxypropanoic acid",
  "(S)-Lactic acid": "(2S)-2-hydroxypropanoic acid", "(R)-Glyceraldehyde": "D-glyceraldehyde", "(S)-Glyceraldehyde": "L-glyceraldehyde",
  "(R,R)-Tartaric acid": "(2R,3R)-2,3-dihydroxybutanedioic acid", "(S,S)-Tartaric acid": "(2S,3S)-2,3-dihydroxybutanedioic acid",
  "meso-Tartaric acid": "(2R,3S)-2,3-dihydroxybutanedioic acid", "trans-Cyclohexane-1,2-diol": "(1R,2R)-cyclohexane-1,2-diol",
  "cis-Cyclohexane-1,2-diol": "(1R,2S)-cyclohexane-1,2-diol", "D-Glyceraldehyde (Fischer)": "D-glyceraldehyde",
  "L-Glyceraldehyde (Fischer)": "L-glyceraldehyde", "L-Alanine (Fischer)": "L-alanine", "D-Ribose (Fischer)": "D-ribose", "D-Glucose (Fischer)": "D-glucose",
  "Cyclooctene": "(Z)-cyclooctene", "Cyclooctatetraene": "cycloocta-1,3,5,7-tetraene", "cis-Decalin": "cis-decahydronaphthalene",
  "trans-Decalin": "trans-decahydronaphthalene", "cod": "(1Z,5Z)-cycloocta-1,5-diene", "dba": "(1E,4E)-1,5-diphenylpenta-1,4-dien-3-one",
  "salen": "salen", "Porphyrin": "21H,23H-porphine", "H2TPP": "H2TPP", "Phthalocyanine": "29H,31H-phthalocyanine",
  // An R group ranks above any element, as a methyl ranks above H: the E of R-CH=N-Me is MeCH=NMe's.
  "Imine": "(E)-N-methylethanimine", "Oxime": "(E)-N-hydroxyethanimine", "Hydrazone": "(E)-ethylidenehydrazine",
};
const reference = (t: (typeof items)[number]) => t.category === "Amino acids" ? (t.name === "Glycine" ? undefined : `L-${t.name.toLowerCase()}`)
  : t.category === "Hexoses" ? t.name.replace(/ \((Haworth|chair)\)$/, "").replace(/^α-D-(.)/, (_, c) => `alpha-D-${c.toLowerCase()}`).replace(/^β-D-(.)/, (_, c) => `beta-D-${c.toLowerCase()}`)
  : STEREO[t.name];
let stereo = 0;
for (const t of molecular) {
  const own = labels(t.mol), ref = reference(t);
  if (!own) { assert.equal(ref, undefined, `${t.name} has no stereo labels`); continue; }
  assert.ok(ref, `${t.name} (${own}) has a reference compound`);
  const smiles = nameToSmiles(ref!) ?? assert.fail(`${ref} is read`), drawn = chem.parseStructure(smiles);
  assert.equal(own, labels(drawn), `${t.name}: its CIP labels are ${ref}'s`);
  if (!t.mol.atoms.some((a) => a.text === "R")) assert.equal(withoutRingEZ(inchiOf(t.mol)), withoutRingEZ(inchiOf(smiles)), `${t.name} is ${ref}`);
  stereo++;
}
// The hexoses as every textbook draws them: β-D-glucopyranose's chair has every group equatorial, the D sugars'
// Haworth projections have CH2OH up, and the anomers' OH is down (α) or up (β) in a Haworth projection.
{
  const mol = (name: string) => libraryItem(`lib:${name}`)!.mol;
  const glc = mol("β-D-Glucopyranose (chair)"), up = (m: Mol, label: string) => m.atoms.filter((a) => (a.text ?? a.label) === label);
  const ring = new Set(glc.bonds.filter((b) => glc.atoms[b.atoms[0]].label !== "O" || glc.atoms[b.atoms[1]].label !== "O").flatMap((b) => b.atoms));
  // Equatorial: no substituent bond is upright (axial bonds are vertical).
  const upright = glc.bonds.filter((b) => { const [p, q] = b.atoms.map((i) => glc.atoms[i].location); return Math.abs(p[0] - q[0]) < 1e-3; });
  assert.equal(upright.length, 0, "β-D-glucopyranose: every group equatorial");
  assert.ok(ring.size);
  for (const sugar of ["α-D-Glucopyranose", "β-D-Glucopyranose", "α-D-Galactopyranose", "β-D-Mannopyranose"]) {
    const m = mol(`${sugar} (Haworth)`), c6 = up(m, "CH2OH")[0], c5 = m.atoms[m.bonds.find((b) => b.atoms.includes(m.atoms.indexOf(c6)))!.atoms.find((i) => m.atoms[i] !== c6)!];
    assert.ok(c6.location[1] > c5.location[1], `${sugar}: CH2OH up`);
    const o5 = m.atoms.findIndex((a) => a.label === "O" && m.bonds.filter((b) => b.atoms.includes(m.atoms.indexOf(a))).length === 2);
    const c1 = m.bonds.flatMap((b) => (b.atoms.includes(o5) ? b.atoms : [])).find((i) => i !== o5 && m.atoms[i] !== c5)!;
    const oh = m.bonds.flatMap((b) => (b.atoms.includes(c1) ? b.atoms : [])).find((i) => m.atoms[i].label === "O" && i !== o5)!;
    assert.equal(m.atoms[oh].location[1] > m.atoms[c1].location[1], sugar.startsWith("β"), `${sugar}: the anomeric OH ${sugar.startsWith("β") ? "up" : "down"}`);
  }
}
console.log(`templates: ${stereo} templates with stereocentres or E/Z bonds are their compounds, by CIP label and InChI ok`);

// Names: Structure to Name as the editor runs it. Each name is read back to the template's own structure, and the
// templates no name is given to are these (an R group, M or L; a carbene; a metal the namer leaves; r and s centres;
// a cage). Lab items have no structure.
const UNNAMED = new Set(["cis-Decalin", "trans-Decalin", "Cubane", "IMes", "IPr", "Cp2TiCl2", "Cp2ZrCl2", "CpMn(CO)3",
  "Rh2(O2CR)4", "Rh2(O2CR)4L2", "Mo2(OAc)4", ...LIBRARY.filter((c) => c.name === "Functional groups" || c.name === "Cp and arene rings").flatMap((c) => c.items.map((t) => t.name))]);
let named = 0;
for (const t of molecular) {
  const name = nameFor(t.mol);
  if (UNNAMED.has(t.name)) { assert.equal(name, undefined, `${t.name} is not named`); continue; }
  assert.ok(name, `${t.name} is named`);
  // The name without its cited abbreviation, read back by OPSIN, is the template's structure.
  const plain = name!.replace(/ \([^()]*(\([^()]*\)[^()]*)*\)$/, (s) => (nameToSmiles(name!.slice(0, -s.length)) ? "" : s));
  const p = sandwichIons(t.mol) ?? t.mol, smiles = nameToSmiles(plain);
  named++;
  // A coordination compound's name with κ or η, which OPSIN does not read, was checked in parts (complexes.ts).
  if (!smiles && /[κη]/.test(name!)) continue;
  assert.equal(withoutRingEZ(inchiOf(smiles!)), withoutRingEZ(inchiOf(p)), `${t.name}: "${name}" is its structure`);
}
for (const [name, want] of [["Ferrocene", "ferrocene"], ["Decamethylferrocene", "1,1',2,2',3,3',4,4',5,5'-decamethylferrocene"], ["Rh2(OAc)4", "tetrakis(μ-acetato-κO:κO')dirhodium(Rh—Rh)"],
  ["Newman projection, gauche", "butane"], ["Cyclohexane chair", "cyclohexane"], ["β-D-Glucopyranose (chair)", "(2R,3R,4S,5S,6R)-6-(hydroxymethyl)oxane-2,3,4,5-tetraol"],
  ["D-Glucose (Fischer)", "(2R,3S,4R,5R)-2,3,4,5,6-pentahydroxyhexanal"], ["dppf", "[1'-(diphenylphosphanyl)ferrocenyl](diphenyl)phosphane (dppf)"]])
  assert.equal(nameFor(libraryItem(`lib:${name}`)!.mol), want, name);
console.log(`templates: ${named} templates named by Structure to Name, each name read back to its structure ok`);

// Clean Up: a structure drawn in perspective (with depth: chairs, Newman, sawhorse and Haworth projections, Fischer
// projections, paddlewheels, cubane) or with a π ligand (metallocenes) is left exactly where it is. Any other comes out
// with the same structure and stereo, and tidy (not marked for Clean Up), but for these: bridged rings and crowded
// biaryl phosphines, whose short or crossing bonds no flat drawing avoids. (Drawn in 3D, a bridged ring's bridgeheads
// read as stereocentres and Structure to Name gives it no name, so they stay flat.)
const CROWDED = new Set(["Bicyclo[1.1.1]pentane", "Bicyclo[2.1.1]hexane", "Bicyclo[3.1.1]heptane", "Norbornane", "Norbornene", "Norbornadiene", "Bicyclo[2.2.2]octane",
  "Bicyclo[3.2.1]octane", "Bicyclo[3.3.1]nonane", "Adamantane", "DABCO", "BINAP", "Xantphos", "XPhos", "SPhos"]);
let kept = 0, cleaned = 0;
for (const t of molecular) {
  const after = chem.cleanUp(t.mol);
  if (t.mol.atoms.some((a) => a.location[2] || a.centre)) {
    assert.deepEqual(after.atoms.map((a) => a.location), t.mol.atoms.map((a) => a.location), `${t.name} is left as drawn`);
    kept++;
    continue;
  }
  assert.equal(labels(after), labels(t.mol), `${t.name} keeps its stereo labels`);
  if (!t.mol.atoms.some((a) => a.text === "R" || a.text === "X")) assert.equal(inchiOf(after), inchiOf(t.mol), `${t.name} keeps its structure`);
  assert.equal(messy(after), CROWDED.has(t.name), `${t.name} is ${CROWDED.has(t.name) ? "crowded (listed)" : "tidy"} after Clean Up`);
  cleaned++;
}
for (const name of ["Cyclohexane chair", "Newman projection, anti", "Sawhorse projection, anti", "α-D-Glucopyranose (Haworth)", "β-D-Glucopyranose (chair)", "D-Glucose (Fischer)", "Rh2(OAc)4", "Ferrocene", "Cubane"])
  assert.ok(libraryItem(`lib:${name}`)!.mol.atoms.some((a) => a.location[2] || a.centre), `${name} is drawn in perspective`);
console.log(`templates: Clean Up leaves ${kept} perspective and π templates as drawn and keeps ${cleaned} others whole ok`);

// Issue 29: the Template button shows the last template used only while it reads at toolbar size. One ring system of
// up to 14 atoms, or up to 9 atoms, does; two ring systems (adenosine: a purine and a ribose) or a bigger one do not.
{
  const lib = (name: string) => libraryItem(`lib:${name}`)!.mol;
  for (const name of ["Benzene", "Naphthalene", "Anthracene", "Indole", "α-D-Glucopyranose", "Phenylalanine"]) assert.ok(legible(lib(name)), `${name} reads at toolbar size`);
  for (const name of ["Biphenyl", "Pyrene", "Porphyrin", "PPh3"]) assert.ok(!legible(lib(name)), `${name} shows the books`);
  const a = lib("Adenine"), r = lib("β-D-Ribofuranose"), n = a.atoms.length;
  const adenosine: Mol = { atoms: [...a.atoms, ...r.atoms], bonds: [...a.bonds, ...r.bonds.map((b) => ({ ...b, atoms: [b.atoms[0] + n, b.atoms[1] + n] as [number, number] }))] };
  assert.ok(!legible(adenosine), "adenosine shows the books");
  assert.ok(legible({ atoms: [], bonds: [] }), "a template of arrows or text keeps its own icon");
  console.log("templates: the Template button's icon reads at toolbar size ok");
}

// Issue 36: generic stereocentres come first in the Stereocentres set, before the named compounds. Each is a carbon
// with a wedge and a hash (or one of them, the H left out) whose narrow ends are at the carbon, or a Fischer cross; it
// gives no warning bare, and with its ends labelled F, Cl, Br and I in turn it is a stereocentre Indigo reads as set,
// R or S. The four turned drawings are one configuration; the wedge and hash three-bond drawings are mirror images.
{
  const { problems } = await import("./check.ts");
  const set = LIBRARY.find((c) => c.name === "Stereocentres")!.items, generic = set.slice(0, 7);
  assert.deepEqual(generic.map((t) => t.name), ["Stereocentre, plain bonds up", "Stereocentre, plain bonds down", "Stereocentre, plain bonds left", "Stereocentre, plain bonds right",
    "Stereocentre, three bonds, wedge", "Stereocentre, three bonds, hash", "Fischer projection, one centre"]);
  assert.equal(set[7].name, "(R)-Bromochlorofluoromethane", "then the named compounds");
  const config = (m: Mol) => {
    const c = m.atoms.findIndex((_, i) => m.bonds.filter((b) => b.atoms.includes(i)).length >= 3);
    for (const b of m.bonds) if (b.stereo) assert.equal(b.atoms[0], c, "the narrow end at the carbon");
    assert.deepEqual(problems(m, chem.stereoFacts(m)), [], "no warning bare");
    const ends = m.bonds.map((b) => b.atoms[1]), halo = ["F", "Cl", "Br", "I"];
    const x: Mol = { ...m, atoms: m.atoms.map((a, i) => (ends.includes(i) ? { ...a, label: halo[ends.indexOf(i)] } : a)) };
    // Indigo's warnings read wedges; a Fischer cross is read from its atoms' places, so its InChI must set the centre.
    const facts = chem.stereoFacts(x);
    if (m.bonds.some((b) => b.stereo)) assert.ok(facts.centres.has(c) && !facts.unset.has(c) && !facts.conflict.has(c), "a set stereocentre");
    else assert.match(chem.toInchi(x) ?? "", /\/t1-\/m[01]\/s1/, "a set stereocentre");
    return chem.cipOf(x).atoms[c];
  };
  const [up, down, left, right, wedge, hash, fischer] = generic.map((t) => config(t.mol));
  assert.ok(up === "R" || up === "S", up);
  assert.deepEqual([down, left, right], [up, up, up], "turned, the same configuration");
  assert.ok((wedge === "R" && hash === "S") || (wedge === "S" && hash === "R"), "mirror images");
  assert.ok(fischer === "R" || fischer === "S", fischer);
  console.log("templates: generic stereocentres first, each a set stereocentre ok");
}
