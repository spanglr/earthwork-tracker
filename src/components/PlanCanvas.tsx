import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Pt } from "../types";

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
interface Ctx {
  /** screen pixels per sheet point */
  k: number;
  toSheet(clientX: number, clientY: number): Pt;
}
const PlanCtx = createContext<Ctx>({ k: 1, toSheet: () => [0, 0] });
export const usePlan = () => useContext(PlanCtx);

interface Props {
  width: number;
  height: number;
  underlayUrl?: string | null;
  underlayOpacity?: number;
  /** area to show first; refit whenever fitKey changes */
  fit?: Box | null;
  fitKey?: string;
  cursor?: string;
  /** a click (not a drag) at a sheet position; k = screen pixels per sheet point */
  onClick?(p: Pt, k: number): void;
  onDoubleClick?(p: Pt): void;
  onMove?(p: Pt | null): void;
  children?: React.ReactNode;
  label: string;
  /** instruction shown over the sheet while a tool is active */
  hint?: string | null;
}

/**
 * Pan/zoom view of the sheet.  Everything drawn inside is in sheet coordinates
 * (PDF points), the same coordinates the contours, mesh and ditches use, so
 * the underlay and the overlays cannot drift apart.
 */
export function PlanCanvas({ width, height, underlayUrl, underlayOpacity = 1, fit, fitKey, cursor, onClick, onDoubleClick, onMove, children, label, hint }: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean; id: number } | null>(null);
  const fitted = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fitTo = useCallback(
    (box: Box | null | undefined) => {
      const b = box ?? { minX: 0, minY: 0, maxX: width, maxY: height };
      const bw = Math.max(b.maxX - b.minX, 1);
      const bh = Math.max(b.maxY - b.minY, 1);
      if (!size.w || !size.h) return;
      const k = Math.min(size.w / bw, size.h / bh) * 0.94;
      setView({ k, tx: (size.w - bw * k) / 2 - b.minX * k, ty: (size.h - bh * k) / 2 - b.minY * k });
    },
    [size.w, size.h, width, height],
  );

  useEffect(() => {
    const key = (fitKey ?? "") + "|" + (size.w > 0 && size.h > 0);
    if (size.w > 0 && size.h > 0 && fitted.current !== key) {
      fitted.current = key;
      fitTo(fit);
    }
  }, [fitKey, size.w, size.h, fit, fitTo]);

  const toSheet = useCallback((cx: number, cy: number): Pt => {
    const r = ref.current!.getBoundingClientRect();
    const v = viewRef.current;
    return [(cx - r.left - v.tx) / v.k, (cy - r.top - v.ty) / v.k];
  }, []);

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    setView((v) => {
      const r = ref.current!.getBoundingClientRect();
      const k = Math.max(0.05, Math.min(60, v.k * factor));
      const sx = (cx - r.left - v.tx) / v.k;
      const sy = (cy - r.top - v.ty) / v.k;
      return { k, tx: cx - r.left - sx * k, ty: cy - r.top - sy * k };
    });
  }, []);

  useEffect(() => {
    const el = ref.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [zoomAt]);

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest("[data-handle]")) return;
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false, id: e.pointerId };
    try {
      ref.current!.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events have no active pointer */
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true;
      if (d.moved) setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }));
    }
    onMove?.(toSheet(e.clientX, e.clientY));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved && onClick) onClick(toSheet(e.clientX, e.clientY), viewRef.current.k);
  };

  const center = () => {
    const r = ref.current!.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2] as const;
  };

  return (
    <div className="plan">
      <svg
        ref={ref}
        role="img"
        aria-label={label}
        style={{ cursor: cursor ?? "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => onMove?.(null)}
        onDoubleClick={(e) => onDoubleClick?.(toSheet(e.clientX, e.clientY))}
      >
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
          <rect x={0} y={0} width={width} height={height} fill="#ffffff" stroke="#c3c2b7" vectorEffect="non-scaling-stroke" />
          {underlayUrl && <image href={underlayUrl} x={0} y={0} width={width} height={height} opacity={underlayOpacity} preserveAspectRatio="none" />}
          <PlanCtx.Provider value={{ k: view.k, toSheet }}>{children}</PlanCtx.Provider>
        </g>
      </svg>
      {hint && <div className="plan-hint">{hint}</div>}
      <div className="plan-zoom">
        <button title="Zoom in" onClick={() => zoomAt(...center(), 1.4)}>+</button>
        <button title="Zoom out" onClick={() => zoomAt(...center(), 1 / 1.4)}>−</button>
        <button title="Fit to the modelled area" onClick={() => fitTo(fit)}>Fit</button>
        <button title="Show the whole sheet" onClick={() => fitTo(null)}>Sheet</button>
      </div>
    </div>
  );
}

/** A draggable point (ditch vertex, calibration point...). */
export function Handle({ at, onDrag, onDone, onClick, onAltClick, color = "#0b0b0b", r = 5, title }: {
  at: Pt; onDrag?(p: Pt): void; onDone?(): void; onClick?(): void; onAltClick?(): void; color?: string; r?: number; title?: string;
}) {
  const { k, toSheet } = usePlan();
  const st = useRef<{ moved: boolean; x: number; y: number } | null>(null);
  return (
    <circle
      data-handle
      cx={at[0]}
      cy={at[1]}
      r={r / k}
      fill="#ffffff"
      stroke={color}
      strokeWidth={2}
      vectorEffect="non-scaling-stroke"
      style={{ cursor: onDrag ? "move" : "pointer" }}
      onPointerDown={(e) => {
        e.stopPropagation();
        st.current = { moved: false, x: e.clientX, y: e.clientY };
        try {
          (e.target as Element).setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }}
      onPointerMove={(e) => {
        const s = st.current;
        if (!s) return;
        if (!s.moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 3) s.moved = true;
        if (s.moved && onDrag) onDrag(toSheet(e.clientX, e.clientY));
      }}
      onPointerUp={(e) => {
        const s = st.current;
        st.current = null;
        if (!s) return;
        if (s.moved) onDone?.();
        else if (e.altKey || e.shiftKey) onAltClick?.();
        else onClick?.();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onAltClick?.();
      }}
    >
      {title && <title>{title}</title>}
    </circle>
  );
}

export const pathD = (pts: Pt[], close = false) => (pts.length ? "M" + pts.map((p) => p[0] + " " + p[1]).join("L") + (close ? "Z" : "") : "");

export function boxOf(pts: Pt[], pad = 0): Box | null {
  if (!pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}
