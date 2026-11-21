import { useEffect, useMemo } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { densify, drapePolygon, effective, polygonCentroid, type Tin } from "../lib/terrain";
import { terrainTint, textOn } from "../lib/colors";
import type { Contour, Ditch } from "../types";

interface Props {
  tin: Tin;
  contours: Contour[];
  ditches: Ditch[];
  /** fill colour and short value text per ditch id */
  ditchStyle: Record<string, { fill: string; text: string }>;
  selectedDitchId: string | null;
  onSelectDitch(id: string | null): void;
  /** 1 = true vertical scale */
  exaggeration: number;
}

function useDisposable<T extends { dispose(): void }>(make: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const obj = useMemo(make, deps);
  useEffect(() => () => obj.dispose(), [obj]);
  return obj;
}

/** Place the camera so the whole surface fits the pane, whatever its shape. */
function FitCamera({ radius, targetY, fitKey }: { radius: number; targetY: number; fitKey: string }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const controls = useThree((s) => s.controls) as any;
  const ready = size.width > 0 && size.height > 0;
  useEffect(() => {
    if (!ready) return;
    const v = (camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(v / 2) * (size.width / size.height));
    const dist = (radius / Math.sin(Math.min(v, hfov) / 2)) * 0.92;
    const target = new THREE.Vector3(0, targetY, 0);
    camera.position.copy(target).addScaledVector(new THREE.Vector3(0.3, 0.62, 0.72).normalize(), dist);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.copy(target);
      controls.update();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, ready, controls]);
  return null;
}

/**
 * Orbitable view of the same surface the plan shows.  Horizontal units are
 * feet from the sheet calibration; vertical units are feet times the chosen
 * exaggeration (1 by default).  Ditches are coloured overlays draped on the
 * surveyed ground: tickets do not move the ground.
 */
export function Terrain3D({ tin, contours, ditches, ditchStyle, selectedDitchId, onSelectDitch, exaggeration }: Props) {
  const bb = tin.bbox!;
  const f = tin.feetPerPoint;
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  const X = (x: number) => (x - cx) * f;
  const Z = (y: number) => (y - cy) * f;
  const Y = (z: number) => (z - bb.minZ) * exaggeration;
  const widthFt = (bb.maxX - bb.minX) * f;
  const depthFt = (bb.maxY - bb.minY) * f;
  const ext = Math.max(widthFt, depthFt);
  const relief = (bb.maxZ - bb.minZ) * exaggeration;

  const terrainGeom = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    const n = tin.x.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const span = Math.max(bb.maxZ - bb.minZ, 1e-6);
    for (let i = 0; i < n; i++) {
      pos[3 * i] = X(tin.x[i]);
      pos[3 * i + 1] = Y(tin.z[i]);
      pos[3 * i + 2] = Z(tin.y[i]);
      const [r, gg, b] = terrainTint((tin.z[i] - bb.minZ) / span);
      col[3 * i] = r; col[3 * i + 1] = gg; col[3 * i + 2] = b;
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(tin.triangles, 1));
    g.computeVertexNormals();
    return g;
  }, [tin, exaggeration]);

  const lineGeoms = useDisposable(() => {
    const groups: Record<string, number[]> = { index: [], intermediate: [], proposed: [] };
    for (const c of contours) {
      const e = effective(c);
      if (e.status !== "accepted" || e.elevation == null) continue;
      const arr = c.surface === "proposed" ? groups.proposed : groups[c.kind];
      const y = Y(e.elevation) + 0.06;
      for (let i = 0; i < c.points.length - 1; i++) arr.push(X(c.points[i][0]), y, Z(c.points[i][1]), X(c.points[i + 1][0]), y, Z(c.points[i + 1][1]));
    }
    const out = {} as Record<string, THREE.BufferGeometry>;
    for (const k of Object.keys(groups)) {
      out[k] = new THREE.BufferGeometry();
      out[k].setAttribute("position", new THREE.Float32BufferAttribute(groups[k], 3));
    }
    return { ...out, dispose: () => Object.values(out).forEach((g) => g.dispose()) } as Record<string, THREE.BufferGeometry> & { dispose(): void };
  }, [tin, contours, exaggeration]);

  const overlays = useDisposable(() => {
    const spacing = 3 / f;
    const items = ditches.filter((d) => d.polygon.length >= 3).map((d) => {
      const drape = drapePolygon(tin, d.polygon, spacing);
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(drape.positions.length * 3);
      drape.positions.forEach(([px, py], i) => {
        pos[3 * i] = X(px);
        pos[3 * i + 1] = Number.isNaN(drape.heights[i]) ? 0 : Y(drape.heights[i]) + 0.2;
        pos[3 * i + 2] = Z(py);
      });
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setIndex(drape.triangles);
      // outline following the ground; gaps where the ground is not modelled
      const ring = densify([...d.polygon, d.polygon[0]], spacing / 2);
      const seg: number[] = [];
      let modelled = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const z0 = tin.sample(ring[i][0], ring[i][1]);
        const z1 = tin.sample(ring[i + 1][0], ring[i + 1][1]);
        if (z0 == null || z1 == null) continue;
        modelled++;
        seg.push(X(ring[i][0]), Y(z0) + 0.3, Z(ring[i][1]), X(ring[i + 1][0]), Y(z1) + 0.3, Z(ring[i + 1][1]));
      }
      const og = new THREE.BufferGeometry();
      og.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
      const c = polygonCentroid(d.polygon);
      const cz = tin.sample(c[0], c[1]);
      const hs = drape.heights.filter((h) => !Number.isNaN(h));
      const labelZ = cz ?? (hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : bb.minZ);
      return { id: d.id, mesh: g, outline: og, label: [X(c[0]), Y(labelZ) + 4, Z(c[1])] as [number, number, number], covered: modelled / Math.max(ring.length - 1, 1) };
    });
    return { items, dispose: () => items.forEach((o) => (o.mesh.dispose(), o.outline.dispose())) };
  }, [tin, ditches, exaggeration]);

  return (
    <Canvas
      camera={{ position: [ext * 0.45, ext * 0.8 + relief, ext * 1.2], fov: 38, near: 1, far: ext * 20 }}
      onPointerMissed={() => onSelectDitch(null)}
      dpr={[1, 2]}
    >
      <color attach="background" args={["#f4f3ef"]} />
      <ambientLight intensity={0.85} />
      <directionalLight position={[-ext * 0.6, ext, -ext * 0.4]} intensity={1.5} />
      <directionalLight position={[ext * 0.5, ext * 0.5, ext * 0.8]} intensity={0.5} />
      <mesh geometry={terrainGeom}>
        <meshStandardMaterial vertexColors flatShading side={THREE.DoubleSide} roughness={1} metalness={0} />
      </mesh>
      <lineSegments geometry={lineGeoms.intermediate}>
        <lineBasicMaterial color="#6f6a5c" transparent opacity={0.55} />
      </lineSegments>
      <lineSegments geometry={lineGeoms.index}>
        <lineBasicMaterial color="#3b382f" />
      </lineSegments>
      <lineSegments geometry={lineGeoms.proposed}>
        <lineBasicMaterial color="#b97e00" />
      </lineSegments>
      {overlays.items.map((o) => {
        const st = ditchStyle[o.id] ?? { fill: "#f0efec", text: "" };
        const sel = o.id === selectedDitchId;
        return (
          <group key={o.id}>
            <mesh
              geometry={o.mesh}
              onClick={(e) => {
                e.stopPropagation();
                onSelectDitch(o.id);
              }}
            >
              <meshBasicMaterial color={st.fill} transparent opacity={0.86} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
            </mesh>
            <lineSegments geometry={o.outline}>
              <lineBasicMaterial color={sel ? "#0b0b0b" : "#52514e"} linewidth={2} />
            </lineSegments>
            <Html position={o.label} center zIndexRange={[20, 0]}>
              <button
                className={"tag3d" + (sel ? " sel" : "")}
                style={{ background: st.fill, color: textOn(st.fill) }}
                onClick={() => onSelectDitch(o.id)}
                title={o.covered < 0.99 ? "Part of this ditch lies outside the modelled terrain" : undefined}
              >
                <b>{o.id}</b> {st.text}
              </button>
            </Html>
          </group>
        );
      })}
      <Html position={[0, 0, -depthFt / 2 - 8]} center zIndexRange={[10, 0]}>
        <div className="north3d">N</div>
      </Html>
      <FitCamera radius={Math.hypot(widthFt, depthFt, bb.maxZ - bb.minZ) / 2} targetY={(bb.maxZ - bb.minZ) / 2} fitKey={`${bb.minX},${bb.minY},${bb.maxX},${bb.maxY}`} />
      <OrbitControls makeDefault target={[0, relief / 2, 0]} maxPolarAngle={Math.PI / 2.02} minDistance={15} maxDistance={ext * 5} />
    </Canvas>
  );
}
