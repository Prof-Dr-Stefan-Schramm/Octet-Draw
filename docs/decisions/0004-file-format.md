# 0004: The .oct file is CDXML with Octet's drawing inside

Status: decided by Sam, 16 October 2026. Changes brief section 7 ("Native format: Octet's own file
(JSON-based, versioned, human-readable)").

## Decision

- Octet saves `.oct` files by default.
- A `.oct` file is a CDXML document. ChemDraw's own objects describe the drawing, so ChemDraw can read
  it. Octet's full drawing (its versioned JSON) is embedded in the same file, so Octet loses nothing.
- A setting makes `.cdxml` the default save format instead.
- Converting is one step either way: Save As with the other extension. The contents are the same.
- Octet still opens the old `.octet` JSON files.

## Why

Sam wants an Octet file that ChemDraw users can open. ChemDraw only opens `.cdx` and `.cdxml`, so the
file has to be CDXML inside.

## Risks to check before building

- ChemDraw may refuse a file named `.oct`. If so, the user renames it to `.cdxml`, or saves with the
  ChemDraw setting. (ChemDraw 25.5 for Windows opens it as an empty document: see below.)
- ChemDraw must keep the embedded Octet part when it saves the file. Test this in ChemDraw 22.2. (ChemDraw 25.5 for
  Windows drops it: see below.)
- If ChemDraw edits the drawing, the embedded Octet part is out of date. Octet stores a hash of the
  CDXML it wrote; when the hash no longer matches, Octet reads the CDXML and ignores the embedded part.
- `.oct` is also the extension of GNU Octave's compiled function files. A clash in the Finder is
  unlikely, since few chemists have Octave installed.

## How it is built (16 October 2026)

- `src/oct.ts` writes the CDXML from `src/cdxml.ts`, then a comment after it:
  `<!--Octet 1 <hash> <base64 of Octet's JSON>-->`. The hash is of the CDXML before the comment.
- On open, a matching hash gives Octet's JSON back exactly. A changed or missing hash, or a damaged copy, and
  Octet reads the CDXML, and says what it could not hold.
- Save writes `.oct` by default and keeps `.cdxml` if the user picks it. Saving an old `.octet` file asks for a
  new `.oct` name.
- Tested in ChemDraw since: see below.

## Tested in ChemDraw 25.5 for Windows (issue 19, 4 November 2026)

Prof. Dr. Stefan Schramm tested both open risks in ChemDraw Professional 25.5.0.5789 for Windows, through its COM
interface, with an L-proline drawn in Octet 1.1.0. Both failed.

- ChemDraw does not open a `.oct`, and says nothing. The same bytes named `proline-with-comment.cdxml` open with 8
  atoms and 8 bonds. Named `proline.oct`, they open as an empty document with no name. Share a `.cdxml` with ChemDraw
  users, or set Settings > Import and export > Save new drawings as to ChemDraw XML (.cdxml).
- A ChemDraw save drops Octet's part: the file it writes has neither the `<!--Octet 1 …-->` comment nor the
  `Octet="…"` attributes. Nothing is damaged. Octet finds no comment, or a hash that no longer matches, and reads the
  CDXML.
- The rest passed. ChemDraw opens Octet's CDXML with no chemical warnings, the same atoms, bonds, wedge and label runs,
  `NeedsClean` on the same three atoms ChemDraw marks, and a render that matches Octet's.

What changed in 1.1.1:

- When Octet opens a file it wrote (named `.oct`, or with its comment still in it) whose `CreationProgram` names
  ChemDraw and whose comment is gone or out of date, it says once, as it opens the file: "ChemDraw saved this file
  last and did not keep Octet's own extras." (`readOct`'s `resaved` in `src/oct.ts`.) A `.cdxml` that ChemDraw saved
  with no comment left looks like any ChemDraw file, so Octet cannot tell, and says nothing.
- The README says that ChemDraw opens a `.oct` file as an empty document, and to share a `.cdxml`.
- Save As already lists ChemDraw drawing (CDXML) under the file type, and Export lists CDXML (ChemDraw). No new UI.
- Not tested yet: ChemDraw 26.1 for the Mac, and what ChemDraw does with Octet's part of a `.cdx` when it saves.
