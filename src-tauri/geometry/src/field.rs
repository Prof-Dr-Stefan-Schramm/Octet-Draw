//! What a force field gives the minimiser, and the geometry its terms share: distances, angles, dihedrals and
//! out-of-plane angles with their analytic derivatives. Coordinates are flat: x0 y0 z0 x1 y1 z1 …
pub(crate) trait Energy {
    fn energy(&self, x: &[f64]) -> f64;
    /// Add the gradient to `g` (zeroed by the caller) and return the energy.
    fn gradient(&self, x: &[f64], g: &mut [f64]) -> f64;
}

pub(crate) type V3 = [f64; 3];

#[inline]
pub(crate) fn at(x: &[f64], i: usize) -> V3 {
    [x[3 * i], x[3 * i + 1], x[3 * i + 2]]
}
#[inline]
pub(crate) fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
pub(crate) fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
pub(crate) fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
#[inline]
pub(crate) fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
pub(crate) fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
#[inline]
pub(crate) fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
#[inline]
pub(crate) fn push(g: &mut [f64], i: usize, v: V3) {
    g[3 * i] += v[0];
    g[3 * i + 1] += v[1];
    g[3 * i + 2] += v[2];
}

/// Distance i–j and its derivative with respect to i (the derivative for j is the negative).
#[inline]
pub(crate) fn distance(x: &[f64], i: usize, j: usize) -> (f64, V3) {
    let d = sub(at(x, i), at(x, j));
    let r = norm(d).max(1e-12);
    (r, scale(d, 1.0 / r))
}

/// Cosine of the angle i–j–k and its derivatives for i and k (j takes minus their sum).
#[inline]
pub(crate) fn cos_angle(x: &[f64], i: usize, j: usize, k: usize) -> (f64, V3, V3, f64, f64) {
    let a = sub(at(x, i), at(x, j));
    let b = sub(at(x, k), at(x, j));
    let ra = norm(a).max(1e-12);
    let rb = norm(b).max(1e-12);
    let c = (dot(a, b) / (ra * rb)).clamp(-1.0, 1.0);
    let di = sub(scale(b, 1.0 / (ra * rb)), scale(a, c / (ra * ra)));
    let dk = sub(scale(a, 1.0 / (ra * rb)), scale(b, c / (rb * rb)));
    (c, di, dk, ra, rb)
}

/// Add dE/dcos × dcos/dx for an angle term.
#[inline]
pub(crate) fn push_angle(g: &mut [f64], i: usize, j: usize, k: usize, de_dcos: f64, di: V3, dk: V3) {
    let gi = scale(di, de_dcos);
    let gk = scale(dk, de_dcos);
    push(g, i, gi);
    push(g, k, gk);
    push(g, j, scale(add(gi, gk), -1.0));
}

/// Dihedral angle i–j–k–l in radians (−π..π) and its derivatives for i, j, k, l, or None when degenerate.
pub(crate) fn dihedral(x: &[f64], i: usize, j: usize, k: usize, l: usize) -> (f64, Option<[V3; 4]>) {
    let b1 = sub(at(x, j), at(x, i));
    let b2 = sub(at(x, k), at(x, j));
    let b3 = sub(at(x, l), at(x, k));
    let n1 = cross(b1, b2);
    let n2 = cross(b2, b3);
    let r2 = norm(b2);
    let phi = (r2 * dot(b1, n2)).atan2(dot(n1, n2));
    let (q1, q2) = (dot(n1, n1), dot(n2, n2));
    if q1 < 1e-20 || q2 < 1e-20 || r2 < 1e-10 {
        return (phi, None);
    }
    let gi = scale(n1, -r2 / q1);
    let gl = scale(n2, r2 / q2);
    let p = dot(b1, b2) / (r2 * r2);
    let q = dot(b3, b2) / (r2 * r2);
    let gj = add(scale(gi, -p - 1.0), scale(gl, q));
    let gk = add(scale(gl, -q - 1.0), scale(gi, p));
    (phi, Some([gi, gj, gk, gl]))
}

/// Sine of the angle between j→l and the plane i–j–k (the cosine of the angle with the plane normal), and its
/// derivatives for i, j, k, l, or None when the plane is degenerate.
pub(crate) fn out_of_plane(x: &[f64], i: usize, j: usize, k: usize, l: usize) -> (f64, Option<[V3; 4]>) {
    let a = sub(at(x, i), at(x, j));
    let b = sub(at(x, k), at(x, j));
    let c = sub(at(x, l), at(x, j));
    let m = cross(a, b);
    let rm = norm(m);
    let rc = norm(c);
    if rm < 1e-12 || rc < 1e-12 {
        return (0.0, None);
    }
    let ch = scale(c, 1.0 / rc);
    let s = (dot(m, ch) / rm).clamp(-1.0, 1.0);
    let ab = dot(a, b);
    let dc = scale(sub(scale(m, 1.0 / rm), scale(ch, s)), 1.0 / rc);
    let da = sub(scale(cross(b, ch), 1.0 / rm), scale(sub(scale(a, dot(b, b)), scale(b, ab)), s / (rm * rm)));
    let db = sub(scale(cross(ch, a), 1.0 / rm), scale(sub(scale(b, dot(a, a)), scale(a, ab)), s / (rm * rm)));
    let dj = scale(add(add(da, db), dc), -1.0);
    (s, Some([da, dj, db, dc]))
}

/// Pairs not separated by one or two bonds (1–4 and further), with a flag for 1–4 pairs.
pub(crate) fn nonbonded_pairs(nbrs: &[Vec<(usize, usize)>]) -> Vec<(usize, usize, bool)> {
    let n = nbrs.len();
    let mut pairs = Vec::new();
    let mut separation = vec![u8::MAX; n];
    for i in 0..n {
        // Topological distance up to 3 from i.
        let mut touched = vec![i];
        separation[i] = 0;
        let mut frontier = vec![i];
        for depth in 1..=3u8 {
            let mut next = Vec::new();
            for &v in &frontier {
                for &(w, _) in &nbrs[v] {
                    if separation[w] == u8::MAX {
                        separation[w] = depth;
                        touched.push(w);
                        next.push(w);
                    }
                }
            }
            frontier = next;
        }
        for j in i + 1..n {
            match separation[j] {
                1 | 2 => {}
                3 => pairs.push((i, j, true)),
                _ => pairs.push((i, j, false)),
            }
        }
        for &t in &touched {
            separation[t] = u8::MAX;
        }
    }
    pairs
}
