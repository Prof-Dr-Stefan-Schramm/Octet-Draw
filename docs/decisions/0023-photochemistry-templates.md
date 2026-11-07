# 0023: the Photochemistry template set

Status: built 7 November 2026 for Sam to review. Issue 43.

Octet's 17th template set (decision 0017 lists the first 16), and the first one whose items are notation rather than
structures: the arrows, labels and energy-level diagrams photochemistry and photophysics are written in.

## ChemDraw

Nothing to match. ChemDraw has no photochemistry or energy-level set: the inventory of its 29 template sets in
decision 0017 has none, and the Windows ChemDraw Professional 25.5.0.5789 install checked for this decision ships no
template sets at all — `ChemDraw/ChemDraw Items` holds only `Add-ins`, `BioDrawResources`, `Monomers`, `N2SData` and
`Nicknames`, and the only shipped `.cdx`/`.cdxml` files whose names touch on any of this are `Nicknames/Hva.cdxml`
(an abbreviation) and `Samples/Codon Triplets.cdxml` (genetics). Only file and folder names were read.

So a Jablonski diagram in ChemDraw is drawn by hand, line by line, every time — which is what chemists in the field
actually do, and why this set is worth having. This is one of the places Octet can simply be better rather than equal.

## Decision

16 items in one set, `tools/library/photochemistry.mjs`, built into `src/library.json` by
`tools/library/build.mjs`, drawn from plain geometry like the Lab set. Nothing new was needed in the app: Octet
already had every part, and the gap was that nobody assembles them and nobody finds `style: "wavy"` by looking at a
toolbar.

The conventions are the field's, as IUPAC's glossary of terms used in photochemistry (3rd edition) states them: a
**straight** arrow for a radiative transition, a **wavy** arrow for a non-radiative one, energy up the page, levels
as horizontal lines, the ground state at the bottom, and the triplet to the right of the singlets and below S₁.

- **Two reaction arrows**, hν and Δ, with the label as a *condition on the arrow* (`on: { arrow, side: "above" }`)
  rather than loose text, so it follows the arrow when the arrow is moved, lengthened or turned. These two are the
  pieces that go in nearly every photochemical scheme.
- **Seven vertical transitions** for a state diagram, each on its own: absorption (hν), fluorescence (hν′),
  phosphorescence (hν″), intersystem crossing, internal conversion, vibrational relaxation and energy transfer. The
  three radiative ones are straight, the four others wavy, which the checks hold to by name.
- **Five species**, each one caption with the multiplicity as a left superscript and the excited state starred:
  ¹O₂, ³O₂, ¹X*, ³X* and Sens*. These are captions with `script: "super"` and `"sub"` runs, so they are retyped for
  another molecule in place and carry their own rich text into CDXML and Word.
- **Two Jablonski diagrams.** The plain one is S₀, S₁ and T₁ with absorption, fluorescence, intersystem crossing and
  phosphorescence, labelled, 6.9 by 3.2 bond lengths. The fuller one adds three vibrational sub-levels over each
  state, absorption into the top sub-level of S₁ and relaxation down to its origin, which is what makes the Stokes
  shift visible in a figure; it is labelled S₀, S₁ and T₁ only, since a figure that size is relabelled anyway.
- Every item is **one integral group**, as the Lab set's glassware is: a click picks all of it, Ungroup frees the
  parts, and a label is then edited on its own. A single caption ships without a group — it groups nothing, and
  CDXML drops a group of one object.
- No item sets its own line width, size, colour or font, so each takes the document's and matches the drawing it is
  dropped into.
- A caption's `y` is its baseline, so a label meant to sit level with a line is dropped 0.24 bond lengths (about
  half the cap height of 10 pt text at ACS 1996's bond length). Without this the level labels float above their
  lines.
- **A state's number is a real subscript run**, never the Unicode subscript character. S₀ was written with U+2080
  at first: Arial draws it as a small full-height digit rather than a subscript, and it stays that character all the
  way into CDXML and Word, where nobody can restyle it and a search for `S1` does not find it. S, T and the
  multiplicity are set as runs, the same way ¹O₂ and ³X* are, and the check file holds every label in the set to
  having no Unicode sub- or superscript character in it at all.
- **hν is set upright in Times New Roman**, the whole label and not only the nu. The nu is a real Greek nu, U+03BD,
  and Arial — the document font — draws that character as a plain v, so beside the Latin letter the two are one
  glyph and the notation is lost. Times New Roman draws it Greek and is already one of the fonts Octet offers
  (`docstyle.ts` FONTS), so the drawing asks for nothing new; setting only the nu in a serif would leave a
  sans-serif h beside a serif nu. **This departs from the literature knowingly**: h and ν are physical quantities
  and are normally italicised, but an italic serif nu leans back towards the very v the Greek letter is here to be
  told apart from, so legibility wins. A user who wants it italic can set it, and Octet's own fonts are a document
  style away. The abbreviations beside it — ISC, IC, VR, EnT, Δ — are abbreviations and a symbol, so they stay in
  the document's own upright font.
- Search words carry the field's other names for each thing: `ISC`, `EnT`, `Förster`, `Dexter`, `quenching`,
  `Stokes shift`, `S0 S1 T1`, `hv` for people who cannot type ν, and `1O2`, `3X*`, `Sens*` for the species.

## Not done

- No singlet-oxygen or sensitiser *cycle* (Type I and Type II photosensitisation), which wants the catalytic cycle
  object rather than arrows.
- No potential-energy surfaces, no conical intersections, and no axes: a Jablonski diagram carries no energy scale,
  and a real surface diagram wants curves the pen tool draws better than a template could.
- The excited state is written `X*`, not bracketed `[X]*`. Brackets round a selection belong in a UI action, not in
  a template with a fixed-size bracket.

## Checks

`src/photochemistry.check.ts`: all 16 items place where they are clicked, keep their way up, hold one line width and
one size, keep the radiative/non-radiative straight/wavy rule, and come back whole from CDXML and from a `.oct`
file — run for run, so ¹O₂ and ³X* keep their superscripts and subscripts, which is what did not survive CDXML
before 1.1.1 (issue 31). The two Jablonski diagrams are checked for their shape: S₁ over T₁ over S₀, the triplet to
the right, the ground state running under both columns, the intersystem crossing the only slanted transition and
non-radiative, absorption up and radiative, and at least two radiative transitions pointing down.
