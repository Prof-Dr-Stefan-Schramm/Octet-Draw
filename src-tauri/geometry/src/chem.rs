//! The molecule as the force fields see it: valence and implicit hydrogens, a Kekulé form, rings, aromaticity,
//! conjugation and hybridisation as RDKit perceives them, then the hydrogens as atoms. Original atoms keep their
//! indices; added hydrogens follow in the order of their parents.
use crate::{Request, rings};

pub(crate) type Result<T> = std::result::Result<T, String>;

/// Elements the force fields and the hydrogen rules support.
pub(crate) const ELEMENTS: [u8; 14] = [1, 5, 6, 7, 8, 9, 14, 15, 16, 17, 33, 34, 35, 53];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Hyb {
    S,
    Sp,
    Sp2,
    Sp3,
    Sp3d,
    Sp3d2,
    Unspecified,
}

#[derive(Clone, Debug)]
pub(crate) struct Atom {
    pub z: u8,
    pub charge: i8,
    pub chiral_tag: u8,
    /// Hydrogens not (yet) present as atoms: explicit and implicit. Zero after expansion.
    pub hs: u8,
    /// RDKit aromaticity.
    pub aromatic: bool,
    pub hyb: Hyb,
}

#[derive(Clone, Debug)]
pub(crate) struct Bond {
    pub a: usize,
    pub b: usize,
    /// Kekulé order: 1, 2 or 3.
    pub order: u8,
    /// RDKit aromaticity (order 1.5 for UFF).
    pub aromatic: bool,
    pub conjugated: bool,
    pub stereo: u32,
    pub refs: Option<[usize; 2]>,
}

#[derive(Clone, Debug)]
pub(crate) struct Mol {
    pub atoms: Vec<Atom>,
    pub bonds: Vec<Bond>,
    /// Neighbours as (atom, bond), in the order of the bond list.
    pub nbrs: Vec<Vec<(usize, usize)>>,
    /// Number of original (request) atoms.
    pub original: usize,
    /// Symmetrised smallest set of smallest rings; atoms in ring order.
    pub rings: Vec<Vec<usize>>,
}

/// Allowed total valences for an element and formal charge, as RDKit 2026.09 gives them (checked against its
/// implicit-hydrogen counts for explicit valence 0–15). With `true`, every valence from the last value up is allowed.
fn valences(z: u8, charge: i8) -> Option<(&'static [u8], bool)> {
    Some(match (z, charge) {
        (1, -1) => (&[0], false),
        (1, 0) => (&[1], false),
        (1, 1) => (&[0], true),
        (5, -8) => (&[3], false),
        (5, -7) => (&[2], true),
        (5, -6) => (&[1], true),
        (5, -5) => (&[0], false),
        (5, -4) => (&[1], false),
        (5, -3) => (&[2], false),
        (5, -2) => (&[3], false),
        (5, -1) => (&[4], false),
        (5, 0) => (&[3], false),
        (5, 1) => (&[2], false),
        (5, 2) => (&[1], true),
        (5, 3) => (&[0], true),
        (5, 4) => (&[0], true),
        (5, 5) => (&[0], true),
        (5, 6) => (&[0], true),
        (5, 7) => (&[0], true),
        (5, 8) => (&[0], true),
        (6, -8) => (&[4], false),
        (6, -7) => (&[3], false),
        (6, -6) => (&[2], true),
        (6, -5) => (&[1], true),
        (6, -4) => (&[0], false),
        (6, -3) => (&[1], false),
        (6, -2) => (&[2], false),
        (6, -1) => (&[3], false),
        (6, 0) => (&[4], false),
        (6, 1) => (&[3], false),
        (6, 2) => (&[2], false),
        (6, 3) => (&[1], true),
        (6, 4) => (&[0], false),
        (6, 5) => (&[1], false),
        (6, 6) => (&[0], true),
        (6, 7) => (&[0], true),
        (6, 8) => (&[0], true),
        (7, -8) => (&[1, 3, 5], false),
        (7, -7) => (&[2, 4, 6], false),
        (7, -6) => (&[3, 5], false),
        (7, -5) => (&[4], false),
        (7, -4) => (&[3], false),
        (7, -3) => (&[0], false),
        (7, -2) => (&[1], false),
        (7, -1) => (&[2], false),
        (7, 0) => (&[3], false),
        (7, 1) => (&[4], false),
        (7, 2) => (&[3], false),
        (7, 3) => (&[2], false),
        (7, 4) => (&[1], true),
        (7, 5) => (&[0], true),
        (7, 6) => (&[0], true),
        (7, 7) => (&[0], true),
        (7, 8) => (&[0], true),
        (8, -8) => (&[0], false),
        (8, -7) => (&[1, 3, 5], false),
        (8, -6) => (&[2, 4, 6], false),
        (8, -5) => (&[3, 5], false),
        (8, -4) => (&[4], false),
        (8, -3) => (&[3], false),
        (8, -2) => (&[0], false),
        (8, -1) => (&[1], false),
        (8, 0) => (&[2], false),
        (8, 1) => (&[3], false),
        (8, 2) => (&[4], false),
        (8, 3) => (&[3], false),
        (8, 4) => (&[2], true),
        (8, 5) => (&[1], true),
        (8, 6) => (&[0], true),
        (8, 7) => (&[0], true),
        (8, 8) => (&[0], true),
        (9, -8) => (&[1, 3, 5], false),
        (9, -7) => (&[0], false),
        (9, -6) => (&[1, 3, 5], false),
        (9, -5) => (&[2, 4, 6], false),
        (9, -4) => (&[3, 5], false),
        (9, -3) => (&[4], false),
        (9, -2) => (&[1], true),
        (9, -1) => (&[0], false),
        (9, 0) => (&[1], false),
        (9, 1) => (&[2], false),
        (9, 2) => (&[3], false),
        (9, 3) => (&[4], false),
        (9, 4) => (&[3], false),
        (9, 5) => (&[2], true),
        (9, 6) => (&[1], true),
        (9, 7) => (&[0], true),
        (9, 8) => (&[0], true),
        (14, -8) => (&[0, 2, 4, 6], false),
        (14, -7) => (&[1, 3, 5], false),
        (14, -6) => (&[0], false),
        (14, -5) => (&[1, 3, 5], false),
        (14, -4) => (&[0], false),
        (14, -3) => (&[1, 3, 5], false),
        (14, -2) => (&[2, 4, 6], false),
        (14, -1) => (&[3, 5], false),
        (14, 0) => (&[4], false),
        (14, 1) => (&[3], false),
        (14, 2) => (&[2], true),
        (14, 3) => (&[1], true),
        (14, 4) => (&[0], true),
        (14, 5) => (&[0], true),
        (14, 6) => (&[0], true),
        (14, 7) => (&[0], true),
        (14, 8) => (&[0], true),
        (15, -8) => (&[1, 3, 5], false),
        (15, -7) => (&[0, 2, 4, 6], false),
        (15, -6) => (&[1, 3, 5], false),
        (15, -5) => (&[0], false),
        (15, -4) => (&[1, 3, 5], false),
        (15, -3) => (&[0], false),
        (15, -2) => (&[1, 3, 5], false),
        (15, -1) => (&[2, 4, 6], false),
        (15, 0) => (&[3, 5], false),
        (15, 1) => (&[4], false),
        (15, 2) => (&[3], false),
        (15, 3) => (&[2], true),
        (15, 4) => (&[1], true),
        (15, 5) => (&[0], true),
        (15, 6) => (&[0], true),
        (15, 7) => (&[0], true),
        (15, 8) => (&[0], true),
        (16, -8) => (&[0, 2, 4, 6], false),
        (16, -7) => (&[1, 3, 5], false),
        (16, -6) => (&[0, 2, 4, 6], false),
        (16, -5) => (&[1, 3, 5], false),
        (16, -4) => (&[0], false),
        (16, -3) => (&[1, 3, 5], false),
        (16, -2) => (&[0, 2, 4], false),
        (16, -1) => (&[1, 3, 5], false),
        (16, 0) => (&[2, 4, 6], false),
        (16, 1) => (&[3, 5], false),
        (16, 2) => (&[4], false),
        (16, 3) => (&[3], false),
        (16, 4) => (&[2], true),
        (16, 5) => (&[1], true),
        (16, 6) => (&[0], true),
        (16, 7) => (&[0], true),
        (16, 8) => (&[0], true),
        (17, -8) => (&[1, 3, 5], false),
        (17, -7) => (&[0, 2, 4, 6], false),
        (17, -6) => (&[1, 3, 5], false),
        (17, -5) => (&[0, 2, 4, 6], false),
        (17, -4) => (&[1, 3, 5], false),
        (17, -3) => (&[0], false),
        (17, -2) => (&[1], true),
        (17, -1) => (&[0], false),
        (17, 0) => (&[1], false),
        (17, 1) => (&[2, 4, 6], false),
        (17, 2) => (&[3, 5], false),
        (17, 3) => (&[4], false),
        (17, 4) => (&[3], false),
        (17, 5) => (&[2], true),
        (17, 6) => (&[1], true),
        (17, 7) => (&[0], true),
        (17, 8) => (&[0], true),
        (33, -8) => (&[0], false),
        (33, -7) => (&[1, 3, 5], false),
        (33, -6) => (&[0, 2, 4, 6], false),
        (33, -5) => (&[1, 3, 5], false),
        (33, -4) => (&[0], false),
        (33, -3) => (&[1, 3, 5], false),
        (33, -2) => (&[1, 3], false),
        (33, -1) => (&[2, 4, 6], false),
        (33, 0) => (&[3, 5], false),
        (33, 1) => (&[4], false),
        (33, 2) => (&[3], false),
        (33, 3) => (&[2], true),
        (33, 4) => (&[1], true),
        (33, 5) => (&[0], true),
        (33, 6) => (&[0], true),
        (33, 7) => (&[0], true),
        (33, 8) => (&[0], true),
        (34, -8) => (&[1, 3, 5], false),
        (34, -7) => (&[0], false),
        (34, -6) => (&[1, 3, 5], false),
        (34, -5) => (&[0], false),
        (34, -4) => (&[2, 4, 6], false),
        (34, -3) => (&[1, 3, 5], false),
        (34, -2) => (&[0, 2, 4], false),
        (34, -1) => (&[1, 3, 5], false),
        (34, 0) => (&[2, 4, 6], false),
        (34, 1) => (&[3, 5], false),
        (34, 2) => (&[4], false),
        (34, 3) => (&[3], false),
        (34, 4) => (&[2], true),
        (34, 5) => (&[1], true),
        (34, 6) => (&[0], true),
        (34, 7) => (&[0], true),
        (34, 8) => (&[0], true),
        (35, -8) => (&[1, 3, 5], false),
        (35, -7) => (&[0, 2, 4, 6], false),
        (35, -6) => (&[1, 3, 5], false),
        (35, -5) => (&[0], false),
        (35, -4) => (&[1, 3, 5], false),
        (35, -3) => (&[0], false),
        (35, -2) => (&[1], true),
        (35, -1) => (&[0], false),
        (35, 0) => (&[1], false),
        (35, 1) => (&[2, 4, 6], false),
        (35, 2) => (&[3, 5], false),
        (35, 3) => (&[4], false),
        (35, 4) => (&[3], false),
        (35, 5) => (&[2], true),
        (35, 6) => (&[1], true),
        (35, 7) => (&[0], true),
        (35, 8) => (&[0], true),
        (53, -8) => (&[0, 2, 4, 6], false),
        (53, -7) => (&[1, 3, 5], false),
        (53, -6) => (&[0, 2, 4, 6], false),
        (53, -5) => (&[1, 3, 5], false),
        (53, -4) => (&[0, 2, 4, 6], false),
        (53, -3) => (&[1, 3, 5], false),
        (53, -2) => (&[1], false),
        (53, -1) => (&[0, 2, 4, 6], false),
        (53, 0) => (&[1, 3, 5], false),
        (53, 1) => (&[2, 4, 6], false),
        (53, 2) => (&[3, 5], false),
        (53, 3) => (&[4], false),
        (53, 4) => (&[3], false),
        (53, 5) => (&[2], true),
        (53, 6) => (&[1], true),
        (53, 7) => (&[0], true),
        (53, 8) => (&[0], true),
        _ => return None,
    })
}

/// Implicit hydrogens for an explicit valence, or None when no allowed valence is reached.
fn implicit_hs(allowed: &[u8], open: bool, explicit: i32) -> Option<i32> {
    match allowed.iter().map(|&v| v as i32).find(|&v| v >= explicit) {
        Some(v) => Some(v - explicit),
        None if open => Some(0),
        None => None,
    }
}

pub(crate) fn outer_electrons(z: u8) -> i32 {
    match z {
        1 => 1,
        5 => 3,
        6 | 14 => 4,
        7 | 15 | 33 => 5,
        8 | 16 | 34 => 6,
        9 | 17 | 35 | 53 => 7,
        _ => 0,
    }
}

/// RDKit's default valence of the neutral element (the first of its valence list).
pub(crate) fn default_valence(z: i32) -> i32 {
    match z {
        1 | 9 | 17 | 35 | 53 => 1,
        5 => 3,
        6 | 14 | 32 => 4,
        7 | 15 | 33 => 3,
        8 | 16 | 34 => 2,
        2 | 10 | 18 => 0,
        3 | 11 | 19 => 1,
        4 | 12 | 20 => 2,
        13 => 3,
        _ => -1,
    }
}

impl Mol {
    pub fn degree(&self, i: usize) -> usize {
        self.nbrs[i].len()
    }
    /// Degree with the hydrogens not yet expanded.
    pub fn total_degree(&self, i: usize) -> i32 {
        (self.nbrs[i].len() + self.atoms[i].hs as usize) as i32
    }
    /// Sum of Kekulé bond orders and unexpanded hydrogens.
    pub fn valence(&self, i: usize) -> i32 {
        self.nbrs[i].iter().map(|&(_, b)| self.bonds[b].order as i32).sum::<i32>() + self.atoms[i].hs as i32
    }
    pub fn bond_between(&self, a: usize, b: usize) -> Option<usize> {
        self.nbrs[a].iter().find(|&&(n, _)| n == b).map(|&(_, bond)| bond)
    }
    pub fn in_ring(&self, i: usize) -> bool {
        self.rings.iter().any(|r| r.contains(&i))
    }
    pub fn bond_in_ring(&self, bond: usize) -> bool {
        let (a, b) = (self.bonds[bond].a, self.bonds[bond].b);
        self.rings.iter().any(|r| ring_has_edge(r, a, b))
    }
    pub fn has_conjugated_bond(&self, i: usize) -> bool {
        self.nbrs[i].iter().any(|&(_, b)| self.bonds[b].conjugated)
    }

    /// Build the original-atom molecule from a request: checks, Kekulé form, hydrogens, rings and perception.
    pub fn from_request(request: &Request) -> Result<Mol> {
        let n = request.atoms.len();
        let mut atoms = Vec::with_capacity(n);
        for (index, atom) in request.atoms.iter().enumerate() {
            if !ELEMENTS.contains(&(atom.atomic_number as u8)) || atom.atomic_number > 53 {
                return Err(format!("atom {index}: query, metal, or unsupported element"));
            }
            if atom.radical != 0 {
                return Err(format!("atom {index}: radicals are unsupported"));
            }
            if !(-8..=8).contains(&atom.charge) {
                return Err(format!("atom {index}: formal charge is outside supported range"));
            }
            atoms.push(Atom {
                z: atom.atomic_number as u8,
                charge: atom.charge as i8,
                chiral_tag: atom.chiral_tag as u8,
                hs: 0,
                aromatic: false,
                hyb: Hyb::Unspecified,
            });
        }
        let mut bonds = Vec::with_capacity(request.bonds.len());
        let mut nbrs = vec![Vec::new(); n];
        let mut aromatic_input = Vec::with_capacity(request.bonds.len());
        for (index, bond) in request.bonds.iter().enumerate() {
            let order = match bond.order {
                1 | 12 => 1,
                2 => 2,
                3 => 3,
                _ => return Err(format!("bond {index}: query or coordination bond is unsupported")),
            };
            aromatic_input.push(bond.order == 12);
            nbrs[bond.a].push((bond.b, index));
            nbrs[bond.b].push((bond.a, index));
            bonds.push(Bond {
                a: bond.a,
                b: bond.b,
                order,
                aromatic: false,
                conjugated: false,
                stereo: bond.stereo,
                refs: bond.stereo_atoms,
            });
        }
        let mut reached = vec![false; n];
        let mut pending = vec![0];
        reached[0] = true;
        while let Some(i) = pending.pop() {
            for &(j, _) in &nbrs[i] {
                if !reached[j] {
                    reached[j] = true;
                    pending.push(j);
                }
            }
        }
        if !reached.iter().all(|&r| r) {
            return Err("geometry requests must contain one connected covalent component".into());
        }
        let mut mol = Mol { atoms, bonds, nbrs, original: n, rings: Vec::new() };
        mol.hydrogens_and_kekule(request, &aromatic_input)?;
        mol.rings = rings::sssr(&mol);
        mol.perceive_aromaticity();
        mol.perceive_conjugation();
        mol.perceive_hybridisation();
        Ok(mol)
    }

    /// Implicit hydrogens (RDKit's rules, the aromatic rule for atoms with aromatic input bonds), then a Kekulé
    /// form for aromatic input bonds.
    fn hydrogens_and_kekule(&mut self, request: &Request, aromatic: &[bool]) -> Result<()> {
        let n = self.atoms.len();
        let mut candidate = vec![false; n];
        for i in 0..n {
            let input = &request.atoms[i];
            let (allowed, open) = valences(self.atoms[i].z, self.atoms[i].charge)
                .ok_or_else(|| format!("atom {i}: formal charge is outside supported range"))?;
            let arom_bonds = self.nbrs[i].iter().filter(|&&(_, b)| aromatic[b]).count() as i32;
            let other: i32 = self.nbrs[i]
                .iter()
                .filter(|&&(_, b)| !aromatic[b])
                .map(|&(_, b)| self.bonds[b].order as i32)
                .sum();
            let explicit_h = input.explicit_h as i32;
            let implicit = if arom_bonds > 0 {
                let dv = allowed[0] as i32;
                let mut accum = other as f64 + 1.5 * arom_bonds as f64 + explicit_h as f64;
                if accum > dv as f64 {
                    let mut pval = dv as f64;
                    for &v in allowed {
                        if v as f64 > accum {
                            break;
                        }
                        pval = v as f64;
                    }
                    if accum - pval <= 1.5 {
                        accum = pval;
                    }
                }
                let ev = (accum + 0.1).round() as i32;
                let h = if ev <= dv { dv - ev } else { 0 };
                // Kekulé candidates: atoms that still need one double bond.
                let total = if input.no_implicit { ev } else { ev + h };
                let mut dv2 = dv;
                let mut vi = 1;
                while total > dv2 && vi < allowed.len() {
                    dv2 = allowed[vi] as i32;
                    vi += 1;
                }
                let hs = explicit_h + if input.no_implicit { 0 } else { h };
                let sbo = other + arom_bonds + hs;
                let degree = self.nbrs[i].len() as i32 + hs;
                candidate[i] = degree < dv2 && sbo < dv2;
                h
            } else {
                let ev = other + explicit_h;
                match implicit_hs(allowed, open, ev) {
                    Some(h) => h,
                    None => return Err(format!("atom {i}: valence is not allowed for this element and charge")),
                }
            };
            let hs = explicit_h + if input.no_implicit { 0 } else { implicit };
            self.atoms[i].hs = u8::try_from(hs).map_err(|_| format!("atom {i}: too many hydrogens"))?;
        }
        if aromatic.iter().any(|&a| a) {
            let mut matched = vec![false; n];
            let edges: Vec<usize> = (0..self.bonds.len()).filter(|&b| aromatic[b]).collect();
            let mut steps = 0usize;
            if !self.kekule_match(&candidate, &mut matched, &edges, &mut steps) {
                return Err("aromatic bonds cannot be resolved into single and double bonds".into());
            }
        }
        // Every atom must now be at an allowed valence.
        for i in 0..n {
            let (allowed, open) = valences(self.atoms[i].z, self.atoms[i].charge).unwrap_or((&[], true));
            let v = self.valence(i);
            if !(open && allowed.last().is_some_and(|&l| v >= l as i32) || allowed.contains(&(v as u8))) {
                return Err(format!("atom {i}: valence is not allowed for this element and charge"));
            }
        }
        Ok(())
    }

    /// Backtracking perfect matching of double bonds over aromatic input bonds between candidate atoms.
    fn kekule_match(&mut self, candidate: &[bool], matched: &mut [bool], edges: &[usize], steps: &mut usize) -> bool {
        *steps += 1;
        if *steps > 200_000 {
            return false;
        }
        let Some(atom) = (0..candidate.len()).find(|&i| candidate[i] && !matched[i]) else {
            return true;
        };
        for &(other, bond) in &self.nbrs[atom].clone() {
            if !edges.contains(&bond) || !candidate[other] || matched[other] {
                continue;
            }
            matched[atom] = true;
            matched[other] = true;
            self.bonds[bond].order = 2;
            if self.kekule_match(candidate, matched, edges, steps) {
                return true;
            }
            self.bonds[bond].order = 1;
            matched[atom] = false;
            matched[other] = false;
        }
        false
    }

    /// RDKit's countAtomElec: electrons an atom can give to a pi system, or -1.
    fn count_atom_elec(&self, i: usize) -> i32 {
        let z = self.atoms[i].z as i32;
        let dv = default_valence(z);
        if dv <= 1 {
            return -1;
        }
        let degree = self.total_degree(i);
        if degree > 3 {
            return -1;
        }
        let nlp = (outer_electrons(z as u8) - dv - self.atoms[i].charge as i32).max(0);
        let mut res = (dv - degree) + nlp;
        if res > 1 {
            let unsaturations = self.valence(i) - degree;
            if unsaturations > 1 {
                res = 1;
            }
        }
        res
    }

    fn incident_multiple_bond(&self, i: usize) -> bool {
        self.nbrs[i].iter().any(|&(_, b)| self.bonds[b].order > 1)
    }

    /// RDKit's default aromaticity model on the Kekulé form.
    fn perceive_aromaticity(&mut self) {
        #[derive(Clone, Copy, PartialEq)]
        enum Donor {
            None,
            Vacant,
            One,
            Two,
        }
        let n = self.atoms.len();
        let ring_bond: Vec<bool> = (0..self.bonds.len()).map(|b| self.bond_in_ring(b)).collect();
        let more_electronegative = |a: u8, b: u8| {
            let (ea, eb) = (outer_electrons(a), outer_electrons(b));
            ea > eb || (ea == eb && a < b)
        };
        let mut donor = vec![Donor::None; n];
        for (i, d) in donor.iter_mut().enumerate() {
            let atom = &self.atoms[i];
            let z = atom.z as i32;
            if !matches!(z, 5..=8 | 14..=16 | 34) {
                continue;
            }
            let nelec = self.count_atom_elec(i);
            let exo = self.nbrs[i].iter().find(|&&(_, b)| !ring_bond[b] && self.bonds[b].order > 1);
            *d = if nelec < 0 {
                Donor::None
            } else if nelec == 0 {
                if exo.is_some() {
                    Donor::Vacant
                } else if self.nbrs[i].iter().any(|&(_, b)| ring_bond[b] && self.bonds[b].order > 1) {
                    Donor::One
                } else {
                    Donor::None
                }
            } else if nelec == 1 {
                if let Some(&(other, _)) = exo {
                    if more_electronegative(self.atoms[other].z, atom.z) { Donor::Vacant } else { Donor::One }
                } else if self.incident_multiple_bond(i) {
                    Donor::One
                } else if atom.charge == 1 {
                    Donor::Vacant
                } else {
                    Donor::None
                }
            } else if self.incident_multiple_bond(i) {
                Donor::One
            } else {
                Donor::Two
            };
            if *d == Donor::None {
                continue;
            }
            // Candidates: in their default valence state, at most one multiple bond.
            let isoelectronic = default_valence(z - atom.charge as i32);
            if default_valence(z) > 0 && self.valence(i) > isoelectronic {
                *d = Donor::None;
                continue;
            }
            let multiple = self.nbrs[i].iter().filter(|&&(_, b)| self.bonds[b].order > 1).count();
            if multiple > 1 {
                *d = Donor::None;
            }
        }
        let rings: Vec<usize> =
            (0..self.rings.len()).filter(|&r| self.rings[r].iter().all(|&a| donor[a] != Donor::None)).collect();
        let electrons = |atoms: &[usize]| -> i32 {
            atoms
                .iter()
                .map(|&a| match donor[a] {
                    Donor::Two => 2,
                    Donor::One => 1,
                    _ => 0,
                })
                .sum()
        };
        let huckel = |e: i32| e == 2 || (e >= 6 && (e - 2) % 4 == 0);
        // Fused systems: rings sharing a bond.
        let shares_bond = |a: &[usize], b: &[usize]| {
            let mut common = 0;
            for x in a {
                if b.contains(x) {
                    common += 1;
                }
            }
            common >= 2
        };
        let mut system = vec![usize::MAX; rings.len()];
        let mut systems: Vec<Vec<usize>> = Vec::new();
        for start in 0..rings.len() {
            if system[start] != usize::MAX {
                continue;
            }
            let id = systems.len();
            let mut members = vec![start];
            system[start] = id;
            let mut k = 0;
            while k < members.len() {
                let r = members[k];
                for other in 0..rings.len() {
                    if system[other] == usize::MAX && shares_bond(&self.rings[rings[r]], &self.rings[rings[other]]) {
                        system[other] = id;
                        members.push(other);
                    }
                }
                k += 1;
            }
            systems.push(members);
        }
        let mut aromatic_ring = vec![false; self.rings.len()];
        for members in &systems {
            let count = members.len();
            let most = if count <= 8 { count } else { 3 };
            let mut tried = 0usize;
            for size in 1..=most {
                let mut combination: Vec<usize> = (0..size).collect();
                loop {
                    tried += 1;
                    if tried > 20_000 {
                        break;
                    }
                    let chosen: Vec<usize> = combination.iter().map(|&c| rings[members[c]]).collect();
                    if !chosen.iter().all(|&r| aromatic_ring[r]) && self.rings_connected(&chosen) {
                        let mut union: Vec<usize> = chosen.iter().flat_map(|&r| self.rings[r].iter().copied()).collect();
                        union.sort_unstable();
                        union.dedup();
                        if huckel(electrons(&union)) {
                            for &r in &chosen {
                                aromatic_ring[r] = true;
                            }
                        }
                    }
                    // Next combination.
                    let mut i = size;
                    while i > 0 && combination[i - 1] == count - size + i - 1 {
                        i -= 1;
                    }
                    if i == 0 {
                        break;
                    }
                    combination[i - 1] += 1;
                    for j in i..size {
                        combination[j] = combination[j - 1] + 1;
                    }
                }
            }
        }
        for (r, ring) in self.rings.clone().iter().enumerate() {
            if !aromatic_ring[r] {
                continue;
            }
            for k in 0..ring.len() {
                let (a, b) = (ring[k], ring[(k + 1) % ring.len()]);
                self.atoms[a].aromatic = true;
                if let Some(bond) = self.bond_between(a, b) {
                    self.bonds[bond].aromatic = true;
                }
            }
        }
    }

    fn rings_connected(&self, chosen: &[usize]) -> bool {
        if chosen.len() == 1 {
            return true;
        }
        let mut reached = vec![chosen[0]];
        let mut k = 0;
        while k < reached.len() {
            let r = reached[k];
            for &other in chosen {
                if !reached.contains(&other) {
                    let common = self.rings[r].iter().filter(|a| self.rings[other].contains(a)).count();
                    if common >= 2 {
                        reached.push(other);
                    }
                }
            }
            k += 1;
        }
        reached.len() == chosen.len()
    }

    /// RDKit's isAtomConjugCand.
    fn conjugation_candidate(&self, i: usize) -> bool {
        let z = self.atoms[i].z;
        let outer = outer_electrons(z);
        (z <= 10 || (outer != 5 && outer != 6) || (outer == 6 && self.total_degree(i) < 2)) && self.count_atom_elec(i) > 0
    }

    /// RDKit's setConjugation: aromatic bonds, then markConjAtomBonds for every atom.
    fn perceive_conjugation(&mut self) {
        for bond in &mut self.bonds {
            bond.conjugated = bond.aromatic;
        }
        for i in 0..self.atoms.len() {
            if !self.conjugation_candidate(i) {
                continue;
            }
            let sbo = self.total_degree(i);
            if !(2..=3).contains(&sbo) {
                continue;
            }
            for &(_, b1) in &self.nbrs[i].clone() {
                if !(self.bonds[b1].aromatic || self.bonds[b1].order >= 2) {
                    continue;
                }
                for &(other, b2) in &self.nbrs[i].clone() {
                    if b1 == b2 || self.total_degree(other) > 3 {
                        continue;
                    }
                    if self.conjugation_candidate(other) {
                        self.bonds[b1].conjugated = true;
                        self.bonds[b2].conjugated = true;
                    }
                }
            }
        }
    }

    /// RDKit's setHybridization (numBondsPlusLonePairs).
    fn perceive_hybridisation(&mut self) {
        for i in 0..self.atoms.len() {
            let atom = &self.atoms[i];
            let degree = self.total_degree(i);
            let norbs = if atom.z <= 1 {
                degree
            } else {
                let outer = outer_electrons(atom.z);
                let valence = self.valence(i);
                let charge = atom.charge as i32;
                let free = outer - (valence + charge);
                // No radicals reach here, so below an octet or not the lone pairs are free / 2.
                degree + free / 2
            };
            self.atoms[i].hyb = match norbs {
                0 | 1 => Hyb::S,
                2 => Hyb::Sp,
                3 => Hyb::Sp2,
                4 => {
                    if degree < 4 && self.has_conjugated_bond(i) {
                        Hyb::Sp2
                    } else {
                        Hyb::Sp3
                    }
                }
                5 => Hyb::Sp3d,
                6 => Hyb::Sp3d2,
                _ => Hyb::Unspecified,
            };
        }
    }

    /// Add the hydrogens as atoms: original atoms first, then each atom's hydrogens in atom order.
    pub fn with_hydrogens(&self) -> Mol {
        let mut mol = self.clone();
        for i in 0..self.atoms.len() {
            for _ in 0..self.atoms[i].hs {
                let h = mol.atoms.len();
                let bond = mol.bonds.len();
                mol.atoms.push(Atom { z: 1, charge: 0, chiral_tag: 0, hs: 0, aromatic: false, hyb: Hyb::Unspecified });
                mol.nbrs.push(vec![(i, bond)]);
                mol.nbrs[i].push((h, bond));
                mol.bonds.push(Bond { a: i, b: h, order: 1, aromatic: false, conjugated: false, stereo: 0, refs: None });
            }
            mol.atoms[i].hs = 0;
        }
        mol
    }

    /// Parent of each added hydrogen.
    pub fn hydrogen_parents(&self) -> Vec<usize> {
        (self.original..self.atoms.len()).map(|h| self.nbrs[h][0].0).collect()
    }
}

pub(crate) fn ring_has_edge(ring: &[usize], a: usize, b: usize) -> bool {
    let n = ring.len();
    (0..n).any(|k| {
        let (x, y) = (ring[k], ring[(k + 1) % n]);
        (x == a && y == b) || (x == b && y == a)
    })
}
