// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), crates/io/src/crystal.rs and crates/io/src/crystal/ (cif.rs, pdb.rs, poscar.rs, xyz.rs, elements.rs, build.rs), MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// Crystal and periodic structures: CIF, PDB, VASP POSCAR/CONTCAR and plain or extended XYZ, read into a drawing of the
// atoms in their unit cell with a 3D model that holds the cell (crystalcell.ts draws it), or a plain 3D model when
// there is no cell.
//
// Each reader keeps only what the structure needs: the lattice, each atom's element, position, charge and label, and
// from CIF its displacement parameters. Everything else in the file is read past and dropped, so a saved drawing never
// holds the file's text. Every file is hostile: sizes, counts and the work a file can ask for are limited, and a file
// that breaks a rule is refused with a plain message (with its line where that helps), never half read.

import type { Atom, Bond, Mol } from "./render.ts";
import { fingerprintOf, type Adp, type Crystal, type Model3d, type V3 } from "./model3d.ts";
import { crystalSize, layOutCrystal, openingView } from "./crystalcell.ts";

// The most atoms a structure may have in its cell.
export const MAX_CRYSTAL_ATOMS = 2_000;
export class CrystalError extends Error {}
// Each reason is a sentence, so the notice can show it after "Octet cannot open …".
const fail = (message: string): never => { throw new CrystalError(/[.!?]$/.test(message) ? message : `${message}.`); };
const failAt = (line: number, message: string): never => fail(`Line ${line}: ${message}`);

type M3 = [V3, V3, V3];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: V3) => Math.sqrt(dot(a, a));

// One atom as a reader keeps it, at a Cartesian position in ångström. asymmetric: a listed CIF input site.
type CAtom = { element: string; charge: number; label: string; xyz: V3; adp?: Adp; asymmetric: boolean };
type Structure = { lattice?: Lattice; atoms: CAtom[]; warnings: string[] };

// A number as structure files write it, without a standard uncertainty in parentheses (5.6402(3)). Strict: "", " 1",
// "1abc" and "0x10" are not numbers.
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
export function number(text: string): number | undefined {
  const t = text.split("(")[0].trim();
  if (!NUMBER.test(t)) return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}
const whole = (text: string): number | undefined => (/^\+?\d+$/.test(text) && Number(text) <= Number.MAX_SAFE_INTEGER ? Number(text) : undefined);
// Lines as Rust's str::lines: split on \n, a trailing \r dropped, no last empty line.
const linesOf = (text: string) => { const l = text.split("\n").map((x) => x.replace(/\r$/, "")); if (l.length && l[l.length - 1] === "") l.pop(); return l; };
const words = (text: string) => text.split(/\s+/).filter(Boolean);

// ---- Elements ----

const SYMBOLS = ("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr " +
  "Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt " +
  "Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og").split(" ");
// Covalent radii in ångström by atomic number from 1 (B. Cordero et al., Dalton Trans. 2008, 2832; Mn, Fe and Co
// between their low- and high-spin values). Heavier elements: 1.5 Å.
const COVALENT = [
  0.31, 0.28, 1.28, 0.96, 0.84, 0.76, 0.71, 0.66, 0.57, 0.58, 1.66, 1.41, 1.21, 1.11, 1.07, 1.05, 1.02, 1.06,
  2.03, 1.76, 1.70, 1.60, 1.53, 1.39, 1.50, 1.42, 1.38, 1.24, 1.32, 1.22, 1.22, 1.20, 1.19, 1.20, 1.20, 1.16,
  2.20, 1.95, 1.90, 1.75, 1.64, 1.54, 1.47, 1.46, 1.42, 1.39, 1.45, 1.44, 1.42, 1.39, 1.39, 1.38, 1.39, 1.40,
  2.44, 2.15, 2.07, 2.04, 2.03, 2.01, 1.99, 1.98, 1.98, 1.96, 1.94, 1.92, 1.92, 1.89, 1.90, 1.87, 1.87,
  1.75, 1.70, 1.62, 1.51, 1.44, 1.41, 1.36, 1.36, 1.32, 1.45, 1.46, 1.48, 1.40, 1.50, 1.50,
  2.60, 2.21, 2.15, 2.06, 2.00, 1.96, 1.90, 1.87, 1.80, 1.69,
];
export const covalentRadius = (symbol: string) => COVALENT[SYMBOLS.indexOf(symbol)] ?? 1.5;
// Deuterium and tritium are hydrogen.
const known = (s: string) => (s === "D" || s === "T" ? "H" : SYMBOLS.includes(s) ? s : undefined);
const capitalised = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : "");
const letters = (text: string) => /^[A-Za-z]{0,2}/.exec(text)![0];
// The charge in what follows a symbol: 2-, +3, + or nothing.
function chargeOf(rest: string): number {
  const t = rest.trim(), sign = t.includes("-") ? -1 : t.includes("+") ? 1 : 0;
  if (!sign) return 0;
  const digits = t.replace(/\D/g, "");
  return sign * (digits ? Math.min(9, Number(digits.slice(0, 6))) : 1);
}
// An element and charge from a symbol column such as Na, O2-, Fe3+, Cl1- or S, in any case.
export function fromSymbol(text: string): { element: string; charge: number } | undefined {
  const t = text.trim(), head = letters(t);
  const element = known(capitalised(head)) ?? (head ? known(capitalised(head.slice(0, 1))) : undefined);
  if (!element) return undefined;
  const used = element === "H" && !t.toUpperCase().startsWith("H") ? 1 : element.length;
  return { element, charge: chargeOf(t.slice(used)) };
}
// An element from an atom label such as C1, Cl2A or O1W: a second lowercase letter makes a two-letter symbol when there
// is one, else the first letter alone, else both letters.
export function fromLabel(text: string): string | undefined {
  const head = letters(text.trim());
  const one = head ? known(capitalised(head.slice(0, 1))) : undefined, two = head.length === 2 ? known(capitalised(head)) : undefined;
  return head.length === 2 && /[a-z]/.test(head[1]) ? two ?? one : one ?? two;
}
const fromNumber = (z: number) => (Number.isInteger(z) && z >= 1 ? SYMBOLS[z - 1] : undefined);
// A metal: not a nonmetal, metalloid or noble gas. An anion former: the anions of salts, oxides and carbides.
const NONMETALS = new Set("H He B C N O F Ne Si P S Cl Ar Ge As Se Br Kr Sb Te I Xe At Rn".split(" "));
const ANIONS = new Set("C N O F P S Cl Se Br Te I".split(" "));

// ---- Lattice ----

const TOLERANCE = 0.45; // bonded when closer than the two covalent radii plus this (Å)
const SAME_SITE = 0.25; // closer atoms are the same site, or overlapping alternatives (Å)
const WRAP = 1e-4; // fractional coordinates within this of 1 wrap to 0
const MIN_SPACING = 0.5; // the closest two lattice planes of a cell may be (Å)
const MAX_REACH = 3; // the farthest cell a bond may reach

export class Lattice {
  readonly vectors: M3;
  readonly reciprocal: M3;
  constructor(vectors: M3) {
    const [a, b, c] = vectors, volume = dot(a, cross(b, c));
    if (!vectors.flat().every(Number.isFinite) || !Number.isFinite(volume)) fail("The lattice vectors are not numbers");
    if (Math.abs(volume) < 1e-3) fail("The unit cell has no volume");
    if (volume < 0) fail("The lattice vectors are left-handed");
    if (vectors.some((v) => length(v) > 1000)) fail("The unit cell is longer than 1000 Å");
    this.vectors = vectors;
    this.reciprocal = [scale(cross(b, c), 1 / volume), scale(cross(c, a), 1 / volume), scale(cross(a, b), 1 / volume)];
    // Lattice planes closer than this make every search for copies of an atom endless; no real cell is that thin.
    if (this.reciprocal.some((r) => length(r) * MIN_SPACING > 1)) fail("The unit cell is thinner than 0.5 Å across one of its faces");
  }
  // The lattice of cell lengths (Å) and angles (degrees), a along x and b in the xy plane, as CIF and PDB define it.
  static fromParameters(lengths: V3, angles: V3): Lattice {
    if (!lengths.every((l) => Number.isFinite(l) && l > 0)) fail("The cell lengths must be positive");
    if (!angles.every((a) => Number.isFinite(a) && a > 0 && a < 180)) fail("The cell angles must be between 0° and 180°");
    const [a, b, c] = lengths, [al, be, ga] = angles.map((x) => (x * Math.PI) / 180);
    const cy = (Math.cos(al) - Math.cos(be) * Math.cos(ga)) / Math.sin(ga), cz2 = 1 - Math.cos(be) ** 2 - cy * cy;
    if (cz2 <= 1e-9) fail("These cell angles make no unit cell");
    return new Lattice([[a, 0, 0], [b * Math.cos(ga), b * Math.sin(ga), 0], [c * Math.cos(be), c * cy, c * Math.sqrt(cz2)]]);
  }
  fractional(p: V3): V3 { return this.reciprocal.map((r) => dot(p, r)) as V3; }
  cartesian(f: V3): V3 { return add(add(scale(this.vectors[0], f[0]), scale(this.vectors[1], f[1])), scale(this.vectors[2], f[2])); }
  reciprocalLengths(): V3 { return this.reciprocal.map(length) as V3; }
  // Whether some lattice copy of q lies within radius of p. Every copy that close is tried, however skewed the cell:
  // a vector's fractional coordinate k is at most its length times |k*|.
  within(p: V3, q: V3, radius: number): boolean {
    const d = this.fractional(sub(q, p)), r = this.reciprocalLengths().map((k) => radius * k);
    const range = (k: number) => [Math.ceil(-r[k] - d[k]), Math.floor(r[k] - d[k])];
    const [i0, i1] = range(0), [j0, j1] = range(1), [k0, k1] = range(2);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) if (length(this.cartesian([d[0] + i, d[1] + j, d[2] + k])) < radius) return true;
    return false;
  }
  // The cells along each axis a sphere of radius reaches into.
  reach(radius: number): V3 { return this.reciprocalLengths().map((r) => Math.min(1e3, Math.max(1, Math.ceil(radius * r)))) as V3; }
}
// Wrap a fractional coordinate into [0, 1), atoms on the far face to 0.
export const wrap = (f: number) => f - Math.floor(f + WRAP);
export const sameSite = (l: Lattice, p: V3, q: V3) => l.within(p, q, SAME_SITE);

// ---- CIF ----

type Token = { text: string; line: number; quoted: boolean };
function cifTokens(text: string): Token[] {
  const out: Token[] = [], lines = linesOf(text);
  for (let n = 0; n < lines.length; n++) {
    let line = n + 1, rest = lines[n];
    if (rest.startsWith(";")) {
      // A text field, to the next line that starts with ";"; tokens may follow the closing semicolon on its line.
      let value = rest.slice(1), end = -1;
      for (let m = n + 1; m < lines.length; m++) {
        if (lines[m].startsWith(";")) { end = m; break; }
        value += "\n" + lines[m];
      }
      if (end < 0) failAt(line, "A text field opened with ; is not closed");
      out.push({ text: value, line, quoted: true });
      n = end; line = end + 1; rest = lines[end].slice(1);
    }
    for (;;) {
      rest = rest.trimStart();
      if (!rest || rest[0] === "#") break;
      const q = rest[0];
      if (q === "'" || q === '"') {
        // A quote closes only where whitespace or the line end follows.
        const body = rest.slice(1);
        let end = -1;
        for (let i = 0; i < body.length; i++) if (body[i] === q && (i + 1 === body.length || /\s/.test(body[i + 1]))) { end = i; break; }
        if (end < 0) failAt(line, "A quoted value is not closed");
        out.push({ text: body.slice(0, end), line, quoted: true });
        rest = body.slice(end + 1);
      } else {
        const m = /\s/.exec(rest), end = m ? m.index : rest.length;
        out.push({ text: rest.slice(0, end), line, quoted: false });
        rest = rest.slice(end);
      }
    }
  }
  return out;
}
type Loop = { tags: string[]; rows: { line: number; row: string[] }[] };
type Block = { items: Map<string, { line: number; value: string }>; loops: Loop[] };
// Tags whose items or loops the reader keeps.
const wanted = (tag: string) => ["_cell_", "_atom_site", "_space_group", "_symmetry_"].some((p) => tag.startsWith(p));
const keyword = (t: Token) => { const l = t.text.toLowerCase(); return !t.quoted && (t.text.startsWith("_") || l.startsWith("data_") || l.startsWith("save_") || l === "loop_" || l === "global_" || l === "stop_"); };
function cifBlocks(tokens: Token[]): Block[] {
  const blocks: Block[] = [];
  let current: Block = { items: new Map(), loops: [] }, started = false, i = 0;
  while (i < tokens.length) {
    const token = tokens[i++], lower = token.text.toLowerCase();
    if (token.quoted) failAt(token.line, "A value has no tag");
    if (lower.startsWith("data_")) {
      if (started) blocks.push(current), current = { items: new Map(), loops: [] };
      started = true;
    } else if (lower === "loop_") {
      const lp: Loop = { tags: [], rows: [] };
      while (i < tokens.length && !tokens[i].quoted && tokens[i].text.startsWith("_")) lp.tags.push(tokens[i++].text.toLowerCase());
      if (!lp.tags.length) failAt(token.line, "A loop has no tags");
      const start = i;
      while (i < tokens.length && !keyword(tokens[i])) i++;
      const values = tokens.slice(start, i);
      if (values.length % lp.tags.length) failAt(token.line, `A loop of ${lp.tags.length} tags has ${values.length} values, not a whole number of rows`);
      if (wanted(lp.tags[0])) {
        for (let k = 0; k < values.length; k += lp.tags.length) lp.rows.push({ line: values[k].line, row: values.slice(k, k + lp.tags.length).map((t) => t.text) });
        current.loops.push(lp);
      }
    } else if (lower.startsWith("_")) {
      if (i >= tokens.length || keyword(tokens[i])) failAt(token.line, `${token.text} has no value`);
      const value = tokens[i++];
      if (wanted(lower)) current.items.set(lower, { line: value.line, value: value.text });
    } else if (lower.startsWith("save_") || lower === "global_" || lower === "stop_") {
      // Save frames and global blocks hold no structure.
    } else failAt(token.line, `Unexpected '${token.text}'`);
  }
  blocks.push(current);
  return blocks;
}
const column = (lp: Loop, tag: string) => { const k = lp.tags.indexOf(tag); return k < 0 ? undefined : k; };
const missing = (t: string) => t === "?" || t === ".";

export type SymOp = { r: M3; t: V3 };
// A symmetry operator such as -x+1/2, y, -z as its rotation rows and translation in fractional coordinates.
export function parseOperator(text: string): SymOp | undefined {
  const parts = text.split(",");
  if (parts.length !== 3) return undefined;
  const r: V3[] = [], t: number[] = [];
  for (const p of parts) { const c = component(p); if (!c) return undefined; r.push(c[0]); t.push(c[1]); }
  if (r.flat().some((v) => Math.abs(v) > 1 + 1e-9)) return undefined;
  const det = dot(r[0], cross(r[1], r[2]));
  return Math.abs(Math.abs(det) - 1) < 1e-6 ? { r: r as M3, t: t as V3 } : undefined;
}
// One coordinate of an operator: a sum of terms such as -x, +1/2, 2y or 0.25.
function component(text: string): [V3, number] | undefined {
  const chars = [...text.replace(/\s/g, "").toLowerCase()];
  if (!chars.length) return undefined;
  const row: V3 = [0, 0, 0];
  let shift = 0, i = 0;
  while (i < chars.length) {
    let sign = 1;
    while (chars[i] === "+" || chars[i] === "-") { if (chars[i] === "-") sign = -sign; i++; }
    const start = i;
    while (i < chars.length && /[0-9./]/.test(chars[i])) i++;
    const digits = chars.slice(start, i).join("");
    let value: number | undefined;
    if (digits) { value = fraction(digits); if (value === undefined) return undefined; }
    if (chars[i] === "*") i++;
    const k = i < chars.length ? "xyz".indexOf(chars[i]) : -1;
    if (k >= 0) { row[k] += sign * (value ?? 1); i++; }
    else { if (value === undefined) return undefined; shift += sign * value; }
  }
  return [row, shift];
}
function fraction(text: string): number | undefined {
  const parts = text.split("/");
  if (parts.length > 2) return undefined;
  const ok = (s: string) => (/^(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : undefined);
  if (parts.length === 1) return ok(parts[0]);
  const n = ok(parts[0]), d = ok(parts[1]);
  return n === undefined || d === undefined || d === 0 ? undefined : n / d;
}
type Aniso = [number, number, number, number, number, number];
// An anisotropic U as CIF writes it (U11 U22 U33 U12 U13 U23) after a symmetry operation with rotation r, through
// U* = N U N, where N holds the reciprocal lengths: U*' = R U* Rᵀ.
export function rotateAdp(u: Aniso, r: M3, n: V3): Aniso {
  const [u11, u22, u33, u12, u13, u23] = u, m = [[u11, u12, u13], [u12, u22, u23], [u13, u23, u33]];
  const star = m.map((row, i) => row.map((v, j) => v * n[i] * n[j]));
  const turned = (i: number, j: number) => {
    let sum = 0;
    for (let k = 0; k < 3; k++) for (let l = 0; l < 3; l++) sum += r[i][k] * star[k][l] * r[j][l];
    const s = n[i] * n[j];
    return s > 0 ? sum / s : 0;
  };
  return [turned(0, 0), turned(1, 1), turned(2, 2), turned(0, 1), turned(0, 2), turned(1, 2)];
}
const MAX_OPERATORS = 192; // the most symmetry operators of a space group (Fm-3m and the like)
const MAX_LISTED_OPERATORS = 8 * MAX_OPERATORS; // the most operator entries read, repeats included
const MAX_EXPANSION = 40_000; // the most sites times operators expanded
const EIGHT_PI_SQUARED = 8 * Math.PI * Math.PI;
// Anisotropic U by atom label, from U or B values (the first row of a label wins).
function anisotropic(block: Block): Map<string, Aniso> {
  const out = new Map<string, Aniso>(), names = ["11", "22", "33", "12", "13", "23"];
  for (const lp of block.loops) {
    const label = column(lp, "_atom_site_aniso_label");
    if (label === undefined) continue;
    for (const [prefix, factor] of [["_atom_site_aniso_u_", 1], ["_atom_site_aniso_b_", 1 / EIGHT_PI_SQUARED]] as const) {
      const cols = names.map((n) => column(lp, prefix + n));
      if (cols.some((c) => c === undefined)) continue;
      for (const { row } of lp.rows) {
        const values = cols.map((c) => number(row[c!] ?? ""));
        if (values.every((v) => v !== undefined) && !out.has(row[label])) out.set(row[label], values.map((v) => v! * factor) as Aniso);
      }
    }
  }
  return out;
}
// The order of keys as Rust's BTreeMap keeps them: by bytes for text (assemblies), by value for group numbers.
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
// Shortest decimal of a value as Rust prints an f64.
const shown = (v: number) => String(v);

export function readCif(text: string): Structure {
  const blocks = cifBlocks(cifTokens(text)).filter((b) => b.items.has("_cell_length_a"));
  if (!blocks.length) fail("The CIF has no unit cell (_cell_length_a)");
  const block = blocks[0], warnings: string[] = [];
  if (blocks.length > 1) warnings.push(`Read the first of ${blocks.length} structures in the file`);
  const item = (tag: string) => {
    const it = block.items.get(tag) ?? fail(`The CIF has no ${tag}`);
    return number(it.value) ?? failAt(it.line, `${tag} is not a number`);
  };
  const lattice = Lattice.fromParameters([item("_cell_length_a"), item("_cell_length_b"), item("_cell_length_c")], [item("_cell_angle_alpha"), item("_cell_angle_beta"), item("_cell_angle_gamma")]);
  const sites = block.loops.find((l) => column(l, "_atom_site_fract_x") !== undefined) ?? fail("The CIF has no atom sites with fractional coordinates (_atom_site_fract_x)");
  const col = (tag: string) => column(sites, tag);
  const [x, y, z] = [col("_atom_site_fract_x"), col("_atom_site_fract_y"), col("_atom_site_fract_z")];
  if (x === undefined || y === undefined || z === undefined) fail("The CIF's atom sites need _atom_site_fract_x, _y and _z");
  const label = col("_atom_site_label"), symbol = col("_atom_site_type_symbol"), group = col("_atom_site_disorder_group"), assembly = col("_atom_site_disorder_assembly");
  const occupancy = col("_atom_site_occupancy"), flag = col("_atom_site_calc_flag"), uIso = col("_atom_site_u_iso_or_equiv"), bIso = col("_atom_site_b_iso_or_equiv");
  const aniso = anisotropic(block);
  const cell = (row: string[], c: number | undefined) => (c === undefined ? undefined : row[c]);
  // Each assembly keeps its most occupied group when every group has a uniform, known occupancy and no other group ties
  // it; otherwise its lowest group. Ungrouped sites and group 0 stay. A negative group sits on a special position.
  const groupOf = (row: string[]): [string, number] | undefined => {
    const g = cell(row, group);
    if (g === undefined || missing(g) || !/^[+-]?\d+$/.test(g)) return undefined;
    const big = BigInt(g);
    if (big === 0n || big > 9223372036854775807n || big < -9223372036854775808n) return undefined;
    const a = cell(row, assembly);
    return [a !== undefined && !missing(a) ? a : "", Number(big < 0n ? -big : big)];
  };
  const groups = new Map<string, Map<number, number | undefined | null>>(); // null: occupancies differ or are missing
  for (const { row } of sites.rows) {
    const g = groupOf(row);
    if (!g) continue;
    const value = number(cell(row, occupancy) ?? "") ?? null;
    const set = groups.get(g[0]) ?? new Map();
    groups.set(g[0], set);
    if (!set.has(g[1])) set.set(g[1], value);
    else if (set.get(g[1]) !== value) set.set(g[1], null);
  }
  const sortedSets = [...groups.keys()].sort(byText);
  const sortedGroups = (set: string) => [...groups.get(set)!.entries()].sort((a, b) => a[0] - b[0]);
  const selected = new Map<string, number>();
  for (const set of sortedSets) {
    const list = sortedGroups(set), lowest = list[0][0];
    let major: number | undefined;
    if (list.every(([, o]) => typeof o === "number")) {
      const top = Math.max(...list.map(([, o]) => o as number)), most = list.filter(([, o]) => o === top);
      if (most.length === 1) major = most[0][0];
    }
    selected.set(set, major ?? lowest);
  }
  const listed: { f: V3; element: string; charge: number; name: string; adp?: Adp }[] = [];
  const alternatives = new Map<string, number>();
  for (const { line, row } of sites.rows) {
    if ((cell(row, flag) ?? "").toLowerCase() === "dum") continue;
    const g = groupOf(row);
    if (g && selected.get(g[0]) !== g[1]) { alternatives.set(g[0], (alternatives.get(g[0]) ?? 0) + 1); continue; }
    // An occupancy of 0 means the site holds none of this atom.
    const occ = number(cell(row, occupancy) ?? "");
    if (occ !== undefined && occ <= 0) continue;
    const l = cell(row, label), name = l !== undefined && !missing(l) ? l : "";
    const s = cell(row, symbol), found = s !== undefined && !missing(s) ? fromSymbol(s) : undefined;
    const { element, charge } = found ?? { element: fromLabel(name) ?? failAt(line, `Cannot tell the element of atom '${name}'`), charge: 0 };
    const coordinate = (c: number) => number(row[c] ?? "") ?? failAt(line, `Atom '${name}' has no fractional coordinates`);
    const f: V3 = [coordinate(x!), coordinate(y!), coordinate(z!)];
    const iso = (c: number | undefined, factor: number): Adp | undefined => { const u = number(cell(row, c) ?? ""); return u === undefined ? undefined : { iso: u * factor }; };
    const a = aniso.get(name);
    listed.push({ f, element, charge, name, adp: a ? { aniso: a } : iso(uIso, 1) ?? iso(bIso, 1 / EIGHT_PI_SQUARED) });
  }
  if (alternatives.size) {
    const details = [...alternatives.keys()].sort(byText).map((set) => {
      const kept = selected.get(set)!, list = sortedGroups(set), occ = groups.get(set)!.get(kept);
      const leftOut = list.filter(([g]) => g !== kept).map(([g, o]) => (typeof o === "number" ? `${g} (${shown(o)})` : `${g}`));
      return `kept group ${kept}${typeof occ === "number" ? ` (occupancy ${shown(occ)})` : ""}${set ? ` of assembly ${set}` : ""}; left out group${leftOut.length === 1 ? "" : "s"} ${leftOut.join(", ")}`;
    });
    const count = [...alternatives.values()].reduce((s, n) => s + n, 0), total = `, ${count} site record${count === 1 ? "" : "s"}`;
    let note = `Disordered sites: ${details.join("; ")}${total}`;
    // Saved notes hold at most 512 characters: summarise many assemblies.
    if (new TextEncoder().encode(note).length > 512) note = `Disordered sites: kept one group in each of ${details.length} assemblies${total}`;
    warnings.push(note);
  }
  let operators = symmetry(block);
  if (!operators.length && !p1(block)) warnings.push("The CIF lists no symmetry operators; only its listed atoms are shown");
  if (!operators.length) operators = [{ r: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] }];
  // Each operator once, translations taken modulo whole cells.
  const seen: SymOp[] = [];
  for (const o of operators) {
    const t = o.t.map(wrap) as V3;
    if (!seen.some((s) => s.r.every((row, i) => row.every((v, j) => v === o.r[i][j])) && s.t.every((v, k) => Math.abs(v - t[k]) < 1e-6))) seen.push({ r: o.r, t });
  }
  if (seen.length > MAX_OPERATORS) fail(`The CIF lists ${seen.length} symmetry operators; a space group has at most ${MAX_OPERATORS}`);
  if (listed.length * seen.length > MAX_EXPANSION) fail(`${listed.length} sites under ${seen.length} symmetry operators are too many to expand; at most ${MAX_CRYSTAL_ATOMS} atoms can be shown`);
  const reciprocal = lattice.reciprocalLengths(), atoms: CAtom[] = [];
  for (const s of listed) {
    const input = lattice.cartesian(s.f.map(wrap) as V3);
    for (const { r, t } of seen) {
      const xyz = lattice.cartesian([0, 1, 2].map((k) => wrap(dot(r[k], s.f) + t[k])) as V3);
      // A source position can be reached by identity (whole cell translations included) or a special-position
      // operation: the image is "asymmetric" when it lies on the listed input position. A later record can promote an
      // earlier copy.
      const asymmetric = sameSite(lattice, input, xyz), earlier = atoms.find((a) => sameSite(lattice, a.xyz, xyz));
      if (earlier) { earlier.asymmetric ||= asymmetric; continue; }
      if (atoms.length >= MAX_CRYSTAL_ATOMS) fail(`The unit cell has more than ${MAX_CRYSTAL_ATOMS} atoms; at most ${MAX_CRYSTAL_ATOMS} can be shown`);
      const adp: Adp | undefined = s.adp && "aniso" in s.adp ? { aniso: rotateAdp(s.adp.aniso, r, reciprocal) } : s.adp;
      atoms.push({ element: s.element, charge: s.charge, label: s.name, xyz, ...(adp ? { adp } : {}), asymmetric });
    }
  }
  return { lattice, atoms, warnings };
}
// Whether the space group is P1, which needs no operators.
const p1 = (block: Block) => ["_space_group_name_h-m_alt", "_symmetry_space_group_name_h-m"].some((tag) => block.items.get(tag)?.value.replace(/\s/g, "").toUpperCase() === "P1");
// The listed symmetry operators, in a loop or as a single item.
function symmetry(block: Block): SymOp[] {
  let listed: { line: number; text: string }[] = [];
  for (const tag of ["_space_group_symop_operation_xyz", "_symmetry_equiv_pos_as_xyz"]) {
    const lp = block.loops.find((l) => column(l, tag) !== undefined);
    if (lp) { const c = column(lp, tag)!; listed = lp.rows.filter((r) => r.row[c] !== undefined).map((r) => ({ line: r.line, text: r.row[c] })); break; }
    const it = block.items.get(tag);
    if (it) { listed = [{ line: it.line, text: it.value }]; break; }
  }
  // Even repeated, no space group needs more entries than this; checked before any operator is parsed.
  if (listed.length > MAX_LISTED_OPERATORS) fail(`The CIF lists ${listed.length} symmetry operators; a space group has at most ${MAX_OPERATORS}`);
  return listed.map(({ line, text }) => parseOperator(text) ?? failAt(line, `Cannot read the symmetry operator '${text}'`));
}

// ---- PDB ----

// Columns from..to (1-based, inclusive, as the PDB format lists them), trimmed.
const cols = (line: string, from: number, to: number) => line.slice(Math.min(from - 1, line.length), Math.min(to, line.length)).trim();
export function readPdb(text: string): Structure {
  let lattice: Lattice | undefined, alternatives = 0;
  const atoms: CAtom[] = [], warnings: string[] = [], first = new Map<string, string>();
  const lines = linesOf(text);
  for (let n = 0; n < lines.length; n++) {
    // PDB columns are ASCII; any other character is read as a space, so columns keep their places.
    const line = lines[n].replace(/[^\x20-\x7e]/g, " "), at = n + 1, record = cols(line, 1, 6);
    if (record === "CRYST1") {
      const field = (from: number, to: number, name: string) => number(cols(line, from, to)) ?? failAt(at, `CRYST1 has no ${name}`);
      const lengths: V3 = [field(7, 15, "a"), field(16, 24, "b"), field(25, 33, "c")], angles: V3 = [field(34, 40, "alpha"), field(41, 47, "beta"), field(48, 54, "gamma")];
      // A 1 Å cube marks a structure without a cell, as from NMR.
      if (!lengths.every((l) => l === 1)) {
        try { lattice = Lattice.fromParameters(lengths, angles); } catch (e) { failAt(at, (e as Error).message); }
      }
    } else if (record === "ATOM" || record === "HETATM") {
      // The first alternate location of each residue.
      const alt = line[16];
      if (alt !== undefined && alt !== " ") {
        const residue = `${cols(line, 22, 22)}|${cols(line, 23, 26)}|${cols(line, 27, 27)}`;
        if (!first.has(residue)) first.set(residue, alt);
        if (first.get(residue) !== alt) { alternatives++; continue; }
      }
      const coordinate = (from: number, to: number) => number(cols(line, from, to)) ?? failAt(at, "The atom's coordinates are not numbers");
      const xyz: V3 = [coordinate(31, 38), coordinate(39, 46), coordinate(47, 54)];
      const name = cols(line, 13, 16), symbol = cols(line, 77, 78);
      // Without an element column, the name's first two columns hold it right-justified: " CA " is carbon, "CA  " calcium.
      const element = (symbol ? fromSymbol(symbol) : fromSymbol(cols(line, 13, 14).replace(/^\d+/, "")))?.element ?? failAt(at, `Cannot tell the element of atom '${name}'`);
      const b = number(cols(line, 61, 66));
      atoms.push({ element, charge: pdbCharge(cols(line, 79, 80)), label: name, xyz, ...(b !== undefined && b > 0 ? { adp: { iso: b / EIGHT_PI_SQUARED } } : {}), asymmetric: false });
      if (atoms.length > MAX_CRYSTAL_ATOMS) fail(`The structure has more than ${MAX_CRYSTAL_ATOMS} atoms; at most ${MAX_CRYSTAL_ATOMS} can be shown`);
    } else if (record === "ENDMDL") break; // the first model only
  }
  if (!atoms.length) fail("The PDB file has no ATOM or HETATM records");
  if (alternatives) warnings.push(`Alternate locations: kept the first of each residue, left out ${alternatives} atom record${alternatives === 1 ? "" : "s"}`);
  return { lattice, atoms, warnings };
}
// A PDB charge such as 2+ or 1-.
function pdbCharge(text: string): number {
  const digits = text.replace(/\D/g, ""), size = digits ? Math.min(9, Number(digits)) : 1;
  return text.includes("-") ? -size : text.includes("+") ? size : 0;
}

// ---- POSCAR ----

// The first three numbers of a line.
const three = (text: string): V3 | undefined => { const w = words(text).slice(0, 3).map(number); return w.length === 3 && w.every((v) => v !== undefined) ? (w as V3) : undefined; };
export function readPoscar(text: string): Structure {
  const lines = linesOf(text).map((l) => l.trim());
  let at = 0;
  const next = (what: string): [number, string] => (at < lines.length ? [at + 1, lines[at++]] : fail(`The POSCAR ends before its ${what}`));
  next("comment");
  const [fl, factorText] = next("scale factor");
  // One scale factor, or three for x, y and z; a comment may follow.
  const factors: number[] = [];
  for (const w of words(factorText)) { const v = number(w); if (v === undefined) break; factors.push(v); }
  let factor: V3;
  if (factors.length === 1 && factors[0] !== 0) factor = [factors[0], factors[0], factors[0]];
  else if (factors.length >= 3 && factors.slice(0, 3).every((f) => f > 0)) factor = [factors[0], factors[1], factors[2]];
  else return failAt(fl, "The scale factor must be one nonzero number or three positive numbers");
  const vectors: V3[] = [];
  for (let k = 0; k < 3; k++) { const [l, t] = next("lattice vectors"); vectors.push(three(t) ?? failAt(l, "A lattice vector needs three numbers")); }
  // A single negative scale factor is the cell's volume.
  if (factor[0] < 0) {
    const volume = Math.abs(dot(vectors[0], cross(vectors[1], vectors[2])));
    if (!(volume > 0)) fail("The unit cell has no volume");
    const s = Math.cbrt(-factor[0] / volume);
    factor = [s, s, s];
  }
  const scaled = (v: V3): V3 => [v[0] * factor[0], v[1] * factor[1], v[2] * factor[2]];
  const lattice = new Lattice(vectors.map(scaled) as M3);
  const [nl, names] = next("element names");
  if (words(names).every((w) => number(w) !== undefined)) failAt(nl, "This POSCAR has no element names; VASP 4 files are not supported");
  const symbols = words(names).map((name) => {
    // POTCAR names such as Fe_pv or O/1a.
    const bare = name.split(/[_/]/)[0], found = fromSymbol(bare);
    return found && found.element.toLowerCase() === bare.toLowerCase() ? found.element : failAt(nl, `'${name}' is not an element`);
  });
  const [cl, countText] = next("atom counts");
  const counts = words(countText).map(whole);
  if (counts.length !== symbols.length || counts.some((c) => c === undefined)) failAt(cl, "The atom counts must be one whole number per element");
  if ((counts as number[]).reduce((s, c) => s + c, 0) > MAX_CRYSTAL_ATOMS) fail(`The structure has more than ${MAX_CRYSTAL_ATOMS} atoms; at most ${MAX_CRYSTAL_ATOMS} can be shown`);
  let [ml, mode] = next("coordinate mode");
  if (/^[Ss]/.test(mode)) [ml, mode] = next("coordinate mode");
  const direct = /^[Dd]/.test(mode);
  if (!direct && !/^[CcKk]/.test(mode)) failAt(ml, "Expected Direct or Cartesian");
  const atoms: CAtom[] = [];
  symbols.forEach((element, k) => {
    for (let i = 0; i < counts[k]!; i++) {
      const [l, t] = next("positions"), p = three(t) ?? failAt(l, "A position needs three numbers");
      atoms.push({ element, charge: 0, label: "", xyz: direct ? lattice.cartesian(p) : scaled(p), asymmetric: false });
    }
  });
  return { lattice, atoms, warnings: [] };
}

// ---- XYZ ----

// The key=value pairs of an extended XYZ comment line; values may be quoted with double quotes. Keys lower-cased.
function pairs(comment: string): [string, string][] {
  const out: [string, string][] = [];
  let rest = comment.trim();
  while (rest) {
    const eq = rest.indexOf("=");
    if (eq < 0) break;
    const key = words(rest.slice(0, eq)).pop() ?? "", after = rest.slice(eq + 1).trimStart();
    let value: string, tail: string;
    if (after.startsWith('"')) { const q = after.indexOf('"', 1); [value, tail] = q < 0 ? [after.slice(1), ""] : [after.slice(1, q), after.slice(q + 1)]; }
    else { const m = /\s/.exec(after); [value, tail] = m ? [after.slice(0, m.index), after.slice(m.index + 1)] : [after, ""]; }
    out.push([key.toLowerCase(), value]);
    rest = tail.trimStart();
  }
  return out;
}
// The species and position columns from a Properties value.
function xyzColumns(properties: string): [number, number] | undefined {
  const fields = properties.split(":");
  if (fields.length % 3) return undefined;
  let at = 0, species: number | undefined, position: number | undefined;
  for (let k = 0; k < fields.length; k += 3) {
    const [name, kind, countText] = fields.slice(k, k + 3), count = whole(countText);
    if (count === undefined || count < 1 || count > 1000) return undefined;
    if (name.toLowerCase() === "species" && kind === "S" && count === 1) species = at;
    if (name.toLowerCase() === "pos" && kind === "R" && count === 3) position = at;
    at += count;
  }
  return species !== undefined && position !== undefined ? [species, position] : undefined;
}
export function readXyz(text: string): Structure {
  const lines = linesOf(text);
  let at = lines.findIndex((l) => l.trim());
  if (at < 0) fail("The XYZ file is empty");
  const line = at + 1, count = whole(lines[at].trim()) ?? failAt(line, "The first line must be the number of atoms");
  if (count > MAX_CRYSTAL_ATOMS) fail(`The structure has ${count} atoms; at most ${MAX_CRYSTAL_ATOMS} can be shown`);
  at++;
  const comment = lines[at++] ?? "", kv = pairs(comment), value = (key: string) => kv.find(([k]) => k === key)?.[1];
  // Partly periodic structures, such as slabs, are not supported; a structure periodic along no axis is a molecule.
  const pbc = value("pbc");
  let periodic = true;
  if (pbc !== undefined) {
    const flags = words(pbc).map((f) => ["T", "t", "True", "true", "1"].includes(f));
    if (flags.length === 3 && flags.every(Boolean)) periodic = true;
    else if (flags.length === 3 && flags.every((f) => !f)) periodic = false;
    else failAt(line + 1, 'Only pbc="T T T" or "F F F" is supported');
  }
  let lattice: Lattice | undefined;
  const latticeText = value("lattice");
  if (latticeText !== undefined && periodic) {
    const n = words(latticeText).map(number);
    if (n.length !== 9 || n.some((v) => v === undefined)) failAt(line + 1, "Lattice needs nine numbers");
    try { lattice = new Lattice([[n[0]!, n[1]!, n[2]!], [n[3]!, n[4]!, n[5]!], [n[6]!, n[7]!, n[8]!]]); } catch (e) { failAt(line + 1, (e as Error).message); }
  }
  const props = value("properties");
  const [species, position] = props === undefined ? [0, 1] : xyzColumns(props) ?? failAt(line + 1, "Properties needs species:S:1 and pos:R:3 columns");
  const atoms: CAtom[] = [];
  for (let i = 0; i < count; i++) {
    if (at >= lines.length) fail(`The XYZ file ends before its ${count} atoms`);
    const l = at + 1, w = words(lines[at++]), name = w[species] ?? failAt(l, "An atom line needs an element and x, y, z");
    const z = whole(name), found = fromSymbol(name);
    const element = (z !== undefined ? fromNumber(z) : found && (found.element.toLowerCase() === name.toLowerCase() || name.toLowerCase() === "d") ? found.element : undefined) ?? failAt(l, `'${name}' is not an element`);
    const xyz = [0, 1, 2].map((k) => number(w[position + k] ?? "") ?? failAt(l, "An atom line needs an element and x, y, z")) as V3;
    atoms.push({ element, charge: 0, label: "", xyz, asymmetric: false });
  }
  return { lattice, atoms, warnings: [] };
}

// ---- Bonds and the boundary rule ----

// Remove atoms within SAME_SITE of an earlier one, across the cell boundary when there is a lattice; how many went.
function deduplicate(atoms: CAtom[], lattice?: Lattice): CAtom[] {
  const kept: CAtom[] = [];
  for (const a of atoms) {
    const same = kept.find((k) => (lattice ? lattice.within(k.xyz, a.xyz, SAME_SITE) : length(sub(k.xyz, a.xyz)) < SAME_SITE));
    if (same) same.asymmetric ||= a.asymmetric;
    else kept.push(a);
  }
  return kept;
}
// A bond from atom a to the copy of atom b `image` cells away.
type Link = { a: number; b: number; image: V3 };
// Every bond by covalent radii, each once; across periodic images with a lattice.
function links(atoms: CAtom[], lattice?: Lattice): Link[] {
  const radii = atoms.map((a) => covalentRadius(a.element)), largest = Math.max(0, ...radii);
  const reach = lattice ? lattice.reach(2 * largest + TOLERANCE) : [0, 0, 0];
  // Bonds to copies more than three cells away would need a reduced cell.
  if (reach.some((r) => r > MAX_REACH)) fail("The unit cell is too thin or skewed to find its bonds; use a reduced (Niggli) cell");
  const shifts: [V3, V3][] = [];
  for (let i = -reach[0]; i <= reach[0]; i++) for (let j = -reach[1]; j <= reach[1]; j++) for (let k = -reach[2]; k <= reach[2]; k++) shifts.push([[i, j, k], lattice ? lattice.cartesian([i, j, k]) : [0, 0, 0]]);
  // In oxides, halides and other salts two metals are not bonded, however close, as rutile's Ti–Ti at 2.96 Å; in metals
  // and alloys they are.
  const salt = atoms.some((a) => ANIONS.has(a.element)), metal = atoms.map((a) => !NONMETALS.has(a.element));
  const out: Link[] = [];
  for (let a = 0; a < atoms.length; a++) for (let b = a; b < atoms.length; b++) {
    if (salt && metal[a] && metal[b]) continue;
    const cutoff = radii[a] + radii[b] + TOLERANCE;
    for (const [image, t] of shifts) {
      // An atom's bond to its own copy counts once, towards +image.
      if (a === b) { const nz = image.find((v) => v !== 0); if (nz === undefined || nz < 0) continue; }
      const d = length(sub(add(atoms[b].xyz, t), atoms[a].xyz));
      if (d < cutoff && d > 0.4) out.push({ a, b, image: [...image] as V3 });
    }
  }
  return out;
}
// The boundary rule, molecule by molecule. A molecule (a finite connected group) is unwrapped so it is whole and moved
// by whole cells so its centre lies in the cell. An extended network, whose bonds connect an atom to its own copy in
// another cell, keeps each atom once inside the cell; its bonds that leave the cell are kept apart.
function arrange(atoms: CAtom[], all: Link[], lattice?: Lattice) {
  const n = atoms.length, neighbours: [number, V3][][] = atoms.map(() => []);
  for (const l of all) { neighbours[l.a].push([l.b, l.image]); neighbours[l.b].push([l.a, l.image.map((v) => -v) as V3]); }
  const offset: (V3 | undefined)[] = new Array(n).fill(undefined), xyz = atoms.map((a) => a.xyz), network = new Array<boolean>(n).fill(false);
  for (let start = 0; start < n; start++) {
    if (offset[start]) continue;
    const members = [start], queue = [start];
    let periodic = false;
    offset[start] = [0, 0, 0];
    while (queue.length) {
      const i = queue.shift()!, ti = offset[i]!;
      for (const [j, image] of neighbours[i]) {
        const want = add(ti, image);
        if (!offset[j]) { offset[j] = want; members.push(j); queue.push(j); }
        else if (offset[j]!.some((v, k) => v !== want[k])) periodic = true;
      }
    }
    if (!lattice) continue;
    if (periodic) { for (const m of members) network[m] = true; continue; }
    // Unwrap the molecule, then move it whole so its centre is inside.
    for (const m of members) xyz[m] = add(xyz[m], lattice.cartesian(offset[m]!));
    const centre = members.reduce<V3>((c, m) => add(c, scale(xyz[m], 1 / members.length)), [0, 0, 0]);
    const back = lattice.cartesian(lattice.fractional(centre).map((v) => -Math.floor(v + WRAP)) as V3);
    for (const m of members) xyz[m] = add(xyz[m], back);
  }
  const bonds: [number, number][] = [], crossing: Link[] = [];
  for (const l of all) {
    if ((network[l.a] || network[l.b]) && l.image.some((v) => v !== 0)) crossing.push(l);
    else bonds.push([l.a, l.b]);
  }
  return { xyz, bonds, crossing, network };
}

// Bond orders for whole molecules: C, N, O and S without a charge take double or triple bonds until each has its usual
// valence (O=C=O, urea's C=O). Each molecule is filled by a search that backtracks, so the order of the atoms never
// matters; a molecule that cannot be filled exactly (as one whose file leaves out its hydrogens) keeps single bonds,
// and so do extended networks.
export function bondOrders(atoms: { element: string; charge: number }[], bonds: [number, number][], network: boolean[]): number[] {
  const valence = (a: { element: string; charge: number }) => (a.charge !== 0 ? 0 : ({ C: 4, N: 3, O: 2, S: 2 } as Record<string, number>)[a.element] ?? 0);
  let free = atoms.map(valence);
  for (const [a, b] of bonds) { free[a]--; free[b]--; }
  const group = atoms.map((_, i) => i), root = (i: number) => { while (group[i] !== i) i = group[i]; return i; };
  for (const [a, b] of bonds) group[root(a)] = root(b);
  let orders = bonds.map(() => 1);
  const members = new Map<number, number[]>();
  atoms.forEach((_, i) => { const r = root(i); members.set(r, [...(members.get(r) ?? []), i]); });
  for (const of of members.values()) {
    if (of.some((i) => network[i]) || of.some((i) => free[i] < 0 && valence(atoms[i]) > 0) || !of.some((i) => free[i] > 0)) continue;
    const trialFree = [...free], trial = [...orders], budget = { left: FILL_BUDGET };
    if (fill(of, bonds, trialFree, trial, budget)) { orders = trial; free = trialFree; }
  }
  return orders;
}
const FILL_BUDGET = 20_000; // the most steps the bond-order search takes for one molecule
function fill(atoms: number[], bonds: [number, number][], free: number[], orders: number[], budget: { left: number }): boolean {
  if (budget.left === 0) return false;
  budget.left--;
  const usable = (i: number) => bonds.flatMap(([a, b], k): [number, number][] => {
    if (orders[k] >= 3) return [];
    const other = a === i ? b : b === i ? a : -1;
    return other >= 0 && other !== i && free[other] > 0 ? [[k, other]] : [];
  });
  let best: [number, [number, number][]] | undefined;
  for (const i of atoms) if (free[i] > 0) { const c = usable(i); if (!best || c.length < best[1].length) best = [i, c]; }
  if (!best) return true;
  const [atom, choices] = best;
  for (const [k, other] of choices) {
    orders[k]++; free[atom]--; free[other]--;
    if (fill(atoms, bonds, free, orders, budget)) return true;
    orders[k]--; free[atom]++; free[other]++;
  }
  return false;
}

// ---- The drawing ----

export type CrystalFormat = "cif" | "pdb" | "poscar" | "xyz";
// The crystal format of a file name: cif, pdb (also .ent), poscar (.vasp, .poscar, .contcar and files named POSCAR…
// or CONTCAR…) or xyz (also .extxyz). Anything else: none.
export function crystalFormat(name: string): CrystalFormat | undefined {
  const lower = name.split(/[\\/]/).pop()!.toLowerCase(), dot = lower.lastIndexOf("."), ext = dot < 0 ? "" : lower.slice(dot + 1);
  const byExt = ({ cif: "cif", pdb: "pdb", ent: "pdb", vasp: "poscar", poscar: "poscar", contcar: "poscar", xyz: "xyz", extxyz: "xyz" } as Record<string, CrystalFormat>)[ext];
  // Named POSCAR… or CONTCAR… with no extension or a number for one (POSCAR.1); "POSCAR study.oct" is a drawing.
  return byExt ?? ((lower.startsWith("poscar") || lower.startsWith("contcar")) && /^\d*$/.test(ext) ? "poscar" : undefined);
}

const MAX_LABEL = 64, MAX_NOTES = 16, MAX_NOTE = 512;
// What Octet read: the drawing (atoms and bonds, laid out as the model's opening view shows them, with a 3D model that
// holds them all, and the cell when there is one) and its notes.
export function readCrystal(format: CrystalFormat, text: string): { mol: Mol; notes: string[] } {
  const s = format === "cif" ? readCif(text) : format === "pdb" ? readPdb(text) : format === "poscar" ? readPoscar(text) : readXyz(text);
  if (!s.atoms.length) fail("The file has no atoms");
  if (s.lattice) for (const a of s.atoms) a.xyz = s.lattice.cartesian(s.lattice.fractional(a.xyz).map(wrap) as V3);
  if (s.atoms.length > MAX_CRYSTAL_ATOMS) fail(`The structure has ${s.atoms.length} atoms; at most ${MAX_CRYSTAL_ATOMS} can be shown`);
  const atoms = deduplicate(s.atoms, s.lattice), removed = s.atoms.length - atoms.length;
  if (removed) s.warnings.push(`${removed} overlapping atom${removed === 1 ? "" : "s"} left out`);
  const arranged = arrange(atoms, links(atoms, s.lattice), s.lattice);
  const orders = bondOrders(atoms, arranged.bonds, arranged.network);
  // Every atom of a structure file is explicit: Octet adds no hydrogens.
  const drawn: Atom[] = atoms.map((a) => ({ label: a.element, location: [0, 0, 0], implicitHCount: 0, ...(a.charge ? { charge: a.charge } : {}) }));
  const seen = new Set<string>(), bonds: Bond[] = [], modelBonds: [number, number][] = [];
  arranged.bonds.forEach(([a, b], k) => {
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    if (a === b || seen.has(key)) return;
    seen.add(key);
    bonds.push({ type: orders[k], atoms: [a, b], ...(s.lattice ? { distance: true as const } : {}) });
    modelBonds.push([a, b]);
  });
  const notes = s.warnings.slice(0, MAX_NOTES).map((n) => n.slice(0, MAX_NOTE));
  let crystal: Crystal | undefined;
  if (s.lattice) {
    const keys = new Set<string>(), crossing: Crystal["crossing"] = [];
    for (const l of arranged.crossing) {
      const c = l.a <= l.b ? { a: l.a, b: l.b, image: l.image } : { a: l.b, b: l.a, image: l.image.map((v) => -v) as V3 };
      const key = `${c.a},${c.b},${c.image.join(",")}`;
      if (!keys.has(key)) { keys.add(key); crossing.push(c); }
    }
    const sites = atoms.flatMap((a, i) => (a.label || a.adp || a.asymmetric ? [{ atom: i, ...(a.label ? { label: [...a.label].slice(0, MAX_LABEL).join("") } : {}), ...(a.adp ? { adp: a.adp } : {}), ...(a.asymmetric ? { asymmetric: true as const } : {}) }] : []));
    crystal = { vectors: s.lattice.vectors.map((v) => [...v]) as M3, ...(crossing.length ? { crossing } : {}), ...(sites.length ? { sites } : {}), ...(notes.length ? { notes } : {}) };
  }
  let mol: Mol = { atoms: drawn, bonds };
  const sources = atoms.map((_, i) => i);
  const model: Model3d = { sources, elements: atoms.map((a) => a.element), xyz: arranged.xyz.map((p) => [...p] as V3), bonds: modelBonds, fingerprint: "", rotation: [1, 0, 0, 0], offset: [0, 0], size: 1, display: "3d",
    ...(crystal ? { crystal } : {}) };
  model.rotation = openingView(model);
  model.size = crystalSize(model);
  mol = layOutCrystal({ ...mol, models: [model] }, 0, [0, 0]);
  mol.models![0].fingerprint = fingerprintOf(mol, sources, !!crystal);
  return { mol, notes };
}
