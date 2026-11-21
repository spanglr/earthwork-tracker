import { useEffect, useMemo } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { densify, drapePolygon, effective, polygonCentroid, type Tin } from "../lib/terrain";
import { terrainTint, textOn } from "../lib/colors";
import { DIRT_TILE_FT, dirtTextures, macroShade } from "../lib/dirtTexture";
import type { Contour, Ditch } from "../types";

/** survey: flat-shaded model with contour lines.  dirt: the same surface drawn as soil. */
export type Look = "survey" | "dirt";

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
  look: Look;
  showLines: boolean;
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

/** A plain sky: pale at the horizon, blue overhead.  Drawn as a large dome
 *  with fixed colours so it looks the same whatever the lighting. */
function SkyDome({ radius }: { radius: number }) {
  const geom = useDisposable(() => {
    const g = new THREE.SphereGeometry(radius, 32, 16);
    const p = g.getAttribute("position");
    const col = new Float32Array(p.count * 3);
    const horizon = new THREE.Color("#cfe1f2");
    const zenith = new THREE.Color("#4a8fdc");
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const up = Math.max(0, p.getY(i) / radius);
      c.copy(horizon).lerp(zenith, Math.pow(up, 0.42));
      col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  }, [radius]);
  return (
    <mesh geometry={geom}>
      <meshBasicMaterial vertexColors side={THREE.BackSide} toneMapped={false} fog={false} depthWrite={false} />
    </mesh>
  );
}

/** Depth of the block of earth drawn under the lowest ground, in feet. */
const BLOCK_DEPTH_FT = 8;
/** Sun direction for the dirt look: from the south-west, about 35 degrees up. */
const SUN = new THREE.Vector3(-0.56, 0.6, 0.57).normalize();

/**
 * Orbitable view of the same surface the plan shows.  Horizontal units are
 * feet from the sheet calibration; vertical units are feet times the chosen
 * exaggeration (1 by default).  Ditches are coloured overlays draped on the
 * surveyed ground: tickets do not move the ground.
 *
 * The dirt look changes only how that surface is drawn: soil colour and grain,
 * a sun with shadows, a sky, and sides so it reads as a block of ground.
 * Areas the sheet gives no contours for are drawn as plain grey pads.
 */
export function Terrain3D({ tin, contours, ditches, ditchStyle, selectedDitchId, onSelectDitch, exaggeration, look, showLines }: Props) {
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
  const dirt = look === "dirt";
  const baseY = -BLOCK_DEPTH_FT * exaggeration;
  const soil = useMemo(() => (dirt ? dirtTextures() : null), [dirt]);

  const geoms = useDisposable(() => {
    const n = tin.x.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const span = Math.max(bb.maxZ - bb.minZ, 1e-6);
    for (let i = 0; i < n; i++) {
      const px = X(tin.x[i]);
      const pz = Z(tin.y[i]);
      pos[3 * i] = px;
      pos[3 * i + 1] = Y(tin.z[i]);
      pos[3 * i + 2] = pz;
      uv[2 * i] = px / DIRT_TILE_FT;
      uv[2 * i + 1] = pz / DIRT_TILE_FT;
      if (dirt) {
        // slow brightness variation so the repeating soil tile is not obvious
        const m = macroShade(px, pz);
        col[3 * i] = m;
        col[3 * i + 1] = m * 0.985;
        col[3 * i + 2] = m * 0.96;
      } else {
        const [r, g, b] = terrainTint((tin.z[i] - bb.minZ) / span);
        col[3 * i] = r; col[3 * i + 1] = g; col[3 * i + 2] = b;
      }
    }
    // every triangle wound so its face points up
    const upward = (tris: Uint32Array) => {
      const out = new Uint32Array(tris.length);
      for (let t = 0; t < tris.length; t += 3) {
        const a = tris[t], b = tris[t + 1], c = tris[t + 2];
        const ny = (pos[3 * b + 2] - pos[3 * a + 2]) * (pos[3 * c] - pos[3 * a]) - (pos[3 * b] - pos[3 * a]) * (pos[3 * c + 2] - pos[3 * a + 2]);
        out[t] = a;
        out[t + 1] = ny >= 0 ? b : c;
        out[t + 2] = ny >= 0 ? c : b;
      }
      return out;
    };
    const surface = (tris: Uint32Array) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      g.setIndex(new THREE.BufferAttribute(upward(tris), 1));
      g.computeVertexNormals();
      return g;
    };
    const terrain = surface(tin.triangles);
    const pads = surface(tin.gapTriangles);

    // Sides of the block: a wall under every outer edge of (surface + pads).
    const edges = new Map<number, [number, number]>();
    const count = new Map<number, number>();
    for (const tris of [tin.triangles, tin.gapTriangles])
      for (let t = 0; t < tris.length; t += 3)
        for (let k = 0; k < 3; k++) {
          const a = tris[t + k], b = tris[t + ((k + 1) % 3)];
          const key = Math.min(a, b) * n + Math.max(a, b);
          count.set(key, (count.get(key) ?? 0) + 1);
          edges.set(key, [a, b]);
        }
    const wp: number[] = [];
    const wc: number[] = [];
    const wuv: number[] = [];
    for (const [key, c] of count) {
      if (c !== 1) continue;
      const [a, b] = edges.get(key)!;
      const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
      const bx = pos[3 * b], by = pos[3 * b + 1], bz = pos[3 * b + 2];
      const quad = [[ax, ay, az], [bx, by, bz], [bx, baseY, bz], [ax, ay, az], [bx, baseY, bz], [ax, baseY, az]];
      for (const [qx, qy, qz] of quad) {
        wp.push(qx, qy, qz);
        // darker with depth, like a cut face
        const shade = qy <= baseY + 1e-6 ? 0.42 : 0.72;
        wc.push(shade, shade * 0.97, shade * 0.93);
        wuv.push((qx + qz) / DIRT_TILE_FT, qy / DIRT_TILE_FT);
      }
    }
    const walls = new THREE.BufferGeometry();
    walls.setAttribute("position", new THREE.Float32BufferAttribute(wp, 3));
    walls.setAttribute("color", new THREE.Float32BufferAttribute(wc, 3));
    walls.setAttribute("uv", new THREE.Float32BufferAttribute(wuv, 2));
    walls.computeVertexNormals();
    return { terrain, pads, walls, dispose: () => (terrain.dispose(), pads.dispose(), walls.dispose()) };
  }, [tin, exaggeration, dirt]);

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

  const shadowHalf = ext * 0.85;
  return (
    <Canvas camera={{ position: [ext * 0.45, ext * 0.8 + relief, ext * 1.2], fov: 38, near: 1, far: ext * 40 }} onPointerMissed={() => onSelectDitch(null)} dpr={[1, 2]} shadows>
      {dirt ? (
        <>
          <SkyDome radius={ext * 15} />
          <hemisphereLight args={["#d5e6ff", "#8a735a", 0.85]} />
          <directionalLight
            position={[SUN.x * ext * 1.6, SUN.y * ext * 1.6, SUN.z * ext * 1.6]}
            intensity={2.6}
            color="#fff3e0"
            castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-bias={-0.0004}
            shadow-normalBias={0.5}
            shadow-camera-left={-shadowHalf}
            shadow-camera-right={shadowHalf}
            shadow-camera-top={shadowHalf}
            shadow-camera-bottom={-shadowHalf}
            shadow-camera-near={1}
            shadow-camera-far={ext * 4}
          />
          <mesh geometry={geoms.terrain} castShadow receiveShadow>
            <meshStandardMaterial map={soil!.map} bumpMap={soil!.bump} bumpScale={0.9} vertexColors side={THREE.DoubleSide} roughness={1} metalness={0} />
          </mesh>
          {/* no contours on the sheet here: drawn plain so it is not mistaken for surveyed ground */}
          <mesh geometry={geoms.pads} receiveShadow>
            <meshStandardMaterial color="#b9b6ac" flatShading side={THREE.DoubleSide} roughness={1} metalness={0} />
          </mesh>
          <mesh geometry={geoms.walls} castShadow receiveShadow>
            <meshStandardMaterial map={soil!.map} vertexColors side={THREE.DoubleSide} roughness={1} metalness={0} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, baseY - 0.02, 0]} receiveShadow>
            <circleGeometry args={[ext * 8, 64]} />
            <meshStandardMaterial color="#cfcabb" roughness={1} metalness={0} />
          </mesh>
        </>
      ) : (
        <>
          <color attach="background" args={["#f4f3ef"]} />
          <ambientLight intensity={0.85} />
          <directionalLight position={[-ext * 0.6, ext, -ext * 0.4]} intensity={1.5} />
          <directionalLight position={[ext * 0.5, ext * 0.5, ext * 0.8]} intensity={0.5} />
          <mesh geometry={geoms.terrain}>
            <meshStandardMaterial vertexColors flatShading side={THREE.DoubleSide} roughness={1} metalness={0} />
          </mesh>
        </>
      )}
      {showLines && (
        <>
          <lineSegments geometry={lineGeoms.intermediate}>
            <lineBasicMaterial color={dirt ? "#2c2219" : "#6f6a5c"} transparent opacity={dirt ? 0.5 : 0.55} />
          </lineSegments>
          <lineSegments geometry={lineGeoms.index}>
            <lineBasicMaterial color={dirt ? "#1d160f" : "#3b382f"} />
          </lineSegments>
          <lineSegments geometry={lineGeoms.proposed}>
            <lineBasicMaterial color={dirt ? "#ffd27a" : "#b97e00"} />
          </lineSegments>
        </>
      )}
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
              {/* in the dirt look the ditch is a light tint so the soil shows through */}
              <meshBasicMaterial color={st.fill} transparent opacity={dirt ? (sel ? 0.42 : 0.28) : 0.86} side={THREE.DoubleSide} depthWrite={!dirt} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
            </mesh>
            <lineSegments geometry={o.outline}>
              <lineBasicMaterial color={dirt ? (sel ? "#ffe45c" : "#ffffff") : sel ? "#0b0b0b" : "#52514e"} />
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
