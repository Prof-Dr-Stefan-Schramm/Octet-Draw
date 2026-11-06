# 0022: Formula text in files

Status: built 5 November 2026 for release 1.1.1 (issue #31).

Octet draws some text as a formula: conditions on an arrow, and a catalytic cycle's reagents, products, centre
label and text intermediates (not its step names). `Pd(PPh3)4` shows as Pd(PPh₃)₄, and after L, R, X or Ar a
number is a subscript too (Pd(0)L₂). The subscripts come from the text each time it is drawn
(`formulaRuns` in `src/labels.ts`). The caption holds the plain text, so it stays searchable and editable as typed.

Up to 1.1.0 the CDXML writer wrote that text as one plain run. ChemDraw then showed `Pd(PPh3)4`, so the file and
the page did not match. Pictures were right, because Octet draws them.

## Options

Prof. Stefan Schramm set these out in issue #31:

1. Keep making the subscripts when the text is drawn. Write them to the file as runs, and make the reader turn
   Octet's own runs back into plain text.
2. Store the subscripts in the caption when it is made. The caption text is then no longer plain.
3. Write ChemDraw's formula face (`face="96"`) and let ChemDraw make the subscripts. ChemDraw's rule is not
   `formulaRuns`, so the file could still differ from the page.

## Decision

Option 1.

- The writer (`toCdxml`) writes text that Octet draws as a formula as runs. The runs have no style of their own,
  and each subscript has `face="32"`. The runs come from `formulaTextRuns`, which also draws the canvas, so the
  file shows what the page shows. Text with runs of its own is written as it is.
- When it writes these runs, Octet adds `formula: 1` to the text's own `Octet` data. The reader turns the runs back
  into plain text only when the file is Octet's (`v: 1`), the mark is there, and the runs still equal what
  `formulaTextRuns` gives for the text. If something else changed the runs, they stay.
- When the text read back is not drawn as a formula after all (turned conditions read as free text, a cycle's text
  whose cycle is gone), it keeps the runs, so the subscripts stay.
- ChemDraw's files have no mark, so their runs read as before, including formula-face runs.
- CDX has no place for Octet's own data. ChemDraw reads the runs from a CDX file. Octet's own `.cdx` keeps the
  drawing exactly (decision 0009), so it reads back as plain text too.
- `.oct` files, copy, paste and export use the same writer. Pictures are drawn from the canvas.

## Checks

`src/cdxml.check.ts` covers:

- `Pd(PPh3)4`, `CH2Cl2`, `10 mol%`, `SO4^2-` and `Pd(0)L2` on an arrow are written as the page draws them, and
  read back as typed through CDXML, `.oct` and Octet's `.cdx`.
- A cycle's `ArB(OH)2` does the same in the main round trip.
- A caption with its own runs (SO₄²⁻) reads back unchanged.
- Runs edited in another program stay.
- Turned conditions, which read back as free text, keep their subscripts.
- ChemDraw's runs read unchanged.
- Free text is never a formula.

## Risks

- ChemDraw has not yet opened a file with these runs. Sam: open an `.oct` with `Pd(PPh3)4` over an arrow in
  ChemDraw 26.1 and check the subscripts.
