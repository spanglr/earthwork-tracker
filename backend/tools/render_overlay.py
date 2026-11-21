"""Write docs/overlay-review.png: the saved demo project's contours and check
points drawn over sheet C-2.1, for checking alignment outside the app.

    .venv/bin/python backend/tools/render_overlay.py
"""
import json
import os
import sys

import fitz

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import projects  # noqa: E402

COL = {"label": (0.16, 0.47, 0.84), "inferred": (0.0, 0.55, 0.3), "manual": (0.38, 0.31, 0.84),
       "pending": (0.92, 0.41, 0.2), "proposed": (0.8, 0.55, 0.0), "rejected": (0.6, 0.6, 0.6)}
NAME = {"label": "Printed label", "inferred": "Inferred by counting", "manual": "Manually confirmed",
        "pending": "Needs review", "proposed": "Proposed grade (not in terrain)", "rejected": "Rejected (not a contour)"}


def category(c):
    r, a = c["review"], c["auto"] or {}
    e = r["elevation"] if r["elevation"] is not None else a.get("elevation")
    if r["status"] == "rejected":
        return "rejected", e
    if r["status"] == "pending" or e is None:
        return "pending", e
    if c["surface"] == "proposed":
        return "proposed", e
    return ("manual" if (r["elevation"] is not None or r["confirmed"]) else a["source"]), e


def main(pid="pittsburgh-demo", out=os.path.join(projects.ROOT, "docs", "overlay-review.png"), zoom=1.7):
    if not projects.exists(pid):
        sys.exit("Project %s does not exist yet. Start the app once (npm start) or run npm run demo:rebuild." % pid)
    p = projects.load(pid)
    doc = fitz.open(projects.source_path(p))
    page = doc[p["source"]["page"] - 1]
    page.remove_rotation()  # draw in the same sheet coordinates the app uses
    xs = [x for c in p["contours"] for x, _ in c["points"]]
    ys = [y for c in p["contours"] for _, y in c["points"]]
    clip = fitz.Rect(min(xs) - 30, min(ys) - 30, max(xs) + 30, max(ys) + 30)
    page.draw_rect(clip, color=None, fill=(1, 1, 1), fill_opacity=0.5)
    for c in p["contours"]:
        cat, e = category(c)
        pts = [fitz.Point(x, y) for x, y in c["points"]]
        page.draw_polyline(pts, color=COL[cat], width=1.5 if c["kind"] == "index" else 0.9,
                           dashes="[3 2] 0" if cat in ("inferred", "rejected") else None)
        if e is not None and cat != "rejected":
            m = pts[int(len(pts) * 0.42)]
            page.draw_rect(fitz.Rect(m.x - 1, m.y - 5, m.x + 14, m.y + 2), color=None, fill=(1, 1, 1), fill_opacity=0.85)
            page.insert_text((m.x, m.y + 1), "%g" % e, fontsize=5.5, color=COL[cat])
    for cp in p["checkPoints"]:
        x, y = cp["x"], cp["y"]
        page.draw_circle((x, y), 5, color=(0, 0, 0), width=1.2)
        page.draw_line((x - 7, y), (x + 7, y), color=(0, 0, 0), width=0.8)
        page.draw_line((x, y - 7), (x, y + 7), color=(0, 0, 0), width=0.8)
        page.draw_rect(fitz.Rect(x + 7, y - 13, x + 27, y - 5), color=None, fill=(0, 0, 0))
        page.insert_text((x + 8.5, y - 7), cp["id"], fontsize=6, color=(1, 1, 1))
    lx, ly = clip.x0 + 8, clip.y1 - 8 - 11 * len(NAME)
    page.draw_rect(fitz.Rect(lx - 4, ly - 10, lx + 150, clip.y1 - 4), color=(0.5, 0.5, 0.5), fill=(1, 1, 1), width=0.5)
    for i, (k, text) in enumerate(NAME.items()):
        yy = ly + i * 11
        page.draw_line((lx, yy - 2), (lx + 22, yy - 2), color=COL[k], width=1.6)
        page.insert_text((lx + 27, yy), text, fontsize=7, color=(0, 0, 0))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip).save(out)
    print("wrote", out)


if __name__ == "__main__":
    main()
