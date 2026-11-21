"""Project files on disk.

projects/<id>/project.json   everything the app needs to reproduce the terrain:
                             calibration, extracted geometry, the operator's
                             review decisions, traced lines, ditches, tickets
projects/<id>/source.<ext>   the uploaded PDF or image, untouched
projects/<id>/underlay-pN.png  raster copy of the chosen page for the plan view
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
from functools import lru_cache
from typing import Any, Dict, List, Optional

import extract
import pdfgeom

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA = os.environ.get("EARTHWORK_DATA", os.path.join(ROOT, "projects"))


def now() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def pdir(pid: str) -> str:
    if not re.match(r"^[a-z0-9][a-z0-9-]{0,60}$", pid):
        raise ValueError("bad project id")
    return os.path.join(DATA, pid)


def ppath(pid: str) -> str:
    return os.path.join(pdir(pid), "project.json")


def exists(pid: str) -> bool:
    return os.path.exists(ppath(pid))


def load(pid: str) -> Dict[str, Any]:
    with open(ppath(pid)) as f:
        return json.load(f)


def save(project: Dict[str, Any]) -> Dict[str, Any]:
    project["updatedAt"] = now()
    os.makedirs(pdir(project["id"]), exist_ok=True)
    tmp = ppath(project["id"]) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(project, f)
    os.replace(tmp, ppath(project["id"]))
    return project


def list_projects() -> List[Dict[str, Any]]:
    out = []
    if not os.path.isdir(DATA):
        return out
    for pid in sorted(os.listdir(DATA)):
        try:
            p = load(pid)
        except Exception:
            continue
        out.append({"id": p["id"], "name": p["name"], "isDemo": bool(p.get("isDemo")), "updatedAt": p.get("updatedAt"),
                    "contours": len(p.get("contours", [])), "ditches": len(p.get("ditches", [])), "tickets": len(p.get("tickets", []))})
    return out


def delete(pid: str) -> None:
    shutil.rmtree(pdir(pid), ignore_errors=True)


def slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "project"
    base, k = s, 2
    while os.path.exists(os.path.join(DATA, s)):
        s = "%s-%d" % (base, k)
        k += 1
    return s


def source_path(project: Dict[str, Any]) -> str:
    return os.path.join(pdir(project["id"]), project["source"]["fileName"])


@lru_cache(maxsize=3)
def _paths_cached(path: str, mtime: float, page_index: int):
    doc = pdfgeom.open_document(path)
    return pdfgeom.load_paths(doc[page_index])


def page_paths(project: Dict[str, Any]):
    path = source_path(project)
    return _paths_cached(path, os.path.getmtime(path), project["source"]["page"] - 1)


def create(name: str, src_file: str, original_name: str, pid: Optional[str] = None, is_demo: bool = False) -> Dict[str, Any]:
    pid = pid or slug(name)
    os.makedirs(pdir(pid), exist_ok=True)
    ext = os.path.splitext(original_name)[1].lower() or ".pdf"
    dst = os.path.join(pdir(pid), "source" + ext)
    shutil.copyfile(src_file, dst)
    doc = pdfgeom.open_document(dst)
    project = {
        "schema": 1,
        "id": pid,
        "name": name,
        "isDemo": is_demo,
        "createdAt": now(),
        "source": {
            "fileName": "source" + ext,
            "originalName": original_name,
            "kind": "image" if ext in pdfgeom.IMAGE_EXT else "pdf",
            "pages": [pdfgeom.page_summary(doc, i) for i in range(len(doc))],
            "page": None,
        },
        "calibration": None,
        "contourInterval": 1,
        "indexInterval": 5,
        "extraction": None,
        "contours": [],
        "labels": [],
        "spotNumbers": [],
        "marks": [],
        "checkPoints": [],
        "terrain": {"maxEdgeFt": 25, "sampleFt": 2},
        "ditches": [],
        "tickets": [],
        "ticketBasis": "loose",
    }
    return save(project)


def set_page(project: Dict[str, Any], page: int) -> Dict[str, Any]:
    """Choose the sheet: render the underlay and list what is on the page."""
    src = project["source"]
    doc = pdfgeom.open_document(source_path(project))
    if page < 1 or page > len(doc):
        raise ValueError("page out of range")
    pg = doc[page - 1]
    under = "underlay-p%d.png" % page
    info = pdfgeom.render_underlay(pg, os.path.join(pdir(project["id"]), under))
    changed = src.get("page") != page
    src["page"] = page
    src["widthPt"] = round(pg.rect.width, 2)
    src["heightPt"] = round(pg.rect.height, 2)
    src["underlay"] = {"file": under, **info}
    paths = pdfgeom.load_paths(pg)
    src["styles"] = pdfgeom.style_table(paths)[:40]
    src["sampleText"] = [w["text"] for w in pdfgeom.text_words(pg)[:400] if len(w["text"]) <= 40][:60]
    project["marks"] = pdfgeom.find_cross_marks(paths)
    if changed:
        project["contours"], project["checkPoints"] = [], []
        project["labels"], project["spotNumbers"], project["extraction"] = [], [], None
        project["calibration"] = None
    return save(project)


def blank_review() -> Dict[str, Any]:
    return {"status": "pending", "elevation": None, "confirmed": False, "note": ""}


def run_extraction(project: Dict[str, Any], cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Run (or re-run) automatic extraction.  Review decisions on lines that
    come out the same are kept; traced and adopted lines are always kept."""
    cal = project.get("calibration") or {}
    cfg = dict(cfg)
    cfg["interval"] = project.get("contourInterval", 1)
    cfg["indexInterval"] = project.get("indexInterval", 5)
    cfg["feetPerPoint"] = cal.get("feetPerPoint")
    res = extract.run_extraction(source_path(project), project["source"]["page"] - 1, cfg)
    old = {c["id"]: c for c in project.get("contours", [])}
    merged = []
    for c in res["contours"]:
        prev = old.get(c["id"])
        c["review"] = prev["review"] if prev and prev.get("origin") == "vector" else blank_review()
        if prev and prev.get("surface") and prev["review"]["status"] != "pending":
            c["surface"] = prev["surface"]
        merged.append(c)
    merged += [c for c in project.get("contours", []) if c.get("origin") != "vector"]
    project["contours"] = merged
    project["labels"] = res["labels"]
    project["spotNumbers"] = res["spotNumbers"]
    project["extraction"] = {"config": {k: cfg.get(k) for k in ("roles", "labelStyles", "existingLabelSlant", "elevationRange", "dashGaps")},
                             "report": res["report"], "ranAt": now()}
    return save(project)
