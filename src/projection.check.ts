// Run: node src/projection.check.ts. Stereo projection tools (projection.ts, stereonames.ts): Invert Configuration
// Here, Convert to Fischer Projection and Convert to Wedge Drawing, the D/L names, steroid α/β and the undefined-centre
// marks. ReShiki's tests (stereochemistry/tests.rs, fischer/tests.rs, native_fischer/tests.rs, dl_descriptors/tests.rs,
// steroid/tests.rs) re-expressed with Octet's own templates and small molecules typed here.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const gl = globalThis as Record<string, unknown>;
gl.document = { documentElement: {}, createElement: () => ({ getContext: () => ({}) }) };
gl.getComputedStyle = () => ({ getPropertyValue: () => "10" });
gl.window = globalThis;
gl.self = { location: { origin: "file://" } };
gl.fetch = async (u: URL | string) => new Response(readFileSync(new URL(String(u))), { headers: { "content-type": "application/wasm" } });
const chem = await import("./chem.ts");
await chem.ready;
const { fischerCross, fischerCrosses, invertAt, toFischer, toWedges, INVERT_SELECT } = await import("./projection.ts");
const { libraryItem } = await import("./library.ts");
type Mol = import("./render.ts").Mol;
type Atom = Mol["atoms"][number];

const lib = (name: string) => structuredClone(libraryItem(`lib:${name}`)!.mol) as Mol;
const ok = (r: { mol?: Mol; error?: string }, what: string): Mol => r.mol ?? assert.fail(`${what}: ${r.error}`);
const no = (r: { mol?: Mol; error?: string }, pattern: RegExp, what: string) => { assert.equal(r.mol, undefined, `${what} is refused`); assert.match(r.error ?? "", pattern, what); };
const inchi = (m: Mol | string) => chem.toInchi(typeof m === "string" ? chem.parseStructure(m) : m);
const labels = (m: Mol) => chem.cipOf(m).atoms;
// The stereo layer of an InChI (/t), for "only that centre changed".
// InChI writes the stereo layer relative, with /m1 for the inverted set: read back as absolute.
const layer = (i?: string) => { const m1 = /\/m1/.test(i ?? ""); return (/\/t([^/]*)/.exec(i ?? "")?.[1]?.split(",") ?? []).map((x) => (m1 ? x.replace(/[+-]$/, (s) => (s === "+" ? "-" : "+")) : x)); };
const turned = (m: Mol, deg: number): Mol => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return { ...m, atoms: m.atoms.map((a) => ({ ...a, location: [a.location[0] * c - a.location[1] * s, a.location[0] * s + a.location[1] * c, a.location[2]] })) }; };
const swap = (c?: string) => ({ R: "S", S: "R", r: "s", s: "r" })[c ?? ""];

// ---- Fischer recognition (fischer/tests.rs) ----
{
  const glc = lib("D-Glucose (Fischer)"), crosses = fischerCrosses(glc);
  assert.equal(crosses.length, 4, "D-glucose: four Fischer centres");
  for (const x of crosses) assert.ok(glc.atoms[x.up].location[1] > glc.atoms[x.centre].location[1] && glc.atoms[x.right].location[0] > glc.atoms[x.centre].location[0], "up is up, right is right (y up)");
  // A turn on the page keeps the configuration (depth holds it) but is no longer a Fischer projection; a half turn is.
  for (const deg of [9, -9]) assert.equal(fischerCrosses(turned(glc, deg)).length, 4, `${deg}° is still a Fischer projection`);
  for (const deg of [11, 90, 270]) {
    const t = turned(glc, deg);
    assert.equal(fischerCrosses(t).length, 0, `${deg}°: no Fischer centre`);
    assert.equal(inchi(t), inchi(glc), `${deg}°: the configuration is unchanged`);
    assert.deepEqual(labels(t), labels(glc));
  }
  assert.equal(fischerCrosses(turned(glc, 180)).length, 4, "a half turn is a Fischer projection");
  assert.equal(inchi(turned(glc, 180)), inchi(glc));
  // A flat cross (no depth), or one with a stereo bond, is no Fischer centre.
  const flat: Mol = { ...glc, atoms: glc.atoms.map((a) => ({ ...a, location: [a.location[0], a.location[1], 0] })) };
  assert.equal(fischerCrosses(flat).length, 0, "a flat cross");
  assert.equal(fischerCross({ ...glc, bonds: glc.bonds.map((b, k) => (k === 1 ? { ...b, display: "bold" } : b)) }, 1), undefined, "a bold arm");
  console.log("projection: Fischer centres read from depth on the page axes; a turn keeps the configuration ok");
}

// ---- Invert Configuration Here (stereochemistry/tests.rs) ----
{
  // Every centre of every Haworth and Fischer template: R ⇄ S there, every other centre unchanged, one /t entry changed.
  const names = ["α-D-Glucopyranose (Haworth)", "β-D-Glucopyranose (Haworth)", "α-D-Galactopyranose (Haworth)", "β-D-Galactopyranose (Haworth)", "α-D-Mannopyranose (Haworth)",
    "β-D-Mannopyranose (Haworth)", "α-D-Fructofuranose (Haworth)", "β-D-Fructofuranose (Haworth)", "D-Glucose (Fischer)", "D-Ribose (Fischer)", "L-Alanine (Fischer)",
    "D-Glyceraldehyde (Fischer)", "α-D-Glucopyranose (chair)", "β-D-Glucopyranose (chair)"];
  let n = 0;
  for (const name of names) {
    const m = lib(name), before = labels(m), t0 = layer(inchi(m));
    before.forEach((c, i) => {
      if (!c) return;
      const out = ok(invertAt(m, i), `${name} atom ${i}`), after = labels(out);
      assert.equal(after[i], swap(c), `${name} atom ${i}: ${c} becomes ${swap(c)}`);
      after.forEach((d, j) => j !== i && assert.equal(d, before[j], `${name}: atom ${j} keeps ${before[j]}`));
      const t1 = layer(inchi(out));
      assert.equal(t1.length, t0.length);
      assert.equal(t1.filter((x, k) => x !== t0[k]).length, 1, `${name} atom ${i}: one InChI centre changed`);
      assert.deepEqual(labels(ok(invertAt(out, i), "back")), before, `${name} atom ${i}: inverted twice is the original`);
      n++;
    });
  }
  // α-glucose C-1 → β-glucose; glucose C-2 → mannose (glucose_c2_inverts_to_mannose_without_changing_the_anomer).
  const a = lib("α-D-Glucopyranose (Haworth)"), c1 = 1, c2 = 2;
  assert.equal(inchi(ok(invertAt(a, c1), "C-1")), inchi(lib("β-D-Glucopyranose (Haworth)")), "α-glucose C-1 inverted is β-glucose");
  assert.equal(inchi(ok(invertAt(lib("β-D-Glucopyranose (Haworth)"), c2), "C-2")), inchi(lib("β-D-Mannopyranose (Haworth)")), "β-glucose C-2 inverted is β-mannose");
  // The anomeric OH moves to the other face (down to up) and the drawing keeps its ring.
  const b = ok(invertAt(a, c1), "C-1");
  assert.ok(a.atoms[6].location[1] < a.atoms[1].location[1] && b.atoms[6].location[1] > b.atoms[1].location[1], "O-1 goes from below the ring to above it");
  assert.deepEqual(b.atoms.slice(0, 6).map((x) => x.location), a.atoms.slice(0, 6).map((x) => x.location), "the ring stays");
  // L-alanine in Fischer → D-alanine; the arms swap sides, the chain stays.
  const ala = lib("L-Alanine (Fischer)"), d = ok(invertAt(ala, 1), "alanine");
  assert.equal(inchi(d), inchi("N[C@H](C)C(=O)O"), "D-alanine");
  assert.ok(d.atoms[2].location[0] > 0 && d.atoms[3].location[0] < 0, "N to the right, H to the left");
  assert.equal(fischerCross(d, 1)?.right, 2, "still a Fischer centre");
  console.log(`projection: Invert Configuration Here at ${n} centres of Haworth, chair and Fischer templates: only that centre changes ok`);
}
{
  // A wedge centre: the marks turn, no atom moves (drawn_wedge_r_inverts_to_s_by_swapping_marks_only); a hollow wedge
  // becomes a hashed bond (outline_wedges_and_long_hashes_keep_their_display_family).
  const at = (label: string, x: number, y: number): Atom => ({ label, location: [x, y, 0] });
  const chfclbr: Mol = { atoms: [at("C", 0, 0), at("F", 0, 1), at("Cl", -0.87, -0.5), at("Br", 0.87, -0.5)], bonds: [{ type: 1, atoms: [0, 1], stereo: 1 }, { type: 1, atoms: [0, 2] }, { type: 1, atoms: [0, 3] }] };
  const s = ok(invertAt(chfclbr, 0), "CHFClBr");
  assert.equal(labels(s)[0], swap(labels(chfclbr)[0]));
  assert.deepEqual(s.atoms, chfclbr.atoms, "no atom moves");
  assert.equal(s.bonds[0].stereo, 6, "the wedge is a hash");
  const hollow = ok(invertAt({ ...chfclbr, bonds: chfclbr.bonds.map((b, k) => (k ? b : { type: 1, atoms: [0, 1], display: "hollow" })) }, 0), "hollow");
  assert.equal(hollow.bonds[0].display, "hashed");
  // A configuration kept from a ChemDraw file, with no stereo bond (stored_winding_without_drawing_marks_can_be_inverted).
  const plain: Mol = { ...chfclbr, bonds: chfclbr.bonds.map(({ stereo: _, ...b }) => b) };
  const kept: Mol = { ...plain, atoms: plain.atoms.map((a, i) => (i ? a : { ...a, kept: { atoms: [1, 2, 3, -1], marks: "0>  0>  0>  h" } })) };
  const { stereoMarks } = await import("./cip.ts");
  kept.atoms[0].kept!.marks = stereoMarks(kept, 0, [1, 2, 3, -1]);
  const k = ok(invertAt(kept, 0), "kept");
  assert.equal(labels(k)[0], swap(labels(kept)[0]), "the kept configuration inverts");
  // Invalid atoms change nothing (invalid_or_undefined_atoms_fail_without_mutation).
  for (const [m, i] of [[plain, 0], [plain, 1], [plain, 9]] as const) no(invertAt(m, i), /Select one atom with a defined configuration/, `atom ${i}`);
  assert.equal(INVERT_SELECT, "Select one atom with a defined configuration.");
  console.log("projection: Invert Configuration Here on wedges, hollow wedges and a kept ChemDraw configuration; refusals ok");
}
{
  // Fischer arms moved whole, and a centre inside an arm keeps its configuration
  // (fischer_inversion_preserves_a_drawn_stereocentre_on_a_horizontal_branch): an arm (S)-CH(CH3)OH on the left.
  const glyc = lib("D-Glyceraldehyde (Fischer)"); // 0 CHO, 1 C, 2 H left, 3 O right, 4 CH2OH
  const m: Mol = { ...glyc, atoms: [...glyc.atoms.map((a, i) => (i === 2 ? { ...a, label: "C" } : a)), { label: "C", location: [-1.5, 0.87, 0.3] }, { label: "O", location: [-1.5, -0.87, 0.3] }],
    bonds: [...glyc.bonds, { type: 1, atoms: [2, 5], stereo: 1 }, { type: 1, atoms: [2, 6] }] };
  const before = labels(m);
  assert.ok(before[1] && before[2], "two centres");
  const out = ok(invertAt(m, 1), "arm");
  assert.equal(labels(out)[1], swap(before[1]));
  assert.equal(labels(out)[2], before[2], "the arm's own centre keeps its configuration");
  assert.ok(out.atoms[5].location[0] > 0 && out.atoms[6].location[0] > 0, "the arm moved whole to the right");
  // A reconnecting arm is refused, nothing changed (fischer_inversion_reflects_complete_branches_and_rejects_reconnections_atomically).
  const ring: Mol = { ...m, bonds: [...m.bonds, { type: 1, atoms: [5, 0] }] };
  if (labels(ring)[1]) no(invertAt(ring, 1), /joins the ring or chain again|joined/, "reconnecting arm");
  console.log("projection: Fischer arms move whole, inner centres kept, a reconnecting arm refused ok");
}

// ---- Convert to Fischer Projection and back (native_fischer/tests.rs) ----
{
  const round = (smiles: string, what: string) => {
    const m = chem.parseStructure(smiles), all = new Set(m.atoms.map((_, i) => i)), want = inchi(m);
    const f = ok(toFischer(m, all), `${what} to Fischer`);
    assert.equal(inchi(f), want, `${what}: the Fischer projection is the same compound`);
    const crosses = fischerCrosses(f);
    assert.ok(crosses.length >= 1, `${what}: Fischer centres`);
    assert.equal(crosses.length, labels(m).filter(Boolean).length, `${what}: every centre is a Fischer cross`);
    const top = f.atoms.map((_, i) => i).filter((i) => f.atoms[i].label === "C" && Math.abs(f.atoms[i].location[0] - f.atoms[crosses[0].centre].location[0]) < 1e-6).sort((p, q) => f.atoms[q].location[1] - f.atoms[p].location[1])[0];
    const w = ok(toWedges(f, new Set()), `${what} to wedges`);
    assert.equal(inchi(w), want, `${what}: back to wedges, the same compound`);
    assert.ok(w.atoms.every((a) => !a.location[2]), `${what}: flat`);
    assert.ok(w.bonds.some((b) => b.stereo), `${what}: wedges`);
    return { f, top };
  };
  // D-glucose (open chain), L-threonine, D-erythrose (the brief); L-alanine (reverse_fischer_roundtrip…).
  const glc = round("O=C[C@H](O)[C@@H](O)[C@H](O)[C@H](O)CO", "D-glucose");
  assert.equal(glc.f.atoms[glc.top].label, "C");
  assert.ok(glc.f.bonds.some((b) => b.type === 2 && b.atoms.includes(glc.top)), "D-glucose: the CHO carbon at the top");
  round("C[C@@H](O)[C@H](N)C(=O)O", "L-threonine");
  round("O=C[C@H](O)[C@H](O)CO", "D-erythrose");
  const ala = round("C[C@H](N)C(=O)O", "L-alanine");
  assert.ok(ala.f.bonds.some((b) => b.type === 2 && b.atoms.includes(ala.top)), "L-alanine: COOH at the top");
  assert.ok(ala.f.atoms.some((a) => a.label === "H"), "an explicit H on the centre");
  // Unsupported input is refused, unchanged (unsupported_reverse_is_clear_and_never_changes_input).
  const all = (m: Mol) => new Set(m.atoms.map((_, i) => i));
  for (const [smiles, what] of [["C1CC[C@H](O)CC1C", "cyclic"], ["CCCCC(CCCC)C[C@H](O)Cl", "off-chain centre"], ["C/C=C/[C@H](O)CC", "E double bond"], ["CCCO", "no centre"]]) {
    const m = chem.parseStructure(smiles);
    no(toFischer(m, all(m)), /Fischer projection needs/, what);
  }
  const two = chem.parseStructure("C[C@H](N)C(=O)O.C[C@@H](N)C(=O)O");
  no(toFischer(two, all(two)), /Select one structure/, "two structures");
  // Wedges back from the Fischer templates.
  for (const name of ["D-Glucose (Fischer)", "D-Ribose (Fischer)", "L-Alanine (Fischer)", "D-Glyceraldehyde (Fischer)", "L-Glyceraldehyde (Fischer)"]) {
    const m = lib(name), w = ok(toWedges(m, new Set()), name);
    assert.equal(inchi(w), inchi(m), `${name}: the same compound with wedges`);
    assert.equal(w.atoms.filter((a) => a.label === "H").length, 0, `${name}: the projection's H atoms go`);
  }
  // A Fischer projection turned off its axes still converts (off_axis_fischer_still_requires_and_supports_wedge_conversion).
  const off = turned(lib("D-Glucose (Fischer)"), 30);
  assert.equal(inchi(ok(toWedges(off, new Set()), "turned")), inchi(off));
  no(toWedges(chem.parseStructure("C[C@H](N)C(=O)O"), new Set()), /Select a Fischer projection/, "a flat drawing");
  console.log("projection: Convert to Fischer Projection and Convert to Wedge Drawing keep the InChI (D-glucose, L-threonine, D-erythrose, L-alanine, templates) ok");
}

// ---- D/L, steroid α/β and undefined marks (stereonames.ts) ----
const { stereoNames, stereoTexts } = await import("./stereonames.ts");
const dir = new URL("./vendor/opsin/", import.meta.url);
if (!existsSync(new URL("opsin.js", dir))) { console.log("projection: names skipped (no OPSIN build)"); process.exit(0); }
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
const { attachOpsin, nameToSmiles } = await import("./names.ts");
attachOpsin(opsin, readFileSync(new URL("names.txt", dir), "utf8"), json("./nameindex.json"), DRUGS, json("./abbreviations.json"));
const named = (name: string) => chem.parseStructure(nameToSmiles(name) ?? assert.fail(`${name} is read`));
const dlOf = (m: Mol) => [...stereoNames(m, { dl: true }).dl.entries()].map(([i, d]) => `${d}:${labels(m)[i]}`).sort();
{
  // The 19 chiral proteinogenic amino acids: L, at Cα only (by its own R or S: L-cysteine is L (R)); glycine none; the
  // D enantiomers D. (amino_acids_follow_priorities_not_a_fixed_r_s_map)
  const acids = ["alanine", "arginine", "asparagine", "aspartic acid", "cysteine", "glutamine", "glutamic acid", "histidine", "isoleucine", "leucine", "lysine", "methionine",
    "phenylalanine", "proline", "serine", "threonine", "tryptophan", "tyrosine", "valine"];
  for (const a of acids) {
    const l = dlOf(named(`L-${a}`)), d = dlOf(named(`D-${a}`));
    assert.equal(l.length, 1, `L-${a}: one D/L name (${l})`);
    assert.match(l[0], /^L:[RS]$/, `L-${a}`);
    assert.deepEqual(d, [l[0].replace("L:R", "D:S").replace("L:S", "D:R")], `D-${a}`);
  }
  assert.deepEqual(dlOf(named("L-cysteine")), ["L:R"], "L-cysteine is L (R)");
  assert.deepEqual(dlOf(named("glycine")), [], "glycine has none");
  // Off by default, and only on R/S centres: an α-amino ketone has none; a dipeptide names both residues.
  assert.equal(stereoNames(named("L-alanine"), {}).dl.size, 0, "off by default");
  assert.deepEqual(dlOf(chem.parseStructure("C[C@H](N)C(=O)C")), [], "an α-amino ketone");
  assert.deepEqual(dlOf(named("L-alanyl-L-alanine")), ["L:S", "L:S"], "both residues of a dipeptide");
  // In a Fischer projection, turned, and as wedges: the same name.
  const ala = lib("L-Alanine (Fischer)");
  assert.deepEqual(dlOf(ala), ["L:S"], "L-alanine (Fischer)");
  assert.deepEqual(dlOf(turned(ala, 90)), ["L:S"], "turned 90°");
  assert.deepEqual(dlOf(ok(invertAt(ala, 1), "D-Ala")), ["D:R"], "inverted, D-alanine");
  // The aldohexoses, open chain: D from the highest-numbered centre (C-5) only; their L enantiomers L.
  for (const s of ["allose", "altrose", "glucose", "mannose", "gulose", "idose", "galactose", "talose"]) {
    assert.deepEqual(dlOf(named(`D-${s}`)), ["D:R"], `D-${s}`);
    assert.deepEqual(dlOf(named(`L-${s}`)), ["L:S"], `L-${s}`);
  }
  for (const name of ["D-Glucose (Fischer)", "D-Ribose (Fischer)", "D-Glyceraldehyde (Fischer)"]) assert.deepEqual(dlOf(lib(name)), ["D:R"], name);
  assert.deepEqual(dlOf(lib("L-Glyceraldehyde (Fischer)")), ["L:S"]);
  // Ring forms (Haworth, chair): C-5 of a pyranose, C-4 of a furanose, and C-4 of a pentopyranose (the ring CH2 is C-5).
  for (const name of ["α-D-Glucopyranose (Haworth)", "β-D-Glucopyranose (Haworth)", "α-D-Galactopyranose (Haworth)", "β-D-Mannopyranose (Haworth)", "α-D-Fructofuranose (Haworth)",
    "β-D-Fructofuranose (Haworth)", "α-D-Glucopyranose (chair)", "β-D-Glucopyranose (chair)"]) {
    const m = lib(name), names = stereoNames(m, { dl: true }).dl;
    assert.deepEqual([...names.values()], ["D"], `${name}: one D`);
  }
  assert.deepEqual(dlOf(named("beta-D-xylopyranose")), ["D:R"], "β-D-xylopyranose at C-4");
  assert.deepEqual(dlOf(named("alpha-L-arabinopyranose")).map((x) => x[0]), ["L"], "α-L-arabinopyranose");
  // The text: "L (S)", the L upright and the S italic (text_runs).
  const t = stereoTexts(labels(ala), stereoNames(ala, { dl: true }), (c) => `(${c})`).get(1)!;
  assert.deepEqual([t.prefix, t.text, t.added], ["L ", "(S)", true]);
  console.log("projection: D and L on the 19 chiral amino acids, the aldohexoses, Fischer, Haworth and chair sugars ok");
}
{
  // Steroid α and β (opsin_named_faces_pin_alpha_beta_parity_and_natural_junctions).
  const faces = (m: Mol) => [...stereoNames(m, { steroid: true }).steroid.values()].sort((p, q) => parseInt(p) - parseInt(q)).join(" ");
  assert.equal(faces(named("5alpha-androstane-3beta,17beta-diol")), "3β 5α 8β 9α 10β 13β 14α 17β");
  assert.equal(faces(named("5beta-androstane-3alpha,17beta-diol")), "3α 5β 8β 9α 10β 13β 14α 17β");
  const chol = named("cholesterol");
  assert.equal(faces(chol), "3β 8β 9α 10β 13β 14α 17β", "cholesterol");
  const c20 = chol.atoms.findIndex((_, i) => labels(chol)[i] && !stereoNames(chol, { steroid: true }).steroid.has(i));
  assert.ok(c20 >= 0, "cholesterol's C-20 keeps R or S");
  assert.equal(faces(named("estra-1,3,5(10)-triene-3,17beta-diol")), "8β 9α 13β 14α 17β", "estradiol: no C-10 centre");
  // The mirror image swaps every face; a 17-ethynyl steroid's C-17 keeps R or S (two groups other than H).
  const mirror: Mol = { ...chol, atoms: chol.atoms.map((a) => ({ ...a, location: [-a.location[0], a.location[1], 0] })) };
  assert.equal(faces(mirror), "3α 8α 9β 10α 13α 14β 17α", "the mirror image");
  assert.ok(!faces(named("17alpha-ethynyl-17beta-hydroxyestr-4-en-3-one")).includes("17"), "norethisterone's C-17 keeps R or S");
  console.log("projection: steroid α and β on androstanediols, cholesterol, estradiol and a mirror image ok");
}
{
  // Undefined centres: (?) or (Ξ), and ξ for a pseudoasymmetric one (2,3,4-trihydroxyglutaric acid's C-3 with C-2 and
  // C-4 set); a wavy bond, or a set centre, gets none.
  const butanol = chem.parseStructure("CCC(C)O");
  assert.deepEqual([...stereoNames(butanol, { unset: "?" }).unset.values()], ["?"]);
  assert.deepEqual([...stereoNames(butanol, { unset: "Ξ" }).unset.values()], ["Ξ"]);
  assert.equal(stereoNames(chem.parseStructure("CC[C@H](C)O"), { unset: "Ξ" }).unset.size, 0, "a set centre");
  const wavy: Mol = { ...butanol, bonds: butanol.bonds.map((b) => (b.atoms.includes(2) && b.atoms.includes(4) ? { ...b, atoms: [2, 4] as [number, number], display: "wavy" as const } : b)) };
  assert.equal(stereoNames(wavy, { unset: "Ξ" }).unset.size, 0, "a wavy bond");
  const ribaric = chem.parseStructure("OC(=O)[C@H](O)C(O)[C@H](O)C(=O)O"), marks = stereoNames(ribaric, { unset: "Ξ" }).unset;
  assert.deepEqual([...marks.values()], ["ξ"], "the pseudoasymmetric C-3");
  assert.deepEqual([...stereoTexts([], { dl: new Map(), steroid: new Map(), unset: marks }, (c) => `(${c})`).values()][0], { text: "(ξ)", upright: true, muted: true, added: true });
  console.log("projection: undefined centres marked (?), (Ξ) and (ξ) ok");
}
{
  // Consistency (decision 0019): the commands' drawings save to .oct and read back the same; copy and paste is the same
  // JSON; CDXML writes D/L, α/β and Ξ as plain text Octet skips when it reads its own file back, with ShowAtomStereo no
  // on those atoms, and plain R/S as ChemDraw's ShowAtomStereo.
  const { serialize, parse } = await import("./file.ts");
  const { toCdxml, fromCdxml } = await import("./cdxml.ts");
  const { DEFAULT_STYLE } = await import("./docstyle.ts");
  const ala = ok(invertAt(lib("L-Alanine (Fischer)"), 1), "D-Ala"), glc = chem.parseStructure("O=C[C@H](O)[C@@H](O)[C@H](O)[C@H](O)CO");
  const fischer = ok(toFischer(glc, new Set()), "glucose");
  for (const m of [ala, fischer, ok(toWedges(fischer, new Set()), "wedges")]) {
    const back = parse(serialize(m));
    assert.equal(inchi(back), inchi(m), "saved and read back the same");
    assert.ok(back.atoms.every((a, i) => a.location.every((v, d) => Math.abs(v - (m.atoms[i].location[d] ?? 0)) < 1e-3)), `with its depth ${JSON.stringify(back.atoms.map((a, i) => [a.location, m.atoms[i].location]).filter(([p, q]) => p.some((v, d) => Math.abs(v - (q[d] ?? 0)) >= 1e-3)))}`);
  }
  const shown: Mol = { ...ala, atoms: ala.atoms.map((a) => ({ ...a, cip: true as const })) };
  const opts = { stereoTexts: (m: Mol) => stereoTexts(labels(m), stereoNames(m, { dl: true }), (c: string) => `(${c})`) };
  const plain = toCdxml(shown, DEFAULT_STYLE), named = toCdxml(shown, DEFAULT_STYLE, opts);
  assert.ok(!/>D <\/s>/.test(plain) && /ShowAtomStereo="yes"/.test(plain), "no names: R/S as ChemDraw's ShowAtomStereo");
  assert.match(named, /<t\s[^>]*Octet="\{&quot;d&quot;:1\}"[^>]*><s [^>]*>D <\/s><s [^>]*face="2"[^>]*>\(R\)<\/s><\/t>/, "D (R) as text, the R italic");
  assert.ok((named.match(/ShowAtomStereo="no"/g) ?? []).length >= 1, "ShowAtomStereo no on the named atom");
  const read = fromCdxml(named);
  assert.ok(!(read.mol.captions ?? []).some((c) => /D/.test(c.text)), "Octet skips its own name text when it reads the file back");
  // The menu, command palette and Actions panel wiring.
  const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  const editor = src("./Editor.tsx"), actions = src("./Actions.tsx"), menu = src("../src-tauri/src/main.rs"), win = src("./SettingsWindow.tsx");
  for (const id of ["invert_here", "to_fischer", "to_wedges"]) {
    assert.ok(editor.includes(`    ${id}: () =>`) && editor.includes(`${id}: ["`), `${id}: a command with a name`);
    assert.ok(actions.includes(`"${id}"`), `${id}: in the Actions panel`);
    assert.ok(menu.includes(`&item("${id}", `), `${id}: in the Structure menu`);
  }
  for (const label of ["D and L names", "Steroid alpha and beta", "Undefined stereocentres"]) assert.ok(win.includes(`"${label}"`), `Settings: ${label}`);
  console.log("projection: .oct round trip with depth, CDXML names as plain text, menu, palette, panel and settings wiring ok");
}
