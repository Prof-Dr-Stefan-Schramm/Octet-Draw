//! MMFF94 and MMFF94s (Halgren, J. Comput. Chem. 1996, 17, 490–641; 1999, 20, 720–729) as RDKit implements them
//! (`Code/ForceField/MMFF`, BSD-3-Clause, the behaviour reference): RDKit's atom typing and MMFF aromaticity on the
//! Kekulé form, MMFF partial charges, and all terms: bond stretch, angle bend (with the linear form), stretch-bend,
//! out-of-plane, torsion, buffered 14-7 van der Waals and buffered Coulomb (dielectric 1, 1–4 scaled by 0.75), with
//! the step-down rules and empirical rules for missing parameters and no non-bonded cut-off. The parameter tables
//! are RDKit's copies of Merck's MMFF files and keep Merck's notice (see `params.rs`).
use crate::chem::{Mol, Result};
use crate::field::{Energy, at, cos_angle, dihedral, distance, out_of_plane, push, push_angle, scale};

mod params;
mod typing;

use params::{Prop, tables};
use typing::Typed;

const UNAVAILABLE: &str = "MMFF parameters are unavailable for this molecule";
const BOND_K: f64 = 143.9325;
const CS: f64 = -2.0;
const DEG2RAD: f64 = std::f64::consts::PI / 180.0;
/// RDKit's exact constants: 143.9325 (deg→rad)² ≈ 0.043844, −0.4 (deg→rad) ≈ −0.006981317 and
/// 143.9325 (deg→rad) ≈ 2.51210.
const ANGLE_K: f64 = BOND_K * DEG2RAD * DEG2RAD;
const CB: f64 = -0.4 * DEG2RAD;
const STBN_K: f64 = BOND_K * DEG2RAD;
const COULOMB: f64 = 332.0716;
const RAD2DEG: f64 = 180.0 / std::f64::consts::PI;

fn unavailable(detail: impl std::fmt::Display) -> String {
    format!("{UNAVAILABLE}: {detail}")
}

fn prop(t: u8) -> Prop {
    tables().prop[t as usize].unwrap_or_default()
}

fn def(t: u8) -> [u8; 4] {
    tables().def[t as usize].unwrap_or([t, t, t, 0])
}

/// Periodic-table row: 0 for H, 1 for Li–Ne, 2 for Na–Ar, 3 for K–Kr, 4 for Rb–Xe.
fn row(z: u8) -> u8 {
    match z {
        0..=2 => 0,
        3..=10 => 1,
        11..=18 => 2,
        19..=36 => 3,
        _ => 4,
    }
}

#[cfg(test)]
pub(crate) fn types(mol: &Mol) -> Result<Vec<u8>> {
    typing::assign(mol).map(|t| t.types).ok_or_else(|| unavailable("no MMFF atom type"))
}

#[cfg(test)]
pub(crate) fn charges(mol: &Mol) -> Result<Vec<f64>> {
    let typed = typing::assign(mol).ok_or_else(|| unavailable("no MMFF atom type"))?;
    typing::charges(mol, &typed).ok_or_else(|| unavailable("no charge parameters"))
}

struct Setup<'a> {
    mol: &'a Mol,
    typed: Typed,
    variant: usize,
}

impl Setup<'_> {
    fn ty(&self, i: usize) -> u8 {
        self.typed.types[i]
    }
    fn bond_type(&self, a: usize, b: usize) -> u8 {
        let bond = self.mol.bond_between(a, b).expect("bonded");
        typing::bond_type(self.mol, &self.typed, bond)
    }
    /// An angle in a four-membered ring: i and k are not bonded but share a neighbour besides j (as RDKit, also
    /// across a bicyclobutane).
    fn four_ring(&self, i: usize, j: usize, k: usize) -> bool {
        self.mol.bond_between(i, k).is_none()
            && self.mol.nbrs[i].iter().any(|&(m, _)| m != j && self.mol.bond_between(m, k).is_some())
    }
    fn same_ring(&self, size: usize, atoms: &[usize]) -> bool {
        self.mol.rings.iter().any(|r| r.len() == size && atoms.iter().all(|a| r.contains(a)))
    }

    /// (kb, r0) for a bond.
    fn bond_params(&self, a: usize, b: usize) -> Result<(f64, f64)> {
        let t = tables();
        let bt = self.bond_type(a, b);
        let (ta, tb) = (self.ty(a), self.ty(b));
        if let Some(&p) = t.bond.get(&(bt, ta.min(tb), ta.max(tb))) {
            return Ok(p);
        }
        self.empirical_bond(a, b)
    }

    fn empirical_bond(&self, a: usize, b: usize) -> Result<(f64, f64)> {
        let t = tables();
        let (za, zb) = (self.mol.atoms[a].z, self.mol.atoms[b].z);
        let (ra, ea) = *t.covrad.get(&za).ok_or_else(|| unavailable("no covalent radius"))?;
        let (rb, eb) = *t.covrad.get(&zb).ok_or_else(|| unavailable("no covalent radius"))?;
        // As RDKit: single-bond covalent radii whatever the bond order (Schomaker–Stevenson with c = 0.085, n = 1.4).
        let c = if za == 1 || zb == 1 { 0.050 } else { 0.085 };
        let r0 = ra + rb - c * (ea - eb).abs().powf(1.4);
        let key = (za.min(zb), za.max(zb));
        let kb = if let Some(&(rref, kref)) = t.bndk.get(&key) {
            kref * (rref / r0).powi(6)
        } else {
            let (x, y) = (row(za).min(row(zb)), row(za).max(row(zb)));
            let &(aij, _dij, dpij) = t.hl.get(&(x, y)).ok_or_else(|| unavailable("no bond rule"))?;
            10f64.powf(-(r0 - aij) / dpij)
        };
        Ok((kb, r0))
    }

    fn angle_type(&self, i: usize, j: usize, k: usize) -> u8 {
        let sum = self.bond_type(i, j) + self.bond_type(j, k);
        if self.mol.bond_between(i, k).is_some() {
            return if sum > 0 { 4 + sum } else { 3 };
        }
        if self.four_ring(i, j, k) {
            return if sum > 0 { 6 + sum } else { 4 };
        }
        sum
    }

    /// (ka, theta0 in degrees) with the step-down and empirical rules.
    fn angle_params(&self, i: usize, j: usize, k: usize, at: u8) -> Result<(f64, f64)> {
        let t = tables();
        let (ti, tj, tk) = (self.ty(i), self.ty(j), self.ty(k));
        let mut found = None;
        for level in 0..4 {
            let (a, c) = (def(ti)[level], def(tk)[level]);
            if let Some(&p) = t.ang.get(&(at, a.min(c), tj, a.max(c))) {
                found = Some(p);
                break;
            }
        }
        match found {
            Some((ka, theta0)) if ka != 0.0 => Ok((ka, theta0)),
            Some((_, theta0)) => Ok((self.empirical_ka(i, j, k, theta0)?, theta0)),
            None => {
                let theta0 = self.empirical_theta0(i, j, k);
                Ok((self.empirical_ka(i, j, k, theta0)?, theta0))
            }
        }
    }

    fn empirical_theta0(&self, i: usize, j: usize, k: usize) -> f64 {
        if self.mol.bond_between(i, k).is_some() {
            return 60.0;
        }
        if self.four_ring(i, j, k) {
            return 90.0;
        }
        let p = prop(self.ty(j));
        let z = self.mol.atoms[j].z;
        match p.crd {
            2 => {
                if z == 8 {
                    105.0
                } else if z > 10 {
                    95.0
                } else if p.lin != 0 {
                    180.0
                } else {
                    120.0
                }
            }
            3 => {
                if p.val == 3 && p.mltb == 0 {
                    if z == 7 { 107.0 } else { 92.0 }
                } else {
                    120.0
                }
            }
            4 => 109.45,
            _ => 109.45,
        }
    }

    fn empirical_ka(&self, i: usize, j: usize, k: usize, theta0: f64) -> Result<f64> {
        let zc = |z: u8| -> (f64, f64) {
            match z {
                1 => (1.395, 0.0),
                6 => (2.494, 1.016),
                7 => (2.711, 1.113),
                8 => (3.045, 1.337),
                9 => (2.847, 0.0),
                14 => (2.350, 0.811),
                15 => (2.350, 1.068),
                16 => (2.980, 1.249),
                17 => (2.909, 1.078),
                33 => (0.0, 0.825),
                35 => (3.017, 0.0),
                53 => (3.086, 0.0),
                _ => (0.0, 0.0),
            }
        };
        let (zi, _) = zc(self.mol.atoms[i].z);
        let (_, cj) = zc(self.mol.atoms[j].z);
        let (zk, _) = zc(self.mol.atoms[k].z);
        let (_, rij) = self.bond_params(i, j)?;
        let (_, rjk) = self.bond_params(j, k)?;
        let mut beta = 1.75;
        if self.mol.bond_between(i, k).is_some() {
            beta *= 0.05;
        } else if self.four_ring(i, j, k) {
            beta *= 0.85;
        }
        let d = (rij - rjk).powi(2) / (rij + rjk).powi(2);
        let th = theta0.to_radians();
        Ok(beta * zi * cj * zk / ((rij + rjk) * th * th * (2.0 * d).exp()))
    }

    /// (kbaIJK, kbaKJI) for an angle.
    fn stretch_bend(&self, i: usize, j: usize, k: usize, at: u8) -> Result<(f64, f64)> {
        let t = tables();
        let b1 = self.bond_type(i, j);
        let sbt: u8 = match at {
            1 => {
                if b1 == 1 {
                    1
                } else {
                    2
                }
            }
            2 => 3,
            3 => 5,
            4 => 4,
            5 => {
                if b1 == 1 {
                    6
                } else {
                    7
                }
            }
            6 => 8,
            7 => {
                if b1 == 1 {
                    9
                } else {
                    10
                }
            }
            8 => 11,
            _ => 0,
        };
        let (ti, tj, tk) = (self.ty(i), self.ty(j), self.ty(k));
        let swap = ti > tk || (ti == tk && matches!(sbt, 2 | 7 | 10));
        let (a, c, s) = if swap {
            let s = match sbt {
                1 => 2,
                2 => 1,
                6 => 7,
                7 => 6,
                9 => 10,
                10 => 9,
                x => x,
            };
            (tk, ti, s)
        } else {
            (ti, tk, sbt)
        };
        if let Some(&(f, g)) = t.stbn.get(&(s, a, tj, c)) {
            return Ok(if swap { (g, f) } else { (f, g) });
        }
        let (ri, rj, rk) = (row(self.mol.atoms[i].z), row(self.mol.atoms[j].z), row(self.mol.atoms[k].z));
        let (lo, hi, sw) = if ri > rk { (rk, ri, true) } else { (ri, rk, false) };
        let &(f, g) = t.dfsb.get(&(lo, rj, hi)).ok_or_else(|| unavailable("no stretch-bend rule"))?;
        Ok(if sw { (g, f) } else { (f, g) })
    }

    fn oop(&self, i: usize, j: usize, k: usize, l: usize) -> Option<f64> {
        let t = tables();
        let tj = self.ty(j);
        for level in 0..4 {
            let mut v = [def(self.ty(i))[level], def(self.ty(k))[level], def(self.ty(l))[level]];
            v.sort_unstable();
            if let Some(&koop) = t.oop[self.variant].get(&(v[0], tj, v[1], v[2])) {
                return Some(koop);
            }
        }
        None
    }

    fn torsion_type(&self, i: usize, j: usize, k: usize, l: usize) -> (u8, u8) {
        let bij = self.bond_type(i, j);
        let bjk = self.bond_type(j, k);
        let bkl = self.bond_type(k, l);
        let mut tt = bjk;
        let jk = self.mol.bond_between(j, k).expect("bonded");
        if bjk == 0 && (bij == 1 || bkl == 1) && self.mol.bonds[jk].order == 1 && !self.typed.aromatic_bond[jk] {
            tt = 2;
        }
        let four = self.mol.bond_between(i, l).is_some();
        let five = !four && self.same_ring(5, &[i, j, k, l]);
        if four {
            (4, tt)
        } else if five && [i, j, k, l].iter().any(|&a| self.ty(a) == 1) {
            (5, tt)
        } else {
            (tt, 0)
        }
    }

    fn torsion(&self, i: usize, j: usize, k: usize, l: usize) -> (f64, f64, f64) {
        let t = tables();
        let (tt, second) = self.torsion_type(i, j, k, l);
        let (ti, tj, tk, tl) = (self.ty(i), self.ty(j), self.ty(k), self.ty(l));
        let lookup = |kind: u8, a: u8, d: u8| {
            let (mut a, mut b, mut c, mut d) = (a, tj, tk, d);
            if b > c {
                std::mem::swap(&mut b, &mut c);
                std::mem::swap(&mut a, &mut d);
            } else if b == c && a > d {
                std::mem::swap(&mut a, &mut d);
            }
            t.tor[self.variant].get(&(kind, a, b, c, d)).copied()
        };
        let levels = |kind: u8| {
            let stages = [
                (ti, tl),
                (def(ti)[0], def(tl)[0]),
                (def(ti)[1], def(tl)[3]),
                (def(ti)[3], def(tl)[1]),
                (def(ti)[3], def(tl)[3]),
            ];
            stages.iter().find_map(|&(a, d)| lookup(kind, a, d))
        };
        if let Some(p) = levels(tt) {
            return p;
        }
        // As RDKit: a five-ring torsion without parameters falls back to its type before it became 5.
        if tt == 5 {
            if let Some(p) = levels(second) {
                return p;
            }
        }
        self.empirical_torsion(j, k)
    }

    fn empirical_torsion(&self, j: usize, k: usize) -> (f64, f64, f64) {
        let pj = prop(self.ty(j));
        let pk = prop(self.ty(k));
        let bond = self.mol.bond_between(j, k).expect("bonded");
        let z = [self.mol.atoms[j].z, self.mol.atoms[k].z];
        let uv = |z: u8| match z {
            6 => (2.0_f64, 2.12_f64),
            7 => (2.0, 1.5),
            8 => (2.0, 0.2),
            14 => (1.25, 1.22),
            15 => (1.25, 2.4),
            16 => (1.25, 0.49),
            _ => (0.0, 0.0),
        };
        let (u0, v0) = uv(z[0]);
        let (u1, v1) = uv(z[1]);
        let n_jk = ((pj.crd as f64 - 1.0) * (pk.crd as f64 - 1.0)).max(1.0);
        let uu = (u0 * u1).sqrt();
        let vv3 = (v0 * v1).sqrt() / n_jk;
        if pj.lin != 0 || pk.lin != 0 {
            return (0.0, 0.0, 0.0);
        }
        if pj.arom != 0 && pk.arom != 0 && self.typed.aromatic_bond[bond] {
            let pi = if pj.pilp == 0 && pk.pilp == 0 { 0.5 } else { 0.3 };
            let beta = if (pj.val == 3 && pk.val == 4) || (pj.val == 4 && pk.val == 3) { 3.0 } else { 6.0 };
            return (0.0, beta * pi * uu, 0.0);
        }
        // An MMFF-aromatic bond has RDKit's aromatic bond type here: neither single nor double.
        let rd_aromatic = self.typed.aromatic_bond[bond];
        if self.mol.bonds[bond].order == 2 && !rd_aromatic {
            let pi = if pj.mltb == 2 && pk.mltb == 2 { 1.0 } else { 0.4 };
            return (0.0, 6.0 * pi * uu, 0.0);
        }
        if pj.crd == 4 && pk.crd == 4 {
            return (0.0, 0.0, vv3);
        }
        let half = |p: Prop| {
            (p.crd == 3 && (p.val == 4 || p.val == 34 || p.mltb != 0)) || (p.crd == 2 && (p.val == 3 || p.mltb != 0))
        };
        if pj.crd == 4 {
            return if half(pk) { (0.0, 0.0, 0.0) } else { (0.0, 0.0, vv3) };
        }
        if pk.crd == 4 {
            return if half(pj) { (0.0, 0.0, 0.0) } else { (0.0, 0.0, vv3) };
        }
        let single = self.mol.bonds[bond].order == 1 && !rd_aromatic;
        if (single && pj.mltb != 0 && pk.mltb != 0)
            || (pj.mltb != 0 && pk.pilp != 0)
            || (pj.pilp != 0 && pk.mltb != 0)
        {
            // RDKit's row test: both atoms in Na–Ar (its periodic row 2 counts from H as 0).
            let both_row2 = row(z[0]) == 2 && row(z[1]) == 2;
            if pj.pilp != 0 && pk.pilp != 0 {
                return (0.0, 0.0, 0.0);
            }
            if pj.pilp != 0 && pk.mltb != 0 {
                let pi = if pj.mltb == 1 {
                    0.5
                } else if both_row2 {
                    0.3
                } else {
                    0.15
                };
                return (0.0, 6.0 * pi * uu, 0.0);
            }
            if pj.mltb != 0 && pk.pilp != 0 {
                let pi = if pk.mltb == 1 {
                    0.5
                } else if both_row2 {
                    0.3
                } else {
                    0.15
                };
                return (0.0, 6.0 * pi * uu, 0.0);
            }
            if (pj.mltb == 1 || pk.mltb == 1) && (z[0] != 6 || z[1] != 6) {
                return (0.0, 6.0 * 0.4 * uu, 0.0);
            }
            return (0.0, 6.0 * 0.15 * uu, 0.0);
        }
        if matches!(z[0], 8 | 16) && matches!(z[1], 8 | 16) {
            let w = |z: u8| if z == 8 { 2.0_f64 } else { 8.0 };
            return (0.0, -(w(z[0]) * w(z[1])).sqrt(), 0.0);
        }
        (0.0, 0.0, vv3)
    }
}

#[derive(Clone, Copy)]
struct BondTerm {
    i: usize,
    j: usize,
    kb: f64,
    r0: f64,
}
#[derive(Clone, Copy)]
struct AngleTerm {
    i: usize,
    j: usize,
    k: usize,
    ka: f64,
    theta0: f64,
    linear: bool,
}
#[derive(Clone, Copy)]
struct StbnTerm {
    i: usize,
    j: usize,
    k: usize,
    kijk: f64,
    kkji: f64,
    rij: f64,
    rkj: f64,
    theta0: f64,
}
#[derive(Clone, Copy)]
struct OopTerm {
    i: usize,
    j: usize,
    k: usize,
    l: usize,
    koop: f64,
}
#[derive(Clone, Copy)]
struct TorsionTerm {
    i: usize,
    j: usize,
    k: usize,
    l: usize,
    v: [f64; 3],
}
#[derive(Clone, Copy)]
struct PairTerm {
    i: usize,
    j: usize,
    r_star: f64,
    eps: f64,
    /// 332.0716 qi qj (× 0.75 for 1–4 pairs).
    qq: f64,
}

pub(crate) struct Field {
    bonds: Vec<BondTerm>,
    angles: Vec<AngleTerm>,
    stbns: Vec<StbnTerm>,
    oops: Vec<OopTerm>,
    torsions: Vec<TorsionTerm>,
    pairs: Vec<PairTerm>,
    distance_dielectric: bool,
}

impl Field {
    pub fn new(mol: &Mol, mmff94s: bool) -> Result<Field> {
        let typed = typing::assign(mol).ok_or_else(|| unavailable("no MMFF atom type"))?;
        let q = typing::charges(mol, &typed).ok_or_else(|| unavailable("no charge parameters"))?;
        let s = Setup { mol, typed, variant: usize::from(mmff94s) };
        let t = tables();
        let mut bonds = Vec::new();
        for b in &mol.bonds {
            let (kb, r0) = s.bond_params(b.a, b.b)?;
            bonds.push(BondTerm { i: b.a, j: b.b, kb, r0 });
        }
        let mut angles = Vec::new();
        let mut stbns = Vec::new();
        for j in 0..mol.atoms.len() {
            let pj = prop(s.ty(j));
            for (x, &(i, _)) in mol.nbrs[j].iter().enumerate() {
                for &(k, _) in &mol.nbrs[j][x + 1..] {
                    let at = s.angle_type(i, j, k);
                    let (ka, theta0) = s.angle_params(i, j, k, at)?;
                    angles.push(AngleTerm { i, j, k, ka, theta0, linear: pj.lin != 0 });
                    if pj.lin == 0 {
                        let (kijk, kkji) = s.stretch_bend(i, j, k, at)?;
                        let (_, rij) = s.bond_params(i, j)?;
                        let (_, rkj) = s.bond_params(k, j)?;
                        stbns.push(StbnTerm { i, j, k, kijk, kkji, rij, rkj, theta0 });
                    }
                }
            }
        }
        let mut oops = Vec::new();
        for j in 0..mol.atoms.len() {
            if mol.nbrs[j].len() != 3 {
                continue;
            }
            let n: Vec<usize> = mol.nbrs[j].iter().map(|&(x, _)| x).collect();
            let Some(koop) = s.oop(n[0], j, n[1], n[2]) else {
                continue;
            };
            for (a, b, l) in [(n[0], n[1], n[2]), (n[0], n[2], n[1]), (n[1], n[2], n[0])] {
                oops.push(OopTerm { i: a, j, k: b, l, koop });
            }
        }
        let mut torsions = Vec::new();
        for b in &mol.bonds {
            let (j, k) = (b.a, b.b);
            let triple = |x: usize| mol.nbrs[x].iter().any(|&(_, bb)| mol.bonds[bb].order == 3);
            if mol.nbrs[j].len() < 2 || mol.nbrs[k].len() < 2 || triple(j) || triple(k) {
                continue;
            }
            for &(i, _) in &mol.nbrs[j] {
                if i == k {
                    continue;
                }
                for &(l, _) in &mol.nbrs[k] {
                    if l == j || l == i {
                        continue;
                    }
                    let (v1, v2, v3) = s.torsion(i, j, k, l);
                    if v1 != 0.0 || v2 != 0.0 || v3 != 0.0 {
                        torsions.push(TorsionTerm { i, j, k, l, v: [v1, v2, v3] });
                    }
                }
            }
        }
        let mut pairs = Vec::new();
        let [power, b_rule, beta, darad, daeps] = t.vdw_rule;
        for (i, j, one_four) in crate::field::nonbonded_pairs(&mol.nbrs) {
            let vi = t.vdw[s.ty(i) as usize].ok_or_else(|| unavailable("no van der Waals parameters"))?;
            let vj = t.vdw[s.ty(j) as usize].ok_or_else(|| unavailable("no van der Waals parameters"))?;
            let ri = vi.a * vi.alpha.powf(power);
            let rj = vj.a * vj.alpha.powf(power);
            let gamma = (ri - rj) / (ri + rj);
            let donor = vi.da == b'D' || vj.da == b'D';
            let spread = if donor { 0.0 } else { b_rule * (1.0 - (-beta * gamma * gamma).exp()) };
            let mut r_star = 0.5 * (ri + rj) * (1.0 + spread);
            let mut eps = 181.16 * vi.g * vj.g * vi.alpha * vj.alpha
                / (((vi.alpha / vi.n).sqrt() + (vj.alpha / vj.n).sqrt()) * r_star.powi(6));
            if (vi.da == b'D' && vj.da == b'A') || (vi.da == b'A' && vj.da == b'D') {
                r_star *= darad;
                eps *= daeps;
            }
            let qq = COULOMB * q[i] * q[j] * if one_four { 0.75 } else { 1.0 };
            pairs.push(PairTerm { i, j, r_star, eps, qq });
        }
        Ok(Field { bonds, angles, stbns, oops, torsions, pairs, distance_dielectric: false })
    }

    fn evaluate(&self, x: &[f64], mut g: Option<&mut [f64]>) -> f64 {
        let mut e = 0.0;
        for b in &self.bonds {
            let (r, d) = distance(x, b.i, b.j);
            let dr = r - b.r0;
            let k = 0.5 * BOND_K * b.kb;
            e += k * dr * dr * (1.0 + CS * dr + 7.0 / 12.0 * CS * CS * dr * dr);
            if let Some(g) = g.as_deref_mut() {
                let f = k * (2.0 * dr + 3.0 * CS * dr * dr + 7.0 / 3.0 * CS * CS * dr * dr * dr);
                push(g, b.i, scale(d, f));
                push(g, b.j, scale(d, -f));
            }
        }
        for a in &self.angles {
            let (c, di, dk, _, _) = cos_angle(x, a.i, a.j, a.k);
            if a.linear {
                e += BOND_K * a.ka * (1.0 + c);
                if let Some(g) = g.as_deref_mut() {
                    push_angle(g, a.i, a.j, a.k, BOND_K * a.ka, di, dk);
                }
                continue;
            }
            let theta = c.acos() * RAD2DEG;
            let dt = theta - a.theta0;
            let k = 0.5 * ANGLE_K * a.ka;
            e += k * dt * dt * (1.0 + CB * dt);
            if let Some(g) = g.as_deref_mut() {
                let de_dtheta = k * (2.0 * dt + 3.0 * CB * dt * dt) * RAD2DEG;
                let s = (1.0 - c * c).max(1e-16).sqrt();
                push_angle(g, a.i, a.j, a.k, -de_dtheta / s, di, dk);
            }
        }
        for s in &self.stbns {
            let (c, di, dk, _, _) = cos_angle(x, s.i, s.j, s.k);
            let dt = c.acos() * RAD2DEG - s.theta0;
            let (rij, uij) = distance(x, s.i, s.j);
            let (rkj, ukj) = distance(x, s.k, s.j);
            let (dri, drk) = (rij - s.rij, rkj - s.rkj);
            e += STBN_K * (s.kijk * dri + s.kkji * drk) * dt;
            if let Some(g) = g.as_deref_mut() {
                let fi = STBN_K * s.kijk * dt;
                let fk = STBN_K * s.kkji * dt;
                push(g, s.i, scale(uij, fi));
                push(g, s.j, scale(uij, -fi));
                push(g, s.k, scale(ukj, fk));
                push(g, s.j, scale(ukj, -fk));
                let de_dtheta = STBN_K * (s.kijk * dri + s.kkji * drk) * RAD2DEG;
                let sn = (1.0 - c * c).max(1e-16).sqrt();
                push_angle(g, s.i, s.j, s.k, -de_dtheta / sn, di, dk);
            }
        }
        for o in &self.oops {
            let (sn, d) = out_of_plane(x, o.i, o.j, o.k, o.l);
            let chi = sn.asin() * RAD2DEG;
            let k = 0.5 * ANGLE_K * o.koop;
            e += k * chi * chi;
            if let (Some(g), Some(d)) = (g.as_deref_mut(), d) {
                let de = 2.0 * k * chi * RAD2DEG / (1.0 - sn * sn).max(1e-16).sqrt();
                for (atom, w) in [o.i, o.j, o.k, o.l].into_iter().zip(d) {
                    push(g, atom, scale(w, de));
                }
            }
        }
        for t in &self.torsions {
            let (phi, d) = dihedral(x, t.i, t.j, t.k, t.l);
            let [v1, v2, v3] = t.v;
            e += 0.5 * (v1 * (1.0 + phi.cos()) + v2 * (1.0 - (2.0 * phi).cos()) + v3 * (1.0 + (3.0 * phi).cos()));
            if let (Some(g), Some(d)) = (g.as_deref_mut(), d) {
                let de = 0.5 * (-v1 * phi.sin() + 2.0 * v2 * (2.0 * phi).sin() - 3.0 * v3 * (3.0 * phi).sin());
                for (atom, w) in [t.i, t.j, t.k, t.l].into_iter().zip(d) {
                    push(g, atom, scale(w, de));
                }
            }
        }
        for p in &self.pairs {
            let a = at(x, p.i);
            let b = at(x, p.j);
            let dv = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
            let r = (dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]).sqrt().max(1e-12);
            let rs = p.r_star;
            let rs7 = rs.powi(7);
            let r7 = r.powi(7);
            let ratio = 1.07 * rs / (r + 0.07 * rs);
            let aa = ratio.powi(7);
            let bb = 1.12 * rs7 / (r7 + 0.12 * rs7) - 2.0;
            e += p.eps * aa * bb;
            let rr = r + 0.05;
            let (ele, dele) = if self.distance_dielectric {
                (p.qq / (rr * rr), -2.0 * p.qq / (rr * rr * rr))
            } else {
                (p.qq / rr, -p.qq / (rr * rr))
            };
            e += ele;
            if let Some(g) = g.as_deref_mut() {
                let da = -7.0 * aa / (r + 0.07 * rs);
                let db = -1.12 * rs7 * 7.0 * r.powi(6) / (r7 + 0.12 * rs7).powi(2);
                let de_dr = p.eps * (da * bb + aa * db) + dele;
                let f = de_dr / r;
                push(g, p.i, scale(dv, f));
                push(g, p.j, scale(dv, -f));
            }
        }
        e
    }
}

impl Energy for Field {
    fn energy(&self, x: &[f64]) -> f64 {
        self.evaluate(x, None)
    }
    fn gradient(&self, x: &[f64], g: &mut [f64]) -> f64 {
        self.evaluate(x, Some(g))
    }
}

#[cfg(test)]
mod tests;
