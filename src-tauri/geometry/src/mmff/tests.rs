use super::*;
use crate::tests::rdkit::REFERENCES;
use crate::tests::{flat, reference_request};
use crate::{ForceField, solver::molecule_for_tests};

#[test]
fn mmff_types_and_charges_match_rdkit() {
    let mut failures = Vec::new();
    for r in REFERENCES {
        let mol = match molecule_for_tests(&reference_request(r, ForceField::MMFF94)) {
            Ok(mol) => mol,
            Err(e) => panic!("{}: {e}", r.name),
        };
        if r.mmff_types.is_empty() {
            if types(&mol).is_ok() && Field::new(&mol, false).is_ok() {
                failures.push(format!("{}: RDKit has no MMFF parameters, we do", r.name));
            }
            continue;
        }
        match types(&mol) {
            Ok(t) if t == r.mmff_types => {}
            Ok(t) => failures.push(format!("{}: types {t:?}\n  RDKit {:?}", r.name, r.mmff_types)),
            Err(e) => failures.push(format!("{}: {e}", r.name)),
        }
        if let Ok(q) = charges(&mol) {
            for (i, (a, b)) in q.iter().zip(r.mmff_charges).enumerate() {
                if (a - b).abs() > 1e-6 {
                    failures.push(format!("{}: charge {i} {a} vs RDKit {b}", r.name));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn mmff_energies_match_rdkit() {
    let mut failures = Vec::new();
    for r in REFERENCES {
        let mol = match molecule_for_tests(&reference_request(r, ForceField::MMFF94)) {
            Ok(mol) => mol,
            Err(e) => panic!("{}: {e}", r.name),
        };
        for (mmff94s, expected) in [(false, r.mmff94), (true, r.mmff94s)] {
            match Field::new(&mol, mmff94s) {
                Ok(field) => {
                    let e = field.energy(&flat(r.coordinates));
                    if expected.is_nan() || (e - expected).abs() > 1e-6 * expected.abs().max(1.0) {
                        failures.push(format!("{} (94s {mmff94s}): {e} vs RDKit {expected}", r.name));
                    }
                }
                Err(error) => {
                    if !expected.is_nan() {
                        failures.push(format!("{}: {error}", r.name));
                    } else {
                        assert!(error.contains("MMFF parameters are unavailable for this molecule"));
                    }
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn mmff_gradients_match_finite_differences() {
    for r in REFERENCES.iter().filter(|r| !r.mmff94.is_nan()) {
        let mol = match molecule_for_tests(&reference_request(r, ForceField::MMFF94)) {
            Ok(mol) => mol,
            Err(e) => panic!("{}: {e}", r.name),
        };
        for mmff94s in [false, true] {
            let field = Field::new(&mol, mmff94s).unwrap();
            let x = flat(r.coordinates);
            let mut g = vec![0.0; x.len()];
            field.gradient(&x, &mut g);
            let h = 1e-6;
            for c in 0..x.len() {
                let mut plus = x.clone();
                let mut minus = x.clone();
                plus[c] += h;
                minus[c] -= h;
                let numeric = (field.energy(&plus) - field.energy(&minus)) / (2.0 * h);
                assert!(
                    (numeric - g[c]).abs() <= 1e-4 + 1e-5 * numeric.abs(),
                    "{} coordinate {c}: analytic {} numeric {numeric}",
                    r.name,
                    g[c]
                );
            }
        }
    }
}

#[test]
fn torsion_and_out_of_plane_derivatives_match_finite_differences() {
    use crate::field::{dihedral, out_of_plane};
    let x = vec![0.1, 0.2, -0.3, 1.4, 0.1, 0.2, 2.0, 1.3, 0.1, 3.3, 1.5, 0.9];
    let h = 1e-6;
    let d = dihedral(&x, 0, 1, 2, 3).1.unwrap();
    let o = out_of_plane(&x, 0, 1, 2, 3).1.unwrap();
    for a in 0..4 {
        for c in 0..3 {
            let (mut p, mut m) = (x.clone(), x.clone());
            p[3 * a + c] += h;
            m[3 * a + c] -= h;
            let nd = (dihedral(&p, 0, 1, 2, 3).0 - dihedral(&m, 0, 1, 2, 3).0) / (2.0 * h);
            let no = (out_of_plane(&p, 0, 1, 2, 3).0 - out_of_plane(&m, 0, 1, 2, 3).0) / (2.0 * h);
            assert!((d[a][c] - nd).abs() < 1e-7, "dihedral atom {a} axis {c}: {} vs {nd}", d[a][c]);
            assert!((o[a][c] - no).abs() < 1e-7, "out of plane atom {a} axis {c}: {} vs {no}", o[a][c]);
        }
    }
}
