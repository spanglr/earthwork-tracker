"""Turn plotted line work into candidate contours with elevations.

Steps
  1. chain_dashes      - join the dashes of a plotted linetype into polylines
  2. attach_labels     - tie printed elevation labels to the line they sit on
  3. infer_elevations  - fill in unlabeled lines by counting between labeled ones
  4. neighbour_check   - evidence: do adjacent lines differ by one interval?

Nothing here invents geometry or heights from outside the sheet.  A line that
cannot be tied to a printed label by an exact count stays unassigned.
"""
from __future__ import annotations

import hashlib
import math
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
from scipy.spatial import cKDTree
from shapely.geometry import LineString
from shapely.strtree import STRtree


# --------------------------------------------------------------------------- helpers
def _length(pts: np.ndarray) -> float:
    return float(np.linalg.norm(np.diff(pts, axis=0), axis=1).sum())


def _end_tangent(pts: np.ndarray, at_start: bool, back: float = 4.0) -> np.ndarray:
    """Unit vector pointing out of the polyline at one of its ends."""
    p = pts if not at_start else pts[::-1]
    end = p[-1]
    acc = 0.0
    ref = p[0]
    for i in range(len(p) - 2, -1, -1):
        acc += float(np.linalg.norm(p[i + 1] - p[i]))
        ref = p[i]
        if acc >= back:
            break
    v = end - ref
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-9 else np.array([1.0, 0.0])


def _angle(u: np.ndarray, v: np.ndarray) -> float:
    return math.degrees(math.acos(max(-1.0, min(1.0, float(np.dot(u, v))))))


def _find(parent: List[int], i: int) -> int:
    while parent[i] != i:
        parent[i] = parent[parent[i]]
        i = parent[i]
    return i


def contour_id(points: np.ndarray) -> str:
    """Stable id from geometry so reviews survive a re-run of extraction."""
    a, b = points[0], points[-1]
    if (b[0], b[1]) < (a[0], a[1]):
        a, b = b, a
    m = points[len(points) // 2]
    raw = "%.0f,%.0f|%.0f,%.0f|%.0f,%.0f|%d" % (a[0], a[1], b[0], b[1], m[0], m[1], len(points))
    return "c-" + hashlib.sha1(raw.encode()).hexdigest()[:8]


# --------------------------------------------------------------------------- 1. chaining
def chain_dashes(
    polys: Sequence[np.ndarray],
    dash_gap: Optional[float],
    join_tol: float = 0.6,
    gap_tol: float = 0.9,
    max_turn_deg: float = 40.0,
    min_length: float = 30.0,
    max_join_turn_deg: float = 70.0,
) -> List[Dict[str, Any]]:
    """Join polylines that touch or that are separated by one dash gap.

    Line work that branches (walls, hatching, symbols drawn in the same style)
    is discarded: a contour is a simple chain.  When the style is dashed, a
    chain must contain at least one dash gap, which drops solid building lines.
    """
    polys = [p for p in polys if len(p) >= 2 and _length(p) > 0.3]
    n = len(polys)
    if n == 0:
        return []
    ends = np.array([p[0] for p in polys] + [p[-1] for p in polys])  # index e: poly e % n, start if e < n
    parent = list(range(2 * n))
    tree = cKDTree(ends)
    for a, b in tree.query_pairs(join_tol):
        if a % n == b % n:
            continue  # do not close a tiny path on itself here
        # Pieces that touch are joined unless they meet at a sharp corner
        # (a contour running into a wall line drawn in the same style).
        if _angle(_end_tangent(polys[a % n], a < n), -_end_tangent(polys[b % n], b < n)) > max_join_turn_deg:
            continue
        ra, rb = _find(parent, a), _find(parent, b)
        if ra != rb:
            parent[ra] = rb
    node = [_find(parent, e) for e in range(2 * n)]
    degree = Counter(node)
    # Where three or more pieces meet (a contour running into wall hatching, a
    # symbol, a leader) the pieces are separated again: each one simply ends
    # there.  Ends at such a junction are not offered for dash linking.
    junction_end = [degree[node[e]] > 2 for e in range(2 * n)]
    for e in range(2 * n):
        if junction_end[e]:
            node[e] = 2 * n + e
    degree = Counter(node)

    links: List[Tuple[int, int]] = []
    if dash_gap:
        free = [e for e in range(2 * n) if degree[node[e]] == 1 and not junction_end[e]]
        tang = {e: _end_tangent(polys[e % n], e < n) for e in free}
        free_set = set(free)
        cand: Dict[int, Tuple[float, int]] = {}
        for e in free:
            for f in tree.query_ball_point(ends[e], dash_gap + gap_tol):
                if f == e or f not in free_set or f % n == e % n:
                    continue
                v = ends[f] - ends[e]
                d = float(np.linalg.norm(v))
                if d < dash_gap - gap_tol:
                    continue
                v = v / d
                a1, a2 = _angle(tang[e], v), _angle(-tang[f], v)
                if a1 > max_turn_deg or a2 > max_turn_deg:
                    continue
                score = a1 + a2 + abs(d - dash_gap) * 10
                if e not in cand or score < cand[e][0]:
                    cand[e] = (score, f)
        for e, (_, f) in cand.items():
            if f in cand and cand[f][1] == e and e < f:
                links.append((e, f))

    # adjacency over nodes: poly edges + dash links
    adj: Dict[int, List[Tuple[str, int, int]]] = defaultdict(list)  # node -> (kind, id, other node)
    for i in range(n):
        a, b = node[i], node[i + n]
        adj[a].append(("p", i, b))
        adj[b].append(("p", i, a))
    for li, (e, f) in enumerate(links):
        adj[node[e]].append(("l", li, node[f]))
        adj[node[f]].append(("l", li, node[e]))

    comp_parent = {k: k for k in adj}

    def cfind(x):
        while comp_parent[x] != x:
            comp_parent[x] = comp_parent[comp_parent[x]]
            x = comp_parent[x]
        return x

    for k, lst in adj.items():
        for _, _, o in lst:
            ra, rb = cfind(k), cfind(o)
            if ra != rb:
                comp_parent[ra] = rb
    comps: Dict[int, List[int]] = defaultdict(list)
    for k in adj:
        comps[cfind(k)].append(k)

    chains = []
    for nodes in comps.values():
        if any(len(adj[k]) > 2 for k in nodes):
            continue  # branching line work: not a contour
        starts = [k for k in nodes if len(adj[k]) == 1]
        closed = not starts
        cur = starts[0] if starts else nodes[0]
        pts: List[np.ndarray] = []
        used = set()
        n_links = 0
        dash_len = 0.0
        while True:
            step = next(((kind, idx, o) for kind, idx, o in adj[cur] if (kind, idx) not in used), None)
            if step is None:
                break
            kind, idx, other = step
            used.add((kind, idx))
            if kind == "p":
                p = polys[idx]
                if node[idx] != cur:
                    p = p[::-1]
                elif node[idx] == node[idx + n] and pts and np.linalg.norm(p[0] - pts[-1]) > np.linalg.norm(p[-1] - pts[-1]):
                    p = p[::-1]
                seg = list(p)
                if pts and np.linalg.norm(seg[0] - pts[-1]) < join_tol * 2:
                    seg = seg[1:]
                pts.extend(seg)
                dash_len += _length(polys[idx])
            else:
                n_links += 1
            cur = other
        if len(pts) < 2:
            continue
        arr = np.array(pts)
        if dash_gap and n_links == 0:
            continue
        if _length(arr) < min_length:
            continue
        chains.append({"points": arr, "dashGaps": n_links, "inkLengthPt": round(dash_len, 1), "closed": closed})
    return chains


# --------------------------------------------------------------------------- 2. labels
def attach_labels(chains: List[Dict[str, Any]], labels: List[Dict[str, Any]], interval: float, index_interval: float) -> None:
    """Tie each label to the contour it sits on.

    A label normally sits in a break in the line: the two line ends on either
    side point at it.  Those ends are bridged into one contour.  Otherwise the
    label is attached to a line passing directly under/next to it.
    Mutates `chains` (may merge) and sets label['contour'] / chain['labels'].
    """
    for c in chains:
        c.setdefault("labels", [])
        c.setdefault("bridges", [])
    for li, lab in enumerate(labels):
        lab["id"] = "L%03d" % li
        lab["attached"] = []
        value = lab["value"]
        if abs(value / interval - round(value / interval)) > 1e-6:
            lab["note"] = "not a multiple of the contour interval"
            continue
        center = np.array(lab["center"], dtype=float)
        reach = lab.get("widthPt", 16) / 2 + 3.5 * lab.get("heightPt", 6) + 2
        hits = []  # (distance, chain index, at_start)
        for ci, c in enumerate(chains):
            if c.get("dead") or c.get("closed"):
                continue
            if c["kind"] == "index" and abs(value / index_interval - round(value / index_interval)) > 1e-6:
                continue
            for at_start in (True, False):
                end = c["points"][0] if at_start else c["points"][-1]
                v = center - end
                d = float(np.linalg.norm(v))
                if d > reach or d < 1e-6:
                    continue
                if _angle(_end_tangent(c["points"], at_start, back=8), v / d) > 38:
                    continue
                hits.append((d, ci, at_start))
        hits.sort()
        hits = hits[:2]
        if len(hits) == 2 and hits[0][1] != hits[1][1]:
            (d1, c1, s1), (d2, c2, s2) = hits
            t1 = _end_tangent(chains[c1]["points"], s1, back=8)
            t2 = _end_tangent(chains[c2]["points"], s2, back=8)
            if chains[c1]["kind"] == chains[c2]["kind"] and _angle(t1, -t2) < 50:
                a = chains[c1]["points"] if not s1 else chains[c1]["points"][::-1]
                b = chains[c2]["points"] if s2 else chains[c2]["points"][::-1]
                merged = chains[c1]
                merged["bridges"] = merged["bridges"] + chains[c2]["bridges"] + [{
                    "label": lab["id"], "from": np.round(a[-1], 2).tolist(), "to": np.round(b[0], 2).tolist()}]
                merged["points"] = np.vstack([a, b])
                merged["dashGaps"] += chains[c2]["dashGaps"]
                merged["inkLengthPt"] += chains[c2]["inkLengthPt"]
                merged["labels"] = merged["labels"] + chains[c2]["labels"] + [{"label": lab["id"], "how": "in a break in the line", "distancePt": round(max(d1, d2), 1)}]
                chains[c2]["dead"] = True
                lab["attached"] = [c1]
                continue
        if hits:
            for d, ci, _ in hits:
                chains[ci]["labels"].append({"label": lab["id"], "how": "at the end of the line", "distancePt": round(d, 1)})
                lab["attached"].append(ci)
            continue
        # fallback: label drawn on / beside a continuous line
        best = None
        for ci, c in enumerate(chains):
            if c.get("dead"):
                continue
            if c["kind"] == "index" and abs(value / index_interval - round(value / index_interval)) > 1e-6:
                continue
            p = c["points"]
            a, b = p[:-1], p[1:]
            ab = b - a
            den = (ab * ab).sum(1)
            den[den == 0] = 1
            t = np.clip(((center - a) * ab).sum(1) / den, 0, 1)
            dist = np.linalg.norm(a + ab * t[:, None] - center, axis=1)
            k = int(dist.argmin())
            if dist[k] > lab.get("heightPt", 6) * 1.3:
                continue
            seg = ab[k] / max(float(np.linalg.norm(ab[k])), 1e-9)
            la = np.array([math.cos(lab["angle"]), math.sin(lab["angle"])])
            if min(_angle(seg, la), _angle(-seg, la)) > 30:
                continue
            if best is None or dist[k] < best[0]:
                best = (float(dist[k]), ci)
        if best:
            chains[best[1]]["labels"].append({"label": lab["id"], "how": "printed on the line", "distancePt": round(best[0], 1)})
            lab["attached"] = [best[1]]
    chains[:] = [c for c in chains if not c.get("dead")]


# --------------------------------------------------------------------------- 3. inference
class _Field:
    """Ray casting across a set of contour polylines."""

    def __init__(self, chains: Sequence[Dict[str, Any]]):
        self.lines = [LineString(c["points"]) for c in chains]
        self.tree = STRtree(self.lines)

    def crossings(self, origin: np.ndarray, direction: np.ndarray, reach: float, skip: int) -> List[Tuple[float, int]]:
        ray = LineString([origin + direction * 0.5, origin + direction * reach])
        out = []
        for idx in self.tree.query(ray):
            idx = int(idx)
            inter = ray.intersection(self.lines[idx])
            if inter.is_empty:
                continue
            geoms = getattr(inter, "geoms", [inter])
            for g in geoms:
                if g.geom_type == "Point":
                    out.append((float(np.hypot(g.x - origin[0], g.y - origin[1])), idx))
                elif g.geom_type in ("LineString", "MultiPoint"):
                    for x, y in (g.coords if g.geom_type == "LineString" else [(q.x, q.y) for q in g.geoms]):
                        out.append((float(np.hypot(x - origin[0], y - origin[1])), idx))
        out.sort()
        # Meeting the contour we started from again means the cross-line has
        # wrapped round a bend or a closed loop: nothing beyond that counts.
        for k, (_, idx) in enumerate(out):
            if idx == skip:
                return out[:k]
        return out


def _samples(points: np.ndarray, step: float) -> List[Tuple[np.ndarray, np.ndarray]]:
    """(point, unit normal) pairs spaced along a polyline."""
    seg = np.diff(points, axis=0)
    seglen = np.linalg.norm(seg, axis=1)
    total = float(seglen.sum())
    if total <= 0:
        return []
    count = max(2, int(total / step))
    out = []
    cum = np.concatenate([[0], np.cumsum(seglen)])
    for k in range(count):
        s = total * (k + 0.5) / count
        i = min(int(np.searchsorted(cum, s, side="right") - 1), len(seg) - 1)
        if seglen[i] <= 0:
            continue
        t = (s - cum[i]) / seglen[i]
        d = seg[i] / seglen[i]
        out.append((points[i] + seg[i] * t, np.array([-d[1], d[0]])))
    return out


def infer_elevations(chains: List[Dict[str, Any]], interval: float, reach_pt: float, step_pt: float = 22.0, passes: int = 8) -> None:
    """Assign heights to unlabeled contours by counting lines between known ones.

    Along a short line drawn square across a contour, the neighbouring contours
    are met in order.  If a known contour lies on each side and the number of
    lines between them is exactly (height difference / interval), every line in
    between has a definite height.  Each cross-line is one vote; a contour is
    assigned when the votes agree.  Outside the outermost labeled contour the
    count is continued in the same direction ("extended") and marked as such.
    """
    field = _Field(chains)
    rays: Dict[int, List[Tuple[List[Tuple[float, int]], List[Tuple[float, int]]]]] = {}
    for ci, c in enumerate(chains):
        rays[ci] = [(field.crossings(p, nrm, reach_pt, ci), field.crossings(p, -nrm, reach_pt, ci)) for p, nrm in _samples(c["points"], step_pt)]

    def known(ci: int) -> Optional[float]:
        return chains[ci].get("elevation")

    def first_known(seq: List[Tuple[float, int]], start: int = 0) -> Optional[int]:
        for i in range(start, len(seq)):
            if known(seq[i][1]) is not None:
                return i
        return None

    for mode in ("between", "extended", "between", "extended"):
        for _ in range(passes):
            new: Dict[int, Dict[str, Any]] = {}
            for ci, c in enumerate(chains):
                if known(ci) is not None:
                    continue
                votes: Counter = Counter()
                detail: Dict[float, Any] = {}
                total = 0
                for plus, minus in rays[ci]:
                    a, b = first_known(plus), first_known(minus)
                    if mode == "between":
                        if a is None or b is None:
                            continue
                        total += 1
                        ea, eb = known(plus[a][1]), known(minus[b][1])
                        steps = (a + 1) + (b + 1)
                        if abs(abs(ea - eb) - steps * interval) > 1e-6:
                            continue
                        e = round(ea + (eb - ea) * (a + 1) / steps, 4)
                        votes[e] += 1
                        detail[e] = {"between": sorted([ea, eb]), "linesBetween": steps - 1}
                    else:
                        for seq, i in ((plus, a), (minus, b)):
                            if i is None:
                                continue
                            j = first_known(seq, i + 1)
                            if j is None:
                                continue
                            ei, ej = known(seq[i][1]), known(seq[j][1])
                            if abs(abs(ej - ei) - (j - i) * interval) > 1e-6:
                                continue
                            total += 1
                            per = (ej - ei) / (j - i)
                            e = round(ei - per * (i + 1), 4)
                            votes[e] += 1
                            detail[e] = {"continuedFrom": [ei, ej], "linesFromNearestKnown": i + 1}
                if not votes:
                    continue
                e, n_agree = votes.most_common(1)[0]
                n_votes = sum(votes.values())
                if n_agree >= 2 and n_agree / n_votes >= 0.7:
                    new[ci] = {"elevation": e, "method": mode, "votes": n_votes, "agree": n_agree, "crossLines": len(rays[ci]), **detail[e]}
            if not new:
                break
            for ci, ev in new.items():
                chains[ci]["elevation"] = ev.pop("elevation")
                chains[ci]["source"] = "inferred"
                chains[ci]["inference"] = ev


def neighbour_check(chains: List[Dict[str, Any]], interval: float, reach_pt: float, step_pt: float = 22.0) -> None:
    """Evidence for review: compare each contour with the first line met on
    either side.  On a consistent sheet they differ by exactly one interval."""
    field = _Field(chains)
    for ci, c in enumerate(chains):
        e = c.get("elevation")
        ok = bad = 0
        seen: Counter = Counter()
        if e is not None:
            for p, nrm in _samples(c["points"], step_pt):
                for d in (nrm, -nrm):
                    cr = field.crossings(p, d, reach_pt, ci)
                    if not cr:
                        continue
                    other = chains[cr[0][1]].get("elevation")
                    if other is None:
                        continue
                    if abs(abs(other - e) - interval) < 1e-6:
                        ok += 1
                    else:
                        bad += 1
                    seen[other] += 1
        c["neighbours"] = {"consistent": ok, "inconsistent": bad, "adjacentHeights": sorted(seen)}
