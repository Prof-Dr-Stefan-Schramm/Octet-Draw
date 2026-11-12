//! Distance geometry after RDKit's (Code/DistGeomHelpers, BSD-3-Clause): a bounds matrix from the topology (1–2 from
//! UFF bond lengths, 1–3 from ideal angles, 1–4 from cis and trans distances with double-bond stereo and ring
//! planarity, van der Waals lower bounds beyond), triangle smoothing, random distances from a seeded generator, a 4D
//! metric-matrix embedding, then minimisation of a distance-error function with chiral-volume terms, first in 4D and
//! then pressing the fourth dimension flat. Deterministic for a given seed.
use crate::chem::{Hyb, Mol};
use crate::field::{Energy, V3, cross, dot, sub};
use crate::minimize::minimize;
use crate::stereo::{StereoExpectation, chiral_tag_from_3d};

const DIST12_DELTA: f64 = 0.01;
const DIST13_TOL: f64 = 0.04;
const GEN_DIST_TOL: f64 = 0.06;
const VDW_SCALE: f64 = 0.7;
const MAX_UPPER: f64 = 1000.0;
const BASIN: f64 = 5.0;
/// Above this many atoms the start is random coordinates, not the metric matrix.
const METRIC_LIMIT: usize = 300;

/// splitmix64: small, fast and fully deterministic.
pub(crate) struct Random(u64);
impl Random {
    pub fn new(seed: u64) -> Self {
        Random(seed ^ 0x9e37_79b9_7f4a_7c15)
    }
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    /// Uniform in [0, 1).
    pub fn uniform(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn vdw_radius(z: u8) -> f64 {
    match z {
        1 => 1.2,
        5 => 1.8,
        6 => 1.7,
        7 => 1.6,
        8 => 1.55,
        9 => 1.5,
        14 => 2.1,
        15 => 1.95,
        16 => 1.8,
        17 => 1.8,
        33 => 2.05,
        34 => 1.9,
        35 => 1.9,
        53 => 2.1,
        _ => 2.0,
    }
}

fn covalent_radius(z: u8) -> f64 {
    match z {
        1 => 0.31,
        5 => 0.84,
        6 => 0.76,
        7 => 0.71,
        8 => 0.66,
        9 => 0.57,
        14 => 1.11,
        15 => 1.07,
        16 => 1.05,
        17 => 1.02,
        33 => 1.19,
        34 => 1.20,
        35 => 1.20,
        53 => 1.39,
        _ => 1.0,
    }
}

/// Smoothed bounds: `upper[i][j]` and `lower[i][j]` in one row-major matrix, upper above the diagonal.
pub(crate) struct Bounds {
    n: usize,
    m: Vec<f64>,
}
impl Bounds {
    fn upper(&self, i: usize, j: usize) -> f64 {
        let (a, b) = if i < j { (i, j) } else { (j, i) };
        self.m[a * self.n + b]
    }
    fn lower(&self, i: usize, j: usize) -> f64 {
        let (a, b) = if i < j { (i, j) } else { (j, i) };
        self.m[b * self.n + a]
    }
    fn set(&mut self, i: usize, j: usize, l: f64, u: f64) {
        let (a, b) = if i < j { (i, j) } else { (j, i) };
        self.m[a * self.n + b] = u;
        self.m[b * self.n + a] = l;
    }
    /// Floyd–Warshall triangle smoothing. False when a lower bound passes an upper bound.
    fn smooth(&mut self) -> bool {
        let n = self.n;
        for k in 0..n {
            for i in 0..n {
                if i == k {
                    continue;
                }
                let (uik, lik) = (self.upper(i, k), self.lower(i, k));
                for j in i + 1..n {
                    if j == k {
                        continue;
                    }
                    let (ukj, lkj) = (self.upper(k, j), self.lower(k, j));
                    let mut u = self.upper(i, j);
                    if uik + ukj < u {
                        u = uik + ukj;
                        self.m[i * n + j] = u;
                    }
                    let l = self.lower(i, j);
                    let candidate = (lik - ukj).max(lkj - uik);
                    if candidate > l {
                        self.m[j * n + i] = candidate;
                    }
                    if self.m[j * n + i] > self.m[i * n + j] + 1e-9 {
                        return false;
                    }
                }
            }
        }
        true
    }
}

/// Ideal angle i–j–k in radians.
fn ideal_angle(mol: &Mol, i: usize, j: usize, k: usize) -> f64 {
    // The smallest ring that holds both bonds.
    let ring = mol
        .rings
        .iter()
        .filter(|r| {
            r.contains(&j)
                && crate::chem::ring_has_edge(r, i, j)
                && crate::chem::ring_has_edge(r, j, k)
        })
        .map(|r| r.len())
        .min();
    let degree = mol.degree(j);
    match (ring, mol.atoms[j].hyb) {
        (Some(3), _) => 60f64.to_radians(),
        (Some(4), _) => 90f64.to_radians(),
        (Some(5), Hyb::Sp3) => 104f64.to_radians(),
        (Some(5), _) => 108f64.to_radians(),
        (_, Hyb::Sp) => std::f64::consts::PI,
        (_, Hyb::Sp2) => 120f64.to_radians(),
        (_, Hyb::Sp3d2) if degree > 4 => 90f64.to_radians(),
        _ => 109.5f64.to_radians(),
    }
}

fn law_of_cosines(a: f64, b: f64, angle: f64) -> f64 {
    (a * a + b * b - 2.0 * a * b * angle.cos()).max(0.0).sqrt()
}

/// 1–4 distance for a dihedral of 0 (cis) or π (trans).
fn dist14(b1: f64, b2: f64, b3: f64, a12: f64, a23: f64, cis: bool) -> f64 {
    // Place j at origin, k on +x; i and l in the xy plane.
    let ix = b1 * a12.cos();
    let iy = b1 * a12.sin();
    let lx = b2 - b3 * a23.cos();
    let ly = b3 * a23.sin() * if cis { 1.0 } else { -1.0 };
    ((lx - ix).powi(2) + (ly - iy).powi(2)).sqrt()
}

pub(crate) fn bounds(mol: &Mol) -> Bounds {
    let n = mol.atoms.len();
    let mut b = Bounds { n, m: vec![0.0; n * n] };
    let mut set = vec![0u8; n * n];
    for i in 0..n {
        for j in i + 1..n {
            let l = VDW_SCALE * (vdw_radius(mol.atoms[i].z) + vdw_radius(mol.atoms[j].z));
            b.set(i, j, l, MAX_UPPER);
        }
    }
    let lengths: Vec<f64> = (0..mol.bonds.len())
        .map(|k| {
            crate::uff::bond_length(mol, k).unwrap_or_else(|| {
                covalent_radius(mol.atoms[mol.bonds[k].a].z) + covalent_radius(mol.atoms[mol.bonds[k].b].z)
            })
        })
        .collect();
    for (k, bond) in mol.bonds.iter().enumerate() {
        b.set(bond.a, bond.b, lengths[k] - DIST12_DELTA, lengths[k] + DIST12_DELTA);
        set[bond.a * n + bond.b] = 1;
        set[bond.b * n + bond.a] = 1;
    }
    for j in 0..n {
        for (x, &(i, bi)) in mol.nbrs[j].iter().enumerate() {
            for &(k, bk) in &mol.nbrs[j][x + 1..] {
                if set[i * n + k] != 0 {
                    continue;
                }
                let d = law_of_cosines(lengths[bi], lengths[bk], ideal_angle(mol, i, j, k));
                let tol = if mol.atoms[j].hyb == Hyb::Sp3 && mol.degree(j) <= 4 { DIST13_TOL } else { 2.0 * DIST13_TOL };
                b.set(i, k, d - tol, d + tol);
                set[i * n + k] = 2;
                set[k * n + i] = 2;
            }
        }
    }
    for (central, bond) in mol.bonds.iter().enumerate() {
        let (j, k) = (bond.a, bond.b);
        let ring = mol.rings.iter().find(|r| crate::chem::ring_has_edge(r, j, k));
        let planar_ring = ring.is_some()
            && (bond.aromatic
                || (bond.order == 2)
                || (mol.atoms[j].hyb == Hyb::Sp2 && mol.atoms[k].hyb == Hyb::Sp2 && ring.is_some_and(|r| r.len() <= 6) && bond.conjugated));
        for &(i, bi) in &mol.nbrs[j] {
            if bi == central {
                continue;
            }
            for &(l, bl) in &mol.nbrs[k] {
                if bl == central || l == i || set[i * n + l] != 0 {
                    continue;
                }
                let a1 = ideal_angle(mol, i, j, k);
                let a2 = ideal_angle(mol, j, k, l);
                let cis = dist14(lengths[bi], lengths[central], lengths[bl], a1, a2, true);
                let trans = dist14(lengths[bi], lengths[central], lengths[bl], a1, a2, false);
                let fixed = if bond.order == 2 && !bond.aromatic && matches!(bond.stereo, 2..=5) {
                    bond.refs.map(|[ra, rb]| {
                        let same = matches!(bond.stereo, 2 | 4);
                        let parity = (i == ra) == (l == rb);
                        parity == same
                    })
                } else if planar_ring {
                    let r = ring.expect("planar ring");
                    Some(r.contains(&i) == r.contains(&l))
                } else {
                    None
                };
                let (l_, u_) = match fixed {
                    Some(true) => (cis - GEN_DIST_TOL, cis + GEN_DIST_TOL),
                    Some(false) => (trans - GEN_DIST_TOL, trans + GEN_DIST_TOL),
                    None => (cis.min(trans) - GEN_DIST_TOL, cis.max(trans) + GEN_DIST_TOL),
                };
                b.set(i, l, l_.max(0.0), u_);
                set[i * n + l] = 3;
                set[l * n + i] = 3;
            }
        }
    }
    b
}

/// Smoothed bounds, softening the van der Waals floor when the topology cannot meet it.
pub(crate) fn smoothed_bounds(mol: &Mol) -> Option<Bounds> {
    let first = bounds(mol);
    let mut trial = Bounds { n: first.n, m: first.m.clone() };
    if trial.smooth() {
        return Some(trial);
    }
    // Lower only the van der Waals floors (pairs beyond 1–4) and try again.
    let n = first.n;
    let topological = topological_distances(mol);
    for factor in [0.5, 0.0] {
        let mut t = Bounds { n, m: first.m.clone() };
        for i in 0..n {
            for j in i + 1..n {
                if topological[i * n + j] > 3 {
                    let l = t.lower(i, j) * factor;
                    let u = t.upper(i, j);
                    t.set(i, j, l, u);
                }
            }
        }
        if t.smooth() {
            return Some(t);
        }
    }
    None
}

fn topological_distances(mol: &Mol) -> Vec<u32> {
    let n = mol.atoms.len();
    let mut d = vec![u32::MAX; n * n];
    for s in 0..n {
        d[s * n + s] = 0;
        let mut queue = std::collections::VecDeque::from([s]);
        while let Some(v) = queue.pop_front() {
            for &(w, _) in &mol.nbrs[v] {
                if d[s * n + w] == u32::MAX {
                    d[s * n + w] = d[s * n + v] + 1;
                    queue.push_back(w);
                }
            }
        }
    }
    d
}

struct Chiral {
    center: usize,
    nbrs: [usize; 3],
    lower: f64,
    upper: f64,
}

/// For large molecules: van der Waals lower bounds between atoms not in the tight list, found through a grid, so
/// each evaluation is linear in the atom count. It gives the same function as testing every pair.
struct Repel {
    /// Half of each atom's lower-bound sum (0.7 × its van der Waals radius).
    radius: Vec<f64>,
    tight: std::collections::HashSet<(usize, usize)>,
    cell: f64,
}

struct ErrorField<'a> {
    dim: usize,
    pairs: &'a [(usize, usize, f64, f64, bool)],
    repel: Option<&'a Repel>,
    chirals: &'a [Chiral],
    chiral_weight: f64,
    fourth_weight: f64,
}

impl Repel {
    fn evaluate(&self, x: &[f64], dim: usize, mut g: Option<&mut [f64]>) -> f64 {
        let n = self.radius.len();
        let key = |i: usize| -> [i64; 3] { std::array::from_fn(|c| (x[i * dim + c] / self.cell).floor() as i64) };
        let mut grid: std::collections::HashMap<[i64; 3], Vec<usize>> = std::collections::HashMap::new();
        for i in 0..n {
            grid.entry(key(i)).or_default().push(i);
        }
        let mut e = 0.0;
        for i in 0..n {
            let k = key(i);
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        let Some(cell) = grid.get(&[k[0] + dx, k[1] + dy, k[2] + dz]) else { continue };
                        for &j in cell {
                            if j <= i || self.tight.contains(&(i, j)) {
                                continue;
                            }
                            let l = self.radius[i] + self.radius[j];
                            let mut d2 = 0.0;
                            for c in 0..dim {
                                let t = x[i * dim + c] - x[j * dim + c];
                                d2 += t * t;
                            }
                            let l2 = l * l;
                            if d2 >= l2 {
                                continue;
                            }
                            let v = 2.0 * l2 / (l2 + d2) - 1.0;
                            e += v * v;
                            if let Some(g) = g.as_deref_mut() {
                                let factor = -8.0 * v * l2 / (l2 + d2).powi(2);
                                for c in 0..dim {
                                    let t = x[i * dim + c] - x[j * dim + c];
                                    g[i * dim + c] += factor * t;
                                    g[j * dim + c] -= factor * t;
                                }
                            }
                        }
                    }
                }
            }
        }
        e
    }
}

impl ErrorField<'_> {
    fn evaluate(&self, x: &[f64], mut g: Option<&mut [f64]>) -> f64 {
        let dim = self.dim;
        let mut e = 0.0;
        for &(i, j, l, u, both) in self.pairs {
            let mut d2 = 0.0;
            for c in 0..dim {
                let t = x[i * dim + c] - x[j * dim + c];
                d2 += t * t;
            }
            let (u2, l2) = (u * u, l * l);
            let factor = if both && d2 > u2 {
                let v = d2 / u2 - 1.0;
                e += v * v;
                4.0 * v / u2
            } else if d2 < l2 {
                let v = 2.0 * l2 / (l2 + d2) - 1.0;
                e += v * v;
                -8.0 * v * l2 / (l2 + d2).powi(2)
            } else {
                continue;
            };
            if let Some(g) = g.as_deref_mut() {
                for c in 0..dim {
                    let t = x[i * dim + c] - x[j * dim + c];
                    g[i * dim + c] += factor * t;
                    g[j * dim + c] -= factor * t;
                }
            }
        }
        if let Some(repel) = self.repel {
            e += repel.evaluate(x, dim, g.as_deref_mut());
        }
        let p = |i: usize| -> V3 { [x[i * dim], x[i * dim + 1], x[i * dim + 2]] };
        for c in self.chirals {
            let p0 = p(c.center);
            let v1 = sub(p(c.nbrs[0]), p0);
            let v2 = sub(p(c.nbrs[1]), p0);
            let v3 = sub(p(c.nbrs[2]), p0);
            let vol = dot(v1, cross(v2, v3));
            let diff = if vol < c.lower {
                vol - c.lower
            } else if vol > c.upper {
                vol - c.upper
            } else {
                continue;
            };
            e += self.chiral_weight * diff * diff;
            if let Some(g) = g.as_deref_mut() {
                let f = 2.0 * self.chiral_weight * diff;
                let d1 = cross(v2, v3);
                let d2 = cross(v3, v1);
                let d3 = cross(v1, v2);
                for (atom, d) in [(c.nbrs[0], d1), (c.nbrs[1], d2), (c.nbrs[2], d3)] {
                    for k in 0..3 {
                        g[atom * dim + k] += f * d[k];
                    }
                }
                for k in 0..3 {
                    g[c.center * dim + k] -= f * (d1[k] + d2[k] + d3[k]);
                }
            }
        }
        if dim == 4 && self.fourth_weight > 0.0 {
            for i in 0..x.len() / 4 {
                let w = x[i * 4 + 3];
                e += self.fourth_weight * w * w;
                if let Some(g) = g.as_deref_mut() {
                    g[i * 4 + 3] += 2.0 * self.fourth_weight * w;
                }
            }
        }
        e
    }
}

impl Energy for ErrorField<'_> {
    fn energy(&self, x: &[f64]) -> f64 {
        self.evaluate(x, None)
    }
    fn gradient(&self, x: &[f64], g: &mut [f64]) -> f64 {
        self.evaluate(x, Some(g))
    }
}

/// Top eigenpairs of a symmetric matrix by power iteration with deflation.
fn top_eigen(mut g: Vec<f64>, n: usize, count: usize, random: &mut Random) -> Vec<(f64, Vec<f64>)> {
    let mut out = Vec::new();
    for _ in 0..count {
        let mut v: Vec<f64> = (0..n).map(|_| random.uniform() - 0.5).collect();
        let mut lambda = 0.0;
        for _ in 0..1000 {
            let mut w = vec![0.0; n];
            for i in 0..n {
                let row = &g[i * n..(i + 1) * n];
                w[i] = row.iter().zip(&v).map(|(a, b)| a * b).sum();
            }
            let norm = w.iter().map(|a| a * a).sum::<f64>().sqrt();
            if norm < 1e-12 {
                break;
            }
            let new_lambda = v.iter().zip(&w).map(|(a, b)| a * b).sum::<f64>();
            w.iter_mut().for_each(|a| *a /= norm);
            let change = w.iter().zip(&v).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
            v = w;
            let converged = (new_lambda - lambda).abs() <= 1e-6 * new_lambda.abs().max(1.0) && change < 1e-4;
            lambda = new_lambda;
            if converged {
                break;
            }
        }
        // Rayleigh quotient of the final vector.
        let mut lam = 0.0;
        for i in 0..n {
            let row = &g[i * n..(i + 1) * n];
            lam += v[i] * row.iter().zip(&v).map(|(a, b)| a * b).sum::<f64>();
        }
        for i in 0..n {
            for j in 0..n {
                g[i * n + j] -= lam * v[i] * v[j];
            }
        }
        out.push((lam, v));
    }
    out
}

/// Prepared embedding data for one molecule, shared by every attempt.
pub(crate) struct Embedder<'a> {
    mol: &'a Mol,
    bounds: Bounds,
    chirals: Vec<Chiral>,
}

impl<'a> Embedder<'a> {
    pub fn new(mol: &'a Mol, expected: &StereoExpectation) -> Option<Self> {
        // Large molecules start from random coordinates and need no random distances, so no O(n³) smoothing.
        let bounds = if mol.atoms.len() <= METRIC_LIMIT { smoothed_bounds(mol)? } else { bounds(mol) };
        // Each specified centre: the volume of its first three neighbours, and with four neighbours every triple, so
        // the fourth neighbour sits on its own side too (signs +, −, +, − for 012, 013, 023, 123 around a tetrahedron).
        let mut chirals = Vec::new();
        for &(center, tag) in &expected.atoms {
            let nb: Vec<usize> = mol.nbrs[center].iter().map(|&(n, _)| n).collect();
            let triples: &[([usize; 3], f64)] =
                if nb.len() == 4 { &[([0, 1, 2], 1.0), ([0, 1, 3], -1.0), ([0, 2, 3], 1.0), ([1, 2, 3], -1.0)] } else { &[([0, 1, 2], 1.0)] };
            for &(t, parity) in triples {
                let nbrs = t.map(|k| nb[k]);
                // The volume of an ideal tetrahedral centre with these bond lengths, from the 1–2 bounds.
                let ideal: f64 = 0.7698 * nbrs.iter().map(|&n| bounds.upper(center, n)).product::<f64>();
                let sign = if tag == 2 { parity } else { -parity };
                let (lower, upper) = if sign > 0.0 { (0.75 * ideal, 1.5 * ideal) } else { (-1.5 * ideal, -0.75 * ideal) };
                chirals.push(Chiral { center, nbrs, lower, upper });
            }
        }
        Some(Embedder { mol, bounds, chirals })
    }

    /// One embedding attempt; None when the stereo did not come out right.
    pub fn attempt(&self, random: &mut Random, expected: &StereoExpectation) -> Option<Vec<V3>> {
        let n = self.mol.atoms.len();
        if n == 1 {
            return Some(vec![[0.0; 3]]);
        }
        const D: usize = 4;
        let mut x = vec![0.0; n * D];
        if n <= METRIC_LIMIT {
            // Random distances within the bounds, then the metric matrix.
            let mut d2 = vec![0.0; n * n];
            for i in 0..n {
                for j in i + 1..n {
                    let (l, u) = (self.bounds.lower(i, j), self.bounds.upper(i, j));
                    let d = l + (u - l) * random.uniform();
                    d2[i * n + j] = d * d;
                    d2[j * n + i] = d * d;
                }
            }
            let total: f64 = (0..n).flat_map(|i| (i + 1..n).map(move |j| (i, j))).map(|(i, j)| d2[i * n + j]).sum();
            let d0: Vec<f64> = (0..n)
                .map(|i| d2[i * n..(i + 1) * n].iter().sum::<f64>() / n as f64 - total / (n * n) as f64)
                .collect();
            let mut g = vec![0.0; n * n];
            for i in 0..n {
                for j in 0..n {
                    g[i * n + j] = 0.5 * (d0[i] + d0[j] - d2[i * n + j]);
                }
            }
            let eigen = top_eigen(g, n, D, random);
            for (k, (lambda, v)) in eigen.iter().enumerate() {
                let s = lambda.max(0.0).sqrt();
                for i in 0..n {
                    x[i * D + k] = s * v[i] + if s == 0.0 { 0.1 * (random.uniform() - 0.5) } else { 0.0 };
                }
            }
        } else {
            // Grow the molecule outwards along its bonds, each atom at its bond length from its parent in a random
            // direction leaning away from the grandparent; the error minimisation does the rest.
            let mut placed = vec![false; n];
            let mut parent = vec![usize::MAX; n];
            let mut queue = std::collections::VecDeque::from([0]);
            placed[0] = true;
            for c in 0..D {
                x[c] = 0.0;
            }
            while let Some(v) = queue.pop_front() {
                let away: Vec<f64> = if parent[v] == usize::MAX {
                    vec![0.0; D]
                } else {
                    let p = parent[v];
                    let d: Vec<f64> = (0..D).map(|c| x[v * D + c] - x[p * D + c]).collect();
                    let norm = d.iter().map(|a| a * a).sum::<f64>().sqrt().max(1e-9);
                    d.iter().map(|a| a / norm).collect()
                };
                for &(w, b) in &self.mol.nbrs[v] {
                    if placed[w] {
                        continue;
                    }
                    let mut d: Vec<f64> = (0..D).map(|c| 2.0 * random.uniform() - 1.0 + 1.2 * away[c]).collect();
                    d[D - 1] *= 0.1;
                    let norm = d.iter().map(|a| a * a).sum::<f64>().sqrt().max(1e-9);
                    let bond = &self.mol.bonds[b];
                    let length = 0.5 * (self.bounds.lower(bond.a, bond.b) + self.bounds.upper(bond.a, bond.b));
                    for c in 0..D {
                        x[w * D + c] = x[v * D + c] + length * d[c] / norm;
                    }
                    placed[w] = true;
                    parent[w] = v;
                    queue.push_back(w);
                }
            }
        }
        let large = n > METRIC_LIMIT;
        let mut pairs = Vec::new();
        for i in 0..n {
            for j in i + 1..n {
                let (l, u) = (self.bounds.lower(i, j), self.bounds.upper(i, j));
                let both = u - l <= BASIN;
                if both || (l > 0.0 && !large) {
                    pairs.push((i, j, l, u, both));
                }
            }
        }
        let repel = large.then(|| {
            let radius: Vec<f64> = self.mol.atoms.iter().map(|a| 0.5 * VDW_SCALE * 2.0 * vdw_radius(a.z)).collect();
            let cell = 2.0 * radius.iter().copied().fold(0.0, f64::max);
            Repel { radius, tight: pairs.iter().map(|p| (p.0, p.1)).collect(), cell }
        });
        let fixed = vec![false; x.len()];
        let mut field =
            ErrorField { dim: D, pairs: &pairs, repel: repel.as_ref(), chirals: &self.chirals, chiral_weight: 1.0, fourth_weight: 0.1 };
        for _ in 0..5 {
            if minimize(&field, &mut x, &fixed, 400, 1e-3, 1e-6).converged {
                break;
            }
        }
        field.chiral_weight = 1.0;
        field.fourth_weight = 1.0;
        for _ in 0..5 {
            if minimize(&field, &mut x, &fixed, 400, 1e-3, 1e-6).converged {
                break;
            }
        }
        let coordinates: Vec<V3> = (0..n).map(|i| [x[i * D], x[i * D + 1], x[i * D + 2]]).collect();
        if !coordinates.iter().all(|p| p.iter().all(|v| v.is_finite())) {
            return None;
        }
        // Each centre must have its tag and a clearly tetrahedral shape: every volume on its side and not flattened.
        for c in &self.chirals {
            let p0 = coordinates[c.center];
            let volume = dot(sub(coordinates[c.nbrs[0]], p0), cross(sub(coordinates[c.nbrs[1]], p0), sub(coordinates[c.nbrs[2]], p0)));
            let ideal = if c.lower > 0.0 { c.lower / 0.75 } else { -c.upper / 0.75 };
            if volume * c.lower.signum() < 0.5 * ideal {
                return None;
            }
        }
        for &(atom, tag) in &expected.atoms {
            if chiral_tag_from_3d(self.mol, &coordinates, atom) != tag {
                return None;
            }
        }
        if expected.validate(self.mol, &coordinates).is_err() {
            return None;
        }
        Some(coordinates)
    }
}
