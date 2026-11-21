import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { makeScale, METRIC_LABEL, NO_DATA, textOn, type Metric, type Scale } from "../lib/colors";
import { BASIS_LABEL, computeTotals, fmtYd, MEASURE_LABEL, OFFSITE, targetProgress, type DitchTotals } from "../lib/haul";
import { effective, pointInPolygon, polygonArea, polygonCentroid } from "../lib/terrain";
import { useDays, useStore, useTin } from "../store";
import type { Basis, Ditch, Pt, Target, TargetMeasure } from "../types";
import { boxOf, Handle, pathD, PlanCanvas, usePlan } from "./PlanCanvas";
import { Terrain3D, type Look } from "./Terrain3D";

const value = (t: DitchTotals | undefined, m: Metric) => (t ? t[m] : 0);
const fmtDay = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

export function CrewView() {
  const project = useStore((s) => s.project)!;
  const { change, updateDitch, selectDitch, setThroughDate, setMetric, setView } = useStore.getState();
  const selectedId = useStore((s) => s.selectedDitchId);
  const metric = useStore((s) => s.metric);
  const tin = useTin();
  const { days, current } = useDays();
  const [underlay, setUnderlay] = useState(true);
  const [showContours, setShowContours] = useState(true);
  const [mode, setMode] = useState<"select" | "draw" | "edit">("select");
  const [draft, setDraft] = useState<Pt[]>([]);
  const [hover, setHover] = useState<Pt | null>(null);
  const [exag, setExag] = useState(1);
  // how the 3D ground is drawn; remembered on this computer
  const [look, setLookState] = useState<Look>(() => {
    try {
      return localStorage.getItem("earthwork.look") === "dirt" ? "dirt" : "survey";
    } catch {
      return "survey";
    }
  });
  const setLook = (l: Look) => {
    setLookState(l);
    try {
      localStorage.setItem("earthwork.look", l);
    } catch {
      /* remembered for this visit only */
    }
  };
  // contour lines in 3D: on in the survey look, off in the dirt look, unless the user chooses
  const [lines3d, setLines3d] = useState<boolean | null>(null);
  const showLines3d = lines3d ?? look === "survey";

  const ditchIds = useMemo(() => project.ditches.map((d) => d.id), [project.ditches]);
  const totals = useMemo(() => computeTotals(project.tickets, ditchIds, current), [project.tickets, ditchIds, current]);
  const scale = useMemo(() => {
    // one fixed scale for the whole log, so colours do not rescale as the date moves
    let max = 0;
    for (const day of days.length ? days : [null]) {
      const t = computeTotals(project.tickets, ditchIds, day);
      for (const id of ditchIds) max = Math.max(max, Math.abs(value(t.ditches[id], metric)));
    }
    return makeScale(metric, max);
  }, [project.tickets, ditchIds, days, metric]);
  const ditchStyle = useMemo(() => {
    const out: Record<string, { fill: string; text: string }> = {};
    for (const d of project.ditches) {
      const t = totals.ditches[d.id];
      const logged = t && t.tickets.length > 0;
      const v = value(t, metric);
      out[d.id] = { fill: logged ? scale.color(v) : NO_DATA, text: logged ? fmtYd(v, metric === "net") + " yd³" : "0 yd³" };
    }
    return out;
  }, [project.ditches, totals, metric, scale]);

  const selected = project.ditches.find((d) => d.id === selectedId) ?? null;
  useEffect(() => {
    if (!selected && mode === "edit") setMode("select");
  }, [selected, mode]);

  const finishDraw = (pts: Pt[]) => {
    const clean = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.5);
    setDraft([]);
    setMode("select");
    if (clean.length < 3) return;
    let n = 1;
    const taken = new Set(ditchIds.map((s) => s.toUpperCase()));
    while (taken.has(`D-${String(n).padStart(2, "0")}`)) n++;
    const id = `D-${String(n).padStart(2, "0")}`;
    change((p) => ({ ...p, ditches: [...p.ditches, { id, name: "", polygon: clean.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as Pt), target: null }] }));
    selectDitch(id);
  };
  useEffect(() => {
    if (mode !== "draw") return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDraft([]);
        setMode("select");
      } else if (e.key === "Enter") finishDraw(draft);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const w = project.source.widthPt ?? 1000;
  const h = project.source.heightPt ?? 1000;
  const fit = useMemo(() => {
    if (tin?.bbox) return { minX: tin.bbox.minX - 20, minY: tin.bbox.minY - 20, maxX: tin.bbox.maxX + 20, maxY: tin.bbox.maxY + 20 };
    return boxOf(project.ditches.flatMap((d) => d.polygon), 40);
  }, [tin, project.ditches]);
  const accepted = useMemo(() => project.contours.filter((c) => effective(c).inTerrain), [project.contours]);

  const onPlanClick = (p: Pt) => {
    if (mode === "draw") {
      setDraft((d) => [...d, p]);
      return;
    }
    if (mode === "edit") return;
    const hit = [...project.ditches].reverse().find((d) => pointInPolygon(p[0], p[1], d.polygon));
    selectDitch(hit ? hit.id : null);
  };

  if (!project.source.page)
    return (
      <div className="empty">
        <h2>No sheet chosen yet</h2>
        <p>Pick the grading-plan page and calibrate it before using the crew view.</p>
        <button className="primary" onClick={() => setView("setup")}>Go to project setup</button>
      </div>
    );

  const dayIndex = current ? days.indexOf(current) : -1;
  return (
    <div className="crew">
      <div className="crew-main">
        <section className="pane">
          <header className="pane-head">
            <h2>Plan</h2>
            <label className="chk"><input type="checkbox" checked={underlay} onChange={(e) => setUnderlay(e.target.checked)} /> PDF underlay</label>
            <label className="chk"><input type="checkbox" checked={showContours} onChange={(e) => setShowContours(e.target.checked)} /> Contours</label>
            <span className="spacer" />
            {mode === "draw" ? (
              <>
                <button onClick={() => finishDraw(draft)} disabled={draft.length < 3}>Finish</button>
                <button onClick={() => { setDraft([]); setMode("select"); }}>Cancel</button>
              </>
            ) : (
              <>
                <button onClick={() => { selectDitch(null); setDraft([]); setMode("draw"); }}>Draw ditch</button>
                <button disabled={!selected} className={mode === "edit" ? "on" : ""} onClick={() => setMode(mode === "edit" ? "select" : "edit")}>
                  {mode === "edit" ? "Done editing" : "Edit shape"}
                </button>
              </>
            )}
          </header>
          <PlanCanvas
            label="Plan view of the site with ditch polygons"
            width={w}
            height={h}
            underlayUrl={underlay ? api.underlayUrl(project) : null}
            underlayOpacity={0.9}
            fit={fit}
            fitKey={project.id + ":" + (project.source.page ?? 0)}
            cursor={mode === "draw" ? "crosshair" : undefined}
            hint={mode === "draw" ? "Click each corner of the ditch. Double-click or press Enter to finish, Esc to cancel." : mode === "edit" ? "Drag a corner to move it. Click a small grey point to add a corner. Double-click a corner to remove it." : null}
            onClick={onPlanClick}
            onDoubleClick={() => mode === "draw" && finishDraw(draft)}
            onMove={mode === "draw" ? setHover : undefined}
          >
            {showContours && accepted.map((c) => (
              <path key={c.id} d={pathD(c.points)} fill="none" stroke="#7a6f55" strokeOpacity={underlay ? 0.55 : 0.9} strokeWidth={c.kind === "index" ? 1.6 : 0.8} vectorEffect="non-scaling-stroke" />
            ))}
            {project.ditches.map((d) => (
              <DitchShape key={d.id} ditch={d} style={ditchStyle[d.id]} selected={d.id === selectedId} />
            ))}
            {mode === "edit" && selected && <DitchEditor ditch={selected} onChange={(polygon) => updateDitch(selected.id, (d) => ({ ...d, polygon }))} />}
            {mode === "draw" && draft.length > 0 && (
              <g>
                <path d={pathD(hover ? [...draft, hover] : draft)} fill="rgba(42,120,214,0.12)" stroke="#2a78d6" strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
                {draft.map((p, i) => (
                  <Handle key={i} at={p} color="#2a78d6" title={i === 0 ? "Click to close the shape" : undefined} onClick={i === 0 ? () => finishDraw(draft) : undefined} />
                ))}
              </g>
            )}
          </PlanCanvas>
        </section>

        <section className="pane">
          <header className="pane-head">
            <h2>3D</h2>
            <div className="seg" role="group" aria-label="How the ground is drawn">
              <button className={look === "survey" ? "on" : ""} onClick={() => setLook("survey")} title="Plain model with contour lines">Survey</button>
              <button className={look === "dirt" ? "on" : ""} onClick={() => setLook("dirt")} title="The same surface drawn as soil, with sun and shadows">Dirt</button>
            </div>
            <label className="chk"><input type="checkbox" checked={showLines3d} onChange={(e) => setLines3d(e.target.checked)} /> Contours</label>
            <span className="spacer" />
            <label className="sel">
              Vertical scale{" "}
              <select value={exag} onChange={(e) => setExag(Number(e.target.value))}>
                <option value={1}>1× (true scale)</option>
                <option value={2}>2× exaggerated</option>
                <option value={3}>3× exaggerated</option>
                <option value={5}>5× exaggerated</option>
              </select>
            </label>
          </header>
          <div className="three">
            {tin && tin.bbox ? (
              <Terrain3D tin={tin} contours={project.contours} ditches={project.ditches} ditchStyle={ditchStyle} selectedDitchId={selectedId} onSelectDitch={selectDitch} exaggeration={exag} look={look} showLines={showLines3d} />
            ) : (
              <div className="empty small">
                <p>No terrain yet. Accept contours in <b>Terrain review</b> to build the surface.</p>
              </div>
            )}
            {exag !== 1 && <div className="exag-flag">Vertical scale exaggerated {exag}×. Slopes look {exag}× steeper than they are.</div>}
            {tin?.bbox && (
              <div className="three-note">
                {look === "dirt"
                  ? `Same surveyed ground (${tin.bbox.minZ}–${tin.bbox.maxZ} ft), drawn as soil. Grey areas have no contours on the sheet. Soil colour is for looks only and tickets do not reshape the ground.`
                  : `Surveyed existing ground from the plan (${tin.bbox.minZ}–${tin.bbox.maxZ} ft). Gaps are areas the sheet gives no contours for.`}
                <span className="muted"> Drag to orbit, scroll to zoom, right-drag to pan.</span>
              </div>
            )}
          </div>
        </section>
      </div>

      <footer className="crew-bar">
        <div className="bar-block grow">
          <div className="bar-title">
            Loads through <b>{current ? fmtDay(current) : "no tickets yet"}</b>
            {days.length > 0 && <span className="muted"> · day {dayIndex + 1} of {days.length}</span>}
          </div>
          <div className="slider-row">
            <button disabled={dayIndex <= 0} onClick={() => setThroughDate(days[dayIndex - 1])} title="Previous day">◀</button>
            <input
              type="range"
              aria-label="Date"
              min={0}
              max={Math.max(days.length - 1, 0)}
              step={1}
              value={Math.max(dayIndex, 0)}
              disabled={days.length < 2}
              onChange={(e) => setThroughDate(days[Number(e.target.value)])}
            />
            <button disabled={dayIndex < 0 || dayIndex >= days.length - 1} onClick={() => setThroughDate(days[dayIndex + 1])} title="Next day">▶</button>
          </div>
          {days.length > 0 && (
            <div className="slider-ends muted">
              <span>{days[0]}</span>
              <span>{days[days.length - 1]}</span>
            </div>
          )}
        </div>
        <div className="bar-block">
          <div className="bar-title">Colour ditches by</div>
          <div className="seg" role="group" aria-label="Metric">
            {(["inbound", "outbound", "net"] as Metric[]).map((m) => (
              <button key={m} className={metric === m ? "on" : ""} onClick={() => setMetric(m)}>{METRIC_LABEL[m]}</button>
            ))}
          </div>
        </div>
        <Legend scale={scale} />
        <div className="bar-block site">
          <div className="bar-title">Whole site</div>
          <div className="kv"><span>Brought in from off site</span><b>{fmtYd(totals.site.imported)}</b></div>
          <div className="kv"><span>Hauled off site</span><b>{fmtYd(totals.site.exported)}</b></div>
          <div className="kv"><span>Moved ditch to ditch</span><b>{fmtYd(totals.site.transferred)}</b></div>
          <div className="kv total"><span>Site net</span><b>{fmtYd(totals.site.net, true)} yd³</b></div>
        </div>
      </footer>

      <aside className="side">
        {selected ? (
          <DitchPanel ditch={selected} totals={totals.ditches[selected.id]} current={current} editing={mode === "edit"} onEdit={() => setMode(mode === "edit" ? "select" : "edit")} />
        ) : (
          <SitePanel totals={totals.ditches} style={ditchStyle} metric={metric} />
        )}
        <p className="note">
          Colour shows what the tickets say was hauled. The ground shown is the surveyed baseline from the plan. Tickets do not say where in a ditch the dirt went or how
          high the finished ground is, so the terrain is not reshaped.
        </p>
      </aside>
    </div>
  );
}

function DitchShape({ ditch, style, selected }: { ditch: Ditch; style: { fill: string; text: string }; selected: boolean }) {
  const { k } = usePlan();
  const c = polygonCentroid(ditch.polygon);
  const fs = 12 / k;
  return (
    <g>
      <path d={pathD(ditch.polygon, true)} fill={style.fill} fillOpacity={0.72} stroke={selected ? "#0b0b0b" : "#52514e"} strokeWidth={selected ? 3 : 1.5} vectorEffect="non-scaling-stroke" />
      <g transform={`translate(${c[0]} ${c[1]})`} style={{ pointerEvents: "none" }}>
        <rect x={-46 / k} y={-17 / k} width={92 / k} height={34 / k} rx={4 / k} fill="#ffffff" fillOpacity={0.9} stroke="#c3c2b7" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <text textAnchor="middle" y={-3 / k} fontSize={fs} fontWeight={700} fill="#0b0b0b">{ditch.id}{ditch.sample ? " · sample" : ""}</text>
        <text textAnchor="middle" y={11 / k} fontSize={fs * 0.92} fill="#52514e">{style.text}</text>
      </g>
    </g>
  );
}

function DitchEditor({ ditch, onChange }: { ditch: Ditch; onChange(poly: Pt[]): void }) {
  const poly = ditch.polygon;
  const round = (p: Pt): Pt => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
  return (
    <g>
      {poly.map((p, i) => {
        const q = poly[(i + 1) % poly.length];
        const mid: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        return (
          <Handle key={"m" + i} at={mid} r={3.5} color="#898781" title="Click to add a corner here"
            onClick={() => onChange([...poly.slice(0, i + 1), round(mid), ...poly.slice(i + 1)])} />
        );
      })}
      {poly.map((p, i) => (
        <Handle key={"v" + i} at={p} r={6} title="Drag to move. Double-click to remove."
          onDrag={(np) => onChange(poly.map((v, j) => (j === i ? round(np) : v)))}
          onAltClick={() => poly.length > 3 && onChange(poly.filter((_, j) => j !== i))} />
      ))}
    </g>
  );
}

export function Legend({ scale }: { scale: Scale }) {
  return (
    <div className="bar-block legend">
      <div className="bar-title">{METRIC_LABEL[scale.metric]}, yd³</div>
      <div className="legend-bar" style={{ background: scale.gradient }} />
      <div className="legend-ticks">
        {scale.ticks.map((t) => (
          <span key={t.label} style={{ left: `${t.at * 100}%` }}>{t.label}</span>
        ))}
      </div>
      <div className="legend-notes">
        {scale.metric === "net" ? <span><i style={{ background: "#b93232" }} /> more out than in <i style={{ background: "#1c5cab" }} /> more in than out</span> : <span>darker = more hauled</span>}
        <span><i style={{ background: NO_DATA, border: "1px solid #c3c2b7" }} /> no loads logged</span>
      </div>
    </div>
  );
}

function SitePanel({ totals, style, metric }: { totals: Record<string, DitchTotals>; style: Record<string, { fill: string; text: string }>; metric: Metric }) {
  const project = useStore((s) => s.project)!;
  const { selectDitch } = useStore.getState();
  return (
    <div>
      <h3>Ditches</h3>
      {project.isDemo && <p className="badge-note">{project.demoNote}</p>}
      {project.ditches.length === 0 ? (
        <p className="muted">No ditches yet. Use <b>Draw ditch</b> above the plan, then click the corners of the work area.</p>
      ) : (
        <table className="tbl click">
          <thead>
            <tr><th>Ditch</th><th className="num">In</th><th className="num">Out</th><th className="num">Net</th></tr>
          </thead>
          <tbody>
            {project.ditches.map((d) => {
              const t = totals[d.id];
              return (
                <tr key={d.id} onClick={() => selectDitch(d.id)} title="Show details">
                  <td><i className="sw" style={{ background: style[d.id]?.fill }} /> <b>{d.id}</b>{d.name ? <span className="muted"> {d.name}</span> : null}</td>
                  <td className="num">{fmtYd(t?.inbound ?? 0)}</td>
                  <td className="num">{fmtYd(t?.outbound ?? 0)}</td>
                  <td className="num">{fmtYd(t?.net ?? 0, true)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted small">Cubic yards through the selected date. Click a ditch on the plan, in 3D or in this table for its tickets. Swatch colour follows “{METRIC_LABEL[metric]}”.</p>
    </div>
  );
}

function DitchPanel({ ditch, totals, current, editing, onEdit }: { ditch: Ditch; totals: DitchTotals | undefined; current: string | null; editing: boolean; onEdit(): void }) {
  const project = useStore((s) => s.project)!;
  const { change, updateDitch, selectDitch } = useStore.getState();
  const [idDraft, setIdDraft] = useState(ditch.id);
  const [idError, setIdError] = useState<string | null>(null);
  useEffect(() => {
    setIdDraft(ditch.id);
    setIdError(null);
  }, [ditch.id]);
  const t = totals ?? { inbound: 0, outbound: 0, net: 0, tickets: [] };
  const fpp = project.calibration?.feetPerPoint ?? 0;
  const areaSqFt = polygonArea(ditch.polygon) * fpp * fpp;

  const commitId = () => {
    const next = idDraft.trim();
    if (next === ditch.id) return;
    if (!next) return setIdError("An ID is required.");
    if (next.toUpperCase() === OFFSITE) return setIdError("OFFSITE is reserved for imports and exports.");
    if (/[,"\n]/.test(next)) return setIdError("IDs cannot contain commas or quotes.");
    if (project.ditches.some((d) => d !== ditch && d.id.toUpperCase() === next.toUpperCase())) return setIdError(`${next} is already used.`);
    setIdError(null);
    // tickets follow the ditch so the log stays consistent
    change((p) => ({
      ...p,
      ditches: p.ditches.map((d) => (d.id === ditch.id ? { ...d, id: next } : d)),
      tickets: p.tickets.map((k) => ({ ...k, from_id: k.from_id === ditch.id ? next : k.from_id, to_id: k.to_id === ditch.id ? next : k.to_id })),
    }));
    selectDitch(next);
  };
  const setTarget = (target: Target | null) => updateDitch(ditch.id, (d) => ({ ...d, target }));
  const tg = ditch.target;
  const prog = tg ? targetProgress(tg, t, project.ticketBasis) : null;

  return (
    <div>
      <button className="link" onClick={() => selectDitch(null)}>← All ditches</button>
      <h3>
        {ditch.id} {ditch.sample && <span className="badge">sample boundary</span>}
      </h3>
      <div className="form">
        <label>Ditch ID
          <input value={idDraft} onChange={(e) => setIdDraft(e.target.value)} onBlur={commitId} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        </label>
        {idError && <div className="err">{idError}</div>}
        <label>Name
          <input value={ditch.name} placeholder="Optional description" onChange={(e) => updateDitch(ditch.id, (d) => ({ ...d, name: e.target.value }))} />
        </label>
      </div>
      <div className="stats">
        <div><span>Inbound</span><b>{fmtYd(t.inbound)}</b></div>
        <div><span>Outbound</span><b>{fmtYd(t.outbound)}</b></div>
        <div className="net"><span>Net</span><b>{fmtYd(t.net, true)}</b></div>
      </div>
      <p className="muted small">yd³ through {current ?? "—"} · tickets logged as {BASIS_LABEL[project.ticketBasis]} · plan area {Math.round(areaSqFt).toLocaleString()} sq ft</p>

      <h4>Target</h4>
      {tg ? (
        <div className="form">
          <div className="row">
            <label>Quantity (yd³)
              <input type="number" min={0} step="any" value={tg.quantity} onChange={(e) => setTarget({ ...tg, quantity: Number(e.target.value) })} />
            </label>
            <label>Measures
              <select value={tg.measures} onChange={(e) => setTarget({ ...tg, measures: e.target.value as TargetMeasure })}>
                {(Object.keys(MEASURE_LABEL) as TargetMeasure[]).map((m) => <option key={m} value={m}>{MEASURE_LABEL[m]}</option>)}
              </select>
            </label>
          </div>
          <label>Volume basis of the target
            <select value={tg.basis} onChange={(e) => setTarget({ ...tg, basis: e.target.value as Basis })}>
              {(Object.keys(BASIS_LABEL) as Basis[]).map((b) => <option key={b} value={b}>{BASIS_LABEL[b]}</option>)}
            </select>
          </label>
          {prog && prog.comparable && prog.percent != null ? (
            <div className="progress">
              <div className="progress-head"><b>{Math.round(prog.percent)}% complete</b><span>{fmtYd(prog.logged)} of {fmtYd(tg.quantity)} yd³ {MEASURE_LABEL[tg.measures]}</span></div>
              <div className="progress-track"><div style={{ width: `${Math.max(0, Math.min(100, prog.percent))}%` }} /></div>
              {prog.percent > 100 && <div className="muted small">Logged quantity is past the target.</div>}
              {prog.percent < 0 && <div className="muted small">Logged quantity runs the opposite way from this target.</div>}
            </div>
          ) : (
            <div className="warn">
              <b>No percentage shown.</b> {prog?.reason} Logged so far: {fmtYd(prog?.logged ?? 0)} yd³ {MEASURE_LABEL[tg.measures]}.
            </div>
          )}
          <button className="link" onClick={() => setTarget(null)}>Remove target</button>
        </div>
      ) : (
        <button onClick={() => setTarget({ quantity: 100, measures: "inbound", basis: project.ticketBasis })}>Add a target</button>
      )}

      <h4>Tickets through {current ?? "—"} ({t.tickets.length})</h4>
      {t.tickets.length ? (
        <table className="tbl">
          <thead><tr><th>Date</th><th>Ticket</th><th>Move</th><th className="num">yd³</th></tr></thead>
          <tbody>
            {t.tickets.map((k) => {
              const inbound = k.to_id === ditch.id;
              return (
                <tr key={k.ticket_id}>
                  <td>{k.date}</td>
                  <td>{k.ticket_id}</td>
                  <td>{inbound ? `in from ${k.from_id}` : `out to ${k.to_id}`}</td>
                  <td className="num">{inbound ? "+" : "−"}{fmtYd(k.volume_yd3)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="muted small">No tickets for this ditch up to this date.</p>
      )}
      <div className="row gap">
        <button onClick={onEdit} className={editing ? "on" : ""}>{editing ? "Done editing" : "Edit shape"}</button>
        <button
          className="danger"
          onClick={() => {
            if (!confirm(`Delete ditch ${ditch.id}? Its ${project.tickets.filter((k) => k.from_id === ditch.id || k.to_id === ditch.id).length} ticket(s) stay in the haul log.`)) return;
            change((p) => ({ ...p, ditches: p.ditches.filter((d) => d.id !== ditch.id) }));
            selectDitch(null);
          }}
        >
          Delete ditch
        </button>
      </div>
    </div>
  );
}
