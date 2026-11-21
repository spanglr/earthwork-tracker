import { useEffect, useMemo, useState } from "react";
import { api, type DemoInfo } from "../api";
import { useStore } from "../store";
import type { ExtractionConfig, Pt, StyleRole } from "../types";
import { Handle, pathD, PlanCanvas } from "./PlanCanvas";

const KIND: Record<string, string> = {
  vector: "Vector drawing: lines can be extracted automatically",
  raster: "Scanned image: trace contours by hand over the calibrated image",
  mixed: "Scan with some vector content: check the line styles, expect to trace",
  sparse: "Very little line work on this page",
};
const ROLE_LABEL: Record<StyleRole, string> = {
  "existing-index": "Existing: index contours",
  "existing-intermediate": "Existing: intermediate contours",
  "existing-mixed": "Existing: major and minor in one style",
  proposed: "Proposed contours",
};

export function SetupView() {
  const project = useStore((s) => s.project);
  const list = useStore((s) => s.list);
  const { open, adopt, refreshList, change, flush, setError, setView } = useStore.getState();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [demos, setDemos] = useState<DemoInfo[]>([]);
  const loadDemos = () => api.demos().then(setDemos).catch(() => {});
  useEffect(() => {
    loadDemos();
  }, []);
  const resetDemo = (id: string, label: string) =>
    run(label, async () => {
      await flush();
      const p = await api.resetDemo(id);
      await refreshList();
      await loadDemos();
      if (project?.id === p.id || !project) await open(p.id);
    });

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="setup">
      <section className="col narrow">
        <div className="card">
          <h3>Projects</h3>
          <table className="tbl">
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className={project?.id === p.id ? "on" : ""}>
                  <td><b>{p.name}</b>{p.isDemo && <span className="badge">demo</span>}<div className="muted small">{p.contours} contours · {p.ditches} ditches · {p.tickets} tickets</div></td>
                  <td className="num">
                    {project?.id !== p.id && <button onClick={() => open(p.id)}>Open</button>}{" "}
                    {p.isDemo ? (
                      <button title="Rebuild this demo from its source sheet" disabled={!!busy} onClick={() => confirm(`Rebuild "${p.name}" from its sheet? Changes made to this demo project are discarded.`) && resetDemo(p.id, "Rebuilding the demo from its sheet…")}>Reset</button>
                    ) : (
                      <button className="danger" onClick={() => confirm(`Delete project "${p.name}" and its files?`) && run("Deleting…", async () => {
                        await api.remove(p.id);
                        await refreshList();
                        if (project?.id === p.id) await open(useStore.getState().list.find((x) => x.isDemo)?.id ?? "");
                      })}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {demos.filter((d) => !d.sourcePresent).map((d) => (
            <div key={d.id} className="warn">
              <b>{d.title}</b> is not installed, because its plan PDF is not shipped with the code.{" "}
              {d.sourceUrl ? <>Open <a href={d.sourceUrl} target="_blank" rel="noreferrer">the PDF</a> in a browser, save it as <code>{d.sourcePdf}</code> in the app folder, then press </> : <>Put the file at <code>{d.sourcePdf}</code>, then press </>}
              <button className="link" disabled={!!busy} onClick={() => resetDemo(d.id, "Building the demo from the PDF…")}>Build this demo</button>.
            </div>
          ))}
        </div>

        <div className="card">
          <h3>New project</h3>
          <p className="muted small">Upload the grading plan as a PDF, or a scan as PNG/JPG/TIFF. The file stays on this computer.</p>
          <div className="form">
            <label>Project name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Maple Street storm line" /></label>
            <label>Plan file<input type="file" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
            <button className="primary" disabled={!file || !name.trim() || !!busy} onClick={() => run("Reading the file…", async () => {
              await flush();
              const p = await api.create(name.trim(), file!);
              await refreshList();
              await open(p.id);
              setName("");
              setFile(null);
            })}>Create project</button>
          </div>
        </div>
        {busy && <div className="okbox">{busy}</div>}
      </section>

      {project && <ProjectSteps key={project.id} run={run} busy={!!busy} onReview={() => setView("review")} />}
    </div>
  );
}

function ProjectSteps({ run, busy, onReview }: { run(label: string, fn: () => Promise<void>): Promise<void>; busy: boolean; onReview(): void }) {
  const project = useStore((s) => s.project)!;
  const { adopt, change, flush } = useStore.getState();
  const src = project.source;
  const page = src.pages.find((p) => p.page === src.page) ?? null;
  const cal = project.calibration;
  const [pick, setPick] = useState<Pt[] | null>(null); // calibration points being placed
  const [dist, setDist] = useState<string>(cal?.distanceFt ? String(cal.distanceFt) : "");
  const [inches, setInches] = useState<string>(String(cal?.printedScale?.inches ?? 1));
  const [feet, setFeet] = useState<string>(cal?.printedScale?.feet ? String(cal.printedScale.feet) : "");
  const [roles, setRoles] = useState<Record<string, StyleRole>>(project.extraction?.config.roles ?? {});
  const [slant, setSlant] = useState<"any" | "italic" | "upright">(project.extraction?.config.existingLabelSlant ?? "any");
  const [range, setRange] = useState<[string, string]>(() => {
    const r = project.extraction?.config.elevationRange;
    return r ? [String(r[0]), String(r[1])] : ["", ""];
  });
  // dash gap typed by the operator for a style whose own gap could not be detected
  const [gaps, setGaps] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(project.extraction?.config.dashGaps ?? {}).map(([k, v]) => [k, String(v)])),
  );
  const [show, setShow] = useState<string | null>(null);
  const [lines, setLines] = useState<Pt[][]>([]);

  useEffect(() => {
    if (!show) return setLines([]);
    let live = true;
    api.styleLines(project.id, show).then((r) => live && setLines(r.lines)).catch(() => live && setLines([]));
    return () => {
      live = false;
    };
  }, [show, project.id]);

  const pts = pick ?? (cal?.a && cal?.b ? [cal.a, cal.b] : []);
  const distPt = pts.length === 2 ? Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) : 0;
  const twoPointFpp = distPt > 0 && Number(dist) > 0 ? Number(dist) / distPt : null;
  const printedFpp = Number(inches) > 0 && Number(feet) > 0 ? Number(feet) / (Number(inches) * 72) : null;
  const printed = printedFpp ? { inches: Number(inches), feet: Number(feet) } : null;
  const w = src.widthPt ?? 1000;
  const h = src.heightPt ?? 1000;
  const styles = src.styles ?? [];
  const vectorPage = page && page.kind !== "raster" && styles.length > 0;
  const chosen = Object.keys(roles).filter((k) => styles.some((s) => s.key === k));
  const rep = project.extraction?.report;
  const cfg = useMemo<ExtractionConfig>(() => ({
    roles: Object.fromEntries(chosen.map((k) => [k, roles[k]])),
    labelStyles: null,
    existingLabelSlant: slant,
    elevationRange: range[0] !== "" && range[1] !== "" && Number(range[1]) > Number(range[0]) ? [Number(range[0]), Number(range[1])] : null,
    dashGaps: Object.fromEntries(chosen.filter((k) => Number(gaps[k]) > 0).map((k) => [k, Number(gaps[k])])),
  }), [chosen.join("|"), roles, slant, range, gaps]);

  return (
    <>
      <section className="col">
        <div className="card">
          <h3>1 · Sheet</h3>
          <p className="small">
            <b>{src.originalName}</b>{src.sheet ? ` · ${src.sheet}` : ""}
            {src.url && <> · <a href={src.url} target="_blank" rel="noreferrer">source</a></>}
          </p>
          <table className="tbl">
            <thead><tr><th>Page</th><th>Size</th><th className="num">Vector paths</th><th className="num">Text words</th><th className="num">Images</th><th>What it is</th><th /></tr></thead>
            <tbody>
              {src.pages.map((p) => (
                <tr key={p.page} className={p.page === src.page ? "on" : ""}>
                  <td>{p.page}</td>
                  <td>{(p.widthPt / 72).toFixed(1)} × {(p.heightPt / 72).toFixed(1)} in</td>
                  <td className="num">{p.vectorPaths.toLocaleString()}</td>
                  <td className="num">{p.textWords} <span className="muted">({p.numericTextWords} numeric)</span></td>
                  <td className="num">{p.images.length}{p.images.some((i) => i.pageCoverage > 0.5) ? " (full page)" : ""}</td>
                  <td className="small">{KIND[p.kind]}</td>
                  <td className="num">
                    {p.page === src.page ? <b>in use</b> : (
                      <button disabled={busy} onClick={() => (project.contours.length === 0 || confirm("Switching page clears the contours, calibration and check points of this project.")) && run("Rendering the page…", async () => {
                        await flush();
                        adopt(await api.setPage(project.id, p.page));
                      })}>Use this page</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {page && page.vectorPaths > 200 && page.numericTextWords < 5 && (
            <p className="muted small">This page has almost no numeric text objects, so elevation labels are probably drawn as stroked lettering. The extractor reads stick-font digits; anything it cannot read is left for you to confirm.</p>
          )}
        </div>

        {src.page && (
          <div className="card">
            <h3>2 · Horizontal scale</h3>
            <div className="form">
              <div className="row gap wrap">
                <button className={pick ? "on" : ""} onClick={() => setPick(pick ? null : [])}>{pick ? "Cancel picking" : pts.length === 2 ? "Pick two new points" : "Pick two points on the sheet"}</button>
                <label className="inline">are <input type="number" min={0} step="any" value={dist} onChange={(e) => setDist(e.target.value)} style={{ width: 90 }} /> ft apart</label>
              </div>
              <p className="muted small">Use the ends of the printed scale bar or a printed dimension. Zoom in and click each end (on a vector PDF the click snaps to the nearest line end); drag the points to adjust.{pick && pick.length < 2 ? ` Click point ${pick.length + 1} of 2.` : ""}</p>
              {src.kind === "pdf" && (
                <label className="inline">Printed scale: <input type="number" min={0} step="any" value={inches} onChange={(e) => setInches(e.target.value)} style={{ width: 60 }} /> inch =
                  <input type="number" min={0} step="any" value={feet} onChange={(e) => setFeet(e.target.value)} style={{ width: 80 }} /> ft</label>
              )}
              <ul className="plain small">
                {twoPointFpp && <li>Two points: {distPt.toFixed(2)} pt for {dist} ft, so 1 inch on the sheet = <b>{(twoPointFpp * 72).toFixed(3)} ft</b></li>}
                {printedFpp && <li>Printed scale: 1 inch on the sheet = <b>{(printedFpp * 72).toFixed(3)} ft</b></li>}
                {twoPointFpp && printedFpp && (
                  <li className={Math.abs(twoPointFpp / printedFpp - 1) < 0.01 ? "ok" : "bad"}>
                    {Math.abs(twoPointFpp / printedFpp - 1) < 0.01 ? "The measured points agree with the printed scale." : `These disagree by ${(Math.abs(twoPointFpp / printedFpp - 1) * 100).toFixed(1)}%. A scan or a reduced print does not keep its printed scale: trust the measured points.`}
                  </li>
                )}
              </ul>
              <div className="row gap wrap">
                <button className="primary" disabled={!twoPointFpp} onClick={() => { change((p) => ({ ...p, calibration: { method: "two-point", a: pts[0], b: pts[1], distanceFt: Number(dist), feetPerPoint: twoPointFpp!, printedScale: printed, note: "" } })); setPick(null); }}>Use the two points</button>
                {src.kind === "pdf" && <button disabled={!printedFpp} onClick={() => { change((p) => ({ ...p, calibration: { method: "printed-scale", feetPerPoint: printedFpp!, printedScale: printed, note: "" } })); setPick(null); }}>Use the printed scale only</button>}
              </div>
              {cal ? <div className="okbox">In use: 1 inch = {(cal.feetPerPoint * 72).toFixed(3)} ft ({cal.method === "two-point" ? "two measured points" : "printed scale, not measured"}). {cal.note}</div> : <div className="warn">Not calibrated yet.</div>}
            </div>
          </div>
        )}

        {src.page && (
          <div className="card">
            <h3>3 · Contours</h3>
            <div className="row gap wrap">
              <label className="inline">Contour interval <input type="number" min={0.1} step="any" value={project.contourInterval} style={{ width: 70 }} onChange={(e) => Number(e.target.value) > 0 && change((p) => ({ ...p, contourInterval: Number(e.target.value) }))} /> ft</label>
              <label className="inline">Index contour every <input type="number" min={0.1} step="any" value={project.indexInterval} style={{ width: 70 }} onChange={(e) => Number(e.target.value) > 0 && change((p) => ({ ...p, indexInterval: Number(e.target.value) }))} /> ft</label>
            </div>
            {vectorPage ? (
              <>
                <p className="small">Tell the extractor which line styles are contours. Tick “show” to see a style highlighted on the sheet. Look at the sheet's legend if it has one.</p>
                <div className="scroll">
                  <table className="tbl">
                    <thead><tr><th>Show</th><th>Line style</th><th className="num">Pieces</th><th className="num">Length</th><th>Linetype</th><th>Use as</th></tr></thead>
                    <tbody>
                      {styles.slice(0, 18).map((s) => (
                        <tr key={s.key} className={show === s.key ? "on" : ""}>
                          <td><input type="checkbox" aria-label={`Show ${s.key}`} checked={show === s.key} onChange={(e) => setShow(e.target.checked ? s.key : null)} /></td>
                          <td>
                            <svg width="46" height="12" aria-hidden><rect width="46" height="12" fill="#fff" stroke="#e1e0d9" /><line x1="3" y1="6" x2="43" y2="6" stroke={`rgb(${s.color.map((c) => Math.round(c * 255)).join(",")})`} strokeWidth={Math.max(1, s.width * 1.6)} /></svg>{" "}
                            <span className="small">{s.color[0] === s.color[1] && s.color[1] === s.color[2] ? (s.color[0] === 0 ? "black" : s.color[0] === 1 ? "white" : `${Math.round((1 - s.color[0]) * 100)}% grey`) : "colour"}, {s.width} pt</span>
                          </td>
                          <td className="num">{s.paths.toLocaleString()}</td>
                          <td className="num">{cal ? Math.round(s.totalLengthPt * cal.feetPerPoint).toLocaleString() + " ft" : Math.round(s.totalLengthPt) + " pt"}</td>
                          <td className="small">
                            {s.dashGapPt ? `dashed (gap ${s.dashGapPt} pt)` : "solid or mixed"}{s.glyphLike && !s.dashGapPt ? ", looks like lettering" : ""}
                            {roles[s.key] && !s.dashGapPt && (
                              <div>
                                <input type="number" min={0} step="any" aria-label={`Dash gap for ${s.key}`} placeholder="auto" value={gaps[s.key] ?? ""} style={{ width: 62 }}
                                  onChange={(e) => setGaps((g) => ({ ...g, [s.key]: e.target.value }))} /> pt gap
                              </div>
                            )}
                          </td>
                          <td>
                            <select value={roles[s.key] ?? ""} onChange={(e) => setRoles((r) => { const n = { ...r }; if (e.target.value) n[s.key] = e.target.value as StyleRole; else delete n[s.key]; return n; })}>
                              <option value="">not a contour</option>
                              {(Object.keys(ROLE_LABEL) as StyleRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="row gap wrap">
                  <label className="inline">Labels on existing contours are
                    <select value={slant} onChange={(e) => setSlant(e.target.value as any)}>
                      <option value="any">any lettering</option>
                      <option value="italic">slanted lettering only</option>
                      <option value="upright">upright lettering only</option>
                    </select>
                  </label>
                  <label className="inline">Plausible elevations from <input type="number" step="any" value={range[0]} style={{ width: 80 }} onChange={(e) => setRange([e.target.value, range[1]])} /> to
                    <input type="number" step="any" value={range[1]} style={{ width: 80 }} onChange={(e) => setRange([range[0], e.target.value])} /> ft</label>
                </div>
                <div className="row gap wrap">
                  <button className="primary" disabled={busy || !cal || chosen.length === 0} onClick={() => run("Extracting contours from the PDF…", async () => {
                    await flush();
                    adopt(await api.extract(project.id, cfg));
                  })}>{project.extraction ? "Run extraction again" : "Extract contours"}</button>
                  {!cal && <span className="warn inline">Calibrate first.</span>}
                  {cal && chosen.length === 0 && <span className="muted small">Choose at least one contour style.</span>}
                </div>
                <p className="muted small">
                  Running again keeps your review decisions on lines that come out the same, and always keeps traced and adopted lines. If a dashed contour style also
                  carries other line work, its dash gap cannot be measured: it then borrows the gap of your other contour styles, or you can type one.
                </p>
              </>
            ) : (
              <p className="small">This page is a scan or has no usable line work, so nothing is extracted automatically. Calibrate it above, then open <b>Terrain review</b> and use <b>Trace a line</b> to draw each contour over the image and type its height.</p>
            )}
            {rep && (
              <div className="okbox">
                Last run found {rep.contours} candidate lines: {rep.withLabel} with a printed label, {rep.inferred} by counting, {rep.unassigned} without a height. {rep.labelsRead} labels read ({rep.labelsFromPdfText} PDF text, {rep.labelsFromStrokes} stroked){rep.labelRule ? `; used ${rep.labelRule}` : ""}.
                {Object.values((rep.dashGaps ?? {}) as Record<string, { gapPt: number | null; how: string }>).some((g) => g.how.startsWith("borrowed")) ? " A dash gap was borrowed for a style that had none of its own." : ""}{" "}
                <button className="link" onClick={onReview}>Review the result →</button>
              </div>
            )}
            {!rep && cal && <button onClick={onReview}>Open terrain review</button>}
          </div>
        )}
      </section>

      {src.page && (
        <section className="pane sheet">
          <header className="pane-head"><h2>Sheet, page {src.page}</h2><span className="hint">Scroll to zoom, drag to pan</span></header>
          <PlanCanvas label="Sheet preview" width={w} height={h} underlayUrl={api.underlayUrl(project)} underlayOpacity={show ? 0.45 : 1} fitKey={project.id + ":" + src.page} cursor={pick ? "crosshair" : undefined}
            hint={pick ? (pick.length < 2 ? `Click calibration point ${pick.length + 1} of 2` : "Drag the points to adjust, then enter the distance") : show ? "Highlighted in pink: the ticked line style" : null}
            onClick={async (p, k) => {
              if (!pick || pick.length >= 2) return;
              // on a vector sheet, land exactly on the nearest line end (e.g. a scale-bar tick)
              let at: Pt = [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
              try {
                at = (await api.snap(project.id, p[0], p[1], 7 / k)).point;
              } catch {
                /* keep the raw click */
              }
              setPick((cur) => (cur && cur.length < 2 ? [...cur, at] : cur));
            }}>
            {lines.map((l, i) => <path key={i} d={pathD(l)} fill="none" stroke="#d6408a" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />)}
            {pts.length === 2 && <line x1={pts[0][0]} y1={pts[0][1]} x2={pts[1][0]} y2={pts[1][1]} stroke="#d03b3b" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />}
            {pts.map((p, i) => (
              <Handle key={i} at={p} color="#d03b3b" r={6} title="Drag to adjust" onDrag={(np) => setPick((pts as Pt[]).map((q, j) => (j === i ? [Math.round(np[0] * 100) / 100, Math.round(np[1] * 100) / 100] : q)) as Pt[])} />
            ))}
          </PlanCanvas>
        </section>
      )}
    </>
  );
}
