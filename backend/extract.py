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
ROLE_EXISTING_MIXED = "existing-mixed"  # major and minor contours drawn in one style
ROLE_PROPOSED = "proposed"

EXTENDED_FLAG = "height continued past the outermost labeled lines, not counted between two of them: check it against the sheet"

NUM_RE = re.compile(r"^\d{2,5}(\.\d{1,2})?$")


def _labels_from_text(page) -> List[Dict[str, Any]]:
    """Whole numbers printed as real PDF text, with their colour and slant."""
    out = []
    for w in pdfgeom.text_words(page):
        txt = w["text"].replace(",", "")
        if not NUM_RE.match(txt):
            continue
        size = float(w.get("size") or 0) or min(w["bbox"][2] - w["bbox"][0], w["bbox"][3] - w["bbox"][1])
        out.append({
            "text": txt, "center": w["center"], "bbox": w["bbox"], "angle": w["angle"],
            # a rotated label's box is not its size: use the lettering height instead
            "heightPt": round(size * 0.72, 2), "widthPt": round(len(txt) * size * 0.56, 2),
            "reader": "pdf-text", "italic": bool(w.get("italic")), "score": 0.0, "style": None, "color": w.get("color"),
        })
    return out


def _split_major_minor(chains: List[Dict[str, Any]], labels: List[Dict[str, Any]], index_interval: float) -> Optional[str]:
    """In a style that holds both major and minor contours, tell them apart by
    dash pattern when the sheet draws them with two patterns.  The split is
    only trusted if the printed labels bear it out: labels on the longer
    pattern must be index heights and labels on the shorter one must not be."""
    note = None
    for style in {c["style"] for c in chains if c.get("mixedStyle")}:
        mine = [c for c in chains if c["style"] == style]
        fams = sorted({c.get("gapFamily") for c in mine if c.get("gapFamily")})
        if len(fams) < 2:
            continue
        long_gap = fams[-1]

        def label_values(c):
            return [labels[int(a["label"][1:])]["value"] for a in c.get("labels", [])]

        def is_index(v):
            return abs(v / index_interval - round(v / index_interval)) < 1e-6

        on_long = [v for c in mine if c.get("gapFamily") == long_gap for v in label_values(c)]
        on_short = [v for c in mine if c.get("gapFamily") != long_gap for v in label_values(c)]
        # (a short piece of a major line can show only the short gap, so a few
        # index labels on short-dash pieces are tolerated)
        if len(on_long) >= 3 and all(is_index(v) for v in on_long) and sum(1 for v in on_short if is_index(v)) <= max(2, len(on_short) // 4):
            for c in mine:
                if c.get("gapFamily") == long_gap:
                    c["kind"], c["mixedStyle"] = "index", False
                elif c.get("dashGaps", 0) >= 3:
                    c["kind"], c["mixedStyle"] = "intermediate", False
                # else: too short to show its dash pattern; its height will say which it is
            note = "major and minor contours told apart by dash pattern (%d labels on long-dash lines, all index heights)" % len(on_long)
    return note


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
    text_heights = sum(1 for l in labels if "." not in l["text"] and (lo is None or lo <= float(l["text"]) <= hi))
    if text_heights < 10:
        # No real text labels to speak of: the lettering is plotted as strokes.
        # (When a sheet does carry text labels, stroke reading is skipped: bits
        # of dashed line work can happen to look like digits.)
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
    # Dash gap per contour style: what the operator typed, else what was
    # detected.  A style that also carries other line work (utility lines, say)
    # often has no clear gap of its own; existing-contour styles on one sheet
    # share a linetype scale, so it borrows the gap detected for the others.
    typed = {k: float(v) for k, v in (cfg.get("dashGaps") or {}).items() if v}
    detected = {k: styles.get(k, {}).get("dashGapPt") for k in roles}
    detected_all = {k: styles.get(k, {}).get("dashGapsPt") or [] for k in roles}
    existing_gaps = [g for k, g in detected.items() if g and roles[k] != ROLE_PROPOSED]
    gap_used: Dict[str, Any] = {}
    chains: List[Dict[str, Any]] = []
    for key, role in roles.items():
        if role not in (ROLE_EXISTING_INDEX, ROLE_EXISTING_INTERMEDIATE, ROLE_EXISTING_MIXED, ROLE_PROPOSED):
            continue
        polys = [s for p in paths if p.style == key for s in p.strokes]
        if key in typed:
            gap, how = typed[key], "typed"
        elif detected.get(key):
            more = detected_all.get(key) or [detected[key]]
            gap, how = (more if len(more) > 1 else detected[key]), "detected"
        elif role != ROLE_PROPOSED and existing_gaps:
            gap, how = max(set(existing_gaps), key=existing_gaps.count), "borrowed from the other contour styles"
        else:
            gap, how = None, "none: treated as solid lines"
        gap_used[key] = {"gapPt": gap, "how": how}
        for c in ct.chain_dashes(polys, gap):
            c["style"] = key
            c["surface"] = "proposed" if role == ROLE_PROPOSED else "existing"
            c["kind"] = "index" if role == ROLE_EXISTING_INDEX else "intermediate"
            c["mixedStyle"] = role == ROLE_EXISTING_MIXED
            c["role"] = role
            c["dashGapPt"] = gap
            chains.append(c)

    slant = cfg.get("existingLabelSlant") or "any"
    existing = [c for c in chains if c["surface"] == "existing"]
    proposed = [c for c in chains if c["surface"] == "proposed"]
    ex_labels = [l for l in contour_labels if slant == "any" or (slant == "italic") == bool(l.get("italic"))]
    # When the sheet letters its existing contours in the contour styles
    # themselves, labels in any other style (proposed-contour labels, usually)
    # are not offered to existing lines.
    existing_styles = {k for k, r in roles.items() if r != ROLE_PROPOSED}
    existing_colours = {k.split("/")[0] for k in existing_styles}
    in_style = [l for l in ex_labels if l.get("style") in existing_styles or (l["reader"] == "pdf-text" and l.get("color") in existing_colours)]
    label_rule = "any lettering"
    if len(in_style) >= 3:
        # Stroked labels drawn in a contour style, or text labels printed in a
        # contour colour: the sheet colour-codes its labels, so only those are
        # offered to existing lines.
        ex_labels = in_style
        label_rule = "only labels drawn in the existing-contour styles or colours"
    other_labels = [l for l in contour_labels if l not in ex_labels]

    ct.attach_labels(existing, ex_labels, interval, index_interval)
    split_note = _split_major_minor(existing, ex_labels, index_interval)
    for c in existing:
        vals = sorted({ex_labels[int(a["label"][1:])]["value"] for a in c["labels"]})
        if len(vals) == 1:
            c["elevation"], c["source"] = vals[0], "label"
        elif len(vals) > 1:
            c["flags"] = ["labels disagree: " + ", ".join("%g" % v for v in vals)]
    # How far a cross-line looks for neighbouring contours: 60 ft on the
    # ground, but never less than about 3.5 inches of paper.  Labels are spaced
    # for the paper, so a small-scale sheet needs the longer look.
    reach = max((60.0 / ft_per_pt) if ft_per_pt else 0.0, 250.0)
    ct.infer_elevations(existing, interval, reach, index_interval=index_interval)
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
            if c.get("mixedStyle"):
                # one style for major and minor lines: the height says which it is
                c["kind"] = "index" if is_index_height else "intermediate"
            elif c["kind"] == "index" and not is_index_height:
                flags.append("drawn as an index line but height is not a multiple of %g" % index_interval)
            if not c.get("mixedStyle") and c["kind"] == "intermediate" and is_index_height:
                flags.append("drawn as an intermediate line but height is a multiple of %g" % index_interval)
            nb = c.get("neighbours", {})
            if nb.get("inconsistent", 0) > max(1, nb.get("consistent", 0) // 4):
                flags.append("neighbouring lines are not one interval away in %d of %d places" % (nb["inconsistent"], nb["inconsistent"] + nb["consistent"]))
        if (c.get("inference") or {}).get("method") == "extended":
            flags.append(EXTENDED_FLAG)
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
            "labelRule": label_rule,
            "majorMinorSplit": split_note,
            "dashGaps": gap_used,
            "contours": len(out_contours),
            "withLabel": sum(1 for c in out_contours if c["auto"]["source"] == "label"),
            "inferred": sum(1 for c in out_contours if c["auto"]["source"] == "inferred"),
            "unassigned": sum(1 for c in out_contours if c["auto"]["elevation"] is None),
            "flagged": sum(1 for c in out_contours if c["auto"]["flags"]),
        },
    }
