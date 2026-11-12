// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), src/clipboard/copy_as/chemdoodle.rs and
// src/clipboard/copy_as.rs (chemical_text_snapshot), MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
//
// Copy for SciFinder (issue #113): the selected structures (or all of them) as text that CAS SciFinder's structure
// editors read. Structures go as SMILES, which CAS Draw's text field takes ("Add to Editor"). One reaction step goes as
// ChemDoodle JSON (web.chemdoodle.com/docs/chemdoodle-json-format), which the ChemDoodle editor in SciFinder loads
// from its Open field: CAS Draw does not take reaction SMILES. Nothing is sent anywhere; the user pastes the text.
import { hydrogens, type Mol } from "./render.ts";
import { ELEMENTS } from "./labels.ts";
import { toKekuleRxn, toSmiles, type RxnStep } from "./chem.ts";

export type SciFinderCopy = { text: string; reaction: boolean; agents: boolean } | { refused: string };

// ChemDoodle's own bond length (px, y down); Octet's drawings are in bond lengths, y up.
const BOND = 20;
// ReShiki's limit (chemdoodle.rs): beyond it the JSON is too large for a pasted query.
export const MAX_ATOMS = 10_000;

// Structures as SMILES, or one reaction step as ChemDoodle JSON (agents left out: ChemDoodle JSON has no role for
// them). More than one step is refused, as SciFinder searches one reaction.
export function forSciFinder(mol: Mol, steps: RxnStep[]): SciFinderCopy {
  if (!mol.atoms.length) return { refused: "There is no structure to copy." };
  if (steps.length > 1) return { refused: "SciFinder searches one reaction at a time. Select one reaction step, then copy again." };
  if (mol.atoms.length > MAX_ATOMS) return { refused: `Copy for SciFinder takes ${MAX_ATOMS.toLocaleString("en-GB")} atoms or fewer.` };
  if (!steps.length) return { text: toSmiles(mol), reaction: false, agents: false };
  const json = chemDoodleReaction(toKekuleRxn(mol, steps[0]));
  return typeof json === "string" ? { text: json, reaction: true, agents: steps[0].agents.length > 0 } : json;
}

type Atom = { i: string; l: string; x: number; y: number; c?: number; m?: number; h: number; r?: number };
type Bond = { b: number; e: number; o?: number; s?: string };
type Parsed = { atoms: (Atom & { used: number })[]; bonds: Bond[] };

const int = (s: string) => Number.parseInt(s.trim() || "0", 10) || 0;
// The atom block's old charge codes (CTfile): 1 = +3, 2 = +2, 3 = +1, 4 = a doublet radical, 5 = −1, 6 = −2, 7 = −3.
const OLD_CHARGE = [0, 3, 2, 1, 0, -1, -2, -3];
// Molfile wedges (bond stereo, from the first atom) as ChemDoodle's: 1 up, 6 down, 4 either; a crossed double bond is 3.
const WEDGE: Record<number, string> = { 1: "protruding", 6: "recessed", 4: "ambiguous" };
// Property blocks that make a query or a Markush structure, which ChemDoodle JSON cannot keep.
const QUERY = /^M {2}(RGP|ALS|LIN|SUB|UNS|RBC|APO|AAL|LOG)/;

// A V2000 RXN file (toKekuleRxn) as ChemDoodle reaction JSON: every reactant and product a molecule, and the arrow a
// synthetic Line whose rs and ps name one atom of each (chemdoodle.rs write). A refusal names what cannot go.
export function chemDoodleReaction(rxn: string): string | { refused: string } {
  const lines = rxn.replace(/\r/g, "").split("\n");
  if (lines[0]?.trim() !== "$RXN") return { refused: "Octet cannot write this reaction for SciFinder." };
  const nr = int(lines[4]?.slice(0, 3) ?? ""), np = int(lines[4]?.slice(3, 6) ?? "");
  const blocks: string[][] = [];
  for (const line of lines.slice(5)) {
    if (line.startsWith("$MOL")) blocks.push([]);
    else blocks[blocks.length - 1]?.push(line);
  }
  if (!nr || !np || blocks.length < nr + np) return { refused: "A reaction needs a starting material and a product." };
  let next = 0;
  const parsed: Parsed[] = [];
  for (const block of blocks.slice(0, nr + np)) {
    const one = molecule(block, () => `a${next++}`);
    if ("refused" in one) return one;
    parsed.push(one);
  }
  // Scale to ChemDoodle's bond length, by the mean bond length of the whole reaction, and turn y down.
  let sum = 0, n = 0;
  for (const p of parsed) for (const b of p.bonds) { sum += Math.hypot(p.atoms[b.b].x - p.atoms[b.e].x, p.atoms[b.b].y - p.atoms[b.e].y); n++; }
  const k = BOND / (n && sum > 0 ? sum / n : 1), round = (v: number) => Math.round(v * 100) / 100 || 0;
  for (const p of parsed) for (const a of p.atoms) { a.x = round(a.x * k); a.y = round(-a.y * k); }
  // The arrow between the two rows (reactionKet leaves at least three bond lengths there), at their middle height.
  const xs = (list: Parsed[]) => list.flatMap((p) => p.atoms.map((a) => a.x)), ys = parsed.flatMap((p) => p.atoms.map((a) => a.y));
  const left = Math.max(...xs(parsed.slice(0, nr))), right = Math.min(...xs(parsed.slice(nr)));
  const x1 = round(left + BOND), x2 = round(Math.max(right - BOND, x1 + 2 * BOND)), y = round((Math.min(...ys) + Math.max(...ys)) / 2);
  const m = parsed.map((p) => ({ a: p.atoms.map(({ used: _, ...a }) => a), b: p.bonds }));
  return JSON.stringify({
    m,
    s: [{ t: "Line", i: "s0", x1, y1: y, x2, y2: y, a: "synthetic", rs: parsed.slice(0, nr).map((p) => p.atoms[0].i), ps: parsed.slice(nr).map((p) => p.atoms[0].i) }],
  });
}

// One $MOL block (V2000, without its "$MOL" line): atoms with charge, isotope, radical and total hydrogens; Kekulé bonds.
function molecule(lines: string[], id: () => string): Parsed | { refused: string } {
  const counts = lines[3] ?? "";
  if (/V3000/.test(counts)) return { refused: "This structure is too large for Copy for SciFinder." };
  const na = int(counts.slice(0, 3)), nb = int(counts.slice(3, 6));
  if (!na) return { refused: "A reaction needs a starting material and a product." };
  const atoms: Parsed["atoms"] = [], valence: number[] = [], radical: number[] = [];
  for (const line of lines.slice(4, 4 + na)) {
    let l = line.slice(31, 34).trim(), m: number | undefined;
    if (l === "D" || l === "T") { m = l === "D" ? 2 : 3; l = "H"; }
    if (!ELEMENTS.has(l)) return { refused: "Copy for SciFinder takes elements only. Change R groups, query atoms and other labels to atoms, then copy again." };
    const code = int(line.slice(36, 39));
    atoms.push({ i: id(), l, x: Number(line.slice(0, 10)), y: Number(line.slice(10, 20)), c: OLD_CHARGE[code] ?? 0, m, h: 0, used: 0 });
    radical.push(code === 4 ? 1 : 0);
    valence.push(int(line.slice(48, 51)));
  }
  const bonds: Bond[] = [];
  for (const line of lines.slice(4 + na, 4 + na + nb)) {
    const b = int(line.slice(0, 3)) - 1, e = int(line.slice(3, 6)) - 1, o = int(line.slice(6, 9)), st = int(line.slice(9, 12));
    if (!atoms[b] || !atoms[e]) return { refused: "Octet cannot write this reaction for SciFinder." };
    if (o === 4) return { refused: "Octet cannot give an aromatic ring alternating single and double bonds. Check the ring, then copy again." };
    if (o < 1 || o > 3) return { refused: "Copy for SciFinder takes single, double and triple bonds only." };
    const s = o === 1 ? WEDGE[st] : o === 2 && st === 3 ? "ambiguous" : undefined;
    bonds.push({ b, e, ...(o > 1 ? { o } : {}), ...(s ? { s } : {}) });
    atoms[b].used += o;
    atoms[e].used += o;
  }
  // Property lines: CHG, ISO and RAD give each atom's value and replace the atom block's (CTfile rule).
  const props = lines.slice(4 + na + nb);
  if (props.some((p) => QUERY.test(p))) return { refused: "Copy for SciFinder takes plain structures. Remove R groups and query features, then copy again." };
  if (props.some((p) => /^M {2}STY/.test(p) && /\b(SRU|COP|MON|MER|GEN|ANY|MOD|GRA|COM|MIX|FOR|CRO|ALT|RAN|BLO)\b/.test(p.slice(9)))) return { refused: "Copy for SciFinder cannot keep polymer and mixture brackets. Remove them, then copy again." };
  const pairs = (tag: string) => props.filter((p) => p.startsWith(`M  ${tag}`)).flatMap((p) => {
    const t = p.slice(6).trim().split(/\s+/).map(Number), out: [number, number][] = [];
    for (let j = 1; j + 1 < t.length && out.length < t[0]; j += 2) out.push([t[j] - 1, t[j + 1]]);
    return out;
  });
  const chg = pairs("CHG"), iso = pairs("ISO"), rad = pairs("RAD");
  if (chg.length || iso.length || rad.length) { atoms.forEach((a, j) => { a.c = 0; radical[j] = 0; }); }
  for (const [j, v] of chg) if (atoms[j]) atoms[j].c = v;
  for (const [j, v] of iso) if (atoms[j]) atoms[j].m = v;
  // RAD: 1 a singlet, 2 a doublet, 3 a triplet. Octet's radical codes (render.ts hydrogens): 1 doublet, 2 triplet, 3 singlet.
  for (const [j, v] of rad) radical[j] = v === 2 ? 1 : v === 3 ? 2 : v === 1 ? 3 : 0;
  atoms.forEach((a, j) => {
    // h is the number of hydrogens on the atom (ChemDoodle's override of its own count): a valence written in the file
    // (15 is zero) holds, else Octet's own count, as the canvas shows it.
    const v = valence[j];
    a.h = v ? Math.max(0, (v === 15 ? 0 : v) - a.used) : hydrogens(a.l, a.c ?? 0, a.used, radical[j]);
    const r = radical[j] === 1 ? 1 : radical[j] === 2 ? 2 : 0;
    if (r) a.r = r;
    if (!a.c) delete a.c;
    if (a.m === undefined) delete a.m;
  });
  return { atoms, bonds };
}
