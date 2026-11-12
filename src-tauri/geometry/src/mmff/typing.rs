//! MMFF atom typing, aromaticity and partial charges, following RDKit's `Code/ForceField/MMFF/AtomTyper.cpp`
//! (BSD-3-Clause) on the Kekulé form with hydrogens as atoms.
use super::params::tables;
use crate::chem::{Hyb, Mol, ring_has_edge};

pub(crate) struct Typed {
    pub types: Vec<u8>,
    /// MMFF aromaticity of each bond.
    pub aromatic_bond: Vec<bool>,
}

fn nos(z: u8) -> bool {
    matches!(z, 7 | 8 | 16)
}

/// RDKit's setMMFFAromaticity.
fn aromaticity(mol: &Mol) -> (Vec<bool>, Vec<bool>, Vec<bool>) {
    let n = mol.atoms.len();
    let mut arom = vec![false; n];
    let mut seen = vec![false; n];
    let mut ring_arom = vec![false; mol.rings.len()];
    let in_ring: Vec<bool> = (0..n).map(|i| mol.in_ring(i)).collect();
    let mut old = usize::MAX;
    loop {
        for (r, ring) in mol.rings.iter().enumerate() {
            let mut pi = 0;
            let mut move_on = false;
            let mut has_nos = false;
            let mut exo_double = false;
            for (j, &a) in ring.iter().enumerate() {
                if !has_nos {
                    has_nos = nos(mol.atoms[a].z);
                }
                let next = ring[(j + 1) % ring.len()];
                let bond = mol.bond_between(a, next).expect("ring bond");
                if mol.bonds[bond].order == 2 {
                    pi += 2;
                    continue;
                }
                let z = mol.atoms[a].z;
                if z != 6 && !(z == 7 && mol.valence(a) == 4) {
                    continue;
                }
                for &(nb, b) in &mol.nbrs[a] {
                    if ring.contains(&nb) || mol.bonds[b].order == 1 {
                        continue;
                    }
                    if in_ring[nb] && !seen[nb] {
                        move_on = true;
                        break;
                    }
                    if mol.bonds[b].order == 2 {
                        if seen[nb] && arom[nb] {
                            pi += 1;
                        } else {
                            exo_double = true;
                        }
                    }
                }
                if move_on {
                    break;
                }
            }
            if move_on {
                continue;
            }
            let mut can = true;
            for &a in ring {
                seen[a] = true;
                let z = mol.atoms[a].z;
                if (z == 6 || z == 7) && mol.atoms[a].hyb != Hyb::Sp2 {
                    can = false;
                }
            }
            if !can {
                continue;
            }
            if has_nos && !exo_double && ring.len() % 2 == 1 {
                pi += 2;
            }
            if pi > 2 && (pi - 2) % 4 == 0 {
                ring_arom[r] = true;
                for &a in ring {
                    arom[a] = true;
                }
            }
        }
        let count = ring_arom.iter().filter(|&&a| a).count();
        if count == old {
            break;
        }
        old = count;
    }
    let mut bond_arom = vec![false; mol.bonds.len()];
    for (b, bond) in mol.bonds.iter().enumerate() {
        if arom[bond.a] && arom[bond.b] {
            bond_arom[b] = mol
                .rings
                .iter()
                .enumerate()
                .any(|(r, ring)| ring_arom[r] && ring_has_edge(ring, bond.a, bond.b));
        }
    }
    (arom, bond_arom, ring_arom)
}

struct Ctx<'a> {
    mol: &'a Mol,
    arom: Vec<bool>,
    ring_arom: Vec<bool>,
}

impl Ctx<'_> {
    fn z(&self, i: usize) -> u8 {
        self.mol.atoms[i].z
    }
    fn deg(&self, i: usize) -> usize {
        self.mol.nbrs[i].len()
    }
    fn nbrs(&self, i: usize) -> impl Iterator<Item = (usize, u8)> + '_ {
        self.mol.nbrs[i].iter().map(|&(n, b)| (n, self.mol.bonds[b].order))
    }
    fn charge(&self, i: usize) -> i8 {
        self.mol.atoms[i].charge
    }
    fn in_ring_size(&self, i: usize, size: usize) -> bool {
        self.mol.rings.iter().any(|r| r.len() == size && r.contains(&i))
    }
    fn double_partner(&self, i: usize) -> Option<usize> {
        self.nbrs(i).find(|&(_, o)| o == 2).map(|(n, _)| n)
    }
    fn has_order(&self, i: usize, order: u8) -> bool {
        self.nbrs(i).any(|(_, o)| o == order)
    }
    /// Terminal (degree 1) O and S neighbours.
    fn terminal_os(&self, i: usize) -> usize {
        self.nbrs(i).filter(|&(n, _)| matches!(self.z(n), 8 | 16) && self.deg(n) == 1).count()
    }
    fn terminal_o(&self, i: usize) -> usize {
        self.nbrs(i).filter(|&(n, _)| self.z(n) == 8 && self.deg(n) == 1).count()
    }
    /// Aromatic rings of a size containing an atom.
    fn arom_rings(&self, i: usize, size: usize) -> Vec<&Vec<usize>> {
        self.mol
            .rings
            .iter()
            .enumerate()
            .filter(|(r, ring)| self.ring_arom[*r] && ring.len() == size && ring.contains(&i))
            .map(|(_, ring)| ring)
            .collect()
    }
    /// A pi lone-pair donor in a five-membered aromatic ring.
    fn lone_pair_donor(&self, a: usize) -> bool {
        match self.z(a) {
            8 | 16 => self.deg(a) == 2,
            7 => self.deg(a) == 3 && !self.has_order(a, 2) && self.terminal_o(a) == 0,
            _ => false,
        }
    }

    fn five_ring_type(&self, i: usize) -> Option<u8> {
        let z = self.z(i);
        let rings = self.arom_rings(i, 5);
        let (mut alpha, mut beta, mut cation, mut anion) = (false, false, false, false);
        let mut donor = false;
        for ring in &rings {
            let ring_cation = ring
                .iter()
                .any(|&a| self.z(a) == 7 && self.charge(a) > 0 && self.deg(a) == 3 && self.terminal_o(a) == 0);
            let ring_anion = ring.iter().any(|&a| self.z(a) == 7 && self.charge(a) < 0);
            cation |= ring_cation;
            anion |= ring_anion;
            // Carbons of charged rings take general types; nitrogens of a cationic ring still see the donor.
            if ring_anion || (ring_cation && z == 6) {
                continue;
            }
            if self.lone_pair_donor(i) {
                donor = true;
                continue;
            }
            for &a in ring.iter() {
                if a == i || !self.lone_pair_donor(a) {
                    continue;
                }
                if self.mol.bond_between(a, i).is_some() {
                    alpha = true;
                } else {
                    beta = true;
                }
            }
        }
        match z {
            6 => {
                if cation {
                    let n3 = self
                        .nbrs(i)
                        .filter(|&(n, _)| self.z(n) == 7 && self.deg(n) == 3 && self.arom[n])
                        .count();
                    return Some(if n3 >= 2 { 80 } else { 78 });
                }
                if anion {
                    return Some(78);
                }
                Some(match (alpha, beta) {
                    (true, false) => 63,
                    (false, true) => 64,
                    _ => 78,
                })
            }
            7 => {
                if self.terminal_o(i) > 0 {
                    return Some(82);
                }
                if anion && self.deg(i) == 2 {
                    return Some(76);
                }
                if cation && self.deg(i) == 3 {
                    return Some(81);
                }
                if donor || (self.deg(i) == 3 && !self.has_order(i, 2)) {
                    return Some(39);
                }
                Some(match (alpha, beta) {
                    (true, false) => 65,
                    (false, true) => 66,
                    _ => 79,
                })
            }
            8 => Some(59),
            16 => Some(44),
            _ => None,
        }
    }

    fn six_ring_type(&self, i: usize) -> Option<u8> {
        match self.z(i) {
            6 => Some(37),
            7 => {
                if self.terminal_o(i) > 0 {
                    Some(69)
                } else if self.deg(i) == 3 {
                    Some(58)
                } else {
                    Some(38)
                }
            }
            _ => None,
        }
    }

    fn heavy_type(&self, i: usize, types: &[u8]) -> Option<u8> {
        if self.arom[i] {
            if !self.arom_rings(i, 5).is_empty() {
                if let Some(t) = self.five_ring_type(i) {
                    return Some(t);
                }
            } else if !self.arom_rings(i, 6).is_empty()
                && let Some(t) = self.six_ring_type(i)
            {
                return Some(t);
            }
        }
        let deg = self.deg(i);
        match self.z(i) {
            6 => match deg {
                4 => Some(if self.in_ring_size(i, 3) {
                    22
                } else if self.in_ring_size(i, 4) {
                    20
                } else {
                    1
                }),
                3 => {
                    let term_s = self.terminal_os(i) - self.terminal_o(i);
                    if (self.terminal_o(i) == 2 || term_s == 2)
                        && self.nbrs(i).any(|(n, _)| self.deg(n) == 1 && self.charge(n) < 0)
                    {
                        return Some(41);
                    }
                    let n3 = self.nbrs(i).filter(|&(n, _)| self.z(n) == 7 && self.deg(n) == 3).count();
                    let nplus = self.nbrs(i).any(|(n, o)| self.z(n) == 7 && self.charge(n) > 0 && o == 2);
                    if nplus && n3 >= 2 && self.terminal_o(i) == 0 {
                        return Some(57);
                    }
                    match self.double_partner(i) {
                        Some(d) if matches!(self.z(d), 7 | 8 | 15 | 16) => Some(3),
                        Some(d) if self.z(d) == 6 => Some(if self.in_ring_size(i, 4) { 30 } else { 2 }),
                        Some(_) => Some(2),
                        None => Some(2),
                    }
                }
                2 => Some(4),
                1 => {
                    if self.nbrs(i).any(|(n, o)| self.z(n) == 7 && o == 3) {
                        Some(60)
                    } else {
                        None
                    }
                }
                _ => None,
            },
            7 => match deg {
                4 => Some(if self.terminal_o(i) > 0 { 68 } else { 34 }),
                3 => {
                    let term_o = self.terminal_o(i);
                    if term_o >= 2 {
                        return Some(45);
                    }
                    let double = self.double_partner(i);
                    if term_o == 1 && double.is_some() {
                        return Some(67);
                    }

                    // A three-coordinate N with a double bond is an iminium, amidinium or guanidinium N.
                    if let Some(d) = double {
                        if self.z(d) == 6 {
                            let cn3 = self.nbrs(d).filter(|&(n, _)| self.z(n) == 7 && self.deg(n) == 3).count();
                            if cn3 >= 3 {
                                return Some(56);
                            }
                            if cn3 == 2 {
                                return Some(55);
                            }
                        }
                        return Some(54);
                    }
                    // Bonded to an amidinium or guanidinium carbon.
                    for (n, _) in self.nbrs(i) {
                        if self.z(n) == 6 && types[n] == 57 {
                            let cn3 = self.nbrs(n).filter(|&(m, _)| self.z(m) == 7 && self.deg(m) == 3).count();
                            return Some(if cn3 >= 3 { 56 } else { 55 });
                        }
                    }
                    let mut amide = false;
                    let mut enamine = false;
                    let mut sulfonamide = false;
                    let mut hydrazone = false;
                    for (n, _) in self.nbrs(i) {
                        match self.z(n) {
                            16 => {
                                if self.terminal_o(n) >= 2 || (self.terminal_o(n) == 1 && self.deg(n) == 4) {
                                    sulfonamide = true;
                                }
                            }
                            6 | 7 => {
                                if let Some(d) = self.double_partner(n)
                                    && d != i
                                {
                                    let zd = self.z(d);
                                    if self.z(n) == 6 && matches!(zd, 8 | 16) {
                                        amide = true;
                                    } else if self.z(n) == 7 && matches!(zd, 6 | 7) {
                                        hydrazone = true;
                                    } else if self.z(n) == 6 {
                                        enamine = true;
                                    }
                                }
                                // N-C#N (cyanamide) types as NSO2.
                                if self.z(n) == 6 && self.nbrs(n).any(|(m, o)| o == 3 && self.z(m) == 7) {
                                    sulfonamide = true;
                                }
                                if self.arom[n] {
                                    enamine = true;
                                }
                            }
                            _ => {}
                        }
                    }
                    Some(if sulfonamide {
                        43
                    } else if amide {
                        10
                    } else if enamine {
                        40
                    } else if hydrazone {
                        10
                    } else {
                        8
                    })
                }
                2 => {
                    if self.has_order(i, 3) {
                        return Some(61);
                    }
                    let doubles = self.nbrs(i).filter(|&(_, o)| o == 2).count();
                    if doubles == 2 {
                        return Some(53);
                    }
                    if self.charge(i) < 0 {
                        return Some(62);
                    }
                    match self.double_partner(i) {
                        Some(d) if self.z(d) == 8 => Some(46),
                        Some(d) if self.z(d) == 16 => Some(if self.terminal_o(d) > 0 { 48 } else { 62 }),
                        Some(_) => Some(9),
                        None => Some(62),
                    }
                }
                1 => {
                    if self.has_order(i, 3) {
                        Some(42)
                    } else if self.nbrs(i).any(|(n, o)| self.z(n) == 7 && o == 2) {
                        Some(47)
                    } else {
                        None
                    }
                }
                _ => None,
            },
            8 => match deg {
                3 => Some(49),
                2 => {
                    if self.nbrs(i).filter(|&(n, _)| self.z(n) == 1).count() == 2 {
                        Some(70)
                    } else if self.has_order(i, 2) {
                        Some(51)
                    } else {
                        Some(6)
                    }
                }
                1 => {
                    let (x, order) = self.nbrs(i).next()?;
                    let zx = self.z(x);
                    Some(match zx {
                        6 => {
                            if self.terminal_o(x) >= 2 {
                                32
                            } else if order == 2 {
                                7
                            } else {
                                35
                            }
                        }
                        7 => {
                            let oxide = self.deg(x) == 4 || self.arom[x] || self.has_order(x, 2);
                            if self.terminal_o(x) >= 2 {
                                32
                            } else if order == 2 {
                                7
                            } else if oxide {
                                32
                            } else {
                                35
                            }
                        }
                        1 => 35,
                        16 => {
                            if self.terminal_os(x) >= 2 || order == 1 || self.deg(x) == 4 {
                                32
                            } else {
                                7
                            }
                        }
                        _ => 32,
                    })
                }
                _ => None,
            },
            9 => Some(if deg == 0 { 89 } else { 11 }),
            17 => Some(match deg {
                0 => 90,
                4 => 77,
                _ => 12,
            }),
            35 => Some(if deg == 0 { 91 } else { 13 }),
            53 => Some(14),
            14 => Some(19),
            15 => match deg {
                4 => Some(25),
                3 => Some(if self.nbrs(i).any(|(n, o)| self.z(n) == 6 && o == 2) { 75 } else { 26 }),
                2 => Some(75),
                _ => None,
            },
            16 => match deg {
                1 => {
                    let (x, order) = self.nbrs(i).next()?;
                    Some(if self.z(x) == 6 && self.terminal_os(x) - self.terminal_o(x) >= 2 {
                        72
                    } else if self.z(x) == 15 {
                        72
                    } else if order == 2 {
                        16
                    } else {
                        72
                    })
                }
                2 => Some(if self.nbrs(i).filter(|&(_, o)| o == 2).count() >= 1 { 74 } else { 15 }),
                3 => Some(if self.terminal_os(i) == 2 {
                    73
                } else if self.nbrs(i).any(|(n, o)| self.z(n) == 6 && o == 2) {
                    74
                } else {
                    17
                }),
                4 => Some(18),
                _ => None,
            },
            _ => None,
        }
    }

    fn hydrogen_type(&self, i: usize, types: &[u8]) -> Option<u8> {
        let (x, _) = self.nbrs(i).next()?;
        let tx = types[x];
        Some(match self.z(x) {
            6 | 14 | 15 => 5,
            16 => 71,
            7 => match tx {
                9 => 27,
                10 | 40 | 43 | 48 => 28,
                34 | 54 | 55 | 56 | 58 | 81 | 67 | 68 => 36,
                _ => 23,
            },
            8 => {
                if tx == 70 {
                    31
                } else if tx == 49 {
                    50
                } else if tx == 51 {
                    52
                } else {
                    let other = self.nbrs(x).find(|&(n, _)| n != i).map(|(n, _)| n);
                    match other {
                        Some(y) if self.z(y) == 6 => {
                            if self.nbrs(y).any(|(n, o)| o == 2 && matches!(self.z(n), 8 | 16)) {
                                24
                            } else if self.arom[y] || self.nbrs(y).any(|(n, o)| o == 2 && matches!(self.z(n), 6 | 7)) {
                                29
                            } else {
                                21
                            }
                        }
                        Some(y) if self.z(y) == 15 => 24,
                        Some(y) if self.z(y) == 16 => 33,
                        _ => 21,
                    }
                }
            }
            _ => return None,
        })
    }
}

pub(crate) fn assign(mol: &Mol) -> Option<Typed> {
    let (arom, aromatic_bond, ring_arom) = aromaticity(mol);
    let ctx = Ctx { mol, arom, ring_arom };
    let n = mol.atoms.len();
    let mut types = vec![0u8; n];
    // Carbons first so that nitrogens can see amidinium and guanidinium carbons.
    for pass in 0..2 {
        for i in 0..n {
            let z = mol.atoms[i].z;
            if z == 1 || (pass == 0) != (z == 6) {
                continue;
            }
            types[i] = ctx.heavy_type(i, &types)?;
        }
    }
    for i in 0..n {
        if mol.atoms[i].z == 1 {
            types[i] = ctx.hydrogen_type(i, &types)?;
        }
    }
    let t = tables();
    if types.iter().any(|&ty| t.prop[ty as usize].is_none()) {
        return None;
    }
    Some(Typed { types, aromatic_bond })
}

/// MMFF bond type: 1 for a non-aromatic single bond between two sp2 or aromatic atoms.
pub(crate) fn bond_type(mol: &Mol, typed: &Typed, bond: usize) -> u8 {
    let t = tables();
    let b = &mol.bonds[bond];
    let pa = t.prop[typed.types[b.a] as usize].unwrap_or_default();
    let pb = t.prop[typed.types[b.b] as usize].unwrap_or_default();
    u8::from(
        b.order == 1
            && !typed.aromatic_bond[bond]
            && (pa.sbmb != 0 || pa.arom != 0)
            && (pb.sbmb != 0 || pb.arom != 0),
    )
}

/// MMFF partial charges.
pub(crate) fn charges(mol: &Mol, typed: &Typed) -> Option<Vec<f64>> {
    let t = tables();
    let n = mol.atoms.len();
    let ty = &typed.types;
    let mut formal = vec![0.0; n];
    for i in 0..n {
        formal[i] = match ty[i] {
            32 | 72 => {
                let x = mol.nbrs[i][0].0;
                let term: Vec<usize> = mol.nbrs[x]
                    .iter()
                    .map(|&(m, _)| m)
                    .filter(|&m| matches!(mol.atoms[m].z, 8 | 16) && mol.nbrs[m].len() == 1)
                    .collect();
                // The central atom's charge belongs to the group: a nitro group or an N-oxide is neutral.
                let sum: i32 =
                    term.iter().map(|&m| mol.atoms[m].charge as i32).sum::<i32>() + mol.atoms[x].charge as i32;
                if term.is_empty() || !(mol.atoms[x].z == 6 || matches!(ty[x], 18 | 25 | 45 | 73 | 77)) {
                    // Only carboxylate, sulfonate, phosphate, nitrate, sulfinate and perchlorate groups share.
                    0.0
                } else if mol.atoms[x].z == 6 && term.len() >= 2 {
                    // As RDKit: O and S on a carbon with two terminal O/S share −1 (carboxylate semantics).
                    -1.0 / term.len() as f64
                } else {
                    sum as f64 / term.len() as f64
                }
            }
            76 => {
                // The ring anion's charge is shared over its N5M atoms.
                let ring = mol.rings.iter().find(|r| r.len() == 5 && r.contains(&i))?;
                let members: Vec<usize> = ring.iter().copied().filter(|&a| ty[a] == 76).collect();
                let sum: i32 = ring.iter().map(|&a| mol.atoms[a].charge as i32).sum();
                sum as f64 / members.len() as f64
            }
            55 | 56 => {
                let c = mol.nbrs[i].iter().map(|&(m, _)| m).find(|&m| ty[m] == 57)?;
                let members: Vec<usize> =
                    mol.nbrs[c].iter().map(|&(m, _)| m).filter(|&m| matches!(ty[m], 55 | 56)).collect();
                let sum: i32 = members.iter().map(|&m| mol.atoms[m].charge as i32).sum();
                sum as f64 / members.len() as f64
            }
            // A deprotonated sulfonamide-type N is −1 whatever the drawn charges.
            62 => -1.0,
            81 => {
                // Shared over the two nitrogens of an imidazolium N–C–N (a CIM+ carbon); otherwise kept.
                match mol.nbrs[i].iter().map(|&(m, _)| m).find(|&m| ty[m] == 80) {
                    Some(c) => {
                        let members: Vec<usize> =
                            mol.nbrs[c].iter().map(|&(m, _)| m).filter(|&m| ty[m] == 81).collect();
                        let sum: i32 = members.iter().map(|&m| mol.atoms[m].charge as i32).sum();
                        sum as f64 / members.len() as f64
                    }
                    None => mol.atoms[i].charge as f64,
                }
            }
            _ => {
                let central = mol.nbrs[i].iter().any(|&(m, _)| matches!(ty[m], 32 | 72) && mol.nbrs[m].len() == 1);
                // MMFF gives formal charges only to these types; isonitriles, azides and diazo groups are neutral.
                // A diazonium N+ keeps its charge; an isonitrile does not.
                let diazonium = ty[i] == 61
                    && mol.nbrs[i].iter().any(|&(m, b)| mol.bonds[b].order == 3 && mol.atoms[m].z == 7);
                let charged = diazonium || matches!(ty[i], 34 | 35 | 49 | 51 | 54 | 58 | 62 | 89..=99);
                if central || !charged { 0.0 } else { mol.atoms[i].charge as f64 }
            }
        };
    }
    let mut q = vec![0.0; n];
    for i in 0..n {
        let ti = ty[i] as usize;
        let m = t.prop[ti]?.crd as f64;
        let (pbci_i, u_i) = t.pbci[ti]?;
        let mut q0 = formal[i];
        if ty[i] == 62 {
            for &(k, _) in &mol.nbrs[i] {
                if formal[k] > 0.0 {
                    q0 -= formal[k] / 2.0;
                }
            }
        }
        let mut sum = 0.0;
        for &(k, b) in &mol.nbrs[i] {
            let tk = ty[k] as usize;
            let (pbci_k, u_k) = t.pbci[tk]?;
            let bt = bond_type(mol, typed, b);
            let (lo, hi) = (ti.min(tk) as u8, ti.max(tk) as u8);
            let w = match t.chg.get(&(bt, lo, hi)) {
                Some(&bci) => {
                    if ti == lo as usize && ti != tk {
                        -bci
                    } else if ti == tk {
                        0.0
                    } else {
                        bci
                    }
                }
                None => pbci_i - pbci_k,
            };
            sum += w + u_k * formal[k];
        }
        q[i] = (1.0 - m * u_i) * q0 + sum;
    }
    Some(q)
}
