"""Read numbers that a CAD program plotted as stroked lettering.

Many civil sheets are plotted with SHX "stick" fonts: every character is a
small polyline, so the PDF has no text objects for contour labels.  The same
character always produces the same polyline (up to rotation, scale and the
oblique angle), so digits can be recognised by comparing the stroke shape with
a small set of templates.

This only reads digits.  Anything that does not match a digit closely is
ignored rather than guessed.
"""
from __future__ import annotations

import json
import math
import os
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from pdfgeom import VPath

TEMPLATE_FILE = os.path.join(os.path.dirname(__file__), "stroke_digits.json")
SHEARS = (0.0, 0.18, 0.27, 0.36)  # upright, ~10, 15, 20 degree oblique
MATCH_LIMIT = 0.11  # max Hausdorff distance, in glyph heights, to accept a digit


def _sample(strokes: Sequence[np.ndarray], step: float = 0.03) -> np.ndarray:
    pts = []
    for s in strokes:
        for i in range(len(s) - 1):
            a, b = s[i], s[i + 1]
            n = max(1, int(np.linalg.norm(b - a) / step))
            for k in range(n):
                pts.append(a + (b - a) * (k / n))
        pts.append(s[-1])
    return np.array(pts)


def _hausdorff(a: np.ndarray, b: np.ndarray) -> float:
    d = np.linalg.norm(a[:, None, :] - b[None, :, :], axis=2)
    return float(max(d.min(1).max(), d.min(0).max()))


def _center(strokes: Sequence[np.ndarray]) -> List[np.ndarray]:
    allp = np.vstack(strokes)
    c = (allp.min(0) + allp.max(0)) / 2
    return [s - c for s in strokes]


def load_templates(path: str = TEMPLATE_FILE) -> Dict[str, np.ndarray]:
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        data = json.load(f)
    return {ch: _sample([np.array(s, dtype=float) for s in strokes]) for ch, strokes in data["digits"].items()}


def glyph_candidates(paths: Sequence[VPath], max_size: float = 20.0, styles: Optional[Sequence[str]] = None) -> List[VPath]:
    out = []
    for p in paths:
        if styles and p.style not in styles:
            continue
        if p.size > max_size or p.size < 1.5:
            continue
        if sum(len(s) for s in p.strokes) < 3:
            continue
        out.append(p)
    out.sort(key=lambda p: p.seq)
    return out


def group_labels(glyphs: Sequence[VPath]) -> List[List[VPath]]:
    """Characters of one label are emitted consecutively and sit side by side."""
    groups: List[List[VPath]] = []
    cur: List[VPath] = []
    for g in glyphs:
        if cur:
            prev = cur[-1]
            near = np.linalg.norm(g.center - prev.center) < 1.9 * max(prev.size, g.size)
            if g.seq - prev.seq <= 3 and near and g.style == prev.style:
                cur.append(g)
                continue
            groups.append(cur)
        cur = [g]
    if cur:
        groups.append(cur)
    return groups


def normalise_label(group: Sequence[VPath]):
    """Rotate a label so it reads left-to-right; scale to unit glyph height."""
    u = group[-1].center - group[0].center
    ang = math.atan2(u[1], u[0])
    ca, sa = math.cos(-ang), math.sin(-ang)
    rm = np.array([[ca, -sa], [sa, ca]])
    rotated = [[s @ rm.T for s in g.strokes] for g in group]
    heights = []
    for rs in rotated:
        allp = np.vstack(rs)
        heights.append(allp[:, 1].max() - allp[:, 1].min())
    h = float(np.median(heights)) or 1.0
    glyphs = [[s / h for s in _center(rs)] for rs in rotated]
    return ang, h, glyphs


def recognise_label(group: Sequence[VPath], templates: Dict[str, np.ndarray]) -> Optional[Dict[str, Any]]:
    """Return {'text', 'score', ...} when every character matches a digit."""
    if len(group) < 2 or len(group) > 5 or not templates:
        return None
    ang, h, glyphs = normalise_label(group)
    best = None
    for k in SHEARS:
        chars = []
        worst = 0.0
        margin = 9.0
        ok = True
        for strokes in glyphs:
            # undo the oblique angle (y is down, so the top of the glyph has negative y)
            un = _center([np.column_stack([s[:, 0] + k * s[:, 1], s[:, 1]]) for s in strokes])
            pts = _sample(un)
            scored = sorted((_hausdorff(pts, t), ch) for ch, t in templates.items())
            d0, ch0 = scored[0]
            if d0 > MATCH_LIMIT:
                ok = False
                break
            chars.append(ch0)
            worst = max(worst, d0)
            if len(scored) > 1:
                margin = min(margin, scored[1][0] - d0)
        if ok and (best is None or worst < best["score"]):
            best = {"text": "".join(chars), "score": round(worst, 4), "margin": round(margin, 4), "shear": k}
    if not best:
        return None
    pts = np.vstack([s for g in group for s in g.strokes])
    best.update({
        "angle": ang,
        "heightPt": round(h, 2),
        "center": [round(float((pts[:, 0].min() + pts[:, 0].max()) / 2), 2), round(float((pts[:, 1].min() + pts[:, 1].max()) / 2), 2)],
        "bbox": [round(float(pts[:, 0].min()), 2), round(float(pts[:, 1].min()), 2), round(float(pts[:, 0].max()), 2), round(float(pts[:, 1].max()), 2)],
        "widthPt": round(float(np.linalg.norm(group[-1].center - group[0].center) + h * 0.7), 2),
        "style": group[0].style,
        "italic": best["shear"] > 0,
    })
    return best


def find_number_labels(paths: Sequence[VPath], styles: Optional[Sequence[str]] = None) -> List[Dict[str, Any]]:
    templates = load_templates()
    labels = []
    for group in group_labels(glyph_candidates(paths, styles=styles)):
        rec = recognise_label(group, templates)
        if rec:
            labels.append(rec)
    return labels
