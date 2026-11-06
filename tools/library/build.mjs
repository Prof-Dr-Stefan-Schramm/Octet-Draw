// Builds src/library.json, Octet's own template library. Run: node tools/library/build.mjs
// - Structures from their names: each name goes through OPSIN (or its SMILES is given), Indigo lays it out, and the
//   drawing is kept at bond length 1, centred. A functional group's first atom is its R, where it joins.
// - Structures drawn in perspective (perspective.mjs) and π complexes (organometallics.mjs), worked out from geometry.
//   A hexose's or Fischer projection's stereocentres are placed each way, and the build keeps the way whose InChI is
//   the named compound's.
// - The Lab group (glassware and lamps) is drawn in lab.mjs.
// Nothing comes from another program's files.
import { readFileSync, writeFileSync } from "node:fs";
import { LAB, TLC } from "./lab.mjs";
import { conformers, cube, fischerWays, FRUCTOSES, hexose, HEXOSES, paddlewheel, PADDLEWHEELS, stereocentres } from "./perspective.mjs";
import { clashes } from "./clashes.mjs";
import { CP_RINGS, DPPF, METALLOCENES } from "./organometallics.mjs";

const root = new URL("../../", import.meta.url);
const pack = readFileSync(new URL("src/vendor/opsin/opsin-data.bin", root));
const files = new Map();
for (let p = 0; ; ) {
  const n = pack.readUInt16BE(p); p += 2;
  if (!n) break;
  const name = pack.toString("latin1", p, p + n); p += n;
  const size = pack.readInt32BE(p); p += 4;
  files.set(name, new Int8Array(pack.buffer, pack.byteOffset + p, size)); p += size;
}
globalThis.opsinResource = (name) => files.get(name) ?? null;
const opsin = await import(new URL("src/vendor/opsin/opsin.js", root).href);
opsin.init();
const indigo = await (await import(new URL("node_modules/indigo-ketcher/indigo-ketcher-norender.js", root).href)).default();
// chem.ts (for InChIs) reads the drawing tokens and loads Indigo's wasm as a browser does; these stand in for the browser.
Object.assign(globalThis, {
  document: { documentElement: {}, createElement: () => ({ getContext: () => ({}) }) }, getComputedStyle: () => ({ getPropertyValue: () => "10" }),
  window: globalThis, self: { location: { origin: "file://" } },
  fetch: async (u) => new Response(readFileSync(new URL(String(u))), { headers: { "content-type": "application/wasm" } }),
});
const chem = await import(new URL("src/chem.ts", root).href);
await chem.ready;

// [shown name, OPSIN name or "smiles:...", more words the search finds it by]. A shown name alone is read by OPSIN.
const NAMED = {
  "Amino acids": [
    ["Glycine"], ["Alanine", "L-alanine"], ["Valine", "L-valine"], ["Leucine", "L-leucine"], ["Isoleucine", "L-isoleucine"],
    ["Proline", "L-proline"], ["Phenylalanine", "L-phenylalanine"], ["Tryptophan", "L-tryptophan"], ["Methionine", "L-methionine"],
    ["Serine", "L-serine"], ["Threonine", "L-threonine"], ["Cysteine", "L-cysteine"], ["Tyrosine", "L-tyrosine"], ["Asparagine", "L-asparagine"],
    ["Glutamine", "L-glutamine"], ["Aspartic acid", "L-aspartic acid"], ["Glutamic acid", "L-glutamic acid"], ["Lysine", "L-lysine"],
    ["Arginine", "L-arginine"], ["Histidine", "L-histidine"],
  ],
  "Sugars": [
    ["α-D-Glucopyranose", "alpha-D-glucopyranose"], ["β-D-Glucopyranose", "beta-D-glucopyranose"], ["β-D-Galactopyranose", "beta-D-galactopyranose"],
    ["α-D-Mannopyranose", "alpha-D-mannopyranose"], ["β-D-Fructofuranose", "beta-D-fructofuranose"], ["β-D-Ribofuranose", "beta-D-ribofuranose"],
    ["2-Deoxy-β-D-ribofuranose", "2-deoxy-beta-D-ribofuranose"], ["D-Glucose (open chain)", "D-glucose"],
  ],
  "Stereocentres": [
    ["(R)-Bromochlorofluoromethane", "(1R)-bromo(chloro)(fluoro)methane", "CHBrClF"], ["(S)-Bromochlorofluoromethane", "(1S)-bromo(chloro)(fluoro)methane", "CHBrClF"],
    ["(R)-Butan-2-ol", "(2R)-butan-2-ol", "2-butanol"], ["(S)-Butan-2-ol", "(2S)-butan-2-ol", "2-butanol"],
    ["(R)-Lactic acid", "(2R)-2-hydroxypropanoic acid", "D-lactic acid"], ["(S)-Lactic acid", "(2S)-2-hydroxypropanoic acid", "L-lactic acid"],
    ["(R)-Glyceraldehyde", "(2R)-2,3-dihydroxypropanal", "D-glyceraldehyde"], ["(S)-Glyceraldehyde", "(2S)-2,3-dihydroxypropanal", "L-glyceraldehyde"],
    ["(R,R)-Tartaric acid", "(2R,3R)-2,3-dihydroxybutanedioic acid", "L-tartaric acid"], ["(S,S)-Tartaric acid", "(2S,3S)-2,3-dihydroxybutanedioic acid", "D-tartaric acid"],
    ["meso-Tartaric acid", "(2R,3S)-2,3-dihydroxybutanedioic acid"],
    ["trans-Cyclohexane-1,2-diol", "(1R,2R)-cyclohexane-1,2-diol"], ["cis-Cyclohexane-1,2-diol", "(1R,2S)-cyclohexane-1,2-diol"],
  ],
  "Cycloalkanes": [
    ["Cyclopropane"], ["Cyclobutane"], ["Cyclopentane"], ["Cyclohexane"], ["Cycloheptane"], ["Cyclooctane"],
    ["Cyclopropene"], ["Cyclobutene"], ["Cyclopentene"], ["Cyclopentadiene", "cyclopenta-1,3-diene", "CpH"], ["Cyclohexene"],
    ["Cyclohexa-1,3-diene"], ["Cyclohexa-1,4-diene"], ["Cycloheptene"], ["Cycloheptatriene", "cyclohepta-1,3,5-triene"],
    ["Cyclooctene", "(Z)-cyclooctene"], ["Cyclooctatetraene", "cycloocta-1,3,5,7-tetraene", "COT"],
  ],
  "Aromatics": [
    ["Benzene"], ["Toluene"], ["o-Xylene", "1,2-dimethylbenzene"], ["m-Xylene", "1,3-dimethylbenzene"], ["p-Xylene", "1,4-dimethylbenzene"],
    ["Mesitylene", "1,3,5-trimethylbenzene"], ["Styrene", "ethenylbenzene"], ["Biphenyl", "1,1'-biphenyl"], ["p-Terphenyl", "1,4-diphenylbenzene"],
    ["Naphthalene"], ["Azulene"], ["Indene", "1H-indene"], ["Indane", "2,3-dihydro-1H-indene"], ["Tetralin", "1,2,3,4-tetrahydronaphthalene"],
    ["Fluorene", "9H-fluorene"], ["Anthracene"], ["Phenanthrene"], ["Acenaphthylene"], ["Fluoranthene"], ["Tetracene"], ["Triphenylene"],
    ["Chrysene"], ["Pyrene"], ["Perylene"], ["Coronene"],
  ],
  "Bicyclics": [
    ["Bicyclo[1.1.0]butane"], ["Bicyclo[1.1.1]pentane"], ["Bicyclo[2.1.1]hexane"], ["Bicyclo[3.1.0]hexane"], ["Norcarane", "bicyclo[4.1.0]heptane"],
    ["Bicyclo[3.1.1]heptane"], ["Norbornane", "bicyclo[2.2.1]heptane"], ["Norbornene", "bicyclo[2.2.1]hept-2-ene"],
    ["Norbornadiene", "bicyclo[2.2.1]hepta-2,5-diene", "nbd"], ["Bicyclo[2.2.2]octane"], ["Bicyclo[3.2.1]octane"],
    ["Bicyclo[3.3.0]octane", "octahydropentalene"], ["Bicyclo[4.2.0]octane"], ["Bicyclo[3.3.1]nonane"], ["Hydrindane", "octahydro-1H-indene"],
    ["Decalin", "decahydronaphthalene"], ["cis-Decalin", "cis-decahydronaphthalene"], ["trans-Decalin", "trans-decahydronaphthalene"],
    ["Adamantane"], ["Spiro[2.2]pentane"], ["Spiro[3.3]heptane"], ["Spiro[4.5]decane"], ["Spiro[5.5]undecane"],
  ],
  "Heterocycles": [
    ["Pyridine"], ["Pyrrole", "1H-pyrrole"], ["Furan"], ["Thiophene"], ["Imidazole", "1H-imidazole"], ["Pyrazole", "1H-pyrazole"], ["Oxazole"], ["Thiazole"],
    ["Pyrimidine"], ["Pyrazine"], ["Pyridazine"], ["1,3,5-Triazine"], ["Tetrazole", "1H-tetrazole"], ["Indole", "1H-indole"], ["Benzofuran", "1-benzofuran"],
    ["Benzothiophene", "1-benzothiophene"], ["Quinoline"], ["Isoquinoline"], ["Purine", "7H-purine"], ["Carbazole", "9H-carbazole"],
    ["Piperidine"], ["Piperazine"], ["Morpholine"], ["Pyrrolidine"], ["Tetrahydrofuran", "oxolane"], ["Tetrahydropyran", "oxane"], ["Oxetane"], ["Oxirane"], ["Aziridine"],
  ],
  // Names as common.ts keys them, so the library's search shows the library's own drawing for an abbreviation.
  "Ligands": [
    ["PPh3", "triphenylphosphane", "triphenylphosphine"], ["PCy3", "tricyclohexylphosphane"], ["P(t-Bu)3", "tri-tert-butylphosphane"],
    ["dppm", "methylenebis(diphenylphosphane)"], ["dppe", "ethane-1,2-diylbis(diphenylphosphane)"], ["dppp", "propane-1,3-diylbis(diphenylphosphane)"],
    ["BINAP", "[1,1'-binaphthalene]-2,2'-diylbis(diphenylphosphane)"], ["Xantphos", "(9,9-dimethyl-9H-xanthene-4,5-diyl)bis(diphenylphosphane)"],
    ["XPhos", "smiles:CC(C)c1cc(C(C)C)c(-c2ccccc2P(C2CCCCC2)C2CCCCC2)c(C(C)C)c1"], ["SPhos", "smiles:COc1cccc(OC)c1-c1ccccc1P(C1CCCCC1)C1CCCCC1"],
    ["bpy", "2,2'-bipyridine", "bipy"], ["dtbbpy", "4,4'-di-tert-butyl-2,2'-bipyridine"], ["phen", "1,10-phenanthroline"],
    ["tpy", "2,2':6',2''-terpyridine", "terpy, terpyridine"], ["en", "ethane-1,2-diamine", "ethylenediamine"],
    ["TMEDA", "N,N,N',N'-tetramethylethane-1,2-diamine"], ["cod", "cycloocta-1,5-diene"], ["dba", "(1E,4E)-1,5-diphenylpenta-1,4-dien-3-one"],
    ["Cp", "smiles:[CH-]1C=CC=C1", "cyclopentadienyl"], ["Cp*", "smiles:C[C-]1C(C)=C(C)C(C)=C1C", "pentamethylcyclopentadienyl"],
    ["Cp*H", "1,2,3,4,5-pentamethylcyclopenta-1,3-diene"], ["acacH", "pentane-2,4-dione", "acac, acetylacetone"],
    ["salen", "smiles:Oc1ccccc1/C=N/CC/N=C/c1ccccc1O"], ["Porphyrin", "21H,23H-porphine", "porphine"],
    ["H2TPP", "5,10,15,20-tetraphenyl-21H,23H-porphine", "tetraphenylporphyrin"], ["Phthalocyanine", "29H,31H-phthalocyanine"],
    ["IMes", "smiles:Cc1cc(C)c(c(C)c1)N1[C]N(C=C1)c1c(C)cc(C)cc1C"], ["IPr", "smiles:CC(C)c1cccc(C(C)C)c1N1[C]N(c2c(C(C)C)cccc2C(C)C)C=C1"],
    ["DMAP", "N,N-dimethylpyridin-4-amine"], ["DABCO", "1,4-diazabicyclo[2.2.2]octane"],
    ["BOX", "2,2'-(propane-2,2-diyl)bis(4,5-dihydro-1,3-oxazole)", "bis(oxazoline)"], ["PyBOX", "smiles:C1COC(=N1)c1cccc(n1)C1=NCCO1", "pybox"],
  ],
};
// Functional groups: [name, SMILES with the R atom first, more words].
const GROUPS = [
  ["Alkene", "CC=C", "vinyl"], ["Alkyne", "CC#C", "ethynyl"], ["Halide", "CX", "alkyl halide, halogen"], ["Alcohol", "CO", "hydroxy"],
  ["Ether", "COC", "methoxy"], ["Aldehyde", "CC=O", "formyl"], ["Ketone", "CC(C)=O", "carbonyl"], ["Carboxylic acid", "CC(=O)O", "carboxy, COOH"],
  ["Ester", "CC(=O)OC", "carboxylate"], ["Amide", "CC(N)=O", "carboxamide"], ["Weinreb amide", "CC(=O)N(C)OC"], ["Acid chloride", "CC(Cl)=O", "acyl chloride"],
  ["Anhydride", "CC(=O)OC(C)=O", "acid anhydride"], ["Imide", "CC(=O)NC(C)=O"], ["Thioester", "CC(=O)SC"], ["Nitrile", "CC#N", "cyano"],
  ["Primary amine", "CN", "amino"], ["Secondary amine", "CNC", "amino"], ["Tertiary amine", "CN(C)C", "amino"], ["Imine", "C/C=N/C", "Schiff base"],
  ["Oxime", "C/C=N/O"], ["Hydrazone", "C/C=N/N"], ["Nitro", "C[N+](=O)[O-]"], ["Nitroso", "CN=O"], ["Azide", "CN=[N+]=[N-]"],
  ["Diazo", "CC=[N+]=[N-]"], ["Isocyanate", "CN=C=O"], ["Isothiocyanate", "CN=C=S"], ["Carbamate", "CNC(=O)OC", "urethane"],
  ["Urea", "CNC(N)=O"], ["Guanidine", "CNC(N)=N"], ["Carbonate", "COC(=O)OC"], ["Acetal", "CC(OC)OC"], ["Thiol", "CS", "sulfanyl, mercaptan"],
  ["Sulfide", "CSC", "thioether"], ["Disulfide", "CSSC"], ["Sulfoxide", "CS(C)=O"], ["Sulfone", "CS(C)(=O)=O"], ["Sulfonic acid", "CS(=O)(=O)O"],
  ["Sulfonamide", "CS(N)(=O)=O"], ["Sulfonate ester", "CS(=O)(=O)OC", "mesylate, tosylate"], ["Phosphate", "COP(=O)(O)O"],
  ["Boronic acid", "CB(O)O"], ["Pinacol boronate", "CB1OC(C)(C)C(C)(C)O1", "Bpin, boronic ester"],
];
// Fischer projections: [name, top, centres, group, bottom, the compound's name, more words].
const FISCHER = [
  ["D-Glyceraldehyde (Fischer)", "CHO", 1, "O", "CH2OH", "(2R)-2,3-dihydroxypropanal", "(R)-glyceraldehyde, Fischer projection"],
  ["L-Glyceraldehyde (Fischer)", "CHO", 1, "O", "CH2OH", "(2S)-2,3-dihydroxypropanal", "(S)-glyceraldehyde, Fischer projection"],
  ["L-Alanine (Fischer)", "COOH", 1, "N", "CH3", "L-alanine", "(S)-alanine, Fischer projection"],
  ["D-Ribose (Fischer)", "CHO", 3, "O", "CH2OH", "D-ribose", "Fischer projection"],
  ["D-Glucose (Fischer)", "CHO", 4, "O", "CH2OH", "D-glucose", "Fischer projection"],
];

const opts = new indigo.MapStringString();
opts.set("output-content-type", "application/json");
opts.set("dearomatize-on-load", "true");
const r3 = (n) => Math.round(n * 1000) / 1000 + 0;
const failed = [];
const smilesOf = (source) => { if (source.startsWith("smiles:")) return source.slice(7); try { return opsin.parseToSmiles(source) || ""; } catch { return ""; } };
const inchiOf = (s) => { try { return chem.toInchi(s); } catch { return undefined; } };
// A structure from SMILES as Indigo lays it out: bond length 1 (the median), centred on its atoms.
function laidOut(smiles) {
  const ket = JSON.parse(JSON.parse(indigo.layout(smiles, "ket", opts)).struct);
  const atoms = [], bonds = [];
  for (const { $ref } of ket.root.nodes) {
    const f = ket[$ref];
    if (f?.type !== "molecule") continue;
    const base = atoms.length;
    atoms.push(...f.atoms.map((a) => ({ label: a.label, x: a.location[0], y: a.location[1], charge: a.charge, radical: a.radical })));
    bonds.push(...f.bonds.map((b) => [b.atoms[0] + base, b.atoms[1] + base, b.type, ...(b.stereo ? [b.stereo] : [])]));
  }
  const lengths = bonds.map(([a, b]) => Math.hypot(atoms[a].x - atoms[b].x, atoms[a].y - atoms[b].y)).sort((a, b) => a - b);
  const k = 1 / (lengths[Math.floor(lengths.length / 2)] || 1);
  const cx = atoms.reduce((s, a) => s + a.x, 0) / atoms.length, cy = atoms.reduce((s, a) => s + a.y, 0) / atoms.length;
  return { atoms: atoms.map((a) => ({ ...a, x: r3((a.x - cx) * k), y: r3((a.y - cy) * k) })), bonds };
}
// KET's radical (1 a singlet, as a carbene's lone pair; 2 one unpaired electron; 3 two) as Octet keeps it (render.ts
// Atom.radical: 1 a doublet, 2 a triplet, 3 a singlet).
const octetRadical = (r) => (r === 1 ? 3 : r - 1);
// A laid-out structure in the library's short form: [label, x, y, charge, radical] and [a, b, type, stereo].
const compact = ({ atoms, bonds }) => ({
  atoms: atoms.map((a) => [a.label, a.x, a.y, ...(a.charge || a.radical ? [a.charge ?? 0] : []), ...(a.radical ? [octetRadical(a.radical)] : [])]), bonds,
});
// The same as a Mol, for structures the short form cannot hold (a written label).
const asMol = ({ atoms, bonds }) => ({
  atoms: atoms.map((a) => ({ label: a.label, location: [a.x, a.y, 0], ...(a.charge ? { charge: a.charge } : {}), ...(a.radical ? { radical: octetRadical(a.radical) } : {}) })),
  bonds: bonds.map(([a, b, type, stereo]) => ({ type, atoms: [a, b], ...(stereo ? { stereo } : {}) })),
});
const entry = (name, also, body) => ({ name, ...(also ? { also } : {}), ...body });
const rounded = (m) => ({ ...m, atoms: m.atoms.map((a) => ({ ...a, location: a.location.map(r3) })) });


// The way (of several drawings) that is the named compound: its InChI, stereochemistry included, is the name's.
function picker(name) {
  const want = inchiOf(smilesOf(name));
  if (!want) throw new Error(`no InChI for ${name}`);
  return (list, get = (x) => x) => {
    const found = list.filter((x) => inchiOf(get(x)) === want);
    if (found.length > 1) throw new Error(`${name}: ${found.length} drawings are it`);
    return found[0];
  };
}
const fail = (what) => { throw new Error(what); };

const out = [];
// Bridged rings (norbornane, adamantane) stay flat, as Indigo lays them out: drawn in 3D, their bridgeheads read as
// stereocentres, and Structure to Name gives them no name. Where Indigo's layout runs a bond through a label (a
// porphyrin's NH), Octet's Clean Up lays it out again, and the clearer of the two is kept.
const named = (category) => NAMED[category].flatMap(([shown, source = shown, also]) => {
  const smiles = smilesOf(source);
  if (!smiles) { failed.push(shown); return []; }
  const flat = laidOut(smiles), crowded = clashes(asMol(flat)).length;
  if (crowded) { const again = rounded(chem.cleanUp(asMol(flat))); if (clashes(again).length < crowded) return [entry(shown, also, { mol: again })]; }
  return [entry(shown, also, compact(flat))];
});
// The nucleobases all face one way: the atom that bonds to the sugar (N9 of a purine, N1 of a pyrimidine) at the
// bottom, its bond to the sugar pointing straight down, and the Watson-Crick edge (N1 or N3 and the groups beside it)
// on the right (a pyrimidine's C4 group on the line straight up from N1). Purines are the 9H tautomers, so the NH is where the sugar goes. [name, SMILES with the sugar's N
// first, the Watson-Crick atoms by their place in the SMILES, the other edge's atoms (C5, C6 or N7, C8)].
export const NUCLEOBASES = [
  ["Adenine", "N1C=NC2=C1N=CN=C2N", [6, 7, 8, 9], [1, 2]],
  ["Guanine", "N1C=NC2=C1N=C(N)NC2=O", [6, 7, 8, 9, 10], [1, 2]],
  ["Cytosine", "N1C=CC(N)=NC1=O", [3, 4, 5, 6, 7], [1, 2]],
  ["Thymine", "N1C=C(C)C(=O)NC1=O", [4, 5, 6, 7, 8], [1, 2, 3]],
  ["Uracil", "N1C=CC(=O)NC1=O", [3, 4, 5, 6, 7], [1, 2]],
];
function nucleobases() {
  return NUCLEOBASES.map(([name, smiles, edge, back]) => {
    const { atoms, bonds } = laidOut(smiles), at = atoms[0];
    if (inchiOf(smiles) !== inchiOf(smilesOf(name.toLowerCase()))) fail(`${name}: the SMILES is not ${name.toLowerCase()}`);
    // The sugar's bond points away from the middle of N's two ring neighbours: turn it to straight down.
    const ring = bonds.flatMap(([a, b]) => (a === 0 ? [b] : b === 0 ? [a] : []));
    const mx = ring.reduce((s, j) => s + atoms[j].x, 0) / ring.length - at.x, my = ring.reduce((s, j) => s + atoms[j].y, 0) / ring.length - at.y;
    const turn = -Math.PI / 2 - Math.atan2(-my, -mx), c = Math.cos(turn), s = Math.sin(turn);
    let placed = atoms.map((a) => ({ ...a, x: (a.x - at.x) * c - (a.y - at.y) * s, y: (a.x - at.x) * s + (a.y - at.y) * c }));
    // Mirrored if the Watson-Crick edge came out on the left (a flat base has no stereochemistry to lose).
    if (edge.reduce((t, j) => t + placed[j].x, 0) < 0) placed = placed.map((a) => ({ ...a, x: -a.x }));
    const cx = placed.reduce((t, a) => t + a.x, 0) / placed.length, cy = placed.reduce((t, a) => t + a.y, 0) / placed.length;
    const mol = { atoms: placed.map((a) => ({ ...a, x: r3(a.x - cx), y: r3(a.y - cy) })), bonds };
    const y0 = mol.atoms[0].y;
    if (mol.atoms.some((a) => a.y < y0 - 0.005) || edge.some((j) => mol.atoms[j].x < mol.atoms[0].x - 0.005) || back.some((j) => mol.atoms[j].x >= mol.atoms[0].x)) fail(`${name}: not facing the right way`);
    if (clashes(asMol(mol)).length) fail(`${name}: labels clash`);
    return entry(name, undefined, compact(mol));
  });
}

// A hexose's two drawings: in a chair, the one with more substituents equatorial; and the substituents placed must be
// the textbook's (all equatorial in β-D-glucopyranose's 4C1 chair, the D sugars' CH2OH up in a Haworth projection).
const hexoses = [];
for (const [shown, name, form, sugar] of HEXOSES) {
  for (const kind of ["haworth", "chair"]) {
    const found = hexose(form, picker(name), kind) ?? fail(`${shown} (${kind}): no drawing is it`);
    hexoses.push(entry(`${shown} (${kind === "chair" ? "chair" : "Haworth"})`, `${sugar}, ${kind === "chair" ? "chair, conformer" : "Haworth projection"}`, { mol: found.mol }));
    if (kind === "chair") {
      const want = { "β-D-Glucopyranose": 5, "α-D-Glucopyranose": 4, "β-D-Galactopyranose": 4, "α-D-Galactopyranose": 3, "β-D-Mannopyranose": 4, "α-D-Mannopyranose": 3 }[shown];
      if (found.equatorial !== want) fail(`${shown}: ${found.equatorial} groups equatorial, not ${want}`);
    }
  }
}
for (const [shown, name, form, kind] of FRUCTOSES) {
  const found = hexose(form, picker(name), kind) ?? fail(`${shown}: no drawing is it`);
  hexoses.push(entry(`${shown} (${kind === "chair" ? "chair" : "Haworth"})`, `fructose, ${kind === "chair" ? "chair, conformer" : "Haworth projection"}`, { mol: found.mol }));
}
const fischers = FISCHER.map(([shown, top, n, group, bottom, name, also]) => {
  const mol = picker(name)(fischerWays(top, n, group, bottom)) ?? fail(`${shown}: no drawing is it`);
  return entry(shown, also, { mol });
});
// D-glucose: OH right, left, right, right down the chain (C2 to C5), as every textbook has it.
{
  const glc = fischers.find((x) => x.name === "D-Glucose (Fischer)").mol, sides = glc.atoms.filter((a) => a.label === "O" && !a.text).sort((a, b) => b.location[1] - a.location[1]).map((a) => (a.location[0] > 0 ? "R" : "L")).join("");
  if (sides !== "RLRR") fail(`D-glucose (Fischer) has its OH ${sides}`);
}

out.push({ name: "Amino acids", items: named("Amino acids") });
out.push({ name: "Sugars", items: named("Sugars") });
out.push({ name: "Hexoses", items: hexoses });
out.push({ name: "Nucleobases", items: nucleobases() });
// The generic stereocentres first, then the named compounds.
out.push({ name: "Stereocentres", items: [...stereocentres(), ...named("Stereocentres"), ...fischers] });
out.push({ name: "Conformers", items: conformers() });
out.push({ name: "Cycloalkanes", items: named("Cycloalkanes") });
out.push({ name: "Aromatics", items: named("Aromatics") });
out.push({ name: "Bicyclics", items: [...named("Bicyclics"), entry("Cubane", "", { mol: cube() })] });
out.push({ name: "Heterocycles", items: named("Heterocycles") });
out.push({ name: "Functional groups", items: GROUPS.map(([name, smiles, also]) => {
  const m = asMol(laidOut(smiles.replace("X", "[Cl]")));
  // The first atom is R, where the group joins; X is any halogen.
  m.atoms[0] = { ...m.atoms[0], label: "C", text: "R" };
  if (smiles.includes("X")) m.atoms[1] = { ...m.atoms[1], label: "C", text: "X" };
  // A carbon between two double bonds (N=C=O) shows its C, or the two bonds read as one long one.
  m.atoms.forEach((a, i) => { if (a.label === "C" && !a.text && m.bonds.filter((b) => b.type === 2 && b.atoms.includes(i)).length === 2) m.atoms[i] = { ...a, shown: true }; });
  return entry(name, also, { mol: m });
}) });
out.push({ name: "Ligands", items: [...named("Ligands"), DPPF] });
out.push({ name: "Cp and arene rings", items: CP_RINGS });
out.push({ name: "Metallocenes", items: METALLOCENES });
out.push({ name: "Paddlewheels", items: PADDLEWHEELS.map(([name, metal, r, more]) => entry(name, more.also, { mol: paddlewheel(metal, r, more) })) });
out.push({ name: "Lab", items: [...LAB, TLC] });

const names = out.flatMap((c) => c.items.map((t) => t.name));
const twice = names.filter((n, k) => names.indexOf(n) !== k);
if (twice.length) fail(`names used twice: ${twice.join(", ")}`);
writeFileSync(new URL("src/library.json", root), JSON.stringify(out) + "\n");
console.log(`library: ${names.length} templates in ${out.length} sets${failed.length ? `; not read: ${failed.join(", ")}` : ""}`);
