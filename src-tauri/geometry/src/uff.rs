//! UFF (Rappé et al., J. Am. Chem. Soc. 1992, 114, 10024) as RDKit builds it: RDKit's atom typing, its parameter
//! table (`data/uff.txt`, RDKit `Code/ForceField/UFF/Params.cpp`, BSD-3-Clause) and its terms: bond, angle (with the
//! linear, trigonal and square-planar forms), torsion, inversion and Lennard-Jones van der Waals, with no cut-off and
//! no electrostatics.
use crate::chem::{Hyb, Mol, Result};
use crate::field::{Energy, at, cos_angle, dihedral, distance, out_of_plane, push, push_angle, scale};
use std::collections::HashMap;
use std::sync::OnceLock;

const G: f64 = 332.06;
const LAMBDA: f64 = 0.1332;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Params {
    pub r1: f64,
    pub theta0: f64,
    pub x1: f64,
    pub d1: f64,
    pub z1: f64,
    pub v1: f64,
    pub u1: f64,
    pub gmp_xi: f64,
}

pub(crate) fn table() -> &'static HashMap<String, Params> {
    static TABLE: OnceLock<HashMap<String, Params>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut map = HashMap::new();
        for line in include_str!("data/uff.txt").lines() {
            if line.starts_with('#') || line.trim().is_empty() {
                continue;
            }
            let f: Vec<&str> = line.split('\t').collect();
            let v = |k: usize| f[k].trim().parse::<f64>().unwrap_or(0.0);
            map.insert(
                f[0].to_string(),
                Params {
                    r1: v(1),
                    theta0: v(2).to_radians(),
                    x1: v(3),
                    d1: v(4),
                    z1: v(6),
                    v1: v(7),
                    u1: v(8),
                    gmp_xi: v(9),
                },
            );
        }
        map
    })
}

/// RDKit's UFF atom label.
pub(crate) fn label(mol: &Mol, i: usize) -> String {
    let atom = &mol.atoms[i];
    let symbol = match atom.z {
        1 => "H",
        5 => "B",
        6 => "C",
        7 => "N",
        8 => "O",
        9 => "F",
        14 => "Si",
        15 => "P",
        16 => "S",
        17 => "Cl",
        33 => "As",
        34 => "Se",
        35 => "Br",
        53 => "I",
        _ => "X",
    };
    let mut key = symbol.to_string();
    if key.len() == 1 {
        key.push('_');
    }
    let outer = crate::chem::outer_electrons(atom.z);
    if outer != 1 && outer != 7 {
        match atom.z {
            14 | 15 => key.push('3'),
            _ => match atom.hyb {
                Hyb::S => {}
                Hyb::Sp => key.push('1'),
                Hyb::Sp2 => {
                    if (atom.aromatic || mol.has_conjugated_bond(i)) && matches!(atom.z, 6 | 7 | 8 | 16) {
                        key.push('R')
                    } else {
                        key.push('2')
                    }
                }
                Hyb::Sp3 => key.push('3'),
                Hyb::Sp3d => key.push('5'),
                Hyb::Sp3d2 => key.push('6'),
                Hyb::Unspecified => {}
            },
        }
    }
    if atom.z == 1 && mol.degree(i) == 2 && mol.nbrs[i].iter().all(|&(n, _)| mol.atoms[n].z == 5) {
        key = "H_b".into();
    }
    let valence: i32 = mol.valence(i);
    match atom.z {
        15 => key.push_str(if valence == 3 { "+3" } else { "+5" }),
        33 => key.push_str("+3"),
        16 => {
            if atom.hyb != Hyb::Sp2 {
                key.push_str(match valence {
                    2 => "+2",
                    4 => "+4",
                    _ => "+6",
                });
            }
        }
        34 => key.push_str(match valence {
            2 => "+2",
            4 => "+4",
            _ => "+6",
        }),
        _ => {}
    }
    key
}

fn bond_order(mol: &Mol, b: usize) -> f64 {
    let bond = &mol.bonds[b];
    if bond.aromatic { 1.5 } else { bond.order as f64 }
}

fn rest_length(order: f64, a: &Params, b: &Params) -> f64 {
    let (ri, rj) = (a.r1, b.r1);
    let rbo = -LAMBDA * (ri + rj) * order.ln();
    let (xi, xj) = (a.gmp_xi, b.gmp_xi);
    let ren = ri * rj * (xi.sqrt() - xj.sqrt()).powi(2) / (xi * ri + xj * rj);
    ri + rj + rbo - ren
}

/// Bond rest length for distance geometry (RDKit takes it from UFF too).
pub(crate) fn bond_length(mol: &Mol, b: usize) -> Option<f64> {
    let t = table();
    let pa = t.get(&label(mol, mol.bonds[b].a))?;
    let pb = t.get(&label(mol, mol.bonds[b].b))?;
    Some(rest_length(bond_order(mol, b), pa, pb))
}

fn angle_constant(theta0: f64, o12: f64, o23: f64, p1: &Params, p2: &Params, p3: &Params) -> f64 {
    let c0 = theta0.cos();
    let r12 = rest_length(o12, p1, p2);
    let r23 = rest_length(o23, p2, p3);
    let r13 = (r12 * r12 + r23 * r23 - 2.0 * r12 * r23 * c0).sqrt();
    let beta = 2.0 * G / (r12 * r23);
    let pre = beta * p1.z1 * p3.z1 / r13.powi(5);
    let rt = r12 * r23;
    pre * rt * (3.0 * rt * (1.0 - c0 * c0) - r13 * r13 * c0)
}

fn equation17(order: f64, a: &Params, b: &Params) -> f64 {
    5.0 * (a.u1 * b.u1).sqrt() * (1.0 + 4.18 * order.ln())
}

fn group6(z: u8) -> bool {
    matches!(z, 8 | 16 | 34 | 52 | 84)
}

struct Bond {
    i: usize,
    j: usize,
    k: f64,
    r0: f64,
}
struct Angle {
    i: usize,
    j: usize,
    k: usize,
    ka: f64,
    order: u8,
    c: [f64; 3],
}
struct Torsion {
    i: usize,
    j: usize,
    k: usize,
    l: usize,
    v: f64,
    n: f64,
    cos_term: f64,
}
struct Inversion {
    i: usize,
    j: usize,
    k: usize,
    l: usize,
    k_: f64,
    c: [f64; 3],
}
struct Pair {
    i: usize,
    j: usize,
    x: f64,
    d: f64,
}

pub(crate) struct Field {
    bonds: Vec<Bond>,
    angles: Vec<Angle>,
    torsions: Vec<Torsion>,
    inversions: Vec<Inversion>,
    pairs: Vec<Pair>,
}

/// Check that every atom has UFF parameters.
pub(crate) fn check(mol: &Mol) -> Result<()> {
    let t = table();
    if (0..mol.atoms.len()).all(|i| t.contains_key(&label(mol, i))) {
        Ok(())
    } else {
        Err("UFF parameters are unavailable for this molecule".into())
    }
}

impl Field {
    /// The field for a molecule with its hydrogens as atoms.
    pub fn new(mol: &Mol) -> Result<Field> {
        check(mol)?;
        let t = table();
        let params: Vec<Params> = (0..mol.atoms.len()).map(|i| t[&label(mol, i)]).collect();
        let mut bonds = Vec::new();
        for (b, bond) in mol.bonds.iter().enumerate() {
            let (pa, pb) = (&params[bond.a], &params[bond.b]);
            let r0 = rest_length(bond_order(mol, b), pa, pb);
            let k = 2.0 * G * pa.z1 * pb.z1 / r0.powi(3);
            bonds.push(Bond { i: bond.a, j: bond.b, k, r0 });
        }
        let mut angles = Vec::new();
        for j in 0..mol.atoms.len() {
            if mol.degree(j) < 2 {
                continue;
            }
            let order = match mol.atoms[j].hyb {
                Hyb::Sp => 1,
                Hyb::Sp2 => 3,
                Hyb::Sp3d2 => 4,
                _ => 0,
            };
            let pj = &params[j];
            for (a, &(i, bi)) in mol.nbrs[j].iter().enumerate() {
                for &(k, bk) in &mol.nbrs[j][a + 1..] {
                    let ka = angle_constant(pj.theta0, bond_order(mol, bi), bond_order(mol, bk), &params[i], pj, &params[k]);
                    let mut c = [0.0; 3];
                    if order == 0 {
                        let (s, co) = pj.theta0.sin_cos();
                        let c2 = 1.0 / (4.0 * (s * s).max(1e-8));
                        c = [c2 * (2.0 * co * co + 1.0), -4.0 * c2 * co, c2];
                    }
                    angles.push(Angle { i, j, k, ka, order, c });
                }
            }
        }
        let mut torsions = Vec::new();
        for (b, bond) in mol.bonds.iter().enumerate() {
            // RDKit's torsion bonds come with the lower index first.
            let (j, k) = (bond.a.min(bond.b), bond.a.max(bond.b));
            // RDKit's torsion bonds: neither end terminal nor in a triple bond.
            let triple = |x: usize| mol.nbrs[x].iter().any(|&(_, bb)| mol.bonds[bb].order == 3 && !mol.bonds[bb].aromatic);
            if mol.degree(j) < 2 || mol.degree(k) < 2 || triple(j) || triple(k) {
                continue;
            }
            let (hj, hk) = (mol.atoms[j].hyb, mol.atoms[k].hyb);
            if !matches!(hj, Hyb::Sp2 | Hyb::Sp3) || !matches!(hk, Hyb::Sp2 | Hyb::Sp3) {
                continue;
            }
            let order = bond_order(mol, b);
            let (zj, zk) = (mol.atoms[j].z, mol.atoms[k].z);
            let start = torsions.len();
            for &(i, bi) in &mol.nbrs[j] {
                if bi == b {
                    continue;
                }
                for &(l, bl) in &mol.nbrs[k] {
                    if bl == b || l == i {
                        continue;
                    }
                    // As RDKit: either end atom of the torsion is sp2.
                    let end_sp2 = mol.atoms[i].hyb == Hyb::Sp2 || mol.atoms[l].hyb == Hyb::Sp2;
                    let (mut v, mut n, mut cos_term);
                    if hj == Hyb::Sp3 && hk == Hyb::Sp3 {
                        v = (params[j].v1 * params[k].v1).sqrt();
                        n = 3.0;
                        cos_term = -1.0;
                        if order == 1.0 && group6(zj) && group6(zk) {
                            let vj = if zj == 8 { 2.0 } else { 6.8 };
                            let vk = if zk == 8 { 2.0 } else { 6.8 };
                            v = (vj * vk as f64).sqrt();
                            n = 2.0;
                            cos_term = -1.0;
                        }
                    } else if hj == Hyb::Sp2 && hk == Hyb::Sp2 {
                        v = equation17(order, &params[j], &params[k]);
                        n = 2.0;
                        cos_term = 1.0;
                    } else {
                        v = 1.0;
                        n = 6.0;
                        cos_term = 1.0;
                        if order == 1.0 {
                            if (hj == Hyb::Sp3 && group6(zj) && !group6(zk)) || (hk == Hyb::Sp3 && group6(zk) && !group6(zj)) {
                                v = equation17(order, &params[j], &params[k]);
                                n = 2.0;
                                cos_term = -1.0;
                            } else if end_sp2 {
                                v = 2.0;
                                n = 3.0;
                                cos_term = -1.0;
                            }
                        }
                    }
                    torsions.push(Torsion { i, j, k, l, v, n, cos_term });
                }
            }
            let count = (torsions.len() - start) as f64;
            for t in &mut torsions[start..] {
                t.v /= count;
            }
        }
        let mut inversions = Vec::new();
        for j in 0..mol.atoms.len() {
            let z = mol.atoms[j].z;
            if !matches!(z, 6 | 7 | 8 | 15 | 33 | 51 | 83) || mol.degree(j) != 3 {
                continue;
            }
            if matches!(z, 6 | 7 | 8) && mol.atoms[j].hyb != Hyb::Sp2 {
                continue;
            }
            let n: Vec<usize> = mol.nbrs[j].iter().map(|&(x, _)| x).collect();
            let bound_o = z == 6 && n.iter().any(|&x| mol.atoms[x].z == 8 && mol.atoms[x].hyb == Hyb::Sp2);
            let (k_, c) = if matches!(z, 6 | 7 | 8) {
                (if bound_o { 50.0 } else { 6.0 }, [1.0, -1.0, 0.0])
            } else {
                let w0 = match z {
                    15 => 84.4339_f64,
                    33 => 86.9735,
                    51 => 87.7047,
                    _ => 90.0,
                }
                .to_radians();
                let c2 = 1.0;
                let c1 = -4.0 * w0.cos();
                let c0 = -(c1 * w0.cos() + c2 * (2.0 * w0).cos());
                (22.0 / (c0 + c1 + c2), [c0, c1, c2])
            };
            for (a, b, l) in [(n[0], n[1], n[2]), (n[0], n[2], n[1]), (n[1], n[2], n[0])] {
                inversions.push(Inversion { i: a, j, k: b, l, k_: k_ / 3.0, c });
            }
        }
        let pairs = crate::field::nonbonded_pairs(&mol.nbrs)
            .into_iter()
            .map(|(i, j, _)| Pair { i, j, x: (params[i].x1 * params[j].x1).sqrt(), d: (params[i].d1 * params[j].d1).sqrt() })
            .collect();
        Ok(Field { bonds, angles, torsions, inversions, pairs })
    }

    fn evaluate(&self, x: &[f64], mut g: Option<&mut [f64]>) -> f64 {
        let mut e = 0.0;
        for b in &self.bonds {
            let (r, d) = distance(x, b.i, b.j);
            let dr = r - b.r0;
            e += 0.5 * b.k * dr * dr;
            if let Some(g) = g.as_deref_mut() {
                let f = b.k * dr;
                push(g, b.i, scale(d, f));
                push(g, b.j, scale(d, -f));
            }
        }
        for a in &self.angles {
            let (c, di, dk, _, _) = cos_angle(x, a.i, a.j, a.k);
            let s2 = (1.0 - c * c).max(0.0);
            let (term, dterm) = match a.order {
                0 => {
                    let cos2 = c * c - s2;
                    (a.c[0] + a.c[1] * c + a.c[2] * cos2, a.c[1] + 4.0 * a.c[2] * c)
                }
                1 => (1.0 + c, 1.0),
                2 => (1.0 - (2.0 * c * c - 1.0), -4.0 * c / 1.0),
                3 => {
                    let cos3 = 4.0 * c * c * c - 3.0 * c;
                    ((1.0 - cos3) / 9.0, -(12.0 * c * c - 3.0) / 9.0)
                }
                _ => {
                    let cos4 = 8.0 * c.powi(4) - 8.0 * c * c + 1.0;
                    ((1.0 - cos4) / 16.0, -(32.0 * c.powi(3) - 16.0 * c) / 16.0)
                }
            };
            let term = if a.order == 2 { term / 4.0 } else { term };
            let dterm = if a.order == 2 { dterm / 4.0 } else { dterm };
            e += a.ka * term;
            if let Some(g) = g.as_deref_mut() {
                push_angle(g, a.i, a.j, a.k, a.ka * dterm, di, dk);
            }
        }
        for t in &self.torsions {
            let (phi, d) = dihedral(x, t.i, t.j, t.k, t.l);
            e += 0.5 * t.v * (1.0 - t.cos_term * (t.n * phi).cos());
            if let (Some(g), Some(d)) = (g.as_deref_mut(), d) {
                let de = 0.5 * t.v * t.cos_term * t.n * (t.n * phi).sin();
                for (atom, v) in [t.i, t.j, t.k, t.l].into_iter().zip(d) {
                    push(g, atom, scale(v, de));
                }
            }
        }
        for v in &self.inversions {
            let (s, d) = out_of_plane(x, v.i, v.j, v.k, v.l);
            let sin_y = (1.0 - s * s).max(0.0).sqrt();
            let cos2w = 2.0 * sin_y * sin_y - 1.0;
            e += v.k_ * (v.c[0] + v.c[1] * sin_y + v.c[2] * cos2w);
            if let (Some(g), Some(d)) = (g.as_deref_mut(), d) {
                let dsin = if sin_y > 1e-8 { -s / sin_y } else { 0.0 };
                let de = v.k_ * (v.c[1] * dsin - 4.0 * v.c[2] * s);
                for (atom, w) in [v.i, v.j, v.k, v.l].into_iter().zip(d) {
                    push(g, atom, scale(w, de));
                }
            }
        }
        for p in &self.pairs {
            let a = at(x, p.i);
            let b = at(x, p.j);
            let r2 = (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2);
            let q = p.x * p.x / r2.max(1e-12);
            let q6 = q * q * q;
            e += p.d * (q6 * q6 - 2.0 * q6);
            if let Some(g) = g.as_deref_mut() {
                // dE/dr² = d (−6 q⁶ + 6 q³) / r²
                let f = p.d * (-6.0 * q6 * q6 + 6.0 * q6) / r2.max(1e-12) * 2.0;
                let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
                push(g, p.i, scale(d, f));
                push(g, p.j, scale(d, -f));
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
