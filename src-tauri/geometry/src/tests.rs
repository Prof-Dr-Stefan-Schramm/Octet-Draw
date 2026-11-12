// Adapted from ReShiki (https://github.com/Ameyanagi/ReShiki), native/geometry/src/tests.rs, MIT OR Apache-2.0, © 2026 Ameyanagi and ReShiki contributors.
use super::*;
use crate::field::Energy;

pub(crate) mod rdkit;

pub(crate) fn reference_request(r: &rdkit::Reference, field: ForceField) -> Request {
    Request {
        atoms: r
            .atoms
            .iter()
            .map(|&(atomic_number, charge, explicit_h, no_implicit, chiral_tag)| AtomInput {
                atomic_number,
                isotope: 0,
                charge,
                explicit_h,
                no_implicit,
                aromatic: false,
                radical: 0,
                chiral_tag,
            })
            .collect(),
        bonds: r
            .bonds
            .iter()
            .map(|&(a, b, order, stereo, x, y)| BondInput {
                a,
                b,
                order,
                aromatic: false,
                stereo,
                stereo_atoms: (stereo > 1).then_some([x, y]),
            })
            .collect(),
        field,
        operation: Operation::Evaluate,
        coordinates: r.coordinates.to_vec(),
        fixed_atoms: Vec::new(),
        conformers: 4,
        seed: 0x52534b,
        max_iterations: 500,
    }
}

pub(crate) fn flat(c: &[[f64; 3]]) -> Vec<f64> {
    c.iter().flatten().copied().collect()
}

fn reference(name: &str) -> &'static rdkit::Reference {
    rdkit::REFERENCES.iter().find(|r| r.name == name).unwrap()
}

#[test]
fn legacy_capacity_and_first_extra_atom_are_pinned() {
    assert_eq!(
        Capacity::default(),
        Capacity {
            atoms: 512,
            bonds: 2048,
            coordinates: 4096,
        }
    );
    assert_eq!(Capacity::for_heap(258 * 1024 * 1024 - 1).atoms, 512);
    assert_eq!(Capacity::for_heap(258 * 1024 * 1024).atoms, 513);
}

#[test]
fn operational_capacity_is_bounded_by_independent_structural_limits() {
    assert!(Capacity::for_heap(0).validate().is_err());
    assert!(Capacity::for_heap(512 * 1024 - 1).validate().is_err());
    assert_eq!(Capacity::for_heap(64 * 1024 * 1024).atoms, 128);
    assert_eq!(Capacity::for_heap(256 * 1024 * 1024).atoms, 512);
    let high = Capacity::for_heap(usize::MAX);
    assert_eq!(high.atoms, MAX_ATOMS);
    assert_eq!(high.bonds, 4 * MAX_ATOMS);
    assert!(high.bonds <= MAX_BONDS);
    assert_eq!(high.coordinates, MAX_COORDINATES);
    assert!(high.validate().is_ok());
    assert!(Capacity { atoms: MAX_ATOMS + 1, ..high }.validate().is_err());
    assert!(Capacity { bonds: MAX_BONDS + 1, ..high }.validate().is_err());
    assert!(Capacity { coordinates: MAX_COORDINATES + 1, ..high }.validate().is_err());
    let mut request = ethanol(ForceField::MMFF94s);
    request.atoms = vec![request.atoms[0].clone(); 513];
    request.bonds.clear();
    assert!(request.validate_capacity(Capacity::default()).is_err());
    assert!(request.validate_capacity(high).is_ok());
    request.atoms.resize(MAX_ATOMS + 1, request.atoms[0].clone());
    assert!(request.validate().is_err());
}

fn atom(atomic_number: u32) -> AtomInput {
    AtomInput {
        atomic_number,
        isotope: 0,
        charge: 0,
        explicit_h: 0,
        no_implicit: false,
        aromatic: false,
        radical: 0,
        chiral_tag: 0,
    }
}

fn ethanol(field: ForceField) -> Request {
    molecule(&[6, 6, 8], &[(0, 1, 1), (1, 2, 1)], field)
}

fn molecule(numbers: &[u32], edges: &[(usize, usize, u32)], field: ForceField) -> Request {
    Request {
        atoms: numbers.iter().map(|&z| atom(z)).collect(),
        bonds: edges
            .iter()
            .map(|&(a, b, order)| BondInput {
                a,
                b,
                order,
                aromatic: order == 12,
                stereo: 0,
                stereo_atoms: None,
            })
            .collect(),
        field,
        operation: Operation::Generate,
        coordinates: Vec::new(),
        fixed_atoms: Vec::new(),
        conformers: 2,
        seed: 61453,
        max_iterations: 1000,
    }
}

fn evaluate(request: &Request, coordinates: Vec<[f64; 3]>) -> Response {
    let mut evaluation = request.clone();
    evaluation.operation = Operation::Evaluate;
    evaluation.coordinates = coordinates;
    evaluation.fixed_atoms.clear();
    solve(&evaluation).unwrap()
}

fn close(actual: f64, expected: f64, absolute: f64, relative: f64) {
    assert!(
        (actual - expected).abs() <= absolute + relative * expected.abs(),
        "actual={actual}, expected={expected}"
    );
}

#[test]
fn rust_results_preserve_hydrogen_mapping_and_gradient_for_every_field() {
    for field in [ForceField::MMFF94, ForceField::MMFF94s, ForceField::UFF] {
        let mut request = ethanol(field);
        let generated = solve(&request).unwrap();
        assert_eq!(generated.original_count, 3);
        assert_eq!(generated.coordinates.len(), 9);
        assert_eq!(generated.hydrogen_parents, [0, 0, 0, 1, 1, 2]);
        assert!(generated.energy <= generated.initial_energy + 1e-6);
        request.operation = Operation::Evaluate;
        request.coordinates = generated.coordinates;
        request.coordinates[0][0] += 0.15;
        let evaluated = solve(&request).unwrap();
        let gradient = evaluated.gradient.unwrap();
        assert_eq!(gradient.len(), request.coordinates.len());
        let step = 1e-5;
        for (index, force) in gradient.iter().enumerate() {
            for (axis, &analytic) in force.iter().enumerate() {
                let mut plus = request.coordinates.clone();
                let mut minus = plus.clone();
                plus[index][axis] += step;
                minus[index][axis] -= step;
                let numerical = (evaluate(&request, plus).energy - evaluate(&request, minus).energy) / (2.0 * step);
                close(analytic, numerical, 2e-5, 2e-6);
            }
        }

        let transformed = request.coordinates.iter().map(|&[x, y, z]| [-y + 6.5, x - 2.0, z + 1.25]).collect();
        let rotated = evaluate(&request, transformed);
        close(rotated.energy, evaluated.energy, 1e-7, 1e-9);
        let rotated_gradient = rotated.gradient.unwrap();
        for (original, rotated) in gradient.iter().zip(rotated_gradient) {
            let expected = [-original[1], original[0], original[2]];
            for axis in 0..3 {
                close(rotated[axis], expected[axis], 1e-6, 1e-8);
            }
        }
    }
}

#[test]
fn rust_relax_keeps_original_and_added_hydrogen_fixed() {
    for field in [ForceField::MMFF94, ForceField::MMFF94s, ForceField::UFF] {
        let mut request = ethanol(field);
        request.coordinates = solve(&request).unwrap().coordinates;
        request.operation = Operation::Relax;
        request.max_iterations = 20;
        request.fixed_atoms = vec![0, 3];
        request.coordinates[0][0] += 0.04;
        let result = solve(&request).unwrap();
        for &i in &request.fixed_atoms {
            assert_eq!(result.coordinates[i], request.coordinates[i]);
        }
        assert!(result.energy <= result.initial_energy + 1e-6);
    }
}

#[test]
fn seeded_sampling_is_repeatable_and_does_not_substitute_force_fields() {
    for field in [ForceField::MMFF94, ForceField::MMFF94s, ForceField::UFF] {
        let request = ethanol(field);
        let first = solve(&request).unwrap();
        let repeated = solve(&request).unwrap();
        assert_eq!(first.field, field);
        assert_eq!(first.energy, repeated.energy);
        assert_eq!(first.coordinates, repeated.coordinates);
    }
    let mut borane = molecule(&[5], &[], ForceField::UFF);
    let supported = solve(&borane).unwrap();
    assert_eq!(supported.field, ForceField::UFF);
    assert_eq!(supported.hydrogen_parents, [0, 0, 0]);
    for field in [ForceField::MMFF94, ForceField::MMFF94s] {
        borane.field = field;
        assert!(solve(&borane).unwrap_err().contains("MMFF parameters are unavailable"));
    }
}

#[test]
fn changing_generation_seed_samples_a_new_flexible_conformer() {
    let edges: Vec<_> = (0..9).map(|a| (a, a + 1, 1)).collect();
    let mut request = molecule(&[6; 10], &edges, ForceField::MMFF94s);
    request.seed = 0x52534b;
    request.conformers = 8;
    let first = solve(&request).unwrap();
    request.seed += 1_000_003;
    let next = solve(&request).unwrap();
    let repeated = solve(&request).unwrap();
    assert_eq!(first.field, next.field);
    assert_eq!(first.hydrogen_parents, next.hydrogen_parents);
    assert_eq!(next.coordinates, repeated.coordinates);
    // Compare internal distances so a rigid rotation alone cannot count as another conformer.
    let squared_distance =
        |points: &[[f64; 3]], a: usize, b: usize| points[a].iter().zip(points[b]).map(|(a, b)| (a - b).powi(2)).sum::<f64>();
    let mut largest_change = 0_f64;
    for a in 0..request.atoms.len() {
        for b in a + 1..request.atoms.len() {
            largest_change = largest_change
                .max((squared_distance(&first.coordinates, a, b) - squared_distance(&next.coordinates, a, b)).abs());
        }
    }
    assert!(largest_change > 0.1, "{largest_change}; energies {} and {}", first.energy, next.energy);
}

#[test]
fn generation_seed_contract_and_invalid_geometry_fallback_are_bounded() {
    let mut request = ethanol(ForceField::UFF);
    request.coordinates = vec![[0., 0., 0.]; 2];
    assert!(request.validate().unwrap_err().contains("original-atom"));
    request.coordinates = vec![[0., 0., 0.]; 3];
    request.fixed_atoms = vec![0];
    assert!(request.validate().unwrap_err().contains("fixed atoms"));
    request.fixed_atoms.clear();
    for invalid in [
        vec![[0., 0., 0.]; 3],
        vec![[f64::NAN, 0., 0.]; 3],
        vec![[0., 0., 0.], [1.5, 0., 1.5], [2., 1., 3.]],
    ] {
        request.coordinates = invalid;
        let generated = solve(&request).unwrap();
        assert_eq!(generated.hydrogen_parents, [0, 0, 0, 1, 1, 2]);
        assert_eq!(generated.coordinates.len(), 9);
        assert!(generated.diagnostics[0].starts_with("existing original-atom coordinates ignored:"));
        assert!(generated.diagnostics[0].len() < 600);
        assert!(generated.diagnostics.iter().any(|line| line.contains("Rust distance geometry")));
    }
}

#[test]
fn existing_3d_seed_adds_temporary_hydrogens_and_preserves_tetrahedral_stereo() {
    let mut request = molecule(&[6, 9, 17, 35], &[(0, 1, 1), (0, 2, 1), (0, 3, 1)], ForceField::MMFF94s);
    request.atoms[0].chiral_tag = 1;
    let embedded = solve(&request).unwrap();
    request.coordinates = embedded.coordinates[..request.atoms.len()].to_vec();
    let seeded = solve(&request).unwrap();
    assert_eq!(seeded.hydrogen_parents, [0]);
    assert_eq!(seeded.coordinates.len(), 5);
    assert!(seeded.diagnostics[0].starts_with("initialization=existing-3d;"), "{:?}", seeded.diagnostics);
    assert!(seeded.energy <= seeded.initial_energy + 1e-6);
    evaluate(&request, seeded.coordinates.clone());
    let repeated = solve(&request).unwrap();
    assert_eq!(seeded.energy, repeated.energy);
    assert_eq!(seeded.coordinates, repeated.coordinates);
    for point in &mut request.coordinates {
        point[2] = -point[2];
    }
    let corrected = solve(&request).unwrap();
    assert!(corrected.diagnostics[0].starts_with("existing original-atom coordinates ignored:"));
    assert!(corrected.diagnostics[0].contains("tetrahedral stereo"));
    evaluate(&request, corrected.coordinates);
    assert_eq!(request.atoms[0].chiral_tag, 1);
}

#[test]
fn aromatic_hydrogens_and_amide_variant_parameters_are_preserved() {
    let ring: Vec<_> = (0..6).map(|a| (a, (a + 1) % 6, 12)).collect();
    let mut benzene = molecule(&[6; 6], &ring, ForceField::MMFF94);
    for atom in &mut benzene.atoms {
        atom.aromatic = true;
    }
    for field in [ForceField::MMFF94, ForceField::MMFF94s, ForceField::UFF] {
        benzene.field = field;
        let result = solve(&benzene).unwrap();
        assert_eq!(result.coordinates.len(), 12);
        assert_eq!(result.hydrogen_parents, [0, 1, 2, 3, 4, 5]);
        assert!(result.energy <= result.initial_energy + 1e-6);
    }

    let mut amide = molecule(&[6, 6, 8, 7], &[(0, 1, 1), (1, 2, 2), (1, 3, 1)], ForceField::MMFF94);
    let mut displaced = solve(&amide).unwrap().coordinates;
    // Displace nitrogen normal to the carbonyl plane to exercise the improper terms.
    let a: [f64; 3] = std::array::from_fn(|i| displaced[0][i] - displaced[1][i]);
    let b: [f64; 3] = std::array::from_fn(|i| displaced[2][i] - displaced[1][i]);
    let normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let length = normal.iter().map(|x| x * x).sum::<f64>().sqrt();
    assert!(length > 1e-8);
    for (coordinate, direction) in displaced[3].iter_mut().zip(normal) {
        *coordinate += 0.5 * direction / length;
    }
    let mmff94 = evaluate(&amide, displaced.clone()).energy;
    amide.field = ForceField::MMFF94s;
    let mmff94s = evaluate(&amide, displaced).energy;
    assert!((mmff94 - mmff94s).abs() > 1e-3);
}

#[test]
fn tetrahedral_stereo_with_implicit_and_original_isotope_hydrogen_is_checked() {
    for tag in [1, 2] {
        let mut request = molecule(&[6, 9, 17, 35], &[(0, 1, 1), (0, 2, 1), (0, 3, 1)], ForceField::MMFF94s);
        request.atoms[0].chiral_tag = tag;
        let generated = solve(&request).unwrap();
        assert_eq!(generated.hydrogen_parents, [0]);
        evaluate(&request, generated.coordinates.clone());
        request.operation = Operation::Evaluate;
        request.coordinates = generated.coordinates;
        for point in &mut request.coordinates {
            point[2] = -point[2];
        }
        assert!(solve(&request).unwrap_err().contains("tetrahedral stereo"));
        for point in &mut request.coordinates {
            point[2] = 0.;
        }
        assert!(solve(&request).is_err());
    }
    // Explicit deuterium is an original atom, not a disposable calculation H.
    let mut original_hydrogen =
        molecule(&[1, 6, 9, 17, 35], &[(0, 1, 1), (1, 2, 1), (1, 3, 1), (1, 4, 1)], ForceField::MMFF94);
    original_hydrogen.atoms[0].isotope = 2;
    original_hydrogen.atoms[0].no_implicit = true;
    original_hydrogen.atoms[1].chiral_tag = 1;
    let result = solve(&original_hydrogen).unwrap();
    assert_eq!(result.original_count, 5);
    assert_eq!(result.coordinates.len(), 5);
    assert!(result.hydrogen_parents.is_empty());
    evaluate(&original_hydrogen, result.coordinates);
}

#[test]
fn e_z_and_cis_trans_references_reject_inversion_and_degeneracy() {
    for stereo in [2, 3, 4, 5] {
        let mut request = molecule(&[6, 6, 6, 6], &[(0, 1, 1), (1, 2, 2), (2, 3, 1)], ForceField::MMFF94);
        request.bonds[1].stereo = stereo;
        request.bonds[1].stereo_atoms = Some([0, 3]);
        let generated = solve(&request).unwrap();
        evaluate(&request, generated.coordinates.clone());
        request.operation = Operation::Evaluate;
        request.coordinates = generated.coordinates;
        // Rotate one designated substituent by 180 degrees around the bond.
        let axis: [f64; 3] = std::array::from_fn(|i| request.coordinates[2][i] - request.coordinates[1][i]);
        let reference: [f64; 3] = std::array::from_fn(|i| request.coordinates[3][i] - request.coordinates[2][i]);
        let axis2: f64 = axis.iter().map(|x| x * x).sum();
        let projection: f64 = axis.iter().zip(reference).map(|(a, b)| a * b).sum::<f64>() / axis2;
        request.coordinates[3] =
            std::array::from_fn(|i| request.coordinates[2][i] + 2. * projection * axis[i] - reference[i]);
        assert!(solve(&request).is_err());
        request.coordinates[0] = request.coordinates[1];
        assert!(solve(&request).is_err());
    }
}

#[test]
fn evaluation_rejects_collapsed_stretched_and_overlapping_geometry() {
    let mut request = ethanol(ForceField::MMFF94);
    let generated = solve(&request).unwrap();
    request.operation = Operation::Evaluate;
    request.coordinates = generated.coordinates.clone();
    request.coordinates[0][0] += 10.;
    assert!(solve(&request).is_err());
    request.coordinates = generated.coordinates.clone();
    request.coordinates[0] = request.coordinates[1];
    assert!(solve(&request).is_err());
    request.coordinates = generated.coordinates;
    request.coordinates[3] = request.coordinates[8];
    assert!(solve(&request).is_err());
    request.fixed_atoms.push(0);
    assert!(solve(&request).unwrap_err().contains("fixed atoms"));
}

#[test]
fn invalid_requests_and_domain_errors_leave_solver_usable() {
    let mut request = ethanol(ForceField::UFF);
    request.bonds[0].a = usize::MAX;
    assert!(solve(&request).unwrap_err().contains("bond"));
    let mut request = ethanol(ForceField::MMFF94);
    request.atoms[0].atomic_number = 30;
    assert!(!solve(&request).unwrap_err().is_empty());
    let mut request = ethanol(ForceField::UFF);
    request.atoms[0].radical = 1;
    assert!(solve(&request).unwrap_err().contains("radicals"));
    let mut request = ethanol(ForceField::UFF);
    request.bonds[0].order = 17;
    assert!(solve(&request).unwrap_err().contains("coordination"));
    let mut request = ethanol(ForceField::UFF);
    request.bonds.pop();
    assert!(solve(&request).unwrap_err().contains("connected"));
    let mut request = ethanol(ForceField::UFF);
    request.atoms[2].explicit_h = 3;
    request.atoms[2].no_implicit = true;
    assert!(solve(&request).unwrap_err().contains("valence"));
    // A domain failure must not poison subsequent solver operations.
    assert!(solve(&ethanol(ForceField::MMFF94)).is_ok());
}

#[test]
fn uff_energies_match_rdkit() {
    let mut failures = Vec::new();
    for r in rdkit::REFERENCES {
        let mol = solver::molecule_for_tests(&reference_request(r, ForceField::UFF)).unwrap();
        assert_eq!(mol.atoms.len(), r.coordinates.len(), "{}", r.name);
        match uff::Field::new(&mol) {
            Ok(field) => {
                let e = field.energy(&flat(r.coordinates));
                if r.uff.is_nan() || (e - r.uff).abs() > 1e-6 * r.uff.abs().max(1.0) {
                    failures.push(format!("{}: {e} vs RDKit {}", r.name, r.uff));
                }
            }
            Err(error) => {
                if !r.uff.is_nan() {
                    failures.push(format!("{}: {error}", r.name));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn uff_gradients_match_finite_differences() {
    for r in rdkit::REFERENCES.iter().filter(|r| !r.uff.is_nan()) {
        let mol = solver::molecule_for_tests(&reference_request(r, ForceField::UFF)).unwrap();
        let field = uff::Field::new(&mol).unwrap();
        let x = flat(r.coordinates);
        let mut g = vec![0.0; x.len()];
        field.gradient(&x, &mut g);
        let step = 1e-5;
        for k in 0..x.len() {
            let (mut plus, mut minus) = (x.clone(), x.clone());
            plus[k] += step;
            minus[k] -= step;
            let numerical = (field.energy(&plus) - field.energy(&minus)) / (2.0 * step);
            assert!((g[k] - numerical).abs() <= 1e-4 + 1e-6 * numerical.abs(), "{} {k}: {} vs {numerical}", r.name, g[k]);
        }
    }
}

/// The chiral-tag convention, with tags RDKit 2026.09.2 gives from SMILES (atom order and bond order as RDKit
/// parses them): RDKit's own 3D tags on RDKit coordinates, and generation keeps each tag.
#[test]
fn chiral_tags_follow_rdkit_and_survive_generation() {
    // L-alanine N[C@@H](C)C(=O)O (S): tag 1; D-alanine N[C@H](C)C(=O)O: tag 2.
    let alanine = [(0, 1, 1), (1, 2, 1), (1, 3, 1), (3, 4, 2), (3, 5, 1)];
    // (R)-CHFClBr F[C@H](Cl)Br: tag 2; (S) F[C@@H](Cl)Br: tag 1.
    let halo = [(0, 1, 1), (1, 2, 1), (1, 3, 1)];
    // (S)-2-methyltetrahydropyran C[C@H]1CCCCO1: tag 1 (the ring-closure bond O–C1 comes last).
    let ring = [(0, 1, 1), (1, 2, 1), (2, 3, 1), (3, 4, 1), (4, 5, 1), (5, 6, 1), (6, 1, 1)];
    let cases: [(&[u32], &[(usize, usize, u32)], u32); 6] = [
        (&[7, 6, 6, 6, 8, 8], &alanine, 1),
        (&[7, 6, 6, 6, 8, 8], &alanine, 2),
        (&[9, 6, 17, 35], &halo, 2),
        (&[9, 6, 17, 35], &halo, 1),
        (&[6, 6, 6, 6, 6, 6, 8], &ring, 1),
        (&[6, 6, 6, 6, 6, 6, 8], &ring, 2),
    ];
    for (numbers, edges, tag) in cases {
        for field in [ForceField::MMFF94s, ForceField::UFF] {
            let mut request = molecule(numbers, edges, field);
            request.atoms[1].chiral_tag = tag;
            let result = solve(&request).unwrap_or_else(|e| panic!("{numbers:?} {tag} {field:?}: {e}"));
            let mol = solver::molecule_for_tests(&request).unwrap();
            assert_eq!(stereo::chiral_tag_from_3d(&mol, &result.coordinates, 1), tag as u8);
        }
    }
    // RDKit's coordinates for the tripeptide Ala-Gly-Ser give RDKit's tags back, and generation keeps them.
    let r = reference("tripeptide");
    let mol = solver::molecule_for_tests(&reference_request(r, ForceField::UFF)).unwrap();
    let tagged: Vec<_> = r.atoms.iter().enumerate().filter(|(_, a)| a.4 != 0).map(|(i, a)| (i, a.4 as u8)).collect();
    assert_eq!(tagged.len(), 2);
    for &(i, tag) in &tagged {
        assert_eq!(stereo::chiral_tag_from_3d(&mol, r.coordinates, i), tag);
    }
    let generated = generate("tripeptide", ForceField::MMFF94s);
    for &(i, tag) in &tagged {
        assert_eq!(stereo::chiral_tag_from_3d(&mol, &generated.coordinates, i), tag);
    }
}

/// (E)- and (Z)-2-butene as RDKit reads C/C=C/C (stereo 3, references 0 and 3) and C/C=C\C (stereo 2).
#[test]
fn double_bond_stereo_survives_generation() {
    for (stereo, same_side) in [(3, false), (2, true)] {
        for field in [ForceField::MMFF94s, ForceField::UFF] {
            let mut request = molecule(&[6, 6, 6, 6], &[(0, 1, 1), (1, 2, 2), (2, 3, 1)], field);
            request.bonds[1].stereo = stereo;
            request.bonds[1].stereo_atoms = Some([0, 3]);
            let c = solve(&request).unwrap().coordinates;
            let dihedral = field::dihedral(&flat(&c), 0, 1, 2, 3).0.to_degrees();
            if same_side {
                assert!(dihedral.abs() < 10.0, "{dihedral}");
            } else {
                assert!(dihedral.abs() > 170.0, "{dihedral}");
            }
        }
    }
}

fn generate(name: &str, field: ForceField) -> Response {
    let r = reference(name);
    solve(&Request { operation: Operation::Generate, coordinates: Vec::new(), conformers: 8, ..reference_request(r, field) })
        .unwrap_or_else(|e| panic!("{name}: {e}"))
}

#[test]
fn cyclohexane_is_a_chair_and_benzene_is_flat() {
    for field in [ForceField::MMFF94s, ForceField::MMFF94, ForceField::UFF] {
        let c = flat(&generate("cyclohexane", field).coordinates);
        let mut signs = Vec::new();
        for k in 0..6 {
            let phi = field::dihedral(&c, k, (k + 1) % 6, (k + 2) % 6, (k + 3) % 6).0.to_degrees();
            assert!((phi.abs() - 55.5).abs() < 6.0, "{field:?}: ring torsion {phi}");
            signs.push(phi.signum());
        }
        // A chair alternates the torsion signs around the ring.
        for k in 0..6 {
            assert_ne!(signs[k], signs[(k + 1) % 6], "{field:?}");
        }
        // Benzene: every atom, hydrogens too, in the plane of the first three carbons.
        let c = generate("benzene", field).coordinates;
        let normal = field::cross(field::sub(c[1], c[0]), field::sub(c[2], c[0]));
        let normal = field::scale(normal, 1.0 / field::norm(normal));
        for p in &c {
            let height = field::dot(field::sub(*p, c[0]), normal);
            assert!(height.abs() < 0.01, "{field:?}: {height}");
        }
    }
}

#[test]
fn every_reference_molecule_generates_quickly() {
    for r in rdkit::REFERENCES {
        for field in [ForceField::MMFF94s, ForceField::UFF] {
            let expected = if field == ForceField::UFF { r.uff } else { r.mmff94s };
            let start = std::time::Instant::now();
            let request =
                Request { operation: Operation::Generate, coordinates: Vec::new(), conformers: 8, ..reference_request(r, field) };
            match solve(&request) {
                Ok(result) => {
                    assert!(!expected.is_nan(), "{}", r.name);
                    assert_eq!(result.coordinates.len(), r.coordinates.len());
                    assert!(result.energy <= result.initial_energy + 1e-6);
                    // At least as low as RDKit's unminimised reference geometry.
                    assert!(result.energy < expected + 1e-6, "{} {field:?}: {} vs {expected}", r.name, result.energy);
                    let elapsed = start.elapsed().as_secs_f64();
                    assert!(elapsed < 5.0, "{} {field:?}: {elapsed} s", r.name);
                }
                Err(error) => assert!(expected.is_nan(), "{} {field:?}: {error}", r.name),
            }
        }
    }
}



/// Above 300 atoms (hydrogens included) the start is grown along the bonds instead of the metric matrix, and the
/// conformer count is cut to bound the work: stereo still holds and the run stays short.
#[test]
fn a_large_molecule_keeps_its_stereo_within_the_time_bound() {
    let mut edges: Vec<_> = (0..99).map(|a| (a, a + 1, 1)).collect();
    edges.push((50, 100, 1));
    let mut numbers = vec![6; 101];
    numbers[100] = 9;
    let mut request = molecule(&numbers, &edges, ForceField::MMFF94s);
    request.atoms[50].chiral_tag = 2;
    request.conformers = 8;
    request.max_iterations = 500;
    let start = std::time::Instant::now();
    let result = solve(&request).unwrap();
    assert!(start.elapsed().as_secs_f64() < 20.0, "{:?}", start.elapsed());
    assert_eq!(result.coordinates.len(), 302);
    assert!(result.diagnostics.iter().any(|d| d.contains("actual_count=3")), "{:?}", result.diagnostics);
    let mol = solver::molecule_for_tests(&request).unwrap();
    assert_eq!(stereo::chiral_tag_from_3d(&mol, &result.coordinates, 50), 2);
}


/// The torsion angle's derivatives on their own, at many random shapes: each matches a finite difference, and the
/// four sum to zero (moving all four atoms together does not change the angle).
#[test]
fn dihedral_derivatives_match_finite_differences() {
    let mut state = 0x2545_f491_4f6c_dd1du64;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 11) as f64 / (1u64 << 53) as f64 * 4.0 - 2.0
    };
    for _ in 0..200 {
        let x: Vec<f64> = (0..12).map(|_| next()).collect();
        let (phi, Some(g)) = field::dihedral(&x, 0, 1, 2, 3) else { continue };
        for c in 0..3 {
            assert!((g[0][c] + g[1][c] + g[2][c] + g[3][c]).abs() < 1e-9);
        }
        let step = 1e-6;
        for k in 0..12 {
            let (mut plus, mut minus) = (x.clone(), x.clone());
            plus[k] += step;
            minus[k] -= step;
            let (p, m) = (field::dihedral(&plus, 0, 1, 2, 3).0, field::dihedral(&minus, 0, 1, 2, 3).0);
            let mut d = p - m;
            if d > std::f64::consts::PI {
                d -= 2.0 * std::f64::consts::PI;
            } else if d < -std::f64::consts::PI {
                d += 2.0 * std::f64::consts::PI;
            }
            let numerical = d / (2.0 * step);
            assert!((g[k / 3][k % 3] - numerical).abs() <= 1e-5 * (1.0 + numerical.abs()), "phi {phi} coordinate {k}: {} vs {numerical}", g[k / 3][k % 3]);
        }
    }
}
