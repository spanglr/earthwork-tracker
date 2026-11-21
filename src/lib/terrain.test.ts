import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { buildTin, effective, tinFingerprint } from "./terrain";
import type { Project } from "../types";

// The demo project is produced by `npm run demo:rebuild` (backend/demo.py)
// from the real sheet C-2.1.  These tests read the saved project file, i.e.
// exactly what the app opens.
const file = new URL("../../projects/pittsburgh-demo/project.json", import.meta.url);
const have = existsSync(file);
const project: Project = have ? JSON.parse(readFileSync(file, "utf8")) : (null as any);

describe.skipIf(!have)("Pittsburgh demo terrain", () => {
  const tin = have ? buildTin(project) : (null as any);

  it("is calibrated to the printed scale (1 inch = 10 ft)", () => {
    expect(project.calibration!.feetPerPoint).toBeCloseTo(10 / 72, 6);
  });

  it("is built only from accepted existing-ground contours taken from the sheet", () => {
    const used = project.contours.filter((c) => effective(c).inTerrain);
    expect(used.length).toBeGreaterThan(50);
    expect(used.every((c) => c.surface === "existing" && c.review.status === "accepted")).toBe(true);
    expect(used.every((c) => c.origin === "vector" || c.origin === "traced" || c.origin === "adopted")).toBe(true);
    expect(tin.stats.contours).toBe(used.length);
    expect(tin.stats.triangles).toBeGreaterThan(2000);
    expect(tin.stats.heightConflicts).toBe(0);
    expect(tin.bbox!.minZ).toBeGreaterThanOrEqual(960);
    expect(tin.bbox!.maxZ).toBeLessThanOrEqual(1000);
  });

  it("records where every height came from", () => {
    const used = project.contours.filter((c) => effective(c).inTerrain);
    const by = { label: 0, inferred: 0, manual: 0 } as Record<string, number>;
    for (const c of used) by[effective(c).provenance!]++;
    expect(by.label).toBeGreaterThanOrEqual(12);
    expect(by.inferred).toBeGreaterThanOrEqual(40);
    expect(by.manual).toBeGreaterThanOrEqual(1);
    for (const c of used) {
      const e = effective(c);
      if (e.provenance === "label") expect(c.auto!.labels.length).toBeGreaterThan(0);
      if (e.provenance === "inferred") expect(c.auto!.inference!.agree).toBeGreaterThanOrEqual(2);
      if (e.provenance === "manual") expect(c.review.note.length).toBeGreaterThan(10);
    }
  });

  it("matches the independent printed ground elevations within half a contour interval", () => {
    const independent = project.checkPoints.filter((p) => p.role === "independent" && p.refersTo === "existing-ground");
    expect(independent.length).toBeGreaterThanOrEqual(3);
    for (const p of independent) {
      const z = tin.sample(p.x, p.y);
      expect(z, p.label).not.toBeNull();
      expect(Math.abs((z as number) - p.printed), `${p.label}: surface ${z}`).toBeLessThanOrEqual(project.contourInterval / 2);
    }
  });

  it("leaves the existing building footprint unmodelled", () => {
    expect(tin.sample(930, 800)).toBeNull();
    expect(tin.sample(950, 1000)).toBeNull();
  });

  it("gives the same surface every time the saved project is opened", () => {
    const again = buildTin(JSON.parse(readFileSync(file, "utf8")));
    expect(tinFingerprint(again)).toBe(tinFingerprint(tin));
  });

  it("changes when a contour is rejected and returns when it is restored", () => {
    const copy: Project = JSON.parse(JSON.stringify(project));
    const target = copy.contours.find((c) => effective(c).inTerrain)!;
    target.review.status = "rejected";
    expect(tinFingerprint(buildTin(copy))).not.toBe(tinFingerprint(tin));
    target.review.status = "accepted";
    expect(tinFingerprint(buildTin(copy))).toBe(tinFingerprint(tin));
  });
});

// The practice demo is built from samples/practice-plan.pdf, which ships with
// the code, so this runs on a fresh clone once the app has been started once
// (or after `npm run demo:rebuild`).
const practiceFile = new URL("../../projects/practice-demo/project.json", import.meta.url);
const havePractice = existsSync(practiceFile);

describe.skipIf(!havePractice)("Practice demo terrain", () => {
  const practice: Project = havePractice ? JSON.parse(readFileSync(practiceFile, "utf8")) : (null as any);
  const tin = havePractice ? buildTin(practice) : (null as any);

  it("uses the sheet's own scale and interval (1 inch = 20 ft, 2 ft contours)", () => {
    expect(practice.calibration!.feetPerPoint).toBeCloseTo(20 / 72, 6);
    expect(practice.contourInterval).toBe(2);
    expect(tin.stats.contours).toBe(11);
  });

  it("keeps the left-out triangles for drawing but never measures on them", () => {
    expect(tin.gapTriangles.length / 3).toBe(tin.stats.droppedLongEdge);
    expect(tin.gapTriangles.length).toBeGreaterThan(0);
    // centre of the first gap triangle: outside the measured surface unless a kept triangle also covers it
    const [a, b, c] = [tin.gapTriangles[0], tin.gapTriangles[1], tin.gapTriangles[2]];
    const gx = (tin.x[a] + tin.x[b] + tin.x[c]) / 3;
    const gy = (tin.y[a] + tin.y[b] + tin.y[c]) / 3;
    expect(tin.sample(gx, gy)).toBeNull();
  });

  it("matches both printed spot elevations within half a contour interval", () => {
    for (const p of practice.checkPoints) {
      const z = tin.sample(p.x, p.y);
      expect(z, p.label).not.toBeNull();
      expect(Math.abs((z as number) - p.printed), `${p.label}: surface ${z}`).toBeLessThanOrEqual(practice.contourInterval / 2);
    }
  });
});
