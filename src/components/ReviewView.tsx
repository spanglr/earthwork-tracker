import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { PROVENANCE } from "../lib/colors";
import { distToPolyline, effective, polylineLength, tinFingerprint } from "../lib/terrain";
import { useStore, useTin } from "../store";
import type { CheckPoint, Contour, Pt, RefersTo } from "../types";
import { boxOf, Handle, pathD, PlanCanvas, usePlan } from "./PlanCanvas";

type Cat = keyof typeof PROVENANCE;
export function category(c: Contour): Cat {
  const e = effective(c);
  if (e.status === "rejected") return "rejected";
  if (e.status === "pending" || e.elevation == null) return "pending";
  if (c.surface === "proposed") return "proposed";
  return e.provenance ?? "pending";
}

const REFERS: Record<RefersTo, string> = {
  "existing-ground": "existing ground",
  "existing-curb": "existing curb (not ground)",
  "proposed-grade": "proposed grade (not existing)",
  wall: "wall (not ground)",
  floor: "finished floor (not ground)",
  utility: "utility (not ground)",
  other: "other",
};
const ROLE: Record<CheckPoint["role"], string> = {
  independent: "Independent check",
  evidence: "Used as evidence",
  excluded: "Not compared",
};

type Tool = "select" | "trace" | "adopt" | "check";

export function ReviewView() {
  const project = useStore((s) => s.project)!;
  const selectedId = useStore((s) => s.selectedContourId);
  const { change, selectContour, setError, setView } = useStore.getState();
  const tin = useTin();
  const [tool, setTool] = useState<Tool>("select");
  const [draft, setDraft] = useState<Pt[]>([]);
  const [hover, setHover] = useState<Pt | null>(null);
  const [opacity, setOpacity] = useState(0.85);
  const [showHeights, setShowHeights] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [cpSel, setCpSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cats = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of project.contours) m[category(c)] = (m[category(c)] ?? 0) + 1;
    return m;
  }, [project.contours]);
  const selected = project.contours.find((c) => c.id === selectedId) ?? null;
  const pending = project.contours.filter((c) => category(c) === "pending");
  const bulk = project.contours.filter((c) => c.review.status === "pending" && c.auto?.elevation != null && !c.auto.flags.length && c.surface === "existing");

  const finishTrace = (pts: Pt[]) => {
    const clean = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.5);
    setDraft([]);
    setTool("select");
    if (clean.length < 2) return;
    const id = "traced-" + Date.now().toString(36);
    change((p) => ({
      ...p,
      contours: [...p.contours, { id, surface: "existing", kind: "intermediate", origin: "traced", style: null, points: clean.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as Pt), auto: null, review: { status: "pending", elevation: null, confirmed: false, note: "" } }],
    }));
    selectContour(id);
  };
  useEffect(() => {
    if (tool !== "trace") return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDraft([]);
        setTool("select");
      } else if (e.key === "Enter") finishTrace(draft);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const w = project.source.widthPt ?? 1000;
  const h = project.source.heightPt ?? 1000;
  const fit = useMemo(() => boxOf(project.contours.filter((c) => c.review.status !== "rejected").flatMap((c) => c.points), 30), [project.id, project.contours.length]);

  const onClick = async (p: Pt, k: number) => {
    if (tool === "trace") return setDraft((d) => [...d, p]);
    if (tool === "adopt") {
      setBusy(true);
      try {
        const hit = await api.pick(project.id, p[0], p[1], Math.max(2, 6 / k));
        const id = "adopted-" + Date.now().toString(36);
        change((pr) => ({
          ...pr,
          contours: [...pr.contours, { id, surface: "existing", kind: "intermediate", origin: "adopted", style: hit.style, points: hit.points, auto: null, review: { status: "pending", elevation: null, confirmed: false, note: "" } }],
        }));
        selectContour(id);
        setTool("select");
        setError(null);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (tool === "check") {
      // snap to a printed '+' tick when one is close
      let at = p;
      let best = 8 / k;
      for (const m of project.marks ?? []) {
        const d = Math.hypot(m[0] - p[0], m[1] - p[1]);
        if (d < best) {
          best = d;
          at = m;
        }
      }
      let n = 1;
      while (project.checkPoints.some((c) => c.id === `CP-${n}`)) n++;
      const cp: CheckPoint = { id: `CP-${n}`, label: "", x: at[0], y: at[1], printed: NaN, refersTo: "existing-ground", role: "independent", where: "", note: "" };
      change((pr) => ({ ...pr, checkPoints: [...pr.checkPoints, cp] }));
      setCpSel(cp.id);
      setTool("select");
      return;
    }
    const cp = project.checkPoints.find((c) => Math.hypot(c.x - p[0], c.y - p[1]) < 11 / k);
    if (cp) {
      setCpSel(cp.id);
      selectContour(null);
      return;
    }
    let hit: Contour | null = null;
    let best = 7 / k;
    for (const c of project.contours) {
      const d = distToPolyline(c.points, p[0], p[1]);
      if (d < best) {
        best = d;
        hit = c;
      }
    }
    selectContour(hit ? hit.id : null);
    if (hit) setCpSel(null);
  };

  if (!project.source.page)
    return (
      <div className="empty">
        <h2>No sheet chosen yet</h2>
        <button className="primary" onClick={() => setView("setup")}>Go to project setup</button>
      </div>
    );

  return (
    <div className="review">
      <section className="pane">
        <header className="pane-head">
          <h2>Extracted contours over the source sheet</h2>
          <div className="seg" role="group" aria-label="Tool">
            <button className={tool === "select" ? "on" : ""} onClick={() => { setTool("select"); setDraft([]); }}>Select</button>
            <button className={tool === "trace" ? "on" : ""} onClick={() => { setTool("trace"); setDraft([]); }} title="Click along a contour the extraction missed">Trace a line</button>
            <button className={tool === "adopt" ? "on" : ""} disabled={project.source.kind !== "pdf"} onClick={() => setTool("adopt")} title="Click a line in the PDF to use its exact geometry">Adopt a PDF line</button>
            <button className={tool === "check" ? "on" : ""} onClick={() => setTool("check")} title="Mark a printed spot elevation to compare with the surface">Add check point</button>
          </div>
          <span className="spacer" />
          <label className="chk"><input type="checkbox" checked={showHeights} onChange={(e) => setShowHeights(e.target.checked)} /> Heights</label>
          <label className="chk"><input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> Labels read</label>
          <label className="sel">PDF <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="Underlay opacity" /></label>
        </header>
        <PlanCanvas
          label="Source sheet with extracted contours"
          width={w}
          height={h}
          underlayUrl={opacity > 0 ? api.underlayUrl(project) : null}
          underlayOpacity={opacity}
          fit={fit}
          fitKey={project.id + ":" + (project.source.page ?? 0)}
          cursor={tool === "select" ? undefined : "crosshair"}
          hint={tool === "trace" ? "Click along the contour. Double-click or press Enter to finish, Esc to cancel." : tool === "adopt" ? (busy ? "Looking for the line…" : "Click directly on a line in the PDF to use its exact geometry.") : tool === "check" ? "Click the printed + mark of a spot elevation (it snaps to the mark)." : null}
          onClick={onClick}
          onMove={tool === "trace" ? setHover : undefined}
          onDoubleClick={() => tool === "trace" && finishTrace(draft)}
        >
          <ReviewLayers
            selectedId={selectedId}
            showHeights={showHeights}
            showLabels={showLabels}
            cpSel={cpSel}
            tin={tin}
          />
          {tool === "trace" && draft.length > 0 && (
            <g>
              <path d={pathD(hover ? [...draft, hover] : draft)} fill="none" stroke="#6250d6" strokeWidth={2.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
              {draft.map((p, i) => <Handle key={i} at={p} color="#6250d6" r={4} />)}
            </g>
          )}
        </PlanCanvas>
      </section>

      <aside className="side wide">
        <h3>Where each height came from</h3>
        <ul className="prov">
          {(Object.keys(PROVENANCE) as Cat[]).map((k) => (
            <li key={k} title={PROVENANCE[k].help}>
              <svg width="34" height="10" aria-hidden><line x1="1" y1="5" x2="33" y2="5" stroke={PROVENANCE[k].color} strokeWidth="3" strokeDasharray={PROVENANCE[k].dash} /></svg>
              <span>{PROVENANCE[k].label}</span>
              <b>{cats[k] ?? 0}</b>
            </li>
          ))}
        </ul>
        <div className="row gap wrap">
          {bulk.length > 0 && (
            <button
              title="Accepts lines whose height came from a printed label or an exact count and that raised no warning"
              onClick={() => change((p) => ({ ...p, contours: p.contours.map((c) => (bulk.includes(c) ? { ...c, review: { ...c.review, status: "accepted", note: c.review.note || "Accepted in bulk: automatic height with no warnings." } } : c)) }))}
            >
              Accept {bulk.length} automatic height{bulk.length > 1 ? "s" : ""} with no warnings
            </button>
          )}
          {pending.length > 0 && (
            <button onClick={() => { const i = pending.findIndex((c) => c.id === selectedId); selectContour(pending[(i + 1) % pending.length].id); setCpSel(null); }}>
              Next line needing review ({pending.length})
            </button>
          )}
        </div>
        <p className="muted small">Only accepted existing-ground lines with a height go into the terrain. Click a line on the sheet to see the evidence for its height.</p>

        {selected ? <ContourPanel key={selected.id} c={selected} /> : <div className="card muted">No line selected.</div>}

        <CheckPoints tin={tin} sel={cpSel} onSel={(id) => { setCpSel(id); if (id) selectContour(null); }} />
        <TerrainCard />
      </aside>
    </div>
  );
}

function ReviewLayers({ selectedId, showHeights, showLabels, cpSel, tin }: {
  selectedId: string | null; showHeights: boolean; showLabels: boolean; cpSel: string | null; tin: ReturnType<typeof useTin>;
}) {
  const project = useStore((s) => s.project)!;
  const { k } = usePlan();
  const cal = project.calibration;
  const sel = project.contours.find((c) => c.id === selectedId);
  return (
    <g>
      {project.contours.map((c) => {
        const cat = category(c);
        const st = PROVENANCE[cat];
        return (
          <path key={c.id} d={pathD(c.points)} fill="none" stroke={st.color} strokeWidth={c.kind === "index" ? 2.6 : 1.7}
            strokeDasharray={st.dash} strokeOpacity={cat === "rejected" ? 0.7 : 1} vectorEffect="non-scaling-stroke" />
        );
      })}
      {sel && (
        <g style={{ pointerEvents: "none" }}>
          <path d={pathD(sel.points)} fill="none" stroke="#0b0b0b" strokeOpacity={0.25} strokeWidth={9} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d={pathD(sel.points)} fill="none" stroke={PROVENANCE[category(sel)].color} strokeWidth={3.5} vectorEffect="non-scaling-stroke" />
          {sel.auto?.bridges.map((b, i) => (
            <line key={i} x1={b.from[0]} y1={b.from[1]} x2={b.to[0]} y2={b.to[1]} stroke="#0b0b0b" strokeWidth={1.5} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
          ))}
          {sel.auto?.labels.map((l, i) => (
            <circle key={i} cx={l.center[0]} cy={l.center[1]} r={16 / k} fill="none" stroke="#d6408a" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      )}
      {showLabels && project.labels.map((l, i) => (
        <rect key={i} x={l.bbox[0] - 1.5} y={l.bbox[1] - 1.5} width={l.bbox[2] - l.bbox[0] + 3} height={l.bbox[3] - l.bbox[1] + 3} fill="none"
          stroke={l.attached ? "#d6408a" : "#898781"} strokeWidth={1.2} strokeDasharray={l.attached ? "" : "2 2"} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }}>
          <title>{`Read "${l.text}" from ${l.reader === "pdf-text" ? "PDF text" : "stroked lettering"}${l.attached ? "" : " (not tied to a contour)"}`}</title>
        </rect>
      ))}
      {showHeights && k > 0.55 && project.contours.map((c) => {
        const e = effective(c);
        if (e.elevation == null || e.status === "rejected" || c.points.length < 2) return null;
        const m = c.points[Math.floor(c.points.length * 0.42)];
        const fs = 10.5 / k;
        const txt = String(e.elevation);
        return (
          <g key={c.id} transform={`translate(${m[0]} ${m[1]})`} style={{ pointerEvents: "none" }}>
            <rect x={(-txt.length * 3.4) / k} y={-7.5 / k} width={(txt.length * 6.8) / k} height={14 / k} rx={2 / k} fill="#ffffff" fillOpacity={0.88} />
            <text textAnchor="middle" y={3.6 / k} fontSize={fs} fontWeight={600} fill={PROVENANCE[category(c)].color}>{txt}</text>
          </g>
        );
      })}
      {cal?.a && cal?.b && (
        <g style={{ pointerEvents: "none" }}>
          <line x1={cal.a[0]} y1={cal.a[1]} x2={cal.b[0]} y2={cal.b[1]} stroke="#d03b3b" strokeWidth={3} vectorEffect="non-scaling-stroke" />
          <text x={(cal.a[0] + cal.b[0]) / 2} y={Math.min(cal.a[1], cal.b[1]) - 8 / k} textAnchor="middle" fontSize={11 / k} fill="#d03b3b" fontWeight={700}>
            calibration: {cal.distanceFt} ft
          </text>
        </g>
      )}
      {project.checkPoints.map((cp) => {
        const z = tin?.sample(cp.x, cp.y) ?? null;
        const on = cp.id === cpSel;
        const r = 7 / k;
        return (
          <g key={cp.id} transform={`translate(${cp.x} ${cp.y})`} style={{ cursor: "pointer" }}>
            <circle r={r * 1.9} fill="transparent" />
            <path d={`M${-r} 0H${r}M0 ${-r}V${r}`} stroke="#0b0b0b" strokeWidth={on ? 3.5 : 2.2} vectorEffect="non-scaling-stroke" />
            <circle r={r} fill="none" stroke={cp.role === "independent" ? "#0b0b0b" : "#898781"} strokeWidth={on ? 3 : 1.6} strokeDasharray={cp.role === "independent" ? "" : "2 2"} vectorEffect="non-scaling-stroke" />
            <g transform={`translate(${r * 1.4} ${-r * 1.2})`}>
              <rect x={0} y={-11 / k} width={(cp.id.length * 7 + 8) / k} height={15 / k} rx={2 / k} fill="#0b0b0b" />
              <text x={4 / k} y={0} fontSize={11 / k} fill="#ffffff" fontWeight={700}>{cp.id}</text>
            </g>
            <title>{`${cp.id} ${cp.label}: printed ${cp.printed}, surface ${z == null ? "not modelled" : z.toFixed(2)}`}</title>
          </g>
        );
      })}
    </g>
  );
}

function ContourPanel({ c }: { c: Contour }) {
  const project = useStore((s) => s.project)!;
  const { updateContour, change, selectContour } = useStore.getState();
  const e = effective(c);
  const cat = category(c);
  const [height, setHeight] = useState<string>(e.elevation != null ? String(e.elevation) : "");
  const fpp = project.calibration?.feetPerPoint ?? 0;
  const a = c.auto;
  const inf = a?.inference;
  const parsed = Number(height);
  const validHeight = height.trim() !== "" && Number.isFinite(parsed);
  const offInterval = validHeight && Math.abs(parsed / project.contourInterval - Math.round(parsed / project.contourInterval)) > 1e-6;
  const setReview = (r: Partial<Contour["review"]>) => updateContour(c.id, (x) => ({ ...x, review: { ...x.review, ...r } }));

  return (
    <div className="card">
      <div className="card-head">
        <svg width="34" height="10" aria-hidden><line x1="1" y1="5" x2="33" y2="5" stroke={PROVENANCE[cat].color} strokeWidth="3" strokeDasharray={PROVENANCE[cat].dash} /></svg>
        <h4>{e.elevation != null ? `${e.elevation} ft` : "No height yet"} <span className="muted">· {PROVENANCE[cat].label}</span></h4>
      </div>
      <div className="chips">
        <span>{c.surface === "existing" ? "existing ground" : "proposed grade"}</span>
        <span>{c.kind === "index" ? "index line" : "intermediate line"}</span>
        <span>{c.origin === "vector" ? "vector path from the PDF" : c.origin === "adopted" ? "PDF line adopted by reviewer" : "traced by reviewer"}</span>
        <span>{(polylineLength(c.points) * fpp).toFixed(0)} ft long</span>
      </div>

      <h5>Evidence for the height</h5>
      <ul className="evidence">
        {c.review.elevation != null || c.review.confirmed ? (
          <li><b>Confirmed by the reviewer: {e.elevation} ft.</b>{c.review.note ? " " + c.review.note : ""}</li>
        ) : null}
        {a?.labels.map((l, i) => (
          <li key={i}>
            Printed label <b>“{l.text}”</b> {l.how}, {l.distancePt} pt from the line end (circled on the sheet). Read from {l.reader === "pdf-text" ? "the PDF's text" : "stroked lettering"}
            {l.matchError != null && l.reader !== "pdf-text" ? `; shape error ${l.matchError} against a limit of 0.11, next-best digit ${l.matchMargin} worse` : ""}.
          </li>
        ))}
        {inf && inf.method === "between" && (
          <li>
            Counted between labeled lines: {inf.linesBetween} line{inf.linesBetween === 1 ? "" : "s"} lie between the {inf.between![0]} and {inf.between![1]} contours, one per {project.contourInterval} ft, which puts this one at <b>{a!.elevation}</b>.{" "}
            {inf.agree} of {inf.votes} cross-lines that reached a known contour on both sides agree.
          </li>
        )}
        {inf && inf.method === "extended" && (
          <li>
            Outside the outermost known lines: the count was continued from the {inf.continuedFrom![0]} and {inf.continuedFrom![1]} contours, {inf.linesFromNearestKnown} step{inf.linesFromNearestKnown === 1 ? "" : "s"} further, giving <b>{a!.elevation}</b>. {inf.agree} of {inf.votes} cross-lines agree. This assumes the slope keeps going the same way, so it is weaker evidence than a count between two known lines.
          </li>
        )}
        {a && a.elevation == null && c.review.elevation == null && <li>No printed label is tied to this piece and counting between known lines did not give one consistent answer.</li>}
        {!a && c.review.elevation == null && <li>{c.origin === "traced" ? "Traced by hand" : "Adopted from the PDF"}: read the height from the sheet and confirm it below.</li>}
        {a?.neighbours && a.neighbours.consistent + a.neighbours.inconsistent > 0 && (
          <li>
            Neighbour check: the nearest line on either side is exactly one interval away in {a.neighbours.consistent} of {a.neighbours.consistent + a.neighbours.inconsistent} places
            {a.neighbours.adjacentHeights.length ? ` (neighbours at ${a.neighbours.adjacentHeights.join(", ")})` : ""}.
          </li>
        )}
        {a && <li className="muted">Geometry: {a.dashGaps} dash gap{a.dashGaps === 1 ? "" : "s"} joined{a.bridges.length ? `, ${a.bridges.length} label break${a.bridges.length > 1 ? "s" : ""} bridged (dotted)` : ""}.</li>}
      </ul>
      {a?.flags.map((f, i) => <div key={i} className="warn">Warning: {f}</div>)}

      <h5>Decision</h5>
      <div className="row gap wrap">
        <label className="inline">Height (ft)
          <input type="number" step="any" value={height} onChange={(ev) => setHeight(ev.target.value)} style={{ width: 90 }} />
        </label>
        <button className="primary" disabled={!validHeight} onClick={() => setReview({ status: "accepted", elevation: parsed, confirmed: true })} title="Record this height as checked by you against the sheet">
          Confirm height
        </button>
        {a?.elevation != null && c.review.status !== "accepted" && (
          <button onClick={() => setReview({ status: "accepted", elevation: null, confirmed: false })}>Accept automatic {a.elevation}</button>
        )}
        {a?.elevation != null && (c.review.elevation != null || c.review.confirmed) && (
          <button onClick={() => { setReview({ elevation: null, confirmed: false }); setHeight(String(a.elevation)); }}>Back to automatic</button>
        )}
      </div>
      {offInterval && <div className="warn">{parsed} is not a multiple of the {project.contourInterval} ft contour interval.</div>}
      <div className="row gap wrap">
        {c.review.status !== "rejected" ? (
          <button className="danger" onClick={() => setReview({ status: "rejected" })}>Reject: not a contour</button>
        ) : (
          <button onClick={() => setReview({ status: e.elevation != null ? "accepted" : "pending" })}>Restore</button>
        )}
        {c.review.status === "accepted" && <button onClick={() => setReview({ status: "pending" })}>Set aside (needs review)</button>}
        <label className="inline">Surface
          <select value={c.surface} onChange={(ev) => updateContour(c.id, (x) => ({ ...x, surface: ev.target.value as Contour["surface"] }))}>
            <option value="existing">existing ground</option>
            <option value="proposed">proposed grade</option>
          </select>
        </label>
        {c.origin !== "vector" && (
          <button className="danger" onClick={() => { change((p) => ({ ...p, contours: p.contours.filter((x) => x.id !== c.id) })); selectContour(null); }}>Delete line</button>
        )}
      </div>
      <label>Reviewer note
        <textarea rows={2} value={c.review.note} placeholder="Why this height, or why rejected" onChange={(ev) => setReview({ note: ev.target.value })} />
      </label>
      <p className="muted small">
        {e.inTerrain ? "This line is part of the terrain." : c.surface === "proposed" ? "Proposed lines are shown but never mixed into the existing-ground terrain." : "This line is not part of the terrain."}
      </p>
    </div>
  );
}

function CheckPoints({ tin, sel, onSel }: { tin: ReturnType<typeof useTin>; sel: string | null; onSel(id: string | null): void }) {
  const project = useStore((s) => s.project)!;
  const { change } = useStore.getState();
  const tol = project.contourInterval / 2;
  const upd = (id: string, patch: Partial<CheckPoint>) => change((p) => ({ ...p, checkPoints: p.checkPoints.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const cp = project.checkPoints.find((c) => c.id === sel);
  return (
    <div className="card">
      <h4>Printed elevations compared with the surface</h4>
      {project.checkPoints.length === 0 ? (
        <p className="muted small">None yet. Use <b>Add check point</b>, click a printed spot elevation and type its value. Keep a few that you did not use to decide any contour height: those are your independent checks.</p>
      ) : (
        <table className="tbl click">
          <thead><tr><th>Point</th><th className="num">Printed</th><th className="num">Surface</th><th className="num">Diff</th><th>Use</th></tr></thead>
          <tbody>
            {project.checkPoints.map((c) => {
              const z = tin?.sample(c.x, c.y) ?? null;
              const diff = z != null && Number.isFinite(c.printed) ? z - c.printed : null;
              const counted = c.role !== "excluded" && c.refersTo === "existing-ground";
              return (
                <tr key={c.id} className={c.id === sel ? "on" : ""} onClick={() => onSel(c.id === sel ? null : c.id)}>
                  <td><b>{c.id}</b> {c.label}<div className="muted small">{REFERS[c.refersTo]}</div></td>
                  <td className="num">{Number.isFinite(c.printed) ? c.printed : "?"}</td>
                  <td className="num">{z == null ? "none" : z.toFixed(2)}</td>
                  <td className="num">{diff == null ? "" : Math.abs(diff) < 0.005 ? "0.00" : (diff > 0 ? "+" : "") + diff.toFixed(2)}</td>
                  <td>
                    {ROLE[c.role]}
                    {counted && diff != null && <div className={Math.abs(diff) <= tol ? "ok small" : "bad small"}>{Math.abs(diff) <= tol ? `within ${tol} ft` : `more than ${tol} ft off`}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted small">Tolerance is half the contour interval ({tol} ft). “Surface” is the triangulated surface at the point; “none” means the point is outside the modelled area.</p>
      {cp && (
        <div className="form sub">
          <b>{cp.id}</b>
          {cp.where && <p className="muted small">{cp.where}</p>}
          <div className="row">
            <label>Text on the sheet<input value={cp.label} onChange={(e) => upd(cp.id, { label: e.target.value })} placeholder="e.g. HOLD ELEV 997" /></label>
            <label>Printed value (ft)<input type="number" step="any" value={Number.isFinite(cp.printed) ? cp.printed : ""} onChange={(e) => upd(cp.id, { printed: e.target.value === "" ? NaN : Number(e.target.value) })} /></label>
          </div>
          <div className="row">
            <label>Refers to
              <select value={cp.refersTo} onChange={(e) => upd(cp.id, { refersTo: e.target.value as RefersTo, role: e.target.value === "existing-ground" ? (cp.role === "excluded" ? "independent" : cp.role) : "excluded" })}>
                {(Object.keys(REFERS) as RefersTo[]).map((r) => <option key={r} value={r}>{REFERS[r]}</option>)}
              </select>
            </label>
            <label>Use
              <select value={cp.role} onChange={(e) => upd(cp.id, { role: e.target.value as CheckPoint["role"] })}>
                <option value="independent">Independent check (not used for any height)</option>
                <option value="evidence">I used it to decide a contour height</option>
                <option value="excluded">Do not compare</option>
              </select>
            </label>
          </div>
          <label>Note<textarea rows={2} value={cp.note ?? ""} onChange={(e) => upd(cp.id, { note: e.target.value })} /></label>
          <button className="danger" onClick={() => { change((p) => ({ ...p, checkPoints: p.checkPoints.filter((c) => c.id !== cp.id) })); onSel(null); }}>Delete check point</button>
        </div>
      )}
    </div>
  );
}

function TerrainCard() {
  const project = useStore((s) => s.project)!;
  const { change } = useStore.getState();
  const tin = useTin();
  const cal = project.calibration;
  const rep = project.extraction?.report;
  return (
    <div className="card">
      <h4>Terrain built from the reviewed lines</h4>
      {tin && tin.stats.triangles > 0 ? (
        <ul className="plain">
          <li>{tin.stats.contours} accepted contours, {tin.stats.points.toLocaleString()} points, {tin.stats.triangles.toLocaleString()} triangles</li>
          <li>Covers {Math.round(tin.stats.areaSqFt).toLocaleString()} sq ft, elevations {tin.bbox!.minZ}–{tin.bbox!.maxZ} ft</li>
          <li>{tin.stats.droppedLongEdge.toLocaleString()} triangles left out because an edge was longer than the limit (no contour support there)</li>
          <li className="muted">Surface fingerprint <code>{tinFingerprint(tin)}</code>: the same saved project always gives the same value.</li>
        </ul>
      ) : (
        <p className="muted small">No terrain yet: accept at least a few contours with heights.</p>
      )}
      {tin && tin.stats.contours > 1 && tin.stats.droppedLongEdge > tin.stats.triangles && (
        <div className="warn">Most of the ground between your accepted lines is left empty because the lines are further apart than the gap limit below. If neighbouring contours on this sheet really are that far apart, raise the limit.</div>
      )}
      <label className="inline">Leave gaps wider than
        <input type="number" min={5} max={200} step={1} value={project.terrain.maxEdgeFt} style={{ width: 70 }}
          onChange={(e) => change((p) => ({ ...p, terrain: { ...p.terrain, maxEdgeFt: Math.max(5, Number(e.target.value) || 25) } }))} /> ft unmodelled
      </label>
      <h5>Horizontal scale</h5>
      {cal ? (
        <p className="small">
          {(1 / cal.feetPerPoint).toFixed(3)} pt per ft, i.e. 1 inch = {(cal.feetPerPoint * 72).toFixed(2)} ft on the sheet.
          {cal.method === "two-point" ? ` Set from two points ${cal.distanceFt} ft apart (red line on the sheet).` : " Taken from the printed scale."} {cal.note}
        </p>
      ) : (
        <p className="warn">Not calibrated yet. Go to Project setup.</p>
      )}
      {rep && (
        <>
          <h5>Last automatic extraction</h5>
          <p className="small muted">
            {rep.vectorPaths?.toLocaleString()} vector paths on the page. {rep.labelsRead} whole-number labels read ({rep.labelsFromPdfText} from PDF text, {rep.labelsFromStrokes} from stroked lettering). {rep.contours} candidate lines:
            {" "}{rep.withLabel} with a printed label, {rep.inferred} by counting, {rep.unassigned} without a height.
          </p>
        </>
      )}
    </div>
  );
}
