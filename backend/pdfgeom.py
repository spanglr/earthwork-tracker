"""Low-level PDF access: page inspection, vector paths, text, underlay rendering.

All geometry returned from this module is in *sheet coordinates*: PDF points
(1/72 inch) measured on the page as displayed (after the page's /Rotate is
applied), x to the right and y down, origin at the top-left corner.  Every
other part of the app (contours, mesh, ditch polygons, check points) uses the
same coordinates, so nothing ever needs to be re-registered.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

import fitz  # PyMuPDF
import numpy as np

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif", ".webp"}


def open_document(path: str) -> fitz.Document:
    return fitz.open(path)


def style_key(color: Optional[Tuple[float, ...]], width: Optional[float]) -> str:
    """Stable identifier for a stroke style: grey/colour + line width."""
    c = color or (0, 0, 0)
    return "rgb(%d,%d,%d)/w%.2f" % (round(c[0] * 255), round(c[1] * 255), round(c[2] * 255), width or 0)


class VPath:
    """One stroked PDF path, already transformed to sheet coordinates."""

    __slots__ = ("seq", "style", "color", "width", "strokes", "bbox")

    def __init__(self, seq: int, style: str, color, width: float, strokes: List[np.ndarray]):
        self.seq = seq
        self.style = style
        self.color = color
        self.width = width
        self.strokes = strokes
        pts = np.vstack(strokes)
        self.bbox = (float(pts[:, 0].min()), float(pts[:, 1].min()), float(pts[:, 0].max()), float(pts[:, 1].max()))

    @property
    def size(self) -> float:
        return max(self.bbox[2] - self.bbox[0], self.bbox[3] - self.bbox[1])

    @property
    def center(self) -> np.ndarray:
        return np.array([(self.bbox[0] + self.bbox[2]) / 2, (self.bbox[1] + self.bbox[3]) / 2])

    @property
    def length(self) -> float:
        return float(sum(np.linalg.norm(np.diff(s, axis=0), axis=1).sum() for s in self.strokes))


def _bezier(p0, p1, p2, p3, n: int = 8) -> List[Tuple[float, float]]:
    out = []
    for i in range(1, n + 1):
        t = i / n
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t**3 * p3[1]
        out.append((x, y))
    return out


def load_paths(page: fitz.Page) -> List[VPath]:
    """All stroked vector paths on the page as polylines in sheet coordinates.

    Duplicate paths (CAD plots often draw the same geometry twice) are dropped.
    """
    rot = page.rotation_matrix

    ma, mb, mc, md, me, mf = rot.a, rot.b, rot.c, rot.d, rot.e, rot.f

    def tr(p) -> Tuple[float, float]:
        x, y = p[0], p[1]
        return (ma * x + mc * y + me, mb * x + md * y + mf)

    out: List[VPath] = []
    seen = set()
    for d in page.get_drawings():
        if "s" not in d.get("type", "") or not d.get("color"):
            continue
        strokes: List[List[Tuple[float, float]]] = []
        cur: List[Tuple[float, float]] = []
        for it in d["items"]:
            kind = it[0]
            if kind == "l":
                a, b = tr(it[1]), tr(it[2])
                pts = [b]
            elif kind == "c":
                a = tr(it[1])
                pts = _bezier(a, tr(it[2]), tr(it[3]), tr(it[4]))
            elif kind == "re":
                r = it[1]
                corners = [tr(r.tl), tr(r.tr), tr(r.br), tr(r.bl), tr(r.tl)]
                a, pts = corners[0], corners[1:]
            elif kind == "qu":
                q = it[1]
                corners = [tr(q.ul), tr(q.ur), tr(q.lr), tr(q.ll), tr(q.ul)]
                a, pts = corners[0], corners[1:]
            else:
                continue
            if cur and math.dist(cur[-1], a) < 0.05:
                cur.extend(pts)
            else:
                if len(cur) > 1:
                    strokes.append(cur)
                cur = [a] + pts
        if len(cur) > 1:
            strokes.append(cur)
        if not strokes:
            continue
        color = tuple(round(c, 3) for c in d["color"])
        width = round(d.get("width") or 0, 2)
        key = style_key(color, width)
        sig = (key, tuple(round(v, 1) for s in strokes for p in s for v in p))
        if sig in seen:
            continue
        seen.add(sig)
        out.append(VPath(d.get("seqno", len(out)), key, color, width, [np.array(s, dtype=float) for s in strokes]))
    return out


def page_summary(doc: fitz.Document, index: int) -> Dict[str, Any]:
    """What is on the page: vector paths, positioned text, raster images."""
    page = doc[index]
    rect = page.rect
    area = max(rect.width * rect.height, 1)
    images = []
    cover = 0.0
    try:
        for info in page.get_image_info():
            b = fitz.Rect(info["bbox"])
            frac = (b & rect).get_area() / area
            cover = max(cover, frac)
            images.append({"widthPx": info.get("width"), "heightPx": info.get("height"), "pageCoverage": round(frac, 3)})
    except Exception:
        pass
    if not doc.is_pdf:
        # an uploaded picture (PNG/JPG/TIFF scan): the whole page is one image
        cover = 1.0
        images = [{"widthPx": int(rect.width), "heightPx": int(rect.height), "pageCoverage": 1.0}]
    n_paths = len(page.get_drawings())
    words = page.get_text("words")
    numeric = sum(1 for w in words if _looks_numeric(w[4]))
    if n_paths >= 12 and cover < 0.5:
        kind = "vector"
    elif cover >= 0.5 and n_paths < 12:
        kind = "raster"
    elif cover >= 0.5:
        kind = "mixed"
    else:
        kind = "sparse"
    return {
        "page": index + 1,
        "widthPt": round(rect.width, 2),
        "heightPt": round(rect.height, 2),
        "rotation": page.rotation,
        "vectorPaths": n_paths,
        "textWords": len(words),
        "numericTextWords": numeric,
        "images": images,
        "kind": kind,
    }


def _looks_numeric(s: str) -> bool:
    try:
        float(s.replace(",", ""))
        return True
    except ValueError:
        return False


def text_words(page: fitz.Page) -> List[Dict[str, Any]]:
    """Positioned text spans (real PDF text, not stroked CAD lettering)."""
    rot = page.rotation_matrix
    out = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            d = line.get("dir", (1, 0))
            # direction in sheet coordinates
            v = fitz.Point(d[0], d[1]) * fitz.Matrix(rot.a, rot.b, rot.c, rot.d, 0, 0)
            ang = math.atan2(v.y, v.x)
            for span in line.get("spans", []):
                txt = span.get("text", "").strip()
                if not txt:
                    continue
                r = fitz.Rect(span["bbox"]) * rot
                r.normalize()
                rgb = span.get("color", 0) or 0
                font = span.get("font", "") or ""
                out.append({
                    "text": txt,
                    "bbox": [round(r.x0, 2), round(r.y0, 2), round(r.x1, 2), round(r.y1, 2)],
                    "center": [round((r.x0 + r.x1) / 2, 2), round((r.y0 + r.y1) / 2, 2)],
                    "angle": ang,
                    "size": span.get("size", 0),
                    "color": "rgb(%d,%d,%d)" % ((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255),
                    "italic": bool(span.get("flags", 0) & 2) or "italic" in font.lower() or "oblique" in font.lower(),
                })
    return out


def style_table(paths: List[VPath]) -> List[Dict[str, Any]]:
    """Summarise the line styles on the sheet so an operator can pick which
    ones are contours.  Includes a dash-gap estimate for plotted linetypes."""
    from scipy.spatial import cKDTree

    groups: Dict[str, List[VPath]] = {}
    for p in paths:
        groups.setdefault(p.style, []).append(p)
    rows = []
    for key, ps in groups.items():
        lens = np.array([p.length for p in ps])
        sizes = np.array([p.size for p in ps])
        # Dash gap of a plotted linetype: the distance from the end of one piece
        # to the start of the next piece that continues in the same direction.
        # (Requiring the continuation keeps hatching and lettering out of it.)
        ends, tans, owner = [], [], []
        for i, p in enumerate(ps):
            for s in p.strokes:
                if len(s) < 2:
                    continue
                for pts in (s[::-1], s):
                    v = pts[-1] - pts[-2]
                    nv = float(np.linalg.norm(v))
                    if nv <= 1e-9:
                        continue
                    ends.append(pts[-1]); tans.append(v / nv); owner.append(i)
        gap = None
        gap_list: List[float] = []
        dashed = 0.0
        if len(ends) >= 8:
            ends_a, tans_a = np.array(ends), np.array(tans)
            tree = cKDTree(ends_a)
            own = np.array(owner)
            pairs = tree.query_pairs(30.0, output_type="ndarray")
            gaps = []
            if len(pairs):
                e = np.concatenate([pairs[:, 0], pairs[:, 1]])
                f = np.concatenate([pairs[:, 1], pairs[:, 0]])
                keep = own[e] != own[f]
                e, f = e[keep], f[keep]
                v = ends_a[f] - ends_a[e]
                d = np.linalg.norm(v, axis=1)
                touching = np.zeros(len(ends_a), dtype=bool)
                touching[e[d < 1.0]] = True  # joined to another piece: not a dash end
                far = d >= 1.0
                e, f, v, d = e[far], f[far], v[far], d[far]
                vn = v / d[:, None]
                aligned = (np.einsum("ij,ij->i", tans_a[e], vn) > 0.94) & (np.einsum("ij,ij->i", -tans_a[f], vn) > 0.94)
                best = np.full(len(ends_a), np.inf)
                np.minimum.at(best, e[aligned], d[aligned])
                gaps = best[np.isfinite(best) & ~touching].tolist()
            if len(gaps) >= 10:
                hist, edges = np.histogram(gaps, bins=np.arange(1.0, 30.25, 0.25))
                k = int(hist.argmax())
                share = hist[max(0, k - 1):k + 2].sum() / len(gaps)
                if share > 0.4:
                    gap = float((edges[k] + edges[k + 1]) / 2)
                    dashed = float(share)
                    # A style can carry more than one linetype scale (major
                    # contours drawn with longer dashes and gaps than minors).
                    # Keep every clear peak, most common first.
                    need = max(12, 0.04 * len(gaps))
                    peaks = []
                    for j in range(len(hist)):
                        tot = hist[max(0, j - 1):j + 2].sum()
                        if hist[j] >= hist[max(0, j - 2):j + 3].max() and tot >= need:
                            peaks.append((int(tot), float((edges[j] + edges[j + 1]) / 2)))
                    # ...but only peaks that are the main gap scaled by a whole
                    # factor (the same linetype at another scale).  Other peaks
                    # come from hatching and lettering in the same style.
                    def scaled(g: float) -> bool:
                        r = max(g, gap) / min(g, gap)
                        return abs(r - round(r)) < 0.06 and 1 <= round(r) <= 4
                    gap_list = [gap] + [g for _, g in sorted(peaks, reverse=True) if abs(g - gap) > 0.5 and scaled(g)][:2]
        c = ps[0].color
        rows.append({
            "key": key,
            "color": [round(v, 3) for v in c],
            "width": ps[0].width,
            "paths": len(ps),
            "totalLengthPt": round(float(lens.sum()), 1),
            "medianSizePt": round(float(np.median(sizes)), 2),
            "dashGapPt": round(gap, 2) if gap else None,
            "dashGapsPt": [round(g, 2) for g in gap_list],
            "dashedShare": round(dashed, 2),
            "glyphLike": bool(np.median(sizes) < 14 and np.median([sum(len(s) for s in p.strokes) for p in ps]) >= 4),
        })
    rows.sort(key=lambda r: -r["totalLengthPt"])
    return rows


def render_underlay(page: fitz.Page, out_png: str, px_per_pt: float = 2.0, max_px: int = 6000) -> Dict[str, Any]:
    """Raster copy of the page used as the plan-view underlay.

    The image is only ever displayed stretched over the page rectangle in
    sheet coordinates, so its pixel resolution does not affect registration.
    """
    w, h = page.rect.width, page.rect.height
    scale = min(px_per_pt, max_px / max(w, h))
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csGRAY, alpha=False)
    pix.save(out_png)
    return {"widthPx": pix.width, "heightPx": pix.height, "pxPerPt": round(scale, 4)}


def nearest_polyline(paths: List[VPath], x: float, y: float, tol: float) -> Optional[Dict[str, Any]]:
    """Find the vector polyline closest to a click (for 'adopt line from PDF')."""
    best = None
    p = np.array([x, y])
    for vp in paths:
        b = vp.bbox
        if x < b[0] - tol or x > b[2] + tol or y < b[1] - tol or y > b[3] + tol:
            continue
        for s in vp.strokes:
            a, c = s[:-1], s[1:]
            ab = c - a
            den = (ab * ab).sum(1)
            den[den == 0] = 1
            t = np.clip(((p - a) * ab).sum(1) / den, 0, 1)
            d = np.linalg.norm(a + ab * t[:, None] - p, axis=1).min()
            if d <= tol and (best is None or d < best[0]):
                best = (float(d), vp, s)
    if not best:
        return None
    return {"distancePt": round(best[0], 2), "style": best[1].style, "points": np.round(best[2], 2).tolist()}


def find_cross_marks(paths: List[VPath], min_size: float = 2.5, max_size: float = 8.0) -> List[List[float]]:
    """Centres of small '+' tick marks (two short strokes crossing at right
    angles).  Spot elevations are usually tied to one of these."""
    singles = [p for p in paths if len(p.strokes) == 1 and len(p.strokes[0]) == 2 and min_size <= p.size <= max_size]
    out: List[List[float]] = []
    by_cell: Dict[Tuple[int, int], List[VPath]] = {}
    for p in singles:
        by_cell.setdefault((int(p.center[0] // 2), int(p.center[1] // 2)), []).append(p)
    seen = set()
    for p in singles:
        cx, cy = int(p.center[0] // 2), int(p.center[1] // 2)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in by_cell.get((cx + dx, cy + dy), []):
                    if q is p or np.linalg.norm(q.center - p.center) > 0.6:
                        continue
                    u = p.strokes[0][1] - p.strokes[0][0]
                    v = q.strokes[0][1] - q.strokes[0][0]
                    cosang = abs(float(np.dot(u, v)) / (np.linalg.norm(u) * np.linalg.norm(v) + 1e-9))
                    key = (round(float(p.center[0]), 1), round(float(p.center[1]), 1))
                    if cosang < 0.2 and key not in seen:
                        seen.add(key)
                        out.append([round(float(p.center[0]), 2), round(float(p.center[1]), 2)])
    return out


def nearest_vertex(paths: List[VPath], x: float, y: float, tol: float) -> Optional[List[float]]:
    """Closest line end or corner in the vector drawing (for exact calibration picks)."""
    best = None
    q = np.array([x, y])
    for vp in paths:
        b = vp.bbox
        if x < b[0] - tol or x > b[2] + tol or y < b[1] - tol or y > b[3] + tol:
            continue
        for s in vp.strokes:
            d = np.linalg.norm(s - q, axis=1)
            k = int(d.argmin())
            if d[k] <= tol and (best is None or d[k] < best[0]):
                best = (float(d[k]), s[k])
    return None if best is None else [round(float(best[1][0]), 2), round(float(best[1][1]), 2)]
