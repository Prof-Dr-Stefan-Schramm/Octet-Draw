// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), native/geometry/src/solver.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
//! Stereo the result must keep: every specified tetrahedral tag, re-derived from the 3D coordinates as RDKit's
//! assignChiralTypesFrom3D does, and every specified double bond from its reference atoms.
use crate::chem::{Mol, Result};
use crate::field::{V3, cross, dot, scale, sub};

fn require(condition: bool, message: impl Into<String>) -> Result<()> {
    if condition { Ok(()) } else { Err(message.into()) }
}

/// RDKit's tag from 3D: the first three neighbours in bond order, relative to the atom. 0 when |volume| ≤ 0.1.
pub(crate) fn chiral_tag_from_3d(mol: &Mol, coordinates: &[V3], atom: usize) -> u8 {
    let nbrs = &mol.nbrs[atom];
    if nbrs.len() < 3 {
        return 0;
    }
    let p0 = coordinates[atom];
    let v: Vec<V3> = nbrs[..3].iter().map(|&(n, _)| sub(coordinates[n], p0)).collect();
    let volume = dot(v[0], cross(v[1], v[2]));
    if volume < -0.1 {
        1
    } else if volume > 0.1 {
        2
    } else {
        0
    }
}

pub(crate) struct StereoExpectation {
    pub atoms: Vec<(usize, u8)>,
    /// (a, b, reference of a, reference of b, references on the same side)
    pub bonds: Vec<(usize, usize, usize, usize, bool)>,
}

impl StereoExpectation {
    pub fn new(mol: &Mol) -> Result<Self> {
        let mut atoms = Vec::new();
        for (index, atom) in mol.atoms.iter().enumerate() {
            if atom.chiral_tag == 0 {
                continue;
            }
            require((3..=4).contains(&mol.degree(index)), format!("atom {index}: invalid tetrahedral stereo degree"))?;
            atoms.push((index, atom.chiral_tag));
        }
        let mut bonds = Vec::new();
        for bond in &mol.bonds {
            if !matches!(bond.stereo, 2..=5) {
                continue;
            }
            let refs = bond.refs.ok_or("specified double bond has no stereo references")?;
            bonds.push((bond.a, bond.b, refs[0], refs[1], matches!(bond.stereo, 2 | 4)));
        }
        Ok(Self { atoms, bonds })
    }

    pub fn validate(&self, mol: &Mol, coordinates: &[V3]) -> Result<()> {
        validate_coordinates(mol, coordinates)?;
        for &(index, expected) in &self.atoms {
            require(
                chiral_tag_from_3d(mol, coordinates, index) == expected,
                format!("atom {index}: specified tetrahedral stereo inverted or degenerated"),
            )?;
        }
        for &(a, b, ref_a, ref_b, same_side) in &self.bonds {
            let axis = sub(coordinates[b], coordinates[a]);
            let axis2 = dot(axis, axis);
            require(axis2 > 1e-8, "specified double-bond endpoints coincide")?;
            let u = sub(coordinates[ref_a], coordinates[a]);
            let v = sub(coordinates[ref_b], coordinates[b]);
            let u = sub(u, scale(axis, dot(u, axis) / axis2));
            let v = sub(v, scale(axis, dot(v, axis) / axis2));
            let norm2 = dot(u, u) * dot(v, v);
            require(norm2 > 1e-12, "specified double-bond stereo references are collinear")?;
            let cosine = dot(u, v) / norm2.sqrt();
            require(
                cosine.abs() >= 0.8 && (cosine > 0.) == same_side,
                "specified double-bond stereo inverted or degenerated",
            )?;
        }
        Ok(())
    }
}

pub(crate) fn valid_coordinate(p: &V3) -> bool {
    p.iter().all(|x| x.is_finite() && x.abs() <= 1_000_000.0)
}

pub(crate) fn validate_coordinates(mol: &Mol, coordinates: &[V3]) -> Result<()> {
    require(
        coordinates.len() == mol.atoms.len() && coordinates.iter().all(valid_coordinate),
        "invalid all-atom calculation coordinates",
    )
}

/// Every bond 0.2–4 Å; no two atoms closer than 0.2 Å.
pub(crate) fn validate_geometry(mol: &Mol, coordinates: &[V3]) -> Result<()> {
    validate_coordinates(mol, coordinates)?;
    for bond in &mol.bonds {
        let delta = sub(coordinates[bond.a], coordinates[bond.b]);
        require(
            (0.04..=16.).contains(&dot(delta, delta)),
            "optimized covalent bond is collapsed or exceeds 4 Angstrom",
        )?;
    }
    for (index, &point) in coordinates.iter().enumerate() {
        for &other in &coordinates[index + 1..] {
            let delta = sub(point, other);
            require(dot(delta, delta) >= 0.04, "optimized atoms overlap within 0.2 Angstrom")?;
        }
    }
    Ok(())
}

// Test the principal extents, not the drawing's z coordinates: a flat drawing
// remains flat after rotation. A conservative thickness threshold also avoids
// treating roundoff or tiny display offsets as a physical starting geometry.
pub(crate) fn has_three_dimensional_extent(coordinates: &[V3]) -> bool {
    if coordinates.len() < 4 || !coordinates.iter().all(valid_coordinate) {
        return false;
    }
    let count = coordinates.len() as f64;
    let center: V3 = std::array::from_fn(|axis| coordinates.iter().map(|p| p[axis]).sum::<f64>() / count);
    let mut covariance = [[0.; 3]; 3];
    for &point in coordinates {
        let delta = sub(point, center);
        for row in 0..3 {
            for column in 0..3 {
                covariance[row][column] += delta[row] * delta[column] / count;
            }
        }
    }
    // Jacobi diagonalization of this small symmetric matrix.
    for _ in 0..24 {
        let (p, q) = [(0, 1), (0, 2), (1, 2)]
            .into_iter()
            .max_by(|&(a, b), &(c, d)| covariance[a][b].abs().total_cmp(&covariance[c][d].abs()))
            .unwrap_or((0, 1));
        let off_diagonal = covariance[p][q];
        let trace = covariance[0][0] + covariance[1][1] + covariance[2][2];
        if off_diagonal.abs() <= trace.abs() * 1e-14 {
            break;
        }
        let angle = 0.5 * (2. * off_diagonal).atan2(covariance[q][q] - covariance[p][p]);
        let (sin, cos) = angle.sin_cos();
        let pp = covariance[p][p];
        let qq = covariance[q][q];
        covariance[p][p] = cos * cos * pp - 2. * sin * cos * off_diagonal + sin * sin * qq;
        covariance[q][q] = sin * sin * pp + 2. * sin * cos * off_diagonal + cos * cos * qq;
        covariance[p][q] = 0.;
        covariance[q][p] = 0.;
        // A 3×3 covariance matrix has one axis outside the pivot pair.
        let other = 3 - p - q;
        let op = covariance[other][p];
        let oq = covariance[other][q];
        covariance[other][p] = cos * op - sin * oq;
        covariance[p][other] = covariance[other][p];
        covariance[other][q] = sin * op + cos * oq;
        covariance[q][other] = covariance[other][q];
    }
    let mut extents = [covariance[0][0], covariance[1][1], covariance[2][2]];
    extents.sort_by(f64::total_cmp);
    extents[0] > 1e-4 && extents[0] > extents[2] * 1e-4
}
