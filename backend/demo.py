"""Build the demo projects from demo/<name>/config.json.

Two demos ship with the app:

  practice     an invented sheet (samples/practice-plan.pdf).  Always available,
               so a fresh clone has something to open.
  pittsburgh   Rhythm Square, sheet C-2.1 of a City of Pittsburgh zoning
               submission.  The PDF is not redistributed with the code: put it
               at source-pdf/rhythm-square-zba.pdf (see source-pdf/README.md)
               and the demo is built on the next start.

Everything specific to a sheet (page, line styles, scale-bar points, review
decisions, sample ditches, sample tickets) lives in its config file, not in
the application code.  Re-running a build reproduces the same project, which
is how "reopening reproduces the same terrain" is tested.

    .venv/bin/python backend/demo.py            # rebuild every available demo
"""
from __future__ import annotations

import csv
import json
import math
import os
import sys
from typing import Any, Dict, List, Optional

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import pdfgeom  # noqa: E402
import projects  # noqa: E402

DEMOS = ["pittsburgh", "practice"]  # first available one is opened by default
DEMO_DIR = os.path.join(projects.ROOT, "demo", "pittsburgh")
DEMO_ID = "pittsburgh-demo"


def demo_id(name: str) -> str:
    return name + "-demo"


def load_config(name: str = "pittsburgh") -> Dict[str, Any]:
    with open(os.path.join(projects.ROOT, "demo", name, "config.json")) as f:
        return json.load(f)


def status() -> List[Dict[str, Any]]:
    """Which demos can be built here, and which are waiting for their source file."""
    out = []
    for name in DEMOS:
        cfg = load_config(name)
        out.append({
            "name": name, "id": demo_id(name), "title": cfg["name"], "sourcePdf": cfg["sourcePdf"],
            "sourceUrl": cfg.get("sourceUrl"), "sheet": cfg.get("sheet"),
            "sourcePresent": os.path.exists(os.path.join(projects.ROOT, cfg["sourcePdf"])),
            "built": projects.exists(demo_id(name)),
        })
    return out


def name_for(pid: str) -> Optional[str]:
    return next((n for n in DEMOS if demo_id(n) == pid), None)


def _dist_to_polyline(points: List[List[float]], x: float, y: float) -> float:
    p = np.array(points, dtype=float)
    q = np.array([x, y])
    a, b = p[:-1], p[1:]
    ab = b - a
    den = (ab * ab).sum(1)
    den[den == 0] = 1
    t = np.clip(((q - a) * ab).sum(1) / den, 0, 1)
    return float(np.linalg.norm(a + ab * t[:, None] - q, axis=1).min())


def nearest_contour(project: Dict[str, Any], near: List[float], tol: float = 6.0):
    best = min(project["contours"], key=lambda c: _dist_to_polyline(c["points"], near[0], near[1]))
    d = _dist_to_polyline(best["points"], near[0], near[1])
    if d > tol:
        raise RuntimeError("demo review: no contour within %.0f pt of %s (nearest is %.1f pt)" % (tol, near, d))
    return best


def read_tickets(path: str) -> List[Dict[str, Any]]:
    with open(path, newline="") as f:
        return [{"ticket_id": r["ticket_id"].strip(), "date": r["date"].strip(), "from_id": r["from_id"].strip(),
                 "to_id": r["to_id"].strip(), "volume_yd3": float(r["volume_yd3"])} for r in csv.DictReader(f)]


def build(force: bool = True, name: str = "pittsburgh") -> Dict[str, Any]:
    pid = demo_id(name)
    if projects.exists(pid) and not force:
        return projects.load(pid)
    cfg = load_config(name)
    src = os.path.join(projects.ROOT, cfg["sourcePdf"])
    if not os.path.exists(src):
        raise FileNotFoundError("%s is not on this computer. See source-pdf/README.md." % cfg["sourcePdf"])
    projects.delete(pid)
    project = projects.create(cfg["name"], src, os.path.basename(src), pid=pid, is_demo=True)
    project["demoNote"] = cfg["note"]
    if cfg.get("sourceUrl"):
        project["source"]["url"] = cfg["sourceUrl"]
    project["source"]["sheet"] = cfg["sheet"]
    project = projects.set_page(project, cfg["page"])

    cal = cfg["calibration"]
    dist_pt = math.dist(cal["a"], cal["b"])
    project["calibration"] = {"method": "two-point", "a": cal["a"], "b": cal["b"], "distanceFt": cal["distanceFt"],
                              "feetPerPoint": cal["distanceFt"] / dist_pt, "note": cal["note"],
                              "printedScale": cal.get("printedScale")}
    project["contourInterval"] = cfg["contourInterval"]
    project["indexInterval"] = cfg["indexInterval"]
    project["terrain"] = cfg["terrain"]
    project = projects.run_extraction(project, cfg["extraction"])

    # ---- review decisions recorded for the demo
    rv = cfg["review"]
    for c in project["contours"]:
        a = c["auto"]
        if rv.get("acceptUnflagged") and a["elevation"] is not None and not a["flags"] and c["surface"] == "existing":
            c["review"] = {"status": "accepted", "elevation": None, "confirmed": False,
                           "note": "Accepted in bulk: automatic height with no warnings."}
    paths = projects.page_paths(project)
    for d in rv.get("decisions", []):
        c = nearest_contour(project, d["near"])
        if d["action"] == "reject":
            c["review"] = {"status": "rejected", "elevation": None, "confirmed": False, "note": d["note"]}
        elif d["action"] == "confirm":
            c["review"] = {"status": "accepted", "elevation": d["elevation"], "confirmed": True, "note": d["note"]}
        elif d["action"] == "pending":
            c["review"] = {"status": "pending", "elevation": None, "confirmed": False, "note": d["note"]}
        if d.get("surface"):
            c["surface"] = d["surface"]
    for k, a in enumerate(rv.get("adopt", [])):
        hit = pdfgeom.nearest_polyline(paths, a["at"][0], a["at"][1], 3.0)
        if not hit:
            raise RuntimeError("demo review: nothing to adopt at %s" % a["at"])
        project["contours"].append({
            "id": "adopted-%02d" % (k + 1), "surface": a["surface"], "kind": "intermediate", "origin": "adopted",
            "style": hit["style"], "points": hit["points"], "lengthPt": 0, "auto": None,
            "review": {"status": "accepted", "elevation": a["elevation"], "confirmed": True, "note": a["note"]},
        })
    for cp in cfg["checkPoints"]:
        if cp.pop("snapToMark", False) and project["marks"]:
            m = min(project["marks"], key=lambda q: math.dist(q, (cp["x"], cp["y"])))
            if math.dist(m, (cp["x"], cp["y"])) <= 8:
                cp["x"], cp["y"] = m
    project["checkPoints"] = cfg["checkPoints"]
    project["ditches"] = cfg["ditches"]
    project["tickets"] = read_tickets(os.path.join(projects.ROOT, cfg["ticketsCsv"]))
    project["ticketBasis"] = cfg.get("ticketBasis", "loose")
    return projects.save(project)


def build_available(force: bool = False) -> List[str]:
    """Build every demo whose source file is here.  Returns the ids built."""
    done = []
    for d in status():
        if d["sourcePresent"] and (force or not d["built"]):
            build(force=True, name=d["name"])
            done.append(d["id"])
    return done


if __name__ == "__main__":
    for d in status():
        if not d["sourcePresent"]:
            print("skipped %s: %s is not here (see source-pdf/README.md)" % (d["id"], d["sourcePdf"]))
            continue
        p = build(force=True, name=d["name"])
        by: Dict[str, int] = {}
        for c in p["contours"]:
            by[c["review"]["status"]] = by.get(c["review"]["status"], 0) + 1
        print("built", projects.ppath(d["id"]))
        print("  extraction:", p["extraction"]["report"])
        print("  review:", by)
