//! Rings: a minimum cycle basis from Horton's candidate cycles, symmetrised as RDKit does (a ring of the same size
//! that could replace a basis ring is kept too, as in cubane or bicyclo[2.2.2]octane).
use crate::chem::Mol;

struct Cycle {
    atoms: Vec<usize>,
    edges: Vec<u64>,
}

fn bit(set: &mut [u64], i: usize) {
    set[i / 64] ^= 1 << (i % 64);
}

/// Bonds that lie on a cycle (not bridges).
fn ring_bonds(mol: &Mol) -> Vec<bool> {
    let n = mol.atoms.len();
    let mut order = vec![usize::MAX; n];
    let mut low = vec![0; n];
    let mut is_ring = vec![true; mol.bonds.len()];
    let mut counter = 0;
    for root in 0..n {
        if order[root] != usize::MAX {
            continue;
        }
        // Iterative DFS: (atom, parent bond, next neighbour index).
        let mut stack = vec![(root, usize::MAX, 0usize)];
        order[root] = counter;
        low[root] = counter;
        counter += 1;
        while let Some(&mut (v, parent, ref mut next)) = stack.last_mut() {
            if *next < mol.nbrs[v].len() {
                let (w, b) = mol.nbrs[v][*next];
                *next += 1;
                if b == parent {
                    continue;
                }
                if order[w] == usize::MAX {
                    order[w] = counter;
                    low[w] = counter;
                    counter += 1;
                    stack.push((w, b, 0));
                } else {
                    low[v] = low[v].min(order[w]);
                }
            } else {
                stack.pop();
                if let Some(&(u, _, _)) = stack.last() {
                    low[u] = low[u].min(low[v]);
                    if low[v] > order[u] {
                        is_ring[parent] = false;
                    }
                }
            }
        }
    }
    is_ring
}

pub(crate) fn sssr(mol: &Mol) -> Vec<Vec<usize>> {
    let n = mol.atoms.len();
    let is_ring = ring_bonds(mol);
    let ring_edges: Vec<usize> = (0..mol.bonds.len()).filter(|&b| is_ring[b]).collect();
    if ring_edges.is_empty() {
        return Vec::new();
    }
    let words = mol.bonds.len().div_ceil(64);
    let ring_atom: Vec<bool> = (0..n).map(|i| mol.nbrs[i].iter().any(|&(_, b)| is_ring[b])).collect();
    // Components of the ring graph give the number of independent rings.
    let mut component = vec![usize::MAX; n];
    let mut components = 0;
    for start in 0..n {
        if !ring_atom[start] || component[start] != usize::MAX {
            continue;
        }
        let mut pending = vec![start];
        component[start] = components;
        while let Some(v) = pending.pop() {
            for &(w, b) in &mol.nbrs[v] {
                if is_ring[b] && component[w] == usize::MAX {
                    component[w] = components;
                    pending.push(w);
                }
            }
        }
        components += 1;
    }
    let atoms = ring_atom.iter().filter(|&&r| r).count();
    let needed = ring_edges.len() + components - atoms;

    // Horton candidates: shortest path r..x, edge x-y, shortest path y..r, the paths meeting only at r.
    let mut candidates: Vec<Cycle> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for r in 0..n {
        if !ring_atom[r] {
            continue;
        }
        let mut dist = vec![usize::MAX; n];
        let mut parent = vec![(usize::MAX, usize::MAX); n];
        dist[r] = 0;
        let mut queue = std::collections::VecDeque::from([r]);
        while let Some(v) = queue.pop_front() {
            for &(w, b) in &mol.nbrs[v] {
                if is_ring[b] && dist[w] == usize::MAX {
                    dist[w] = dist[v] + 1;
                    parent[w] = (v, b);
                    queue.push_back(w);
                }
            }
        }
        let path = |mut v: usize| {
            let mut atoms = vec![v];
            let mut bonds = Vec::new();
            while v != r {
                let (p, b) = parent[v];
                bonds.push(b);
                atoms.push(p);
                v = p;
            }
            (atoms, bonds)
        };
        for &e in &ring_edges {
            let (x, y) = (mol.bonds[e].a, mol.bonds[e].b);
            if dist[x] == usize::MAX || dist[y] == usize::MAX || parent[x].1 == e || parent[y].1 == e {
                continue;
            }
            let (px, bx) = path(x);
            let (py, by) = path(y);
            // Only r in common.
            if px.iter().filter(|a| py.contains(a)).count() != 1 {
                continue;
            }
            let mut edges = vec![0u64; words];
            for &b in bx.iter().chain(&by) {
                bit(&mut edges, b);
            }
            bit(&mut edges, e);
            if !seen.insert(edges.clone()) {
                continue;
            }
            // Ring order: r .. x (reversed px), then y .. r without r.
            let mut atoms: Vec<usize> = px.iter().rev().copied().collect();
            atoms.extend(py.iter().take(py.len() - 1));
            candidates.push(Cycle { atoms, edges });
        }
    }
    candidates.sort_by(|a, b| a.atoms.len().cmp(&b.atoms.len()).then_with(|| {
        let mut x = a.atoms.clone();
        let mut y = b.atoms.clone();
        x.sort_unstable();
        y.sort_unstable();
        x.cmp(&y)
    }));

    // Gaussian elimination over GF(2); each pivot row remembers which basis rings it is made of.
    let mut pivots: Vec<(usize, Vec<u64>, Vec<u64>)> = Vec::new();
    let mut basis: Vec<usize> = Vec::new();
    let reduce = |pivots: &[(usize, Vec<u64>, Vec<u64>)], edges: &[u64], basis_words: usize| {
        let mut row = edges.to_vec();
        let mut mix = vec![0u64; basis_words];
        for (p, pr, pm) in pivots {
            if row[p / 64] >> (p % 64) & 1 == 1 {
                for (a, b) in row.iter_mut().zip(pr) {
                    *a ^= b;
                }
                for (a, b) in mix.iter_mut().zip(pm) {
                    *a ^= b;
                }
            }
        }
        (row, mix)
    };
    let basis_words = needed.div_ceil(64).max(1);
    let mut extras = Vec::new();
    for (c, cycle) in candidates.iter().enumerate() {
        let (row, mix) = reduce(&pivots, &cycle.edges, basis_words);
        if let Some(p) = (0..mol.bonds.len()).find(|&b| row[b / 64] >> (b % 64) & 1 == 1) {
            if basis.len() < needed {
                let mut m = mix;
                bit(&mut m, basis.len());
                basis.push(c);
                pivots.push((p, row, m));
            }
        } else if basis.len() >= 1 {
            // Dependent: keep it when a basis ring of its own size takes part in it.
            let size = cycle.atoms.len();
            let replaces = (0..basis.len())
                .any(|k| mix[k / 64] >> (k % 64) & 1 == 1 && candidates[basis[k]].atoms.len() == size);
            if replaces && extras.len() < 4 * needed {
                extras.push(c);
            }
        }
        if basis.len() >= needed && cycle.atoms.len() > candidates[*basis.last().unwrap()].atoms.len() {
            break;
        }
    }
    basis.iter().chain(&extras).map(|&c| candidates[c].atoms.clone()).collect()
}
