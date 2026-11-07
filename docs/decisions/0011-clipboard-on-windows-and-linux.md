# 0011: The clipboard on Windows and Linux

Status: built on stream/release, 18 October 2026, for plan items REL-3 and CH-1 (approved by Sam). Adds to Sam's
note in CLAUDE.md ("Version 1 mirrors ChemDraw's clipboard: a vector PDF at true size…"), which describes the
Mac: Office for Windows pastes no PDF, so the picture there is an EMF and a bitmap.

## Decision

Copy puts the same things on the clipboard on every system, in ChemDraw's order: a picture, CDX, a molfile and
SMILES. CDXML goes after CDX as its own type, as ChemDraw JS writes it. Octet's own JSON goes last. No plain
text, so Word and ChemDraw paste the picture and the drawing, not text. Settings > Import and export > Copy
switches each one off, except Octet's JSON. Only the names and the picture change from system to system
(`src-tauri/src/clipboard.rs`).

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Picture | PDF (vector, CDXML in it) | EMF (vector, CDXML in a comment) and a bitmap (CF_DIB) | image/png (CDXML in an iTXt chunk) and image/svg+xml |
| CDX | ChemDraw's PerkinElmer, Revvity and CambridgeSoft types | "ChemDraw Interchange Format" | chemical/x-cdx |
| CDXML | com.perkinelmer.cdxml, com.revvity.cdxml and com.cambridgesoft.cdxml | "CDXML" | chemical/x-cdxml |
| Molfile | com.mdli.molfile (length-prefixed lines) | "MDLCT" (length-prefixed lines) | chemical/x-mdl-molfile (text) |
| SMILES | org.opensmiles.smiles (with a NUL) | "SMILES" (with a NUL) | chemical/x-daylight-smiles (text) |
| Octet | io.github.samchemman.octet.json | application/x-octet+json | application/x-octet+json |

ChemDraw 25.5 for Windows puts no CDXML type on the clipboard. ChemDraw 22.2 for the Mac puts none either: its
CDXML is in the PDF. "CDXML" is ChemDraw JS's name.

- The Windows names for CDX, the molfile and SMILES are ChemDraw's. ChemDraw 25.5 for Windows was checked on 4
  November 2026 (issue 23). MestReNova reads the same three chemistry names.
- On Windows the picture is the EMF and a bitmap (CF_DIB): the same picture on white at the export resolution, for
  programs that read no metafile. On Linux the PNG is at the export resolution of true size, transparent, with its
  resolution in it. A large drawing gets a lower resolution: at most 16 million pixels and 8,192 on a side.
- On the Mac, ChemDraw asks macOS for the name of its CDX and CDXML codes ('CDIF', 'CdxM'). ChemDraw 26.1's
  Info.plist gives each code a Revvity and a CambridgeSoft name, and 22.2's a PerkinElmer and a CambridgeSoft
  name. The name macOS gives can be any of them, so Copy writes all three and Paste reads all three.
- Paste reads Octet's JSON, then CDXML, then CDX, then the molfile, then SMILES, then the text the webview
  gives, on every system. With no JSON or CDXML type, the CDXML comes out of the picture (4 November 2026): the
  PDF, Keynote's copy of the PDF it was given (com.apple.iWork.TSPData.*), the EMF, Office's own copy of the
  picture (a zip: "Art::GVML ClipFormat" on Windows, com.microsoft.Art--GVML-ClipFormat on the Mac), the PNG, or a
  PDF, EMF or PNG file copied in Finder or the file manager. A PDF, EMF or PNG with CDXML in it also opens and drops
  as the drawing, and Export puts the CDXML in all three. The picture's CDXML comes before CDX. A paste from ChemDraw
  for Windows always takes CDX, because its EMF holds no CDXML.
- The clipboard's CDX is the plain interchange form for other programs. It has none of Octet's own objects, such
  as catalytic cycles: a cycle in it is only its arrows (issue 28). Octet's own JSON type is the lossless copy
  from one Octet window to another. Paste reads it first, and Settings cannot switch it off.
- Windows calls the clipboard through `windows-sys`; Linux through GTK (`gtk`), which the window already uses on
  X11 and Wayland. Both crates are in the build through Tauri already.

## The EMF (4 November 2026, release 1.1.1, issue 20)

Prof. Schramm compared Octet 1.1.0's EMF with ChemDraw 25.5's for Windows on the same molecule. Three changes follow.

- Labels and captions are text, as in ChemDraw's EMF: a font record (EMR_EXTCREATEFONTINDIRECTW) and the characters
  (EMR_EXTTEXTOUTW, baseline-aligned), with each character's advance given, so every glyph lands where the PDF has it,
  subscripts and superscripts included. Word and PowerPoint can search them, screen readers and text extraction get
  them, and recolouring atoms in Office later needs them. Letters Octet draws one at a time (the H and O of HO) are one
  string when they abut in the same font.
- Text stays outlines where GDI cannot draw it as usvg did: a face no Windows has, turned or slanted text, a stroke or a
  line under, over or through it, a character outside the Basic Multilingual Plane or a control character, a missing
  glyph, or right-to-left text. The faces: those every Windows 10 and 11 has (Arial, Times New Roman, Courier New,
  Calibri, Segoe UI and the other core fonts), and Helvetica, Liberation, Arimo, Tinos and Cousine written as the
  Windows font with the same widths (Arial, Times New Roman or Courier New). The EPS keeps all text as outlines.
- The metafile's reference device is 96 dpi (20 by 15 in, 1,920 by 1,440 px). A device pixel is exactly 15 logical
  units (1/20 pt each) and every size in the header is a whole number. Bounds records are in device pixels, and the
  drawing is laid down in those logical units whatever the reference is, so the reference costs the geometry no
  precision: it only decides what the bounds are counted in.

  **Amended 7 November 2026 (issue 55), reversing the 720 dpi this decision first recorded.** It has to be 96,
  because Word sizes an enhanced metafile two different ways and only at 96 dpi do the two agree. Measured in Word
  365 16.0.17932 on Windows 11, the same drawing recorded at each reference and pasted:

  | | bounds | `rclFrame` | Word's scale on paste | at 100% scale |
  | --- | --- | --- | --- | --- |
  | with text, 720 dpi | 563 px | 56.21 pt | 13% | **422.25 pt (7.51x)** |
  | with text, 96 dpi | 75 px | 56.21 pt | 98% | 57.00 pt (1.01x) |
  | no text, 720 dpi | 720 px | 72.00 pt | 100% | 72.10 pt (1.00x) |
  | no text, 96 dpi | 96 px | 72.00 pt | 99% | 72.75 pt (1.01x) |

  A metafile that **contains text** is sized from `rclBounds`, read as though the device were 96 dpi: 563 px that way
  is 5.8646 in, which is 422.25 pt, exactly what Word gave it. One with **no text** is sized from the physical
  `rclFrame`, which is right at any reference. That is why 720 dpi looked fine the first time it was tested — the
  test picture's text had been dropped by usvg, and every real drawing has atom labels.

  So at 720 dpi a drawing still arrives looking the right size, because Word compensates with a 13% picture scale.
  What is wrong is the size Word believes it to be. Reset that picture to 100%, which a template, a macro or a
  journal's submission workflow does, and it is 7.51 times too large, which is 720/96. It was never every paste that
  was wrong, only the size Word held and the scale it carried to hide it. At 96 dpi the bounds read at 96 dpi *are*
  the frame, so both of Word's paths agree and there is nothing to get wrong.

  720 was chosen here because some programs draw a metafile into pixels at its reference resolution, and GDI+'s
  `DrawImage` was said to do that at 96 dpi: bonds fat, a hashed wedge's hashes run together. That was recorded under
  Not done below as unchecked, and it has now been checked on a Windows bench. **It does not happen.** Drawing the
  same metafile recorded at 96 and at 720 dpi through `Graphics.DrawImage` at 1x, 2x and 4x gives identical output —
  six hashes still six, a double bond's two lines still two, the same ink to the pixel. 720 bought nothing findable
  and cost the picture its true size. ChemDraw's is about 261 dpi, for the record.
- Every picture's frame fits its ink (Copy and Export, every format alike): a label counts by its glyphs' ink (canvas
  measureText), a stroke by half its width, and the edges are rounded outward to 0.01 pt. Before, labels counted by
  their line boxes and the edges went out to whole points. L-proline went from 58 by 41 pt to 56.21 by 36.55 pt, its ink within 0.01 pt of each edge (ChemDraw:
  within 0.2 pt). Export's margin is added to that, as before; Copy has none. Text still counts by its line box where
  the glyphs cannot be placed exactly: turned or underlined text, and text on the middle baseline (atom numbers, R and
  S), which Chromium's getStartPositionOfChar does not move.

Word keeps the EMF byte for byte (SHA-256 checked on Windows 11 with Word 365): its zip holds the EMF as Octet put
it on, comment and all.

## ChemDraw for Windows (4 November 2026, issue 23)

Prof. Schramm checked a copy from ChemDraw 25.5 for Windows on Windows 11. ChemDraw put 14 formats on the clipboard:
"ChemDraw Interchange Format", "ChemDraw Structure Data", "MDLSK", "MDLCT", "SMILES", "SLNSTRING", CF_ENHMETAFILE,
CF_METAFILEPICT, "Embed Source", "Native", "OwnerLink", "Object Descriptor", "Ole Private Data" and "DataObject". No
"CDXML", no PNG and no bitmap.

- CDX is the only route a ChemDraw paste takes on Windows. It carries the whole drawing: structure, wedges, captions
  and arrows. MDLCT and SMILES are there if the CDX cannot be read. Paste reads none of the other formats, because
  CDX always comes with them and carries more. `chemdraw_for_windows_pastes_its_cdx` in `clipboard.rs` tests this.
- ChemDraw's SMILES for a drawing with an arrow is reaction SMILES, with a side left empty
  (`O=C(O)[C@H]1NCCC1>>`). Octet reads it as the structure and an arrow. Octet's own Copy writes no `>>` for a
  structure with a lone arrow.
- ChemDraw's EMF holds no CDXML. ChemDraw keeps the structure in its OLE formats ("Embed Source", "Native"). So a
  ChemDraw picture copied back out of Word on Windows gives Octet a picture at best, as Octet does not read the OLE
  formats yet. When the clipboard holds something and Paste can use none of it, Octet says "Octet cannot read what is
  on the clipboard." An empty clipboard gives no notice.

## Not done

- Word and the reference device have now been checked on a Windows bench, and GDI+'s DrawImage keeps the hashes
  apart at either resolution: see the amendment above, and issue 55. PowerPoint and LibreOffice are still unchecked,
  and LibreOffice's paste is issue 48.

## Risks to check

- Neither system was run: Windows and Linux code was type-checked on the Mac against `windows-sys` 0.61 and
  `gtk` 0.18, and the formats were checked by `cargo test` (`windows_and_linux_copy_the_same`). Check on a
  Windows and a Linux computer: a copy into Word, PowerPoint, LibreOffice and ChemDraw for Windows; a copy and
  paste between two Octet windows. A paste from ChemDraw 25.5 for Windows was checked on 4 November 2026 (issue
  23): the whole drawing comes across through CDX.
- Not seen yet: what Word for Windows puts on the clipboard when a ChemDraw object is copied out of it, and whether
  ChemDraw for Windows pastes a copy from Octet that has only the CDXML type.
- Edit > Cut, Copy and Paste from the menu on Linux did nothing when clicked (the keys worked): GTK's own items
  press the keys only with libxdo, which Octet does not use. Since 27 October 2026 they are Octet's own items there,
  as Close Window is. They take Ctrl+X, C and V, and the page runs them: in a text field on its text through the
  app's clipboard, elsewhere as the drawing's cut, copy and paste. The Reaxys window has no menu bar on Linux, so its
  page keeps those keys. Windows keeps the system's items: muda presses Ctrl+X, C and V there with SendInput, which
  reaches WebView2 as the keys do. `.github/workflows/platforms.yml` tries both on GitHub's Windows and Linux
  machines.
