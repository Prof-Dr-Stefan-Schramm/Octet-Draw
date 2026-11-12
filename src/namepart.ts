// Structure to Name for one structure, as the window and the naming worker (naming.worker.ts) both run it, so the two
// always give the same name. Editor.tsx asks for names through namingworker.ts; the checks call this directly.
import { cipOf, expandLabels, parseStructure, toInchi, toInchiAux } from "./chem.ts";
import { complexName } from "./complexes.ts";
import { sandwichIons } from "./metals.ts";
import { mixtureName } from "./mixtures.ts";
import { abbreviationOf, knownName, nameToAtoms, nameToSmiles } from "./names.ts";
import { iupacName } from "./namer.ts";
import { checkedName, setComplexNamer, setNamer, withAbbreviation } from "./naming.ts";
import type { Mol } from "./render.ts";

setNamer(iupacName);
setComplexNamer((m) => complexName(m, { read: nameToSmiles, atoms: nameToAtoms, inchi: toInchi, aux: toInchiAux, cip: cipOf }));

// A name's structure is drawn as Octet draws SMILES before its InChI is taken, so it counts hydrogens as the drawing
// does (the P of PPh3 bonded to Pd has none).
export const inchiOf = (s: Mol | string) => { try { return toInchi(typeof s === "string" ? parseStructure(s, false) : s); } catch { return undefined; } };

// The checked name (bare), the name shown (with its abbreviation) and the structure named.
export type NamedPart = { bare?: string; name?: string; mol: Mol };
export function namePart(part: Mol): NamedPart {
  let bare: string | undefined;
  // A metallocene drawn with the j key is named as its ions, as OPSIN and the standard InChI have it.
  const p = sandwichIons(part) ?? part;
  try { bare = checkedName(p, expandLabels(p), nameToSmiles, inchiOf, cipOf, knownName); } catch { bare = undefined; }
  // The abbreviation follows the checked name, as in an experimental section: "... (TREN)".
  return { bare, name: bare && withAbbreviation(bare, abbreviationOf(inchiOf(p))), mol: p };
}

// A grouped mixture's name (mixtures.ts): its components' checked names with their ratio, read back whole.
export type MixturePart = { name: string; mol: Mol; count: number };
export function nameMixture(parts: MixturePart[]): string | undefined {
  try { return mixtureName(parts, nameToSmiles, inchiOf); } catch { return undefined; }
}
