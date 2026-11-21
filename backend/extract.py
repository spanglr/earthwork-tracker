"""PDF page -> candidate contours, labels and spot numbers (sheet coordinates)."""
from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional

import numpy as np

import contours as ct
import pdfgeom
import strokefont

ROLE_EXISTING_INDEX = "existing-index"
ROLE_EXISTING_INTERMEDIATE = "existing-intermediate"
ROLE_PROPOSED = "proposed"

NUM_RE = re.compile(r"^\d{2,5}(\.\d{1,2})?$")


def _labels_from_text(page) -> List[Dict[str, Any]]:
    out = []
    for w in pdfgeom.text_words(page):
        txt = w["text"].replace(",", "")
        if not NUM_RE.match(txt):
            continue
        b = w["bbox"]
        horiz = abs(math.cos(w["angle"])) >= abs(math.sin(w["angle"]))
        out.append({
            "text": txt, "center": w["center"], "bbox": b, "angle": w["angle"],
            "heightPt": round(min(b[2] - b[0], b[3] - b[1]), 2),
            "widthPt": round((b[2] - b[0]) if horiz else (b[3] - b[1]), 2),
            "reader": "pdf-text", "italic": False, "score": 0.0, "style": None,
        })
    return out


def run_extraction(pdf_path: str, page_index: int, cfg: Dict[str, Any]) -> Dict[str, Any]:
    """cfg keys: interval, indexInterval, feetPerPoint, roles {styleKey: role},
    labelStyles [styleKey] | None, existingLabelSlant 'italic'|'upright'|'any',
    elevationRange [lo, hi] | None, dashGaps {styleKey: pt} (optional)."""
    doc = pdfgeom.open_document(pdf_path)
    page = doc[page_index]
    paths = pdfgeom.load_paths(page)
    roles: Dict[str, str] = cfg.get("roles") or {}
    styles = {row["key"]: row for row in pdfgeom.style_table([p for p in paths if p.style in roles])}
    interval = float(cfg.get("interval") or 1)
    index_interval = float(cfg.get("indexInterval") or interval * 5)
    ft_per_pt = float(cfg.get("feetPerPoint") or 0) or None
    lo, hi = (cfg.get("elevationRange") or [None, None])

    # ---- labels: real PDF text first, then stroked lettering
    labels = _labels_from_text(page)
    for rec in strokefont.find_number_labels(paths, styles=cfg.get("labelStyles") or None):
        rec["reader"] = "stroke-font"
        labels.append(rec)
    contour_labels, spots = [], []
    for lab in labels:
        try:
            lab["value"] = float(lab["text"])
        except ValueError:
            continue
        if "." in lab["text"]:
            spots.append(lab)
            continue
        if lo is not None and not (lo <= lab["value"] <= hi):
            continue
        contour_labels.append(lab)

    # ---- chains per role
    chains: List[Dict[str, Any]] = []
    for key, role in roles.items():
        if role not in (ROLE_EXISTING_INDEX, ROLE_EXISTING_INTERMEDIATE, ROLE_PROPOSED):
            continue
        polys = [s for p in paths if p.style == key for s in p.strokes]
        gap = (cfg.get("dashGaps") or {}).get(key, styles.get(key, {}).get("dashGapPt"))
        for c in ct.chain_dashes(polys, gap):
            c["style"] = key
            c["surface"] = "proposed" if role == ROLE_PROPOSED else "existing"
            c["kind"] = "index" if role == ROLE_EXISTING_INDEX else "intermediate"
            c["dashGapPt"] = gap
            chains.append(c)

    slant = cfg.get("existingLabelSlant") or "any"
    existing = [c for c in chains if c["surface"] == "existing"]
    proposed = [c for c in chains if c["surface"] == "proposed"]
    ex_labels = [l for l in contour_labels if slant == "any" or (slant == "italic") == bool(l.get("italic"))]
    other_labels = [l for l in contour_labels if l not in ex_labels]

    ct.attach_labels(existing, ex_labels, interval, index_interval)
    for c in existing:
        vals = sorted({ex_labels[int(a["label"][1:])]["value"] for a in c["labels"]})
        if len(vals) == 1:
            c["elevation"], c["source"] = vals[0], "label"
        elif len(vals) > 1:
            c["flags"] = ["labels disagree: " + ", ".join("%g" % v for v in vals)]
    reach = (60.0 / ft_per_pt) if ft_per_pt else 400.0
    ct.infer_elevations(existing, interval, reach)
    ct.neighbour_check(existing, interval, reach)
    if proposed:
        ct.attach_labels(proposed, other_labels if slant != "any" else ex_labels, interval, index_interval)

    out_contours = []
    for c in existing + proposed:
        pts = c["points"]
        flags = list(c.get("flags", []))
        e = c.get("elevation")
        if e is not None and c["surface"] == "existing":
            is_index_height = abs(e / index_interval - round(e / index_interval)) < 1e-6
            if c["kind"] == "index" and not is_index_height:
                flags.append("drawn as an index line but height is not a multiple of %g" % index_interval)
            if c["kind"] == "intermediate" and is_index_height:
                flags.append("drawn as an intermediate line but height is a multiple of %g" % index_interval)
            nb = c.get("neighbours", {})
            if nb.get("inconsistent", 0) > max(1, nb.get("consistent", 0) // 4):
                flags.append("neighbouring lines are not one interval away in %d of %d places" % (nb["inconsistent"], nb["inconsistent"] + nb["consistent"]))
        chord = pts[-1] - pts[0]
        clen = float(np.linalg.norm(chord))
        if clen > 1 and not c.get("labels"):
            off = np.abs((pts[:, 0] - pts[0, 0]) * chord[1] - (pts[:, 1] - pts[0, 1]) * chord[0]) / clen
            if float(off.max()) < 0.4:
                flags.append("perfectly straight: may be building or boundary line work rather than a contour")
        lab_ev = []
        pool = ex_labels if c["surface"] == "existing" else (other_labels if slant != "any" else ex_labels)
        for a in c.get("labels", []):
            lab = pool[int(a["label"][1:])]
            lab_ev.append({"text": lab["text"], "center": lab["center"], "how": a["how"], "distancePt": a["distancePt"],
                           "reader": lab["reader"], "matchError": lab.get("score"), "matchMargin": lab.get("margin")})
        out_contours.append({
            "id": ct.contour_id(pts),
            "surface": c["surface"],
            "kind": c["kind"],
            "origin": "vector",
            "style": c["style"],
            "points": np.round(pts, 2).tolist(),
            "lengthPt": round(float(np.linalg.norm(np.diff(pts, axis=0), axis=1).sum()), 1),
            "auto": {
                "elevation": e,
                "source": c.get("source") if e is not None else None,
                "labels": lab_ev,
                "inference": c.get("inference"),
                "neighbours": c.get("neighbours"),
                "dashGaps": c.get("dashGaps", 0),
                "bridges": c.get("bridges", []),
                "flags": flags,
            },
        })
    # ids must be unique even for near-identical fragments
    seen: Dict[str, int] = {}
    for c in out_contours:
        k = seen.get(c["id"], 0)
        seen[c["id"]] = k + 1
        if k:
            c["id"] = "%s-%d" % (c["id"], k)

    def pub(lab: Dict[str, Any], used: bool) -> Dict[str, Any]:
        return {"text": lab["text"], "value": lab["value"], "center": lab["center"], "bbox": lab["bbox"],
                "angleDeg": round(math.degrees(lab["angle"]), 1), "reader": lab["reader"], "italic": bool(lab.get("italic")),
                "matchError": lab.get("score"), "style": lab.get("style"), "attached": used}

    return {
        "contours": out_contours,
        "marks": pdfgeom.find_cross_marks(paths),
        "labels": [pub(l, bool(l.get("attached"))) for l in contour_labels],
        "spotNumbers": [pub(l, False) for l in spots],
        "report": {
            "vectorPaths": len(paths),
            "stylesUsed": roles,
            "labelsRead": len(contour_labels),
            "labelsFromPdfText": sum(1 for l in contour_labels if l["reader"] == "pdf-text"),
            "labelsFromStrokes": sum(1 for l in contour_labels if l["reader"] == "stroke-font"),
            "contours": len(out_contours),
            "withLabel": sum(1 for c in out_contours if c["auto"]["source"] == "label"),
            "inferred": sum(1 for c in out_contours if c["auto"]["source"] == "inferred"),
            "unassigned": sum(1 for c in out_contours if c["auto"]["elevation"] is None),
            "flagged": sum(1 for c in out_contours if c["auto"]["flags"]),
        },
    }
