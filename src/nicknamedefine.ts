// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/model/src/chemistry/abbreviations/define.rs and catalog.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// The chemistry of the user's own nicknames: a nickname from the selected group (Structure > Define Nickname…, as
// ChemDraw's), and the checks a nickname passes before Octet keeps it (from that command or from a nicknames file).
import { analyse, expandLabels, parseStructure, toInchi } from "./chem.ts";
import { ELEMENTS, FORMULA_NAMES, GROUPS, isGeneric } from "./labels.ts";
import { counts } from "./mass.ts";
import { CODES } from "./peptide.ts";
import { AROMATIC, hydrogens, orderOf, type Mol } from "./render.ts";
import { bundledNickname, spellingProblem, type Nickname } from "./nicknames.ts";

export const MOST_NICKNAME_ATOMS = 31;

// The group's formula as a nickname keeps it: Hill order (C, then H, then A to Z; with no C, A to Z), then the net
// charge (+, -, 2+). Read with Indigo on an ethyl, less the ethyl. Undefined when Indigo cannot read it.
export function nicknameFormula(smiles: string): string | undefined {
  let m: Mol;
  try { m = parseStructure(`CC${smiles}`, false); } catch { return undefined; }
  const f = analyse(m)?.[0]?.formula, n = f ? counts(f) : undefined;
  if (!n || (n.C ?? 0) < 2 || (n.H ?? 0) < 5) return undefined;
  n.C -= 2; n.H -= 5;
  const charge = m.atoms.reduce((t, a) => t + (a.charge ?? 0), 0);
  const k = Object.keys(n).filter((e) => n[e]).sort((a, b) => (n.C ? (a === "C" ? -1 : b === "C" ? 1 : a === "H" ? -1 : b === "H" ? 1 : 0) : 0) || (a < b ? -1 : a > b ? 1 : 0));
  return k.map((e) => e + (n[e] > 1 ? n[e] : "")).join("") + (charge ? `${Math.abs(charge) > 1 ? Math.abs(charge) : ""}${charge > 0 ? "+" : "-"}` : "");
}

// Spellings a nickname of the user's cannot take (ReShiki's reserved): an element (and D, T), a generic label (R, X,
// ALK), Octet's groups that are not nicknames (Pr, Ar, Cp), the formulas Octet reads its own way (CN, NO2, N3), formulas
// of common groups (OCH3, C2H5, MgBr), a mass number and element (13C), and an amino acid (Ala, D-Ala).
export function reservedSpelling(s: string): boolean {
  return s === "*" || ELEMENTS.has(s) || isGeneric(s) || (!!GROUPS[s] && !bundledNickname(s)) || FORMULA_NAMES.has(s)
    || ["OCH3", "C2H5", "CH2CH3", "OC2H5", "MgBr"].includes(s) || /^\d+[A-Z][a-z]?$/.test(s) || /^[¹²³⁰-⁹]+[A-Z][a-z]?$/.test(s)
    || Object.values(CODES).some((c) => s === c || s === `D-${c}` || s === `L-${c}`);
}

// What is wrong with a nickname, or undefined when Octet can keep it (ReShiki's from_entry): its spellings, for a
// user's nickname none reserved; one structure of 1 to 31 atoms whose first atom joins the drawing by a single bond; no
// stereochemistry, atom maps, radicals or [H] atoms; isotopes only in a nickname that is not contracted; the formula,
// when given, the structure's.
export function checkNickname(e: Nickname, user = true): string | undefined {
  const spelled = spellingProblem(e.label, "Label") ?? spellingProblem(e.reverse ?? "", "Reverse label", true) ?? (e.aliases ?? []).map((a) => spellingProblem(a, "Alias")).find(Boolean);
  if (spelled) return spelled;
  if (user) {
    const taken = [e.label, ...(e.aliases ?? [])].find(reservedSpelling);
    if (taken) return `"${taken}" means an element or one of Octet's own labels already. Choose another label.`;
  }
  const s = e.smiles;
  if (!s || s.includes("*") || s.includes(".")) return "The structure must be one group with one attachment point.";
  if (/[@/\\]/.test(s)) return "A nickname cannot keep stereochemistry. Draw the group without wedges, hashes or E/Z double bonds.";
  if (/:\d+\]/.test(s)) return "A nickname cannot keep atom map numbers.";
  if (/\[(\d*)H[^a-z\]]*\]/.test(s.replace(/\[2H\]|\[3H\]/g, ""))) return "Write hydrogens in the atoms, not as [H] atoms.";
  if (e.contract !== false && /\[\d+[A-Z]/.test(s)) return "A nickname with isotopes must have contract set to false.";
  if (/^[=#$:]/.test(s)) return "The group must join the drawing by a single bond.";
  // Brackets and ring numbers must pair up: Indigo reads past some SMILES that are not complete (C(( as C).
  let depth = 0;
  const rings = new Map<string, number>(), bare = s.replace(/\[[^\]]*\]/g, "A");
  for (const ch of bare) { depth += ch === "(" ? 1 : ch === ")" ? -1 : 0; if (depth < 0) break; }
  for (const r of bare.matchAll(/%\d\d|\d/g)) rings.set(r[0], (rings.get(r[0]) ?? 0) + 1);
  if (depth || /[[\]]/.test(bare) || /\(\)/.test(bare) || [...rings.values()].some((n) => n % 2)) return "Octet cannot read the SMILES.";
  let m: Mol;
  try { m = parseStructure(`C${s}`, false); } catch { return "Octet cannot read the SMILES."; }
  if (!m.atoms.length || m.atoms.length - 1 > MOST_NICKNAME_ATOMS) return `A nickname has 1 to ${MOST_NICKNAME_ATOMS} atoms.`;
  const firstBond = m.bonds.find((b) => b.atoms.includes(0) && b.atoms.includes(1));
  if (!firstBond || firstBond.type !== 1 || m.bonds.filter((b) => b.atoms.includes(0)).length !== 1) return "The group must join the drawing by a single bond.";
  if (m.atoms.some((a) => a.radical)) return "A nickname cannot have radicals.";
  const formula = nicknameFormula(s);
  if (!formula) return "Octet cannot read the SMILES.";
  if (e.formula && e.formula !== formula) return `The formula ${e.formula} is not the structure's (${formula}).`;
  return undefined;
}

// SMILES for a structure from its first atom (the attachment), Kekulé bonds as drawn, each atom with the hydrogens it
// has. Undefined for a bond SMILES cannot write (a hydrogen bond, a quadruple bond).
function smilesFrom(m: Mol, root: number): string | undefined {
  const near: [number, number][][] = m.atoms.map(() => []);
  m.bonds.forEach((b, k) => { near[b.atoms[0]].push([b.atoms[1], k]); near[b.atoms[1]].push([b.atoms[0], k]); });
  const used = m.atoms.map(() => 0);
  m.bonds.forEach((b) => b.atoms.forEach((i) => (used[i] += orderOf(b.type))));
  const symbol = (b: number) => { const t = m.bonds[b].type; return t === 1 ? "" : t === 2 ? "=" : t === 3 ? "#" : t === AROMATIC ? ":" : undefined; };
  const atom = (i: number) => {
    const a = m.atoms[i], el = a.label === "D" ? "H" : a.label === "T" ? "H" : a.label, iso = a.label === "D" ? 2 : a.label === "T" ? 3 : a.isotope;
    const h = a.implicitHCount ?? hydrogens(a.label, a.charge ?? 0, used[i], a.radical === 3 ? 2 : a.radical);
    const plain = ["B", "C", "N", "O", "P", "S", "F", "Cl", "Br", "I"].includes(el) && !iso && !a.charge && a.implicitHCount === undefined && !a.radical;
    if (plain) return el;
    const q = a.charge ?? 0;
    return `[${iso ?? ""}${el}${h ? `H${h > 1 ? h : ""}` : ""}${q ? `${q > 0 ? "+" : "-"}${Math.abs(q) > 1 ? Math.abs(q) : ""}` : ""}]`;
  };
  // Ring closures: each bond not on the spanning tree gets a number at both ends.
  const seen = new Set<number>(), tree = new Set<number>(), order: number[] = [];
  const visit = (i: number) => { seen.add(i); order.push(i); for (const [j, b] of near[i]) if (!seen.has(j)) { tree.add(b); visit(j); } };
  visit(root);
  if (seen.size !== m.atoms.length) return undefined;
  const rings = new Map<number, number>(), free: number[] = [], closes: Map<number, [number, number][]> = new Map(m.atoms.map((_, i) => [i, []]));
  let next = 1;
  for (const i of order) for (const [j, b] of near[i]) {
    if (tree.has(b) || rings.has(b)) continue;
    const n = free.shift() ?? next++;
    rings.set(b, n);
    closes.get(i)!.push([n, b]);
    closes.get(j)!.push([n, b]);
  }
  if (next > 99) return undefined;
  const done = new Set<number>();
  let bad = false;
  const write = (i: number): string => {
    done.add(i);
    let out = atom(i);
    for (const [n, b] of closes.get(i)!) { const s = symbol(b); if (s === undefined) bad = true; out += (done.has(m.bonds[b].atoms[0] === i ? m.bonds[b].atoms[1] : m.bonds[b].atoms[0]) ? "" : s ?? "") + (n > 9 ? `%${n}` : n); }
    const kids = near[i].filter(([j, b]) => tree.has(b) && !done.has(j));
    kids.forEach(([j, b], k) => { const s = symbol(b); if (s === undefined) bad = true; const sub = (s ?? "") + write(j); out += k < kids.length - 1 ? `(${sub})` : sub; });
    return out;
  };
  const text = write(root);
  return bad ? undefined : text;
}
const ATTACHMENT = "Select a group with one single bond to the rest of the structure, or with one attachment point.";
// InChI without its stereo layers, to tell a group that differs only in its stereochemistry.
const flat = (inchi: string | undefined) => inchi?.replace(/\/[btms][^/]*/g, "");

// Define Nickname from the selection (ReShiki's from_selection): the selected atoms (labels in them drawn out) are the
// group, and the one single bond from them to the rest of the structure is where it joins; with no such bond, one
// selected attachment point with one single bond is. The nickname's SMILES starts at the group's atom on that bond. A
// group Octet cannot keep (stereo, query features, a label it cannot read) is refused with the reason. keep: the group's
// atom on that bond, which carries the label when the selection is contracted; group: the atoms that become the label.
export function nicknameFromSelection(m: Mol, atoms: Set<number>, label: string, reverse = ""): { entry: Nickname; keep: number; group: number[] } | string {
  const group = new Set([...atoms].filter((i) => i < m.atoms.length));
  if (!group.size) return "Select the atoms of the group first.";
  const out = m.bonds.filter((b) => group.has(b.atoms[0]) !== group.has(b.atoms[1]));
  let outside: number, keep: number;
  if (out.length === 1) {
    const b = out[0];
    if (b.type !== 1 || b.stereo) return ATTACHMENT;
    [keep, outside] = group.has(b.atoms[0]) ? b.atoms : [b.atoms[1], b.atoms[0]];
  } else if (!out.length) {
    const stars = [...group].filter((i) => m.atoms[i].attach), bonds = stars.length === 1 ? m.bonds.filter((b) => b.atoms.includes(stars[0])) : [];
    if (bonds.length !== 1 || bonds[0].type !== 1) return ATTACHMENT;
    outside = stars[0];
    keep = bonds[0].atoms[0] === outside ? bonds[0].atoms[1] : bonds[0].atoms[0];
    group.delete(outside);
  } else return ATTACHMENT;
  if (!group.size) return "Select the atoms of the group first.";
  const inside = [...group].map((i) => m.atoms[i]);
  if (inside.some((a) => a.attach || a.bead || a.centre || a.query || a.map || a.chemical === false) || m.bonds.some((b) => group.has(b.atoms[0]) && group.has(b.atoms[1]) && (b.query || b.topology)))
    return "A nickname cannot keep query features, attachment points or map numbers. Remove them from the group first.";
  // The group with the rest of the structure as one xenon, its labels drawn out (a label Octet cannot read stays "*").
  const ids = [keep, ...[...group].filter((i) => i !== keep), outside];
  const at = new Map(ids.map((i, k) => [i, k]));
  const part: Mol = {
    atoms: ids.map((i) => (i === outside ? { label: "Xe", location: m.atoms[i].location } : (({ inner: _, ...a }) => a)(m.atoms[i]))),
    bonds: m.bonds.filter((b) => at.has(b.atoms[0]) && at.has(b.atoms[1])).map((b) => ({ ...b, atoms: [at.get(b.atoms[0])!, at.get(b.atoms[1])!] as [number, number] })),
  };
  const x = expandLabels(part);
  if (x.atoms.some((a) => a.label === "*")) return `Octet cannot read a label in the group (${inside.find((a) => a.text)?.text ?? "?"}). Expand or change it first.`;
  // A wavy bond or a crossed double bond says the stereochemistry is not known: SMILES cannot say it, so it is refused.
  if (x.bonds.some((b) => b.stereo || b.display === "wavy" || b.display === "either")) return "A nickname cannot keep stereochemistry. Draw the group without wedges, hashes or wavy bonds.";
  // The SMILES from the xenon, which is then left off: its first atom is the group's atom on the bond.
  const xe = x.atoms.findIndex((a) => a.label === "Xe"), written = smilesFrom(x, xe);
  if (!written?.startsWith("[Xe]")) return "Octet cannot write this group as SMILES.";
  const smiles = written.slice(4), want = toInchi(x), got = toInchi(`[Xe]${smiles}`);
  if (!want || !got || flat(want) !== flat(got)) return "Octet cannot write this group as SMILES.";
  if (want !== got) return "A nickname cannot keep stereochemistry. Draw the group without wedges, hashes or E/Z double bonds.";
  const entry: Nickname = { label: label.trim(), ...(reverse.trim() ? { reverse: reverse.trim() } : {}), smiles, formula: nicknameFormula(smiles) ?? "", category: "user", names: [] };
  const why = checkNickname(entry);
  if (why) return why;
  return { entry, keep, group: [...group] };
}
