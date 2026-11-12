// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), native/geometry/src/solver.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
//! The solver: molecule and hydrogens, stereo expectation, a 3D seed or distance-geometry conformers, force-field
//! minimisation, validation and selection of the lowest-energy valid result.
use super::{ForceField, MAX_COORDINATES, Operation, Request, Response};
use crate::chem::{Hyb, Mol, Result};
use crate::embed::{Embedder, Random};
use crate::field::{Energy, V3, add, cross, dot, norm, scale, sub};
use crate::minimize::minimize;
use crate::stereo::{StereoExpectation, has_three_dimensional_extent, validate_geometry};

/// Embedding attempts for each requested conformer before it counts as failed.
const ATTEMPTS: u32 = 10;
/// Conformers × atoms² that one generation may take (8 conformers up to 200 atoms, hydrogens included).
const CONFORMER_WORK: usize = 320_000;

fn require(condition: bool, message: impl Into<String>) -> Result<()> {
    if condition { Ok(()) } else { Err(message.into()) }
}

fn force_field(mol: &Mol, field: ForceField) -> Result<Box<dyn Energy>> {
    match field {
        ForceField::UFF => Ok(Box::new(crate::uff::Field::new(mol)?)),
        ForceField::MMFF94 => Ok(Box::new(crate::mmff::Field::new(mol, false)?)),
        ForceField::MMFF94s => Ok(Box::new(crate::mmff::Field::new(mol, true)?)),
    }
}

fn flat(coordinates: &[V3]) -> Vec<f64> {
    coordinates.iter().flatten().copied().collect()
}

fn rows(x: &[f64]) -> Vec<V3> {
    x.chunks(3).map(|c| [c[0], c[1], c[2]]).collect()
}

fn energy(field: &dyn Energy, x: &[f64]) -> Result<f64> {
    let value = field.energy(x);
    require(value.is_finite(), "force field produced a nonfinite energy")?;
    Ok(value)
}

struct Candidate {
    coordinates: Vec<V3>,
    initial_energy: f64,
    energy: f64,
    converged: bool,
}

fn minimized(
    mol: &Mol,
    field: &dyn Energy,
    coordinates: &[V3],
    expected: &StereoExpectation,
    request: &Request,
    origin: Option<V3>,
) -> Result<Candidate> {
    expected.validate(mol, coordinates)?;
    let mut fixed = vec![false; mol.atoms.len()];
    for &i in &request.fixed_atoms {
        fixed[i] = true;
    }
    let mut x = flat(coordinates);
    let initial = energy(field, &x)?;
    if let Some(origin) = origin {
        require(request.fixed_atoms.is_empty(), "centered generation cannot fix atoms")?;
        x = flat(&coordinates.iter().map(|&p| sub(p, origin)).collect::<Vec<_>>());
    }
    let outcome = minimize(field, &mut x, &fixed, request.max_iterations, 1e-4, 1e-6);
    require(outcome.iterations <= request.max_iterations, "force-field optimizer exceeded its iteration limit")?;
    let mut result = rows(&x);
    if let Some(origin) = origin {
        result = result.iter().map(|&p| add(p, origin)).collect();
    }
    let final_energy = energy(field, &flat(&result))?;
    require(final_energy <= initial + 1e-6, "force-field minimization increased the energy")?;
    validate_geometry(mol, &result)?;
    expected.validate(mol, &result)?;
    for &index in &request.fixed_atoms {
        require(result[index] == coordinates[index], "force field changed a fixed atom coordinate")?;
    }
    Ok(Candidate { coordinates: result, initial_energy: initial, energy: final_energy, converged: outcome.converged })
}

/// Ideal bond length to a hydrogen.
fn hydrogen_bond_length(z: u8) -> f64 {
    match z {
        5 => 1.19,
        6 => 1.09,
        7 => 1.01,
        8 => 0.97,
        14 => 1.48,
        15 => 1.42,
        16 => 1.34,
        33 => 1.52,
        34 => 1.47,
        _ => 1.1,
    }
}

fn unit(v: V3) -> V3 {
    let n = norm(v);
    if n < 1e-12 { [1.0, 0.0, 0.0] } else { scale(v, 1.0 / n) }
}

/// Any unit vector perpendicular to v.
fn perpendicular(v: V3) -> V3 {
    let trial = if v[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    unit(cross(v, trial))
}

/// Coordinates for added hydrogens around atoms that have them (a 3D seed has only original atoms).
fn place_hydrogens(mol: &Mol, original: &[V3]) -> Vec<V3> {
    let mut out = original.to_vec();
    out.resize(mol.atoms.len(), [0.0; 3]);
    for parent in 0..mol.original {
        let hs: Vec<usize> = mol.nbrs[parent].iter().map(|&(x, _)| x).filter(|&x| x >= mol.original).collect();
        if hs.is_empty() {
            continue;
        }
        let heavy: Vec<usize> = mol.nbrs[parent].iter().map(|&(x, _)| x).filter(|&x| x < mol.original).collect();
        let p = original[parent];
        let length = hydrogen_bond_length(mol.atoms[parent].z);
        let units: Vec<V3> = heavy.iter().map(|&h| unit(sub(original[h], p))).collect();
        let total = heavy.len() + hs.len();
        let hyb = mol.atoms[parent].hyb;
        let directions: Vec<V3> = match (units.len(), hs.len()) {
            (0, _) => {
                let tetra = [[1.0, 1.0, 1.0], [-1.0, -1.0, 1.0], [-1.0, 1.0, -1.0], [1.0, -1.0, -1.0]];
                (0..hs.len()).map(|k| unit(if k < 4 { tetra[k] } else { [0.0, 0.0, 1.0] })).collect()
            }
            (_, 1) => {
                let sum = units.iter().fold([0.0; 3], |a, &b| add(a, b));
                if norm(sum) < 1e-3 {
                    let n = if units.len() >= 2 { unit(cross(units[0], units[1])) } else { perpendicular(units[0]) };
                    vec![if norm(n) > 0.5 { n } else { perpendicular(units[0]) }]
                } else {
                    vec![unit(scale(sum, -1.0))]
                }
            }
            (2, 2) => {
                let bis = unit(scale(add(units[0], units[1]), -1.0));
                let normal = unit(cross(units[0], units[1]));
                let half = 54.75f64.to_radians();
                vec![
                    unit(add(scale(bis, half.cos()), scale(normal, half.sin()))),
                    unit(sub(scale(bis, half.cos()), scale(normal, half.sin()))),
                ]
            }
            (1, k) => {
                let axis = scale(units[0], -1.0);
                // A reference perpendicular from a neighbour's other neighbour keeps the hydrogens staggered.
                let reference = mol.nbrs[heavy[0]]
                    .iter()
                    .map(|&(x, _)| x)
                    .find(|&x| x != parent && x < mol.original)
                    .map(|x| {
                        let r = sub(original[x], original[heavy[0]]);
                        unit(sub(r, scale(units[0], dot(r, units[0]))))
                    })
                    .filter(|r| norm(*r) > 0.5)
                    .unwrap_or_else(|| perpendicular(axis));
                let (angle, step) = if hyb == Hyb::Sp2 || total == 3 {
                    (60f64.to_radians(), 180f64.to_radians())
                } else if hyb == Hyb::Sp || total == 2 {
                    (0.0, 0.0)
                } else {
                    (70.5f64.to_radians(), 120f64.to_radians())
                };
                let other = cross(axis, reference);
                (0..k)
                    .map(|m| {
                        let phi = step * m as f64 + std::f64::consts::PI;
                        let radial = add(scale(reference, phi.cos()), scale(other, phi.sin()));
                        unit(add(scale(axis, angle.cos()), scale(radial, angle.sin())))
                    })
                    .collect()
            }
            (_, k) => {
                let sum = units.iter().fold([0.0; 3], |a, &b| add(a, b));
                let axis = if norm(sum) < 1e-3 { perpendicular(units[0]) } else { unit(scale(sum, -1.0)) };
                let reference = perpendicular(axis);
                let other = cross(axis, reference);
                (0..k)
                    .map(|m| {
                        let phi = 2.0 * std::f64::consts::PI * m as f64 / k as f64;
                        unit(add(scale(axis, 0.5), scale(add(scale(reference, phi.cos()), scale(other, phi.sin())), 0.85)))
                    })
                    .collect()
            }
        };
        for (h, d) in hs.iter().zip(directions) {
            out[*h] = add(p, scale(d, length));
        }
    }
    out
}

fn existing_coordinates(original: &Mol, mol: &Mol, expected: &StereoExpectation, request: &Request) -> Result<Vec<V3>> {
    // Only original atoms and their bonds count here.
    let heavy = Mol {
        atoms: original.atoms.clone(),
        bonds: original.bonds.clone(),
        nbrs: original.nbrs.clone(),
        original: original.original,
        rings: Vec::new(),
    };
    validate_geometry(&heavy, &request.coordinates)?;
    require(
        has_three_dimensional_extent(&request.coordinates),
        "starting geometry is flat, dimensionless, or has insufficient 3D extent",
    )?;
    let coordinates = place_hydrogens(mol, &request.coordinates);
    validate_geometry(mol, &coordinates)?;
    expected.validate(mol, &coordinates)?;
    Ok(coordinates)
}

pub(super) fn solve(request: &Request) -> Result<Response> {
    let original = Mol::from_request(request)?;
    let mol = original.with_hydrogens();
    require(mol.atoms.len() <= MAX_COORDINATES, "hydrogen-expanded atom count exceeds 4096")?;
    let expected = StereoExpectation::new(&mol)?;
    let field = force_field(&mol, request.field)?;
    let parents = mol.hydrogen_parents();
    let mut response = Response {
        coordinates: Vec::new(),
        hydrogen_parents: parents,
        original_count: request.atoms.len(),
        initial_energy: 0.,
        energy: 0.,
        gradient: None,
        converged: false,
        field: request.field,
        diagnostics: Vec::new(),
    };
    if request.operation == Operation::Generate {
        if !request.coordinates.is_empty() {
            match existing_coordinates(&original, &mol, &expected, request).and_then(|coordinates| {
                // The optimizer scales its stopping test by absolute XYZ. Center only this
                // unpinned seed path, then restore the drawing's location before validation.
                let origin = std::array::from_fn(|axis| {
                    coordinates[..request.atoms.len()].iter().map(|point| point[axis]).sum::<f64>() / request.atoms.len() as f64
                });
                minimized(&mol, field.as_ref(), &coordinates, &expected, request, Some(origin))
            }) {
                Ok(candidate) => {
                    response.coordinates = candidate.coordinates;
                    response.initial_energy = candidate.initial_energy;
                    response.energy = candidate.energy;
                    response.converged = candidate.converged;
                    response.diagnostics.push(format!(
                        "initialization=existing-3d; reused existing original-atom 3D coordinates; temporary hydrogens placed from the neighbours; selection=validated existing geometry; iteration_limit={}; converged={}",
                        request.max_iterations, response.converged
                    ));
                    return Ok(response);
                }
                Err(error) => response.diagnostics.push(format!(
                    "existing original-atom coordinates ignored: {}",
                    error.chars().take(512).collect::<String>()
                )),
            }
        }
        let method = "Rust distance geometry";
        let embedder = Embedder::new(&mol, &expected).ok_or("distance bounds cannot be met for this molecule")?;
        let mut best = f64::INFINITY;
        let (mut embedded, mut failed, mut valid, mut rejected) = (0, 0, 0, 0);
        let mut last_failure = String::new();
        // Bounded work: fewer conformers for large molecules, always at least one. Deterministic for a molecule.
        let atoms = mol.atoms.len().max(1);
        let actual = request.conformers.min((CONFORMER_WORK / (atoms * atoms)).max(1) as u32);
        for conformer in 0..actual {
            let mut random = Random::new(request.seed as u64 + conformer as u64);
            let Some(coordinates) = (0..ATTEMPTS).find_map(|_| embedder.attempt(&mut random, &expected)) else {
                failed += 1;
                continue;
            };
            embedded += 1;
            match minimized(&mol, field.as_ref(), &coordinates, &expected, request, None) {
                Ok(candidate) => {
                    valid += 1;
                    if candidate.energy < best {
                        best = candidate.energy;
                        response.coordinates = candidate.coordinates;
                        response.initial_energy = candidate.initial_energy;
                        response.energy = candidate.energy;
                        response.converged = candidate.converged;
                    }
                }
                Err(error) => {
                    rejected += 1;
                    last_failure = error.chars().take(512).collect();
                }
            }
        }
        require(embedded > 0, format!("{method} could not generate a conformer"))?;
        require(valid > 0, format!("all generated conformers failed validation: {last_failure}"))?;
        response.diagnostics.push(format!(
            "{method}; requested={}; actual_count={actual}; embedded={embedded}; failed_embedding={failed}; valid={valid}; rejected={rejected}; seed={}; selection=lowest energy among valid generated conformers; iteration_limit={}; converged={}",
            request.conformers, request.seed, request.max_iterations, response.converged
        ));
        if !last_failure.is_empty() {
            response.diagnostics.push(format!("last_rejection={last_failure}"));
        }
    } else if request.operation == Operation::Relax {
        let candidate = minimized(&mol, field.as_ref(), &request.coordinates, &expected, request, None)?;
        response.coordinates = candidate.coordinates;
        response.initial_energy = candidate.initial_energy;
        response.energy = candidate.energy;
        response.converged = candidate.converged;
        response.diagnostics.push(format!(
            "bounded Rust relaxation; fixed_atoms={}; iteration_limit={}; converged={}",
            request.fixed_atoms.len(),
            request.max_iterations,
            response.converged
        ));
    } else {
        validate_geometry(&mol, &request.coordinates)?;
        expected.validate(&mol, &request.coordinates)?;
        let x = flat(&request.coordinates);
        response.energy = energy(field.as_ref(), &x)?;
        response.initial_energy = response.energy;
        response.coordinates = request.coordinates.clone();
        // Unconstrained: the physical derivative, whatever atoms a caller fixes.
        let mut g = vec![0.0; x.len()];
        field.gradient(&x, &mut g);
        let gradient = rows(&g);
        require(
            gradient.len() == mol.atoms.len() && gradient.iter().flatten().all(|value| value.is_finite()),
            "force field produced an invalid analytic gradient",
        )?;
        response.gradient = Some(gradient);
        response.diagnostics.push("Rust energy and analytic gradient; no minimization".into());
    }
    Ok(response)
}

#[cfg(test)]
pub(crate) fn molecule_for_tests(request: &Request) -> Result<Mol> {
    Ok(Mol::from_request(request)?.with_hydrogens())
}
