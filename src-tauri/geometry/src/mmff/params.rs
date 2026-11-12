//! MMFF94 and MMFF94s parameter tables, read from the text RDKit embeds in `Code/ForceField/MMFF/Params.cpp`
//! (BSD-3-Clause). The files in `data/` are those strings unchanged; the MMFF tables keep their notice
//! "Copyright (c) Merck and Co., Inc., 1994, 1995, 1996 (… 1999 for MMFF94s), All Rights Reserved".
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Prop {
    pub crd: u8,
    pub val: u8,
    pub pilp: u8,
    pub mltb: u8,
    pub arom: u8,
    pub lin: u8,
    pub sbmb: u8,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Vdw {
    pub alpha: f64,
    pub n: f64,
    pub a: f64,
    pub g: f64,
    /// b'D' donor, b'A' acceptor, b'-' neither.
    pub da: u8,
}

pub(crate) struct Tables {
    pub prop: Vec<Option<Prop>>,
    /// Step-down levels 2 to 5 from MMFFDEF (level 1 is the type itself; level 5 is usually the wild card 0).
    pub def: Vec<Option<[u8; 4]>>,
    pub pbci: Vec<Option<(f64, f64)>>,
    pub chg: HashMap<(u8, u8, u8), f64>,
    pub bond: HashMap<(u8, u8, u8), (f64, f64)>,
    pub bndk: HashMap<(u8, u8), (f64, f64)>,
    pub hl: HashMap<(u8, u8), (f64, f64, f64)>,
    pub covrad: HashMap<u8, (f64, f64)>,
    pub ang: HashMap<(u8, u8, u8, u8), (f64, f64)>,
    pub stbn: HashMap<(u8, u8, u8, u8), (f64, f64)>,
    pub dfsb: HashMap<(u8, u8, u8), (f64, f64)>,
    pub oop: [HashMap<(u8, u8, u8, u8), f64>; 2],
    pub tor: [HashMap<(u8, u8, u8, u8, u8), (f64, f64, f64)>; 2],
    pub vdw: Vec<Option<Vdw>>,
    /// power, B, beta, DARAD, DAEPS
    pub vdw_rule: [f64; 5],
}

fn rows(text: &str) -> impl Iterator<Item = Vec<&str>> {
    text.lines()
        .filter(|l| !l.starts_with('*') && !l.starts_with('$') && !l.trim().is_empty())
        .map(|l| l.split_whitespace().collect::<Vec<_>>())
}

fn int(s: &str) -> u8 {
    s.parse::<u32>().unwrap_or(0) as u8
}

fn num(s: &str) -> f64 {
    s.parse::<f64>().unwrap_or(0.0)
}

pub(crate) fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| {
        let mut prop = vec![None; 256];
        for f in rows(include_str!("../data/mmff_prop.txt")) {
            // Columns: type, element (aspec, unused), crd, val, pilp, mltb, arom, lin, sbmb.
            prop[int(f[0]) as usize] = Some(Prop {
                crd: int(f[2]),
                val: int(f[3]),
                pilp: int(f[4]),
                mltb: int(f[5]),
                arom: int(f[6]),
                lin: int(f[7]),
                sbmb: int(f[8]),
            });
        }
        let mut def = vec![None; 256];
        for f in rows(include_str!("../data/mmff_def.txt")) {
            def[int(f[1]) as usize] = Some([int(f[2]), int(f[3]), int(f[4]), int(f[5])]);
        }
        let mut pbci = vec![None; 256];
        for f in rows(include_str!("../data/mmff_pbci.txt")) {
            pbci[int(f[1]) as usize] = Some((num(f[2]), num(f[3])));
        }
        let chg = rows(include_str!("../data/mmff_chg.txt"))
            .map(|f| ((int(f[0]), int(f[1]), int(f[2])), num(f[3])))
            .collect();
        let bond = rows(include_str!("../data/mmff_bond.txt"))
            .map(|f| ((int(f[0]), int(f[1]), int(f[2])), (num(f[3]), num(f[4]))))
            .collect();
        let bndk = rows(include_str!("../data/mmff_bndk.txt"))
            .map(|f| ((int(f[0]), int(f[1])), (num(f[2]), num(f[3]))))
            .collect();
        let hl = rows(include_str!("../data/mmff_hl.txt"))
            .map(|f| ((int(f[0]), int(f[1])), (num(f[2]), num(f[3]), num(f[4]))))
            .collect();
        let covrad = rows(include_str!("../data/mmff_covrad.txt"))
            .map(|f| (int(f[0]), (num(f[1]), num(f[2]))))
            .collect();
        let ang = rows(include_str!("../data/mmff_ang.txt"))
            .map(|f| ((int(f[0]), int(f[1]), int(f[2]), int(f[3])), (num(f[4]), num(f[5]))))
            .collect();
        let stbn = rows(include_str!("../data/mmff_stbn.txt"))
            .map(|f| ((int(f[0]), int(f[1]), int(f[2]), int(f[3])), (num(f[4]), num(f[5]))))
            .collect();
        let dfsb = rows(include_str!("../data/mmff_dfsb.txt"))
            .map(|f| ((int(f[0]), int(f[1]), int(f[2])), (num(f[3]), num(f[4]))))
            .collect();
        let oop_of = |text: &str| {
            rows(text).map(|f| ((int(f[0]), int(f[1]), int(f[2]), int(f[3])), num(f[4]))).collect()
        };
        let tor_of = |text: &str| {
            rows(text)
                .map(|f| ((int(f[0]), int(f[1]), int(f[2]), int(f[3]), int(f[4])), (num(f[5]), num(f[6]), num(f[7]))))
                .collect()
        };
        let mut vdw = vec![None; 256];
        let mut vdw_rule = [0.25, 0.2, 12.0, 0.8, 0.5];
        for (k, f) in rows(include_str!("../data/mmff_vdw.txt")).enumerate() {
            if k == 0 {
                vdw_rule = [num(f[0]), num(f[1]), num(f[2]), num(f[3]), num(f[4])];
                continue;
            }
            vdw[int(f[0]) as usize] =
                Some(Vdw { alpha: num(f[1]), n: num(f[2]), a: num(f[3]), g: num(f[4]), da: f[5].as_bytes()[0] });
        }
        Tables {
            prop,
            def,
            pbci,
            chg,
            bond,
            bndk,
            hl,
            covrad,
            ang,
            stbn,
            dfsb,
            oop: [oop_of(include_str!("../data/mmff_oop.txt")), oop_of(include_str!("../data/mmff94s_oop.txt"))],
            tor: [tor_of(include_str!("../data/mmff_tor.txt")), tor_of(include_str!("../data/mmff94s_tor.txt"))],
            vdw,
            vdw_rule,
        }
    })
}
