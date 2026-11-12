//! BFGS minimisation with a backtracking line search, after RDKit's `BFGSOpt` (BSD-3-Clause), with RDKit's
//! convergence tests: positions (`energy_tol`) and the scaled gradient (`force_tol`). The energy never rises: a step is
//! taken only when the line search lowers it. Fixed coordinates have zero gradient and so never move. Large systems
//! use limited-memory BFGS with the same line search and tests.
use crate::field::Energy;

const FUNCTOL: f64 = 1e-4;
const MOVETOL: f64 = 1e-7;
const EPS: f64 = 3e-8;
const MAXSTEP: f64 = 100.0;
/// Above this many coordinates the inverse Hessian is not kept in full.
const DENSE_LIMIT: usize = 300;
const MEMORY: usize = 12;

pub(crate) struct Outcome {
    pub iterations: u32,
    pub converged: bool,
}

struct Problem<'a> {
    field: &'a dyn Energy,
    fixed: &'a [bool],
}

impl Problem<'_> {
    fn value(&self, x: &[f64]) -> f64 {
        self.field.energy(x)
    }
    /// RDKit's gradient functor: the gradient is scaled by 0.1, and further when it is large; returns the scale.
    fn gradient(&self, x: &[f64], g: &mut [f64]) -> f64 {
        g.iter_mut().for_each(|v| *v = 0.0);
        self.field.gradient(x, g);
        for (i, v) in g.iter_mut().enumerate() {
            if self.fixed[i / 3] {
                *v = 0.0;
            }
        }
        let mut scale = 0.1;
        let mut largest = -1e8_f64;
        for v in g.iter_mut() {
            *v *= scale;
            largest = largest.max(*v);
        }
        if largest > 10.0 {
            let mut extra = 1.0;
            while largest * extra > 10.0 {
                extra *= 0.5;
            }
            g.iter_mut().for_each(|v| *v *= extra);
            scale *= extra;
        }
        scale
    }
}

/// Returns true when a lower point was found in `new`.
#[allow(clippy::too_many_arguments)]
fn line_search(p: &Problem, old: &[f64], old_value: f64, grad: &[f64], dir: &mut [f64], new: &mut [f64], value: &mut f64, max_step: f64) -> bool {
    let length = dir.iter().map(|v| v * v).sum::<f64>().sqrt();
    if length > max_step {
        dir.iter_mut().for_each(|v| *v *= max_step / length);
    }
    let slope: f64 = dir.iter().zip(grad).map(|(d, g)| d * g).sum();
    if slope >= 0.0 {
        new.copy_from_slice(old);
        *value = old_value;
        return false;
    }
    let test = dir.iter().zip(old).map(|(d, x)| d.abs() / x.abs().max(1.0)).fold(0.0, f64::max);
    let lambda_min = MOVETOL / test;
    let (mut lambda, mut lambda2, mut value2) = (1.0, 0.0, 0.0);
    for it in 0..1000 {
        if lambda < lambda_min {
            break;
        }
        for i in 0..old.len() {
            new[i] = old[i] + lambda * dir[i];
        }
        *value = p.value(new);
        if *value - old_value <= FUNCTOL * lambda * slope && value.is_finite() {
            return true;
        }
        let next = if !value.is_finite() {
            0.1 * lambda
        } else if it == 0 {
            -slope / (2.0 * (*value - old_value - slope))
        } else {
            let rhs1 = *value - old_value - lambda * slope;
            let rhs2 = value2 - old_value - lambda2 * slope;
            let a = (rhs1 / (lambda * lambda) - rhs2 / (lambda2 * lambda2)) / (lambda - lambda2);
            let b = (-lambda2 * rhs1 / (lambda * lambda) + lambda * rhs2 / (lambda2 * lambda2)) / (lambda - lambda2);
            let t = if a == 0.0 {
                -slope / (2.0 * b)
            } else {
                let disc = b * b - 3.0 * a * slope;
                if disc < 0.0 {
                    0.5 * lambda
                } else if b <= 0.0 {
                    (-b + disc.sqrt()) / (3.0 * a)
                } else {
                    -slope / (b + disc.sqrt())
                }
            };
            t.min(0.5 * lambda)
        };
        lambda2 = lambda;
        value2 = *value;
        lambda = if next.is_finite() { next.max(0.1 * lambda) } else { 0.1 * lambda };
    }
    new.copy_from_slice(old);
    *value = old_value;
    false
}

/// Minimise in place. `fixed` marks atoms (not coordinates) whose positions must not change.
pub(crate) fn minimize(field: &dyn Energy, x: &mut [f64], fixed: &[bool], max_iterations: u32, force_tol: f64, energy_tol: f64) -> Outcome {
    let p = Problem { field, fixed };
    let dim = x.len();
    let mut grad = vec![0.0; dim];
    let mut energy = p.value(x);
    if dim == 0 || !energy.is_finite() {
        return Outcome { iterations: 0, converged: false };
    }
    p.gradient(x, &mut grad);
    let sum: f64 = x.iter().map(|v| v * v).sum();
    let max_step = MAXSTEP * sum.sqrt().max(dim as f64);
    let dense = dim <= DENSE_LIMIT;
    let mut inverse = if dense { vec![0.0; dim * dim] } else { Vec::new() };
    if dense {
        for i in 0..dim {
            inverse[i * dim + i] = 1.0;
        }
    }
    let mut memory: std::collections::VecDeque<(Vec<f64>, Vec<f64>, f64)> = std::collections::VecDeque::new();
    let mut dir: Vec<f64> = grad.iter().map(|g| -g).collect();
    let mut new = vec![0.0; dim];
    let mut dgrad = vec![0.0; dim];
    let mut hdg = vec![0.0; dim];
    for iteration in 1..=max_iterations {
        let mut value = energy;
        line_search(&p, x, energy, &grad, &mut dir, &mut new, &mut value, max_step);
        energy = value;
        let mut test = 0.0_f64;
        for i in 0..dim {
            dir[i] = new[i] - x[i];
            x[i] = new[i];
            test = test.max(dir[i].abs() / x[i].abs().max(1.0));
            dgrad[i] = grad[i];
        }
        if test < energy_tol {
            return Outcome { iterations: iteration, converged: true };
        }
        let scale = p.gradient(x, &mut grad);
        let term = (energy * scale).max(1.0);
        let mut gtest = 0.0_f64;
        for i in 0..dim {
            gtest = gtest.max(grad[i].abs() * x[i].abs().max(1.0));
            dgrad[i] = grad[i] - dgrad[i];
        }
        if gtest / term < force_tol {
            return Outcome { iterations: iteration, converged: true };
        }
        if dense {
            let (mut fac, mut fae, mut sum_dg, mut sum_xi) = (0.0, 0.0, 0.0, 0.0);
            for i in 0..dim {
                let row = &inverse[i * dim..(i + 1) * dim];
                hdg[i] = row.iter().zip(&dgrad).map(|(a, b)| a * b).sum();
                fac += dgrad[i] * dir[i];
                fae += dgrad[i] * hdg[i];
                sum_dg += dgrad[i] * dgrad[i];
                sum_xi += dir[i] * dir[i];
            }
            if fac > (EPS * sum_dg * sum_xi).sqrt() {
                let fac = 1.0 / fac;
                let fad = 1.0 / fae;
                for i in 0..dim {
                    dgrad[i] = fac * dir[i] - fad * hdg[i];
                }
                for i in 0..dim {
                    for j in i..dim {
                        let v = inverse[i * dim + j] + fac * dir[i] * dir[j] - fad * hdg[i] * hdg[j] + fae * dgrad[i] * dgrad[j];
                        inverse[i * dim + j] = v;
                        inverse[j * dim + i] = v;
                    }
                }
            }
            for i in 0..dim {
                let row = &inverse[i * dim..(i + 1) * dim];
                dir[i] = -row.iter().zip(&grad).map(|(a, b)| a * b).sum::<f64>();
            }
        } else {
            let sy: f64 = dir.iter().zip(&dgrad).map(|(a, b)| a * b).sum();
            let yy: f64 = dgrad.iter().map(|v| v * v).sum();
            if sy > 1e-12 * yy.max(1e-300) && sy > 0.0 {
                if memory.len() == MEMORY {
                    memory.pop_front();
                }
                memory.push_back((dir.clone(), dgrad.clone(), 1.0 / sy));
            }
            let mut q = grad.clone();
            let mut alphas = Vec::with_capacity(memory.len());
            for (s, y, rho) in memory.iter().rev() {
                let alpha = rho * s.iter().zip(&q).map(|(a, b)| a * b).sum::<f64>();
                for (qi, yi) in q.iter_mut().zip(y) {
                    *qi -= alpha * yi;
                }
                alphas.push(alpha);
            }
            if let Some((s, y, _)) = memory.back() {
                let gamma = s.iter().zip(y).map(|(a, b)| a * b).sum::<f64>() / y.iter().map(|v| v * v).sum::<f64>();
                q.iter_mut().for_each(|v| *v *= gamma);
            }
            for ((s, y, rho), alpha) in memory.iter().zip(alphas.iter().rev()) {
                let beta = rho * y.iter().zip(&q).map(|(a, b)| a * b).sum::<f64>();
                for (qi, si) in q.iter_mut().zip(s) {
                    *qi += si * (alpha - beta);
                }
            }
            for i in 0..dim {
                dir[i] = if fixed[i / 3] { 0.0 } else { -q[i] };
            }
        }
    }
    Outcome { iterations: max_iterations, converged: false }
}
