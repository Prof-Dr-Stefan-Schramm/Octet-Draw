// Picture to structure (decision 0023): what a model read, as an Octet structure. MolScribe's atoms keep their
// places in the picture, scaled so the median bond is one bond length (14.4 pt in ACS 1996). A label it read (OMe,
// Ph, CO2Et, R1) stays a written label, as the author drew it; Octet's own chemistry expands it as it expands any
// label typed by hand.
import { ELEMENTS } from "./labels.ts";
import type { Graph } from "./recognise-models.ts";
import type { Mol } from "./render.ts";

type Atom = Mol["atoms"][number];

// Condensed formulas old drawings write out, as the abbreviation Octet's chemistry reads (Octet 1.1.1 reads "OC2H5" as
// O(CH3)2 and "C6H5" as a chain): ethyl, phenyl and acetyl, alone or in an ester or ether.
const CONDENSED: Record<string, string> = {
  C2H5: "Et", H5C2: "Et", OC2H5: "OEt", C2H5O: "EtO", COOC2H5: "CO2Et", CO2C2H5: "CO2Et", C2H5OOC: "EtO2C", C2H5O2C: "EtO2C",
  C6H5: "Ph", H5C6: "Ph", OC6H5: "OPh", C6H5O: "PhO", CH3CO: "Ac", COCH3: "Ac", OCOCH3: "OAc", CH3COO: "AcO", CH3CO2: "AcO",
};

// One atom as MolScribe writes it: C, c (aromatic), Cl, [NH+], [13CH3], [O-], [H], or a label in brackets ([OMe]).
export function readSymbol(symbol: string): Pick<Atom, "label" | "text" | "charge" | "isotope"> {
  const inner = symbol.startsWith("[") && symbol.endsWith("]") ? symbol.slice(1, -1) : symbol;
  const m = /^(\d*)([A-Z][a-z]?|[bcnops]|se|as)@{0,2}(?:H\d*)?([+-]\d*|\+{2,}|-{2,})?$/.exec(inner);
  if (m) {
    const el = m[2][0].toUpperCase() + m[2].slice(1);
    if (ELEMENTS.has(el)) {
      const c = m[3], charge = !c ? 0 : /^[+-]\d+$/.test(c) ? (c[0] === "-" ? -1 : 1) * +c.slice(1) : (c[0] === "-" ? -1 : 1) * c.length;
      return { label: el, ...(charge ? { charge } : {}), ...(m[1] ? { isotope: +m[1] } : {}) };
    }
  }
  return { label: "C", text: inner === "*" ? "R" : CONDENSED[inner] ?? inner };
}

const STEREO_ELEMENTS = new Set(["C", "N", "P", "S", "Si", "Ge", "Sn", "B", "As", "Se"]);

// MolScribe's atoms and bonds as a structure, centred on 0, 0, y up. A wedge MolScribe gives as a pair of atoms is
// drawn from the end that can be a stereocentre: the atom with more bonds, never a label or a hydrogen.
export function graphMol(g: Graph): Mol {
  const atoms: Atom[] = g.atoms.map((a) => ({ ...readSymbol(a.symbol), location: [a.x, a.y, 0] }));
  const degree = atoms.map(() => 0);
  for (const b of g.bonds) { degree[b.a]++; degree[b.b]++; }
  const lengths = g.bonds.map((b) => Math.hypot(g.atoms[b.a].x - g.atoms[b.b].x, g.atoms[b.a].y - g.atoms[b.b].y)).sort((p, q) => p - q);
  const unit = lengths.length ? lengths[lengths.length >> 1] || 1 : 30;
  const cx = g.atoms.reduce((s, a) => s + a.x, 0) / Math.max(1, g.atoms.length), cy = g.atoms.reduce((s, a) => s + a.y, 0) / Math.max(1, g.atoms.length);
  for (const a of atoms) a.location = [(a.location[0] - cx) / unit, -(a.location[1] - cy) / unit, 0];
  const centre = (i: number) => (atoms[i].text || !STEREO_ELEMENTS.has(atoms[i].label) ? -1 : degree[i]);
  const bonds: Mol["bonds"] = g.bonds.map((b) => {
    if (b.kind <= 4) return { type: b.kind, atoms: [b.a, b.b] as [number, number] };
    // kind 5: a wedge from a, which is a hashed wedge from b; kind 6 the other way round.
    const fromA = centre(b.a) >= centre(b.b), solid = (b.kind === 5) === fromA;
    return { type: 1, atoms: (fromA ? [b.a, b.b] : [b.b, b.a]) as [number, number], stereo: solid ? 1 : 6 };
  });
  return { atoms, bonds };
}
