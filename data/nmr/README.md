# NMR shift table

`shifts.bin.gz` is Octet's table of ¹H and ¹³C chemical shifts by atom environment. It is built by
`scripts/nmr-table.ts` from the measured spectra in nmrshiftdb2's `nmrshiftdb2withsignals.sd`
(downloaded 16 October 2026 from https://sourceforge.net/projects/nmrshiftdb2/files/data/). Spectra the file marks
as predicted are left out.

Contains information from nmrshiftdb2 (www.nmrshiftdb.org), which is made available here under the
[nmrshiftdb2 Database License](https://nmrshiftdb.nmr.uni-koeln.de/nmrshiftdbhtml/nmrshiftdb2datalicense.txt).
A copy of the licence is in `LICENCE.txt`. This table is a derivative database under that licence, so it is shared
under the same licence. Octet's code is Apache-2.0 (an OSI-approved licence, as section 4.5 requires).

Format: "ONMR", version 2 and the four table sizes, then for ¹³C and then ¹H the code hashes (u32), median shifts
(i16, ppm × 100), standard deviations (u16, ppm × 100) and counts (u16), little-endian, sorted by hash. Then the same
for the solvent tables, ¹³C and ¹H: codes as measured in one of the Spectrum panel's solvents (from the file's Solvent
field), kept where their shifts there differ from those in every solvent. Version 1 files have no solvent tables.

Rebuild: `node scripts/nmr-table.ts <path to nmrshiftdb2withsignals.sd>`. Add `--test` to measure accuracy on one
molecule in ten held out (16 October 2026: ¹³C mean absolute error 2.27 ppm, median 0.90; ¹H 0.25 ppm, median 0.09.
18 October 2026: for ¹³C shifts measured in a known solvent, 2.12 ppm from every solvent and 2.08 with the solvent
table).

8 November 2026: ¹H has a solvent table too (2,151 codes; ¹³C has 11,124). It had none before, because on the held-out
tenth it costs a little accuracy. It is in because chemists expect the solvent to move a ¹H prediction, and a solvent
picker that changes nothing reads as broken. The threshold (`SOLVENT_DIFF` in the build script) is 0.1 ppm, measured
against 0.025, 0.05, 0.2 and 0.3 on the held-out tenth. All cost about the same (MAE 0.236 ppm from every solvent,
0.237 to 0.238 with the table, over 1,701 shifts), so the choice is coverage rather than accuracy: 0.1 moves the most
signals, and every shift it moves it moves by at least 0.1 ppm (40 Hz at 400 MHz), which is visible rather than noise.
On the 65 hydrogens on O, N and S it costs more, 1.186 to 1.230 ppm. The general ¹H and ¹³C tables are unchanged.

What the table reaches is set by nmrshiftdb2's solvent-tagged spectra, not by the threshold. Of 16 common compounds
predicted in CDCl₃ and DMSO-d₆, five move: phenol (OH, 0.61 ppm), ethanol (0.67), acetic acid (COOH, 1.86), aniline
(NH₂, 0.48) and paracetamol (0.96) — the exchangeable protons, as expected. Aspirin, salicylic acid, benzoic acid,
glucose, caffeine and ibuprofen do not: their environments have no solvent-tagged measurements. The Details view
names the solvent each shift came from ("any solvent" when it came from all of them).

5 November 2026: codes start at level 0 (the atom alone, with ^ when it is η-bonded to a metal), so every atom gets
a shift. Atoms η-bonded to a metal (Cp and arene rings) are written one way however the molfile draws them (no
charge, the hydrogens of a ring carbon beside the metal, ~ and ^ bonds), so ferrocene's ten carbons are alike. A
¹H spectrum that gives one atom more different shifts than it has hydrogens leaves that atom out. Held-out tenth:
¹³C 2.29 ppm (36,581 shifts, 22 of them only at level 0), ¹H 0.25 ppm (13,189 shifts, 9 at level 0); the shifts
covered before give the same errors as before, within 0.001 ppm.
