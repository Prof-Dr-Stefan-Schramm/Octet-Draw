# Picture to structure: the model files

Decision 0023. Octet reads pictures with two published models, exported once from PyTorch to ONNX and packed into
one `.octmodel` file each. These steps make both files from the published weights, byte for byte. Their SHA-256
values go into `src-tauri/src/recognise.rs` (`MODELS`), and the bench's numbers are for exactly these files.

| File | From | Licence |
| --- | --- | --- |
| `molscribe.octmodel` (131 MB) | [MolScribe](https://github.com/thomas0809/MolScribe), `swin_base_char_aux_1m680k.pth` from [huggingface.co/yujieq/MolScribe](https://huggingface.co/yujieq/MolScribe) | MIT |
| `glyph.octmodel` (137 MB) | [OCSRGlyph](https://github.com/EdisonScientific/glyph), `model.pth` from [huggingface.co/EdisonScientific/OCSRGlyph](https://huggingface.co/EdisonScientific/OCSRGlyph) | Apache-2.0 |
| `text.octmodel` (7.8 MB) | PaddleOCR PP-OCRv5 English line reader, `languages/english/rec.onnx` and `dict.txt` from [huggingface.co/monkt/paddleocr-onnx](https://huggingface.co/monkt/paddleocr-onnx), unchanged | Apache-2.0 |

## What each export holds

- **MolScribe**: `encoder.onnx` (picture to the decoder's cross-attention keys and values, all six layers at
  once), `step.onnx` (one token in, the next token's log-probabilities, the decoder state and the grown key/value
  cache out) and `edges.onnx` (the decoder states of the atoms to the bond class of every pair).
- **OCSRGlyph**: `encoder.onnx` and `step.onnx` the same way (it has no bond predictor).

The step graphs are written out by hand from each model's own layers (`export-*.py`), because a decoder step with a
cache cannot be traced from either model's own decoding loop. Each export script then decodes the example pictures
both ways and prints `"same": true` when ONNX Runtime gives exactly the original model's tokens (and, for MolScribe,
its atom positions and bonds). Do not pack a model that prints `false`.

`quantize.py` stores the weights of every MatMul and Gemm in 8 bits (ONNX Runtime's dynamic quantisation): a quarter
of the size, and faster. On the bench it changes an atom's position by one step of 64 at most and no structure.

## Steps

Two Python environments, as the two models pin different `timm` versions. With [uv](https://docs.astral.sh/uv/):

```bash
git clone https://github.com/thomas0809/MolScribe src/MolScribe
git clone https://github.com/EdisonScientific/glyph src/glyph
# On Windows, git may have changed the line endings of glyph's vocab file, whose SHA-256 glyph checks:
sed -i 's/\r$//' src/glyph/glyph/ocsr/vocab/vocab_chars.json

uv venv -p 3.10 venv-ms
VIRTUAL_ENV=venv-ms uv pip install --extra-index-url https://download.pytorch.org/whl/cpu "torch==2.1.2+cpu" "torchvision==0.16.2+cpu" \
  "numpy<2" "opencv-python-headless==4.8.1.78" "albumentations==1.1.0" "timm==0.4.12" "SmilesPE==0.0.3" "OpenNMT-py==2.2.0" \
  rdkit pandas matplotlib scipy onnx==1.16.2 onnxruntime==1.18.1
uv venv -p 3.12 venv-gl
VIRTUAL_ENV=venv-gl uv pip install --extra-index-url https://download.pytorch.org/whl/cpu "torch==2.9.1+cpu" "timm>=1.0" rdkit SmilesPE \
  pillow pyyaml typer tqdm huggingface-hub onnx onnxruntime onnxscript numpy
VIRTUAL_ENV=venv-gl uv pip install --no-deps -e src/glyph

curl -L -o models/swin_base_char_aux_1m680k.pth https://huggingface.co/yujieq/MolScribe/resolve/main/swin_base_char_aux_1m680k.pth
curl -L -o models/model.pth https://huggingface.co/EdisonScientific/OCSRGlyph/resolve/main/model.pth

venv-ms/Scripts/python tools/recognise/export-molscribe.py out/molscribe
venv-ms/Scripts/python tools/recognise/verify-molscribe.py out/molscribe src/MolScribe/assets/*.png
venv-gl/Scripts/python tools/recognise/export-glyph.py out/glyph src/glyph/examples/imatinib.png src/glyph/examples/cholesterol_ester.png
venv-gl/Scripts/python tools/recognise/quantize.py out/molscribe out/molscribe-q8
venv-gl/Scripts/python tools/recognise/quantize.py out/glyph out/glyph-q8

node tools/recognise/pack.ts molscribe out/molscribe-q8 ~/octet-research/models/molscribe.octmodel
node tools/recognise/pack.ts glyph out/glyph-q8 ~/octet-research/models/glyph.octmodel

# The text model: rec.onnx as it is, and vocab.json = {"keys": ["", ...the 436 lines of dict.txt, " "]} (CTC's blank
# first, the space last).
node tools/recognise/pack.ts text out/text ~/octet-research/models/text.octmodel
```

`pack.ts` prints each file's size and SHA-256. `MOLSCRIBE_SRC`, `MOLSCRIBE_WEIGHTS` and `GLYPH_WEIGHTS` point the
scripts elsewhere.

## Test pictures

- `make-drawn.py` draws `tests/recognise/drawn/` with RDKit: known SMILES in ACS 1996 style at screen sizes, with
  written labels, in a heavy style, small, and as schemes with arrows and captions.
- `record.ts` records what both models read in a few pictures (`tests/recognise/readings.json`), so
  `src/recognise.check.ts` tests everything after the models on every computer.
- `scripts/recognise-bench.ts` runs both models on every test set and compares each answer with the expected
  structure by standard InChI. `--check` fails when a number falls below `tests/recognise/baseline.json`.
