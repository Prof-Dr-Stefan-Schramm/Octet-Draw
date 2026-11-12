# Run: python tools/recognise/make-drawn.py tests/recognise/drawn. Draws the "drawn" test set with RDKit: known SMILES
# in ACS 1996 style, in a heavier style, with written labels (OMe, Ph, Boc, CO2Me), and as small screenshots; then
# schemes of several structures with arrows and text, for finding structures. Writes cases.json beside them.
import json, sys, os, random
from rdkit import Chem
from rdkit.Chem import rdAbbreviations, rdDepictor
from rdkit.Chem import Draw
from rdkit.Chem.Draw import rdMolDraw2D
from PIL import Image, ImageDraw, ImageFont
import io

out = sys.argv[1]; os.makedirs(out, exist_ok=True)
random.seed(7)
MOLS = [
  ("luminol", "Nc1cccc2c1C(=O)NNC2=O"),
  ("D-luciferin", "OC(=O)[C@H]1CSC(=N1)c1nc2ccc(O)cc2s1"),
  ("coelenterazine", "Oc1ccc(Cc2nc3c(Cc4ccccc4)nc(-c4ccc(O)cc4)cn3c2O)cc1"),
  ("lophine", "c1ccc(-c2nc(-c3ccccc3)c(-c3ccccc3)[nH]2)cc1"),
  ("lucigenin", "C[n+]1c2ccccc2c(-c2c3ccccc3[n+](C)c3ccccc23)c2ccccc21"),
  ("TCPO", "O=C(Oc1c(Cl)cc(Cl)cc1Cl)C(=O)Oc1c(Cl)cc(Cl)cc1Cl"),
  ("AMPPD", "COC1(c2cccc(OP(=O)(O)O)c2)OOC12C1CC3CC(C3)C2C1"),
  ("acridinium ester", "C[n+]1c2ccccc2c(C(=O)Oc2ccccc2)c2ccccc21"),
  ("riboflavin", "Cc1cc2nc3c(=O)[nH]c(=O)nc-3n(C[C@H](O)[C@H](O)[C@H](O)CO)c2cc1C"),
  ("fluorescein", "O=C1OC2(c3ccc(O)cc3Oc3cc(O)ccc32)c2ccccc21"),
  ("BODIPY", "Cc1cc(C)n2c1C=C1C(C)=CC(C)=[N+]1[B-]2(F)F"),
  ("umbelliferone", "O=c1ccc2ccc(O)cc2o1"),
  ("caffeine", "Cn1c(=O)c2c(ncn2C)n(C)c1=O"),
  ("(S)-ibuprofen", "CC(C)Cc1ccc([C@H](C)C(=O)O)cc1"),
  ("morphine", "CN1CC[C@]23c4c5ccc(O)c4O[C@H]2[C@@H](O)C=C[C@H]3[C@H]1C5"),
  ("penicillin G", "CC1(C)S[C@@H]2[C@H](NC(=O)Cc3ccccc3)C(=O)N2[C@H]1C(=O)O"),
  ("cholesterol", "CC(C)CCC[C@@H](C)[C@H]1CC[C@H]2[C@@H]3CC=C4C[C@@H](O)CC[C@]4(C)[C@H]3CC[C@]12C"),
  ("cisplatin", "N[Pt](N)(Cl)Cl"),
  ("oseltamivir", "CCC(CC)O[C@@H]1C=C(C(=O)OCC)C[C@@H](N)[C@H]1NC(C)=O"),
  ("nicotine", "CN1CCC[C@H]1c1cccnc1"),
  ("quinine", "COc1ccc2nccc([C@@H](O)[C@@H]3C[C@@H]4CCN3C[C@@H]4C=C)c2c1"),
  ("vanillin", "COc1cc(C=O)ccc1O"),
  ("sildenafil", "CCCc1nn(C)c2c(=O)[nH]c(-c3cc(S(=O)(=O)N4CCN(C)CC4)ccc3OCC)nc12"),
  ("tetraphenylethylene", "c1ccc(C(=C(c2ccccc2)c2ccccc2)c2ccccc2)cc1"),
  ("9,10-diphenylanthracene", "c1ccc(-c2c3ccccc3c(-c3ccccc3)c3ccccc23)cc1"),
  ("glucose", "OC[C@H]1O[C@H](O)[C@H](O)[C@@H](O)[C@@H]1O"),
  ("Boc-Phe-OMe", "COC(=O)[C@H](Cc1ccccc1)NC(=O)OC(C)(C)C"),
  ("methyl 4-methoxycinnamate", "COC(=O)/C=C/c1ccc(OC)cc1"),
  ("triphenylphosphine oxide", "O=P(c1ccccc1)(c1ccccc1)c1ccccc1"),
  ("dimethyl 2-phenylmalonate", "COC(=O)C(C(=O)OC)c1ccccc1"),
]
ABBR = {"Boc-Phe-OMe", "methyl 4-methoxycinnamate", "triphenylphosphine oxide", "dimethyl 2-phenylmalonate"}

def draw(mol, w, h, style, abbreviate=False, scale=2.0):
    m = Chem.Mol(mol); rdDepictor.Compute2DCoords(m)
    if abbreviate:
        m = rdAbbreviations.CondenseMolAbbreviations(m, rdAbbreviations.GetDefaultAbbreviations(), maxCoverage=0.6)
    d = rdMolDraw2D.MolDraw2DCairo(w, h); o = d.drawOptions()
    if style == "acs":
        # ACS 1996 at 72 dpi is a 14.4 px bond; scale 2 is a screenshot at 144 dpi, as a paper looks on a laptop.
        rdMolDraw2D.SetACS1996Mode(o, Chem.Draw.MeanBondLength(m) or 1.5)
        o.scalingFactor *= scale; o.fixedBondLength *= scale; o.fixedFontSize = int(o.fixedFontSize * scale); o.bondLineWidth *= scale
    else:
        o.bondLineWidth = 3; o.minFontSize = 18; o.fixedBondLength = 40
    o.useBWAtomPalette(); o.addStereoAnnotation = False
    rdMolDraw2D.PrepareAndDrawMolecule(d, m); d.FinishDrawing()
    return Image.open(io.BytesIO(d.GetDrawingText())).convert("RGB")

def trim(img, pad=8):
    g = img.convert("L"); box = Image.eval(g, lambda v: 255 if v < 250 else 0).getbbox()
    img = img.crop(box); out = Image.new("RGB", (img.width + 2 * pad, img.height + 2 * pad), "white"); out.paste(img, (pad, pad)); return out

cases = []; kept = {}
for i, (name, smi) in enumerate(MOLS):
    mol = Chem.MolFromSmiles(smi); assert mol, name
    can = Chem.MolToSmiles(mol)
    img = trim(draw(mol, -1, -1, "acs", name in ABBR)); kept[name] = img
    f = f"drawn-{i+1:02d}.png"; img.save(f"{out}/{f}")
    cases.append({"file": f, "kind": "structure", "name": name, "smiles": can, "style": "ACS 1996" + (", labels" if name in ABBR else "")})
    if i % 3 == 0:
        img2 = trim(draw(mol, -1, -1, "heavy")); f2 = f"drawn-{i+1:02d}-heavy.png"; img2.save(f"{out}/{f2}")
        cases.append({"file": f2, "kind": "structure", "name": name, "smiles": can, "style": "heavy lines, large labels"})
    if i % 3 == 1:
        small = trim(draw(mol, -1, -1, "acs", name in ABBR, 1.2))
        f3 = f"drawn-{i+1:02d}-small.png"; small.save(f"{out}/{f3}")
        cases.append({"file": f3, "kind": "structure", "name": name, "smiles": can, "style": "ACS 1996 at 86 dpi: a small screenshot"})

# Schemes: two to four structures in a row, with reaction arrows, plus signs, compound numbers and a caption.
font = ImageFont.load_default(size=20)
def scheme(names, k):
    imgs = [kept[n] for n in names]; gapx = 90
    W = sum(im.width for im in imgs) + gapx * (len(imgs) + 1); H = max(im.height for im in imgs) + 140
    page = Image.new("RGB", (W, H), "white"); dr = ImageDraw.Draw(page); x = gapx
    for j, im in enumerate(imgs):
        y = 40 + (H - 140 - im.height) // 2; page.paste(im, (x, y))
        dr.text((x + im.width // 2 - 6, H - 90), f"{j + 1}", fill="black", font=ImageFont.load_default(size=22))
        x += im.width
        if j < len(imgs) - 1:
            cy = 40 + (H - 140) // 2
            if k % 2: dr.text((x + gapx // 2 - 8, cy - 14), "+", fill="black", font=ImageFont.load_default(size=30))
            else:
                dr.line([(x + 15, cy), (x + gapx - 15, cy)], fill="black", width=2); dr.polygon([(x + gapx - 15, cy), (x + gapx - 27, cy - 6), (x + gapx - 27, cy + 6)], fill="black")
                dr.text((x + 18, cy - 30), "hv", fill="black", font=font)
        x += gapx
    dr.text((gapx, H - 45), f"Scheme {k}. Structures drawn for Octet's tests.", fill="black", font=font)
    f = f"drawn-page-{k:02d}.png"; page.save(f"{out}/{f}")
    arrows = [] if k % 2 else [{"above": ["hν"], "below": []} for _ in names[1:]]
    cases.append({"file": f, "kind": "figure", "name": ", ".join(names), "smiles": [Chem.MolToSmiles(Chem.MolFromSmiles(dict(MOLS)[n])) for n in names], "style": "scheme with arrows, numbers and a caption", "arrows": arrows})
scheme(["luminol", "umbelliferone"], 1)
scheme(["vanillin", "caffeine", "nicotine"], 2)
scheme(["TCPO", "fluorescein", "lophine"], 3)
scheme(["(S)-ibuprofen", "D-luciferin", "acridinium ester", "glucose"], 4)
json.dump(cases, open(f"{out}/cases.json", "w"), indent=1)
print(len(cases), "pictures")
