# 0017: Octet's own template sets (CD-32)

Status: built 27 October 2026 for Sam to review. Roadmap 1.1.0 item 1.

## ChemDraw 26.1

ChemDraw 26.1 ships 29 template sets (30 files with the blank New Templates sheet; the bundle's list is in
`~/octet-research/notes/chemdraw26-inventory.md` 3.9). Octet draws its own; nothing comes from ChemDraw's art or data.

| ChemDraw set | Octet |
| --- | --- |
| Amino Acids | Amino acids |
| Aromatics | Aromatics |
| Bicyclics | Bicyclics |
| Conformers | Conformers |
| Cp Rings | Cp and arene rings |
| Ph Rings | Cp and arene rings (η6 arenes), Aromatics |
| Cycloalkanes | Cycloalkanes |
| Functional Groups | Functional groups |
| Hexoses | Hexoses |
| Metallocenes | Metallocenes |
| Stereocenters | Stereocentres |
| Clipware part 1 and part 2 (glassware) | Lab, in part |
| DNA Templates, RNA Templates | Nucleobases only |
| Polyhedra | Cubane only |
| Amino Acid Side Chains, Polypeptides, Supramolecules, Nanotubes, Shapes | none (Octet's Shape tool draws shapes) |
| Advanced BioDraw, Anatomy, Animals, Bio Instruments, BioArt, Bugs, Microorganisms, Organelles | none |

Octet's own sets ChemDraw has no set for: Sugars, Nucleobases, Heterocycles, Ligands and Paddlewheels.

What each ChemDraw set holds, and how it draws a Newman projection or a Cp ring, needs ChemDraw running
(`~/octet-research/notes/chemdraw-checks-pending.md` item 22).

## Decision

The library has 292 templates in 16 sets: Amino acids 20, Sugars 8, Hexoses 16, Nucleobases 5, Stereocentres 18,
Conformers 12, Cycloalkanes 17, Aromatics 25, Bicyclics 24, Heterocycles 29, Functional groups 44, Ligands 33, Cp and
arene rings 6, Metallocenes 11, Paddlewheels 8, Lab 16. Polycyclics is split into Aromatics and Bicyclics.
`tools/library/build.mjs` builds them all. A 17th set, Photochemistry, was added by decision 0023.

- Structures with a name are drawn from it (OPSIN, then Indigo's layout), as before. Where Indigo's layout runs a bond
  through a label (a porphyrin's NH), Octet's Clean Up lays it out again: porphyrin, H2TPP, phthalocyanine and XPhos.
- Conformers, hexoses, Fischer projections, paddlewheels and cubane are drawn in perspective: each atom keeps its depth
  (decision 0012), worked out from simple geometry (`tools/library/perspective.mjs`). Octet reads their
  stereochemistry from the atoms' places (decision 0013), so a chair or Haworth projection has R and S, names right
  and is the right isomer. Where a group goes up or down, the build tries each way and keeps the one whose InChI is
  the named compound's. A chair has the Ring tool's textbook shape with real depths; a Haworth ring is a real ring seen
  from 35° above, drawn 1.3 times as wide, its substituents straight up and down. A sugar's rings are drawn larger
  than one bond length (Haworth 1.45, chair 1.3), as textbooks draw them, so the labels fit inside and round them.
- No label overlaps another, and no bond runs through a label but its own atom's, as the app draws the template at
  the default style with Arial's metrics (`tools/library/clashes.mjs`). The build places substituents by that test:
  each takes the length (0.65 to 2.1 times its own) and, on an upright bond, the reading (OH or HO) that clears its
  label, one at a time and then two at a time, and never one that changes the compound. A paddlewheel takes the
  smallest size and nearest view in which every label is clear. Decamethylferrocene's rings sit 0.45 bond lengths
  further from the iron, so their methyls clear each other.
- A Fischer projection is drawn plain, as chemists draw it: its across groups lie a bond length nearer the viewer, so
  the stereochemistry is in the drawing. No wedges are needed.
- A bond seen end on (its atoms within a tenth of its length on the page) is a Newman projection: the bond is not
  drawn, and the atom behind (when it has no label) is a circle 0.4 bond lengths across that its other bonds start
  from. This also draws any structure turned in 3D to look down a bond. ChemDraw draws such a bond as nothing and the
  two atoms on top of each other.
- Cp and arene rings and metallocenes are drawn with Octet's π ligands (the j and Shift+J keys), on a metal or on M.
  Carbonyls are M=C=O, as common.ts draws them.
- Functional groups have R as their first atom: a click on an atom puts the group there.
- The Lab group adds a Schlenk flask, vial, syringe, chromatography column, heating mantle, hotplate stirrer and
  stirrer bar in its own line style, and a TLC plate that is Octet's own TLC object.
- Ligands are named as common.ts keys them (bpy, tpy, PyBOX), so the library's search shows the library's own
  drawing for an abbreviation. A template kept in the Ring strip under its old name (bipy, terpy, pybox) still works.
- A template placed on the page keeps its depth (mirrored, its depth changes sign, so it turns over in 3D).
- Clean Up leaves a structure with depth as drawn, as it never marks one messy. It also leaves a π ligand's ring as
  drawn: before, the ring (not bonded to its multi-centre point) was redrawn as a flat regular polygon.

## Not done

- Bridged rings (norbornane, adamantane, bicyclo[2.2.2]octane, DABCO) stay flat, as Indigo lays them out. Drawn in 3D
  they look as chemists draw them, but Octet's CIP labeller and Indigo's InChI then read their bridgeheads as
  stereocentres (r and s on norbornane), and Structure to Name gives them no name. The flat drawings and the crowded
  biaryl phosphines (BINAP, Xantphos, XPhos, SPhos) are marked for Clean Up as drawn.
- Not named by Structure to Name: functional groups (R), the M templates, Cp2TiCl2, Cp2ZrCl2, (benzene)Cr(CO)3,
  CpMn(CO)3, bis(benzene)chromium, Mo2(OAc)4, IMes and IPr (carbenes), cis- and trans-decalin, cubane.
- ChemDraw writes a Newman projection's depth to CDXML as `xyz`; ChemDraw draws it without the circle.

## Checks

`src/templates.check.ts`: every built-in template parses back from Octet's file text, has a name of its own, has
clear labels (all 276 with atoms, none let off), has the CIP labels and InChI of its reference compound (74 with
stereo), gets a name from Structure to Name that reads back to its structure (213 named), and survives Clean Up (60
kept as drawn, 216 kept whole). `src/lab.check.ts` covers the
Lab group, and `src/perspective.check.ts` the Newman circle.
