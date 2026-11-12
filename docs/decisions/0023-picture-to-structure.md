# 0023: Picture to structure

Status: built 12 November 2026 by Stefan Schramm's support project, for Sam to review. It changes one line of the
brief: section "Not in version 1" lists AI features ("Leave clean extension points for these. Do not build them").
This is one. It is offered because it is the feature users of every other drawing program now expect, and because it
can be built without giving up anything the brief asks for: it is free, offline after one download, and no picture
leaves the computer.

## What the user does

1. Paste a screenshot of a scheme or figure, or drop a picture file (as today: it becomes a picture object).
2. Structure > **Convert Picture to Structures**, or the same item in the picture's Actions panel and the command
   palette. With no picture selected, the drawing's only picture is used.
3. The first time, a dialog offers to download the three reading models (280 MB, once) or to install them from files
   (a computer without internet, or files from a colleague).
4. Octet finds every structure in the picture and places each one, as atoms and bonds, to the right of the picture in
   the picture's own arrangement, at the document's bond length. The picture stays, so each structure can be checked
   against it. Labels the author wrote (OMe, CO2Et, Boc) stay labels; wedges and charges are kept.
5. Each reaction arrow comes too, where it was (reaction, double-headed, or equilibrium), with its conditions as the
   arrow's own text above and below it ("Br2, FeBr3" over the arrow, "0 °C, 2 h" under it): Octet keeps that text
   with the arrow and sets it as a formula (FeBr₃), as it does for conditions typed by hand.
6. Structures the two models read differently are selected, and the notice says to check them.

## ChemDraw 26.1

ChemDraw has no picture recognition (its release notes for 25.0 to 26.8 list none). ChemDoodle, KingDraw, InDraw,
ChemStitch and Ketcher have it; of the 2026 newcomers, ChemDraft (as a MolScribe plugin) and Ester Studio. The
cross-check is against those, not ChemDraw.

## How it works

| Step | File | What |
| --- | --- | --- |
| Find | `src/recognise-find.ts` | No model. The ink is split into connected pieces; the size of a letter is measured; each structure is a large piece (its bonds) or a group of bond strokes, with the letters near them (its labels). Arrows, rules, frames, branched arrows, captions and compound numbers start no structure. A reaction arrow is a long straight piece with a head at one end (both: double-headed; two half-headed ones side by side: equilibrium); its conditions are the lines of text stacked over and under it. |
| Prepare | `src/recognise-image.ts` | Each structure's crop as each model was trained on it: OpenCV's bilinear resize and grey for MolScribe, Pillow's for OCSRGlyph. Matches the Python preprocessing to one grey level (`src/recognise.check.ts` holds OpenCV's and Pillow's own numbers). |
| Read | `src/recognise-models.ts`, `src/recognise.worker.ts` | Both models, with ONNX Runtime Web as WebAssembly on one thread, in a worker, so the canvas stays smooth. About 2 s per structure for each model on a 2023 laptop. |
| Read conditions | `src/recognise-models.ts` | Each line of conditions read by PaddleOCR's PP-OCRv5 English line reader (Apache-2.0, 7.8 MB), on the same runtime: hv becomes hν, an increment sign Δ. Lines it is unsure of are left out (stray marks on a scan). |
| Build | `src/recognise-build.ts` | MolScribe's atoms and bonds as an Octet structure. Wedges are drawn from the stereocentre. Condensed formulas that Octet's label reader gets wrong (OC2H5, C6H5, COOC2H5, CH3CO) become the abbreviation it reads (OEt, Ph, CO2Et, Ac). |
| Weigh and place | `src/recognise.ts` | See below. |
| Model files | `src-tauri/src/recognise.rs` | Kept in the app's data folder; only the three exact files Octet knows (size and SHA-256), checked again each time they are read. |

### Two models, and which one Octet trusts

- **MolScribe** (Qian et al., *J. Chem. Inf. Model.* 2023; MIT, code and weights) reads atoms with their positions,
  then the bond between each pair, so its structure keeps the picture's layout.
- **OCSRGlyph** (Edison Scientific, 2026; Apache-2.0, code and weights) reads a SMILES string. It reports the best
  accuracy on the USPTO patent benchmark.

Both read every structure. The answer is MolScribe's drawing. OCSRGlyph is a second opinion: when it reads the same
structure (the same standard InChI), the answer is marked sure; when it differs, the structure is selected for the
user to check. This rule comes from the bench (below, 205 structures): the two agree on 56% of the structures and are
then right 98% of the time. Where they differ, MolScribe is right 33 times and OCSRGlyph 10 times. Neither model's own
confidence separates right from wrong well enough to use it (MolScribe above 0.9 is still wrong 4 times in 11).

### Without Python

Both models are published for PyTorch. `tools/recognise` exports each one to ONNX: an encoder that also computes the
decoder's cross-attention keys and values, and one decoder step with a key/value cache, written out by hand from each
model's own layers (neither model's decoding loop can be traced). Each export is checked token for token against the
original model before it is packed. Weights are stored in 8 bits (ONNX Runtime's dynamic quantisation): a quarter of
the size, and on the bench it moves an atom by one step in 64 at most and changes no structure. Each model is one
`.octmodel` file (a JSON header and its ONNX files). `tools/recognise/README.md` makes the files again, byte for
byte, from the published weights. The text model is PaddlePaddle's own PP-OCRv5 English model as converted to ONNX
by monkt/paddleocr-onnx (Apache-2.0), packed unchanged.

### Size, network and security

- The installer grows by ONNX Runtime's WebAssembly file (12 MB, about 4 MB compressed). The models are not in it.
- Octet connects to the network only when the user presses Download, and only to the three fixed addresses in
  `recognise.rs`. **Sam: the files need a home.** The addresses point to a release `models-1` of
  SamChemMan/Octet-Draw, which does not exist yet; until it does, Download fails and Install From Files works.
- A model file is data for ONNX Runtime, never code, and Octet takes only the three files whose SHA-256 it knows.
- The page's rules (CSP) are unchanged. The picture is decoded by an image element, as the page already shows it,
  because the rules forbid fetching a `data:` address.

## The bench

`scripts/recognise-bench.ts` reads every picture of a test set the way the app does (find, then both models) and
compares each answer with the expected structure by standard InChI. `--check` fails when a number falls below
`tests/recognise/baseline.json`. The models are not in the repository, so `npm test` runs `src/recognise.check.ts`
instead, which tests everything except the models themselves on every computer: preparation, finding every
structure in all 113 committed pictures, label reading, building structures from what the models read in seven
recorded pictures (`tests/recognise/readings.json`), weighing, placing and the model file format, and every reaction
arrow (with how many lines of conditions it has) in the eight figures whose arrows are written down in `cases.json`.

| Set | Pictures | Licence | What |
| --- | --- | --- | --- |
| `drawn` | 54 | Octet's | 30 compounds drawn by RDKit in ACS 1996 style at screen size, some heavier, smaller or with labels; 4 schemes with arrows, plus signs, numbers and captions |
| `new` | 30 | CC-BY 3.0 / 4.0 | Recent papers (2025–2026): Beilstein J. Org. Chem., Molecules, Chemical Science. Natural products with many stereocentres, drugs, dyes, chemiluminescent compounds, a Ru complex, a Ge dication; 5 whole figures |
| `old` | 29 | public domain | US patents 1976–1994 (typewriter and hand-drawn, scanned) and Berichte 1891 (Wallach, Brühl); 4 whole pages |
| `own` (local only) | 58 | Stefan's, unpublished | Structures from Stefan's chemiluminescence drawings, drawn by ChemDraw 25.5. Not in the repository |

Each committed set has a `SOURCES.md` with each picture's source and licence.

Results, 12 November 2026 (exact: the standard InChI with stereo; found: pictures where every structure was found and
nothing else):

| Set | Structures | Found | MolScribe | OCSRGlyph | **Octet** |
| --- | ---: | ---: | ---: | ---: | ---: |
| drawn | 62 | 100% | 89% | 87% | **94%** |
| new (2025–2026 papers) | 51 | 100% | 80% | 51% | **84%** |
| old (1891 to 1994, scanned) | 38 | 88% | 13% | 16% | **13%** |
| own (Stefan's ChemDraw drawings, local) | 58 | 98% | 78% | 64% | **78%** |

Reaction arrows, in the 8 figures whose arrows are written down: every arrow found (12), with its direction, and all
17 lines of conditions read exactly as printed (nitration followed / by Sandmeyer / bromination; Kornblum /
oxidation; hν). A branched arrow (one tail, two heads) is not read yet.

Over all 205 structures the two models agree on 115 (56%), and 113 of those are right (98%). Of the 90 where they
differ, MolScribe is right 33 times and OCSRGlyph 10 times. Reading takes 4.5 s per structure on one core (both
models), in the worker. `tests/recognise/baseline.json` holds these numbers less two points (another processor may
round a few values differently).

What it means for a user: a structure from a recent paper or drawn in ChemDraw comes out exactly right four times in
five, and right almost every time Octet says both models agree. Old scanned drawings, typewriter labels and 1891 formulas are mostly
beyond both models; Octet still finds most of those structures and places a first draft to correct.

## Not done

- Branched and curved arrows, plus signs, and conditions beside a steep arrow. Superscripts in conditions (Cr^VI) come
  as plain text. Markush structures with R groups.
  OCSRGlyph's sister model MarkushGlyph reads those, but it is a 2-billion-parameter model, too large for this.
- Pictures inside PDF files. Today the user pastes a screenshot of the page.
- A hand-drawn structure model (DECIMER has one).
- Turning the picture's layout into Octet's clean layout: structures come as drawn; Clean Up tidies them.
