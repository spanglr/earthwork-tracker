"""Local API for the earthwork tracker.  Runs on 127.0.0.1 only."""
from __future__ import annotations

import math
import os
import sys
import tempfile
from typing import Any, Dict

sys.path.insert(0, os.path.dirname(__file__))

import numpy as np  # noqa: E402
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

import demo  # noqa: E402
import pdfgeom  # noqa: E402
import projects  # noqa: E402

app = FastAPI(title="Earthwork tracker")
ALLOWED_EXT = {".pdf"} | pdfgeom.IMAGE_EXT


@app.on_event("startup")
def _startup() -> None:
    os.makedirs(projects.DATA, exist_ok=True)
    demo.build_available()


def _load(pid: str) -> Dict[str, Any]:
    try:
        if not projects.exists(pid):
            raise HTTPException(404, "No such project")
    except ValueError:
        raise HTTPException(400, "Bad project id")
    return projects.load(pid)


@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {"ok": True}


@app.get("/api/demos")
def demos():
    """Demo projects that ship with the app, and whether their source file is here."""
    return demo.status()


@app.get("/api/projects")
def list_projects():
    return projects.list_projects()


@app.post("/api/projects")
async def create_project(name: str = Form(...), file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, "Upload a PDF or an image (PNG, JPG, TIFF).")
    data = await file.read()
    if len(data) > 200 * 1024 * 1024:
        raise HTTPException(400, "File is larger than 200 MB.")
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        try:
            project = projects.create(name.strip() or "New project", tmp_path, os.path.basename(file.filename or ("upload" + ext)))
        except Exception as e:  # unreadable / encrypted / not really a PDF
            raise HTTPException(400, "Could not read that file: %s" % e)
    finally:
        os.unlink(tmp_path)
    if len(project["source"]["pages"]) == 1:
        project = projects.set_page(project, 1)
    return project


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    return _load(pid)


@app.put("/api/projects/{pid}")
def put_project(pid: str, body: Dict[str, Any] = Body(...)):
    current = _load(pid)
    if body.get("id") != pid:
        raise HTTPException(400, "Project id mismatch")
    # the source file description is owned by the server
    body["source"] = current["source"]
    body["isDemo"] = current.get("isDemo", False)
    return {"ok": True, "updatedAt": projects.save(body)["updatedAt"]}


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    _load(pid)
    if demo.name_for(pid):
        raise HTTPException(400, "A demo project cannot be deleted. Use 'Reset demo' instead.")
    projects.delete(pid)
    return {"ok": True}


@app.post("/api/projects/{pid}/page")
def choose_page(pid: str, body: Dict[str, Any] = Body(...)):
    project = _load(pid)
    try:
        return projects.set_page(project, int(body["page"]))
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/projects/{pid}/extract")
def extract_contours(pid: str, body: Dict[str, Any] = Body(...)):
    project = _load(pid)
    if not project["source"].get("page"):
        raise HTTPException(400, "Choose a page first.")
    if not (project.get("calibration") or {}).get("feetPerPoint"):
        raise HTTPException(400, "Calibrate the sheet first.")
    return projects.run_extraction(project, body or {})


@app.get("/api/projects/{pid}/underlay")
def underlay(pid: str):
    project = _load(pid)
    u = project["source"].get("underlay")
    if not u:
        raise HTTPException(404, "No page chosen yet")
    return FileResponse(os.path.join(projects.pdir(pid), u["file"]), media_type="image/png", headers={"Cache-Control": "no-cache"})


@app.get("/api/projects/{pid}/style-lines")
def style_lines(pid: str, key: str):
    """Polylines of one line style, so the operator can see what it is."""
    project = _load(pid)
    out = []
    for p in projects.page_paths(project):
        if p.style == key:
            for s in p.strokes:
                out.append(np.round(s, 1).tolist())
    return {"key": key, "lines": out[:6000]}


@app.post("/api/projects/{pid}/pick")
def pick_line(pid: str, body: Dict[str, Any] = Body(...)):
    """Nearest vector polyline to a click ('adopt line from PDF')."""
    project = _load(pid)
    x, y, tol = float(body["x"]), float(body["y"]), float(body.get("tol", 4))
    if not all(math.isfinite(v) for v in (x, y, tol)):
        raise HTTPException(400, "Bad coordinates")
    hit = pdfgeom.nearest_polyline(projects.page_paths(project), x, y, tol)
    if not hit:
        raise HTTPException(404, "No vector line there. Zoom in and click directly on a line, or trace it instead.")
    return hit


@app.post("/api/projects/{pid}/snap")
def snap_point(pid: str, body: Dict[str, Any] = Body(...)):
    """Nearest line end or corner to a click, or the click itself when none is close."""
    project = _load(pid)
    x, y, tol = float(body["x"]), float(body["y"]), float(body.get("tol", 4))
    if not all(math.isfinite(v) for v in (x, y, tol)):
        raise HTTPException(400, "Bad coordinates")
    hit = pdfgeom.nearest_vertex(projects.page_paths(project), x, y, tol) if project["source"].get("page") else None
    return {"point": hit or [round(x, 2), round(y, 2)], "snapped": hit is not None}


@app.post("/api/demo/reset")
def reset_demo(body: Dict[str, Any] = Body(default={})):
    name = demo.name_for(str(body.get("id") or demo.DEMO_ID))
    if not name:
        raise HTTPException(404, "No such demo")
    try:
        return demo.build(force=True, name=name)
    except FileNotFoundError as e:
        raise HTTPException(400, str(e))


@app.get("/api/example-csv")
def example_csv():
    return FileResponse(os.path.join(projects.ROOT, "samples", "haul-tickets-example.csv"), media_type="text/csv", filename="haul-tickets-example.csv")


# Serve the built web app when it exists (npm run build), so one process is enough.
_dist = os.path.join(projects.ROOT, "dist")
if os.path.isdir(_dist):
    app.mount("/", StaticFiles(directory=_dist, html=True), name="web")
