# 0011: The clipboard on Windows and Linux

Status: built on stream/release, 18 October 2026, for plan items REL-3 and CH-1 (approved by Sam). Adds to Sam's
note in CLAUDE.md ("Version 1 mirrors ChemDraw's clipboard: a vector PDF at true size…"), which describes the
Mac: Office for Windows pastes no PDF, so the picture there is a PNG.

## Decision

Copy puts the same things on the clipboard on every system, in ChemDraw's order: a picture, CDX, CDXML, a
molfile, SMILES and Octet's own JSON. No plain text, so Word and ChemDraw paste the picture and the drawing,
not text. Settings > Import and export > Copy switches each one off, except Octet's JSON. Only the names and
the picture change from system to system (`src-tauri/src/clipboard.rs`).

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Picture | PDF (vector, CDXML in it) | EMF (vector, CDXML in a comment) and a bitmap (CF_DIB) | image/png (CDXML in an iTXt chunk) and image/svg+xml |
| CDX | ChemDraw's PerkinElmer, Revvity and CambridgeSoft types | "ChemDraw Interchange Format" | chemical/x-cdx |
| CDXML | com.perkinelmer.cdxml, com.revvity.cdxml and com.cambridgesoft.cdxml | "CDXML" | chemical/x-cdxml |
| Molfile | com.mdli.molfile (length-prefixed lines) | "MDLCT" (length-prefixed lines) | chemical/x-mdl-molfile (text) |
| SMILES | org.opensmiles.smiles (with a NUL) | "SMILES" (with a NUL) | chemical/x-daylight-smiles (text) |
| Octet | io.github.samchemman.octet.json | application/x-octet+json | application/x-octet+json |

- The Windows names are the ones ChemDraw's own clipboard code uses (ChemDraw JS in ChemOffice+, and
  MestReNova reads the same three chemistry names). Research note: `notes/clipboard-blackbox.md`.
- The PNG is at 300 dpi of true size, transparent, with its resolution in it, so Office places it at true
  size. A large drawing gets a lower resolution: at most 16 million pixels and 8,192 on a side. The bitmap is
  the same picture on white, for programs that read no PNG.
- On the Mac, ChemDraw asks macOS for the name of its CDX and CDXML codes ('CDIF', 'CdxM'). ChemDraw 26.1's
  Info.plist gives each code a Revvity and a CambridgeSoft name, and 22.2's a PerkinElmer and a CambridgeSoft
  name. The name macOS gives can be any of them, so Copy writes all three and Paste reads all three.
- Paste reads Octet's JSON, then CDXML, then CDX, then the molfile, then SMILES, then the text the webview
  gives, on every system. With no JSON or CDXML type, the CDXML comes out of the picture (4 November 2026): the
  PDF, Keynote's copy of the PDF it was given (com.apple.iWork.TSPData.*), the EMF, Office's own copy of the
  picture (a zip: "Art::GVML ClipFormat" on Windows, com.microsoft.Art--GVML-ClipFormat on the Mac), the PNG, or a
  PDF, EMF or PNG file copied in Finder or the file manager. A PDF, EMF or PNG with CDXML in it also opens and drops
  as the drawing, and Export puts the CDXML in all three.
- Windows calls the clipboard through `windows-sys`; Linux through GTK (`gtk`), which the window already uses on
  X11 and Wayland. Both crates are in the build through Tauri already.

## Not done

- Not checked on Windows: whether Word's copy keeps the EMF's comment, and whether its zip holds the EMF as Octet
  put it on. Paste tries both.

## Risks to check

- Neither system was run: Windows and Linux code was type-checked on the Mac against `windows-sys` 0.61 and
  `gtk` 0.18, and the formats were checked by `cargo test` (`windows_and_linux_copy_the_same`). Check on a
  Windows and a Linux computer: a copy into Word, PowerPoint, LibreOffice and ChemDraw for Windows; a paste from
  ChemDraw for Windows; a copy and paste between two Octet windows.
- Edit > Cut, Copy and Paste from the menu on Linux did nothing when clicked (the keys worked): GTK's own items
  press the keys only with libxdo, which Octet does not use. Since 27 October 2026 they are Octet's own items there,
  as Close Window is. They take Ctrl+X, C and V, and the page runs them: in a text field on its text through the
  app's clipboard, elsewhere as the drawing's cut, copy and paste. The Reaxys window has no menu bar on Linux, so its
  page keeps those keys. Windows keeps the system's items: muda presses Ctrl+X, C and V there with SendInput, which
  reaches WebView2 as the keys do. `.github/workflows/platforms.yml` tries both on GitHub's Windows and Linux
  machines.
