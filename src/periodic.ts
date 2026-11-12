// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), src/app/palettes.rs (the atom palette's 18-column layout), MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
// The periodic table window (PeriodicTable.tsx): where each element sits, what the window says about it, and how the
// arrow keys move through the grid. La and Ac sit in group 3, with Ce–Lu and Th–Lr in the two f-block rows, as in
// ReShiki and ChemDraw.
import { ELEMENTS as SYMBOLS } from "./labels.ts";
import { ELEMENTS as NAMES } from "./metals.ts";
import { atomMass } from "./mass.ts";

// Nine rows of 18 cells; "." is an empty cell. Rows 7 and 8 are the lanthanoids and actinoids.
export const PERIODIC_ROWS: string[][] = [
  "H . . . . . . . . . . . . . . . . He",
  "Li Be . . . . . . . . . . B C N O F Ne",
  "Na Mg . . . . . . . . . . Al Si P S Cl Ar",
  "K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr",
  "Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe",
  "Cs Ba La Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn",
  "Fr Ra Ac Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og",
  ". . Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu . .",
  ". . Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr . .",
].map((r) => r.split(" ").map((s) => (s === "." ? "" : s)));
// What a screen reader calls each row.
export const ROW_NAMES = ["Period 1", "Period 2", "Period 3", "Period 4", "Period 5", "Period 6", "Period 7", "Lanthanoids", "Actinoids"];

// labels.ts lists the 118 elements in order of atomic number (then D and T).
const ORDER = [...SYMBOLS].slice(0, 118);
export type ElementInfo = { symbol: string; name: string; number: number; mass?: number };
export function elementInfo(symbol: string): ElementInfo | undefined {
  const number = ORDER.indexOf(symbol) + 1, name = NAMES.get(symbol);
  if (!number || !name) return undefined;
  const mass = atomMass(symbol);
  return { symbol, name, number, ...(mass ? { mass } : {}) };
}
export const capital = (t: string) => t[0].toUpperCase() + t.slice(1);

// The cell the arrow key goes to from (row, col): along the row to the next element, or up and down the same group
// to the next row that has an element there (so Ra stops, La goes on to Ac, Ce and Th). Stays put at an edge.
export function step(at: [number, number], key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End"): [number, number] {
  const [r, c] = at, row = PERIODIC_ROWS[r];
  const filled = (k: number) => row[k] !== "";
  if (key === "Home") return [r, row.findIndex((s) => s)];
  if (key === "End") return [r, row.length - 1 - [...row].reverse().findIndex((s) => s)];
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const d = key === "ArrowLeft" ? -1 : 1;
    for (let k = c + d; k >= 0 && k < row.length; k += d) if (filled(k)) return [r, k];
    return at;
  }
  const d = key === "ArrowUp" ? -1 : 1;
  for (let k = r + d; k >= 0 && k < PERIODIC_ROWS.length; k += d) if (PERIODIC_ROWS[k][c]) return [k, c];
  return at;
}
export function cellOf(symbol: string): [number, number] | undefined {
  for (let r = 0; r < PERIODIC_ROWS.length; r++) {
    const c = PERIODIC_ROWS[r].indexOf(symbol);
    if (c >= 0) return [r, c];
  }
  return undefined;
}
// Letters typed in the window: the element with that symbol (any case), else the first whose symbol starts so.
export function findSymbol(typed: string): string | undefined {
  const t = typed.toLowerCase();
  return ORDER.find((s) => s.toLowerCase() === t) ?? ORDER.find((s) => s.toLowerCase().startsWith(t));
}
