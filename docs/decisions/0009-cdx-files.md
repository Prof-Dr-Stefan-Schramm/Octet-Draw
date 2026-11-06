# 0009: Octet reads and writes CDX itself

Status: built on stream/release, 18 October 2026, for plan items CH-3 and REL-17 (approved by Sam). Changes
decision 0001 (Indigo for CDX and CDXML) and brief section 5 ("Import: CDXML, CDX (best effort)"): Octet
reads and writes CDX in full, with its own code.

## Decision

- Octet opens, imports, saves, exports, copies and pastes ChemDraw's binary format, `.cdx`, as well as
  `.cdxml`.
- CDX is the same tree of objects and attributes as CDXML. `src/cdx.ts` turns a CDX file into the tree
  `src/cdxml.ts` reads, and turns the tree `src/cdxml.ts` writes into CDX. One reader and one writer serve
  both formats, so a feature added to one is in the other.
- Indigo is not used for CDX. Indigo reads and writes only the molecules, and loses arrows, text, shapes,
  pictures and styles.
- A `.cdx` file Octet saves holds Octet's drawing (its JSON) in a user property of the document, tag
  0x4F43, first in the document, beside a hash of the rest of the file. As with `.oct` (decision 0004), a
  matching hash gives Octet's drawing back exactly; after another program changes the file, Octet reads the
  CDX as ChemDraw's drawing. Export as CDX and the clipboard's CDX leave the JSON out.
- Copy puts ChemDraw's CDX type on the clipboard (under its PerkinElmer and Revvity names), after the PDF,
  as ChemDraw does. ChemDraw reads it first, so the whole drawing pastes into ChemDraw. Settings > Import and
  export > Copy has a CDX switch.

## Format facts

`src/cdxtags.ts` lists every object and property tag, its CDXML name, how its bytes read and its value
names. It is generated from Octet's research notes (`notes/binary-tag-table.json`, from ChemDraw 22.2's
file-format library and the public CDX spec; `specs-draft/cdx-binary.md`). Facts only; no ChemDraw code.

- The header is "VjCD0100", the byte order (04 03 02 01 little-endian; 01 02 03 04 big-endian, as early Mac
  ChemDraw wrote), 10 reserved bytes, then the document object's tag and id. Indigo leaves the document's
  tag and id as zeros; Octet reads both.
- Text has two copies: each run in its font's legacy charset (0x0700) and in UTF-8 (0x0709). Octet reads
  the UTF-8 copy first. It writes both, as ChemDraw does: the legacy copy in its font's charset, each run cut
  at its first character that charset lacks.
- The font table's charset is the one ChemDraw writes on the same system (issue #18, release 1.1.1): ChemDraw
  25.5 for Windows writes iso-8859-1 (code page 1252), ChemDraw for the Mac x-mac-roman. Octet writes
  iso-8859-1 on Windows and Linux and x-mac-roman on the Mac, in CDXML, CDX and the clipboard's copies of
  both. Until 1.1.0 it wrote x-mac-roman on every system. A run with no font takes its caption or label
  font's charset, then the document's, then Mac Roman, when read and when written.
- ChemDraw writes Greek, arrows and some maths in the Symbol font as Latin characters: "n" in Symbol is ν and
  "D" is Δ (issue #21, release 1.1.1). Octet reads each Symbol run, in CDXML and CDX, as the characters the
  Symbol font draws (Adobe's Symbol encoding, as Unicode publishes it; `src/charset.ts`). A character above
  ASCII maps by its byte in the Symbol font's charset when that is a Windows charset (iso-8859-1 and the other
  Windows code pages). In any other charset (x-mac-roman, Unknown or none) it stays as it is, because ChemDraw
  on the Mac draws it as it is. The run then takes the font of the run before it, else the run after it, else
  its text's font. Octet writes the characters back as Unicode in that font and never writes a Symbol run. A
  byte the Symbol font has no glyph for stays as it is and counts as a lost character.
- Picture data (PNG, PDF, EMF and the other picture properties) is hex in CDXML from ChemDraw on the Mac. A
  ChemDraw 21 file from Windows holds it as base64 with line breaks (issue #22, release 1.1.1). Octet reads hex
  or padded base64, and ignores spaces, tabs and line breaks. It keeps and writes the bytes as uppercase hex,
  because ChemDraw on the Mac refuses a file with base64 picture data. CDX holds the bytes themselves.
- Flags are written with no data, Point3D in 12 bytes, style records in 8. The reader checks every length
  against the bytes left, caps nesting at 64 levels and objects at a million, and leaves out a property
  that does not read as its tag says.

## Checks

- `src/cdx.check.ts`: reading, writing, hostile files, Octet's own `.cdx`.
- ChemDraw's own CDX files (29 templates and 21 stationery pads in its bundle, and Sam's clipboard copy; local
  only) read, write and read back the same tree. Written again, 369,369 of the 383,423 properties in the
  little-endian ones match ChemDraw's bytes. The rest: colours older files wrote in 4 bytes (Octet writes 2,
  as ChemDraw 22 does), the font table's platform field, automatic double-bond positions (CDXML cannot tell
  them from chosen ones) and 21 empty H-dot properties.
- `scripts/cdxml-corpus.ts`: each of Sam's 68 files is written as CDX and read back the same.

## Risks to check

- No ChemDraw has opened a CDX file Octet wrote yet (test T04). Sam: save five drawings as `.cdx` from
  Octet and open them in ChemDraw 26.1.
- Not checked in ChemDraw for Windows: a CDX or CDXML from Octet on Windows with a degree sign or an accented
  letter in a caption. Plain strings with no font (a document's name, a tag's value) are still in Mac Roman,
  or UTF-8 when Mac Roman lacks a character.
- Not checked: what ChemDraw for Windows writes for a Symbol run above ASCII, in CDXML and in a CDX's UTF-8
  copy. If it writes a real µ or ® in a Symbol run with an iso-8859-1 font, Octet reads ∝ or →.
- Not checked: whether ChemDraw for Windows writes base64 with no "=" padding. Octet refuses unpadded base64,
  so such a picture counts as lost.
- ChemDraw keeps unknown properties when it saves, so a `.cdx` that ChemDraw saved still holds Octet's
  JSON. The hash no longer matches, so Octet reads the CDX instead.
  This is true of a saved `.cdx` only. The clipboard's CDX has no JSON (decision 0011).
