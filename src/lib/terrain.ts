import Delaunator from "delaunator";
import type { Contour, Project, Pt } from "../types";

export type Provenance = "label" | "inferred" | "manual";

export interface Effective {
  elevation: number | null;
  /** Where the height came from. null = no height yet. */
  provenance: Provenance | null;
  status: "pending" | "accepted" | "rejected";
  /** True when this line is part of the existing-ground surface. */
  inTerrain: boolean;
}

/** The single rule for what a contour's height is and whether it is used. */
export function effective(c: Contour): Effective {
  const manual = c.review.elevation != null;
  const elevation = manual ? c.review.elevation : c.auto?.elevation ?? null;
  let provenance: Provenance | null = null;
  if (elevation != null) provenance = manual || c.review.confirmed ? "manual" : (c.auto?.source ?? null);
  const status = c.review.status;
  return { elevation, provenance, status, inTerrain: status === "accepted" && elevation != null && c.surface === "existing" };
}

export function polylineLength(points: Pt[]): number {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return s;
}

/** Points at roughly `step` spacing along a polyline, keeping its vertices. */
export function densify(points: Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 0; k < n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  if (points.length) out.push(points[points.length - 1]);
  return out;
}

export interface Tin {
  /** Vertex positions in sheet points (x, y) and height in feet. */
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  triangles: Uint32Array;
  /** Triangles left out of the surface because an edge was longer than the gap
   *  limit.  They are never sampled or measured; the realistic 3D look draws
   *  them as plain "not modelled" pads so the block of ground has no holes. */
  gapTriangles: Uint32Array;
  feetPerPoint: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number; minZ: number; maxZ: number } | null;
  stats: { contours: number; points: number; triangles: number; droppedLongEdge: number; areaSqFt: number; heightConflicts: number };
  /** Height of the surface at a sheet position, or null where it is not modelled. */
  sample(x: number, y: number): number | null;
}

/**
 * Triangulate the accepted existing-ground contours.
 *
 * The only inputs are contour vertices with their reviewed heights.  Triangles
 * with an edge longer than `maxEdgeFt` are dropped, which leaves areas with no
 * contour support (building footprints, sheet margins) unmodelled instead of
 * bridging them with made-up ground.  The result depends only on the saved
 * project, so reopening a project gives the same surface.
 */
export function buildTin(project: Pick<Project, "contours" | "calibration" | "terrain">): Tin {
  const fpp = project.calibration?.feetPerPoint ?? 0;
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const seen = new Map<string, number>();
  let used = 0;
  let conflicts = 0;
  if (fpp > 0) {
    const step = Math.max(project.terrain.sampleFt, 0.5) / fpp;
    for (const c of project.contours) {
      const e = effective(c);
      if (!e.inTerrain || c.points.length < 2) continue;
      used++;
      for (const [px, py] of densify(c.points, step)) {
        const key = Math.round(px * 10) + ":" + Math.round(py * 10);
        const prev = seen.get(key);
        if (prev != null) {
          if (zs[prev] !== e.elevation) conflicts++;
          continue;
        }
        seen.set(key, xs.length);
        xs.push(px);
        ys.push(py);
        zs.push(e.elevation as number);
      }
    }
  }
  const n = xs.length;
  const x = Float64Array.from(xs);
  const y = Float64Array.from(ys);
  const z = Float64Array.from(zs);
  const keep: number[] = [];
  const gaps: number[] = [];
  let dropped = 0;
  let areaPt = 0;
  if (n >= 3) {
    const coords = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      coords[2 * i] = x[i];
      coords[2 * i + 1] = y[i];
    }
    const d = new Delaunator(coords);
    const maxEdgePt = project.terrain.maxEdgeFt / fpp;
    const max2 = maxEdgePt * maxEdgePt;
    for (let t = 0; t < d.triangles.length; t += 3) {
      const a = d.triangles[t], b = d.triangles[t + 1], c = d.triangles[t + 2];
      const ab = (x[a] - x[b]) ** 2 + (y[a] - y[b]) ** 2;
      const bc = (x[b] - x[c]) ** 2 + (y[b] - y[c]) ** 2;
      const ca = (x[c] - x[a]) ** 2 + (y[c] - y[a]) ** 2;
      const area = Math.abs((x[b] - x[a]) * (y[c] - y[a]) - (x[c] - x[a]) * (y[b] - y[a])) / 2;
      if (area < 1e-6) continue;
      if (ab > max2 || bc > max2 || ca > max2) {
        dropped++;
        gaps.push(a, b, c);
        continue;
      }
      keep.push(a, b, c);
      areaPt += area;
    }
  }
  const triangles = Uint32Array.from(keep);
  const gapTriangles = Uint32Array.from(gaps);

  let bbox: Tin["bbox"] = null;
  if (triangles.length) {
    bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const i of triangles) {
      bbox.minX = Math.min(bbox.minX, x[i]); bbox.maxX = Math.max(bbox.maxX, x[i]);
      bbox.minY = Math.min(bbox.minY, y[i]); bbox.maxY = Math.max(bbox.maxY, y[i]);
      bbox.minZ = Math.min(bbox.minZ, z[i]); bbox.maxZ = Math.max(bbox.maxZ, z[i]);
    }
  }

  // uniform grid over triangle bounding boxes for point location
  const cell = bbox ? Math.max((bbox.maxX - bbox.minX) / 80, (bbox.maxY - bbox.minY) / 80, 1) : 1;
  const grid = new Map<number, number[]>();
  const cols = bbox ? Math.floor((bbox.maxX - bbox.minX) / cell) + 1 : 1;
  if (bbox) {
    for (let t = 0; t < triangles.length; t += 3) {
      const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2];
      const gx0 = Math.floor((Math.min(x[a], x[b], x[c]) - bbox.minX) / cell);
      const gx1 = Math.floor((Math.max(x[a], x[b], x[c]) - bbox.minX) / cell);
      const gy0 = Math.floor((Math.min(y[a], y[b], y[c]) - bbox.minY) / cell);
      const gy1 = Math.floor((Math.max(y[a], y[b], y[c]) - bbox.minY) / cell);
      for (let gy = gy0; gy <= gy1; gy++)
        for (let gx = gx0; gx <= gx1; gx++) {
          const k = gy * cols + gx;
          let list = grid.get(k);
          if (!list) grid.set(k, (list = []));
          list.push(t);
        }
    }
  }

  function sample(px: number, py: number): number | null {
    if (!bbox || px < bbox.minX || px > bbox.maxX || py < bbox.minY || py > bbox.maxY) return null;
    const list = grid.get(Math.floor((py - bbox.minY) / cell) * cols + Math.floor((px - bbox.minX) / cell));
    if (!list) return null;
    for (const t of list) {
      const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2];
      const det = (y[b] - y[c]) * (x[a] - x[c]) + (x[c] - x[b]) * (y[a] - y[c]);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((y[b] - y[c]) * (px - x[c]) + (x[c] - x[b]) * (py - y[c])) / det;
      const l2 = ((y[c] - y[a]) * (px - x[c]) + (x[a] - x[c]) * (py - y[c])) / det;
      const l3 = 1 - l1 - l2;
      const eps = -1e-9;
      if (l1 >= eps && l2 >= eps && l3 >= eps) return l1 * z[a] + l2 * z[b] + l3 * z[c];
    }
    return null;
  }

  return {
    x, y, z, triangles, gapTriangles, feetPerPoint: fpp, bbox, sample,
    stats: { contours: used, points: n, triangles: triangles.length / 3, droppedLongEdge: dropped, areaSqFt: areaPt * fpp * fpp, heightConflicts: conflicts },
  };
}

/** Short fingerprint of a surface, used to show that a reopened project
 *  reproduces the same terrain. */
export function tinFingerprint(tin: Tin): string {
  let h = 2166136261;
  const mix = (v: number) => {
    h ^= v;
    h = Math.imul(h, 16777619);
  };
  for (let i = 0; i < tin.x.length; i++) {
    mix(Math.round(tin.x[i] * 100));
    mix(Math.round(tin.y[i] * 100));
    mix(Math.round(tin.z[i] * 100));
  }
  for (const t of tin.triangles) mix(t);
  return (h >>> 0).toString(16).padStart(8, "0") + "-" + tin.x.length + "-" + tin.triangles.length / 3;
}

export function pointInPolygon(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(a) / 2;
}

export function polygonCentroid(poly: Pt[]): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f;
    cx += (poly[j][0] + poly[i][0]) * f;
    cy += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return poly[0] ?? [0, 0];
  return [cx / (3 * a), cy / (3 * a)];
}

export function distToPolyline(points: Pt[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const dx = x1 - x0, dy = y1 - y0;
    const den = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / den));
    best = Math.min(best, Math.hypot(x0 + dx * t - x, y0 + dy * t - y));
  }
  return best;
}

/** A mesh draped on the surface inside a polygon (for colouring a ditch in 3D). */
export function drapePolygon(tin: Tin, poly: Pt[], spacingPt: number): { positions: Pt[]; heights: number[]; triangles: number[] } {
  const pts: Pt[] = [];
  const ring = densify([...poly, poly[0]], spacingPt);
  ring.pop();
  for (const p of ring) pts.push(p);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of poly) {
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  for (let gy = minY + spacingPt / 2; gy < maxY; gy += spacingPt)
    for (let gx = minX + spacingPt / 2; gx < maxX; gx += spacingPt)
      if (pointInPolygon(gx, gy, poly) && distToPolyline([...poly, poly[0]], gx, gy) > spacingPt * 0.35) pts.push([gx, gy]);
  const heights = pts.map(([px, py]) => tin.sample(px, py) ?? NaN);
  const out: number[] = [];
  if (pts.length >= 3) {
    const d = Delaunator.from(pts);
    for (let t = 0; t < d.triangles.length; t += 3) {
      const a = d.triangles[t], b = d.triangles[t + 1], c = d.triangles[t + 2];
      if (Number.isNaN(heights[a]) || Number.isNaN(heights[b]) || Number.isNaN(heights[c])) continue;
      const cx = (pts[a][0] + pts[b][0] + pts[c][0]) / 3;
      const cy = (pts[a][1] + pts[b][1] + pts[c][1]) / 3;
      if (pointInPolygon(cx, cy, poly)) out.push(a, b, c);
    }
  }
  return { positions: pts, heights, triangles: out };
}
