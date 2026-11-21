"""Developer tool: rebuild backend/stroke_digits.json.

The digit templates are the upright stick-font digits 0-9 as plotted on the
Rhythm Square sheet C-2.1 (proposed-contour labels 991-998 and one "980").
Each exemplar below was read by eye from the rendered sheet; the tool only
copies the stroke shape of each character into the template file.

Usage:  .venv/bin/python backend/tools/build_stroke_digits.py source-pdf/rhythm-square-zba.pdf
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import pdfgeom  # noqa: E402
import strokefont  # noqa: E402

# (label centre in sheet points, text read from the sheet)
EXEMPLARS = [
    ((1205, 506), "998"), ((1303, 507), "997"), ((1332, 505), "996"), ((1346, 506), "995"),
    ((1360, 506), "994"), ((1375, 507), "993"), ((1389, 507), "992"), ((1423, 523), "991"),
    ((1168, 743), "980"),
]
LABEL_STYLE = "rgb(0,0,0)/w0.48"


def main(pdf_path: str) -> None:
    doc = pdfgeom.open_document(pdf_path)
    paths = pdfgeom.load_paths(doc[2])
    groups = strokefont.group_labels(strokefont.glyph_candidates(paths, styles=[LABEL_STYLE]))
    digits = {}
    for (cx, cy), text in EXEMPLARS:
        best = min(groups, key=lambda g: np.linalg.norm(np.mean([p.center for p in g], axis=0) - np.array([cx, cy])))
        assert len(best) == len(text), (text, len(best))
        _, _, glyphs = strokefont.normalise_label(best)
        for ch, strokes in zip(text, glyphs):
            digits.setdefault(ch, [np.round(s, 4).tolist() for s in strokes])
    assert sorted(digits) == list("0123456789"), sorted(digits)
    out = os.path.join(os.path.dirname(__file__), "..", "stroke_digits.json")
    with open(out, "w") as f:
        json.dump({
            "about": "Upright stick-font digits (AutoCAD RomanS/Simplex style), unit = glyph height, centred on the glyph box. "
                     "Shapes copied from labels on Rhythm Square sheet C-2.1; see tools/build_stroke_digits.py.",
            "digits": {k: digits[k] for k in sorted(digits)},
        }, f)
    print("wrote", os.path.normpath(out), {k: sum(len(s) for s in v) for k, v in sorted(digits.items())})


if __name__ == "__main__":
    main(sys.argv[1])
