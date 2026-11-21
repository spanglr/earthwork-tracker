import { useMemo, useRef, useState } from "react";
import { api } from "../api";
import { applyImport, BASIS_LABEL, COLUMNS, computeTotals, fmtYd, OFFSITE, previewImport, type ImportPreview, type RowStatus } from "../lib/haul";
import { useStore } from "../store";
import type { Basis } from "../types";

const STATUS: Record<RowStatus, { label: string; cls: string }> = {
  new: { label: "New", cls: "ok" },
  duplicate: { label: "Already counted", cls: "muted" },
  conflict: { label: "Conflict", cls: "bad" },
  error: { label: "Problem", cls: "bad" },
};

export function HaulView() {
  const project = useStore((s) => s.project)!;
  const { change } = useStore.getState();
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [replace, setReplace] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const ditchIds = useMemo(() => project.ditches.map((d) => d.id), [project.ditches]);
  const preview: ImportPreview | null = useMemo(() => (text == null ? null : previewImport(text, ditchIds, project.tickets)), [text, ditchIds, project.tickets]);
  const totals = useMemo(() => computeTotals(project.tickets, ditchIds, null), [project.tickets, ditchIds]);
  const known = new Set([...ditchIds, OFFSITE]);
  const orphans = project.tickets.filter((t) => !known.has(t.from_id) || !known.has(t.to_id));
  const logConflicts = preview ? preview.rows.filter((r) => r.conflictsWithLog).length : 0;
  const willAdd = preview ? preview.counts.new + (replace ? logConflicts : 0) : 0;

  const load = async (f: File | undefined) => {
    if (!f) return;
    setDone(null);
    setReplace(false);
    setFileName(f.name);
    setText(await f.text());
  };
  const apply = () => {
    if (!preview) return;
    const before = project.tickets.length;
    const next = applyImport(project.tickets, preview, replace);
    change((p) => ({ ...p, tickets: next }));
    setDone(`${preview.counts.new} new ticket${preview.counts.new === 1 ? "" : "s"} added${replace && logConflicts ? `, ${logConflicts} replaced` : ""}. The log now has ${next.length} ticket${next.length === 1 ? "" : "s"} (was ${before}).`);
    setText(null);
    setFileName("");
    if (input.current) input.current.value = "";
  };

  return (
    <div className="haul">
      <section className="col">
        <div className="card">
          <h3>Import a dirt delivery log</h3>
          <p>
            CSV with the columns <code>{COLUMNS.join(", ")}</code>. Use a ditch ID from this project, or <code>{OFFSITE}</code> for dirt that comes from or leaves the site.
            Dates as <code>YYYY-MM-DD</code>. <a href={api.exampleCsvUrl} download>Download the example CSV</a>
          </p>
          <div className="row gap wrap">
            <input ref={input} type="file" accept=".csv,text/csv,text/plain" aria-label="CSV file" onChange={(e) => load(e.target.files?.[0])} />
            {text != null && <button onClick={() => { setText(null); setFileName(""); if (input.current) input.current.value = ""; }}>Clear</button>}
          </div>
          <p className="muted small">Nothing is changed until you press the button under the preview. Known ditch IDs: {ditchIds.length ? ditchIds.join(", ") : "none yet (draw ditches in the Crew view first)"}.</p>
          {done && <div className="okbox">{done}</div>}
        </div>

        {preview && (
          <div className="card">
            <h3>Preview{fileName ? `: ${fileName}` : ""}</h3>
            {preview.headerError ? (
              <div className="warn">{preview.headerError}</div>
            ) : (
              <>
                <div className="chips big">
                  <span className="ok">{preview.counts.new} new</span>
                  <span>{preview.counts.duplicate} already counted</span>
                  <span className={preview.counts.conflict ? "bad" : ""}>{preview.counts.conflict} conflicting ticket ID{preview.counts.conflict === 1 ? "" : "s"}</span>
                  <span className={preview.counts.error ? "bad" : ""}>{preview.counts.error} with problems</span>
                </div>
                <div className="scroll">
                  <table className="tbl">
                    <thead>
                      <tr><th>Line</th><th>ticket_id</th><th>date</th><th>from_id</th><th>to_id</th><th className="num">volume_yd3</th><th>Result</th></tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r) => (
                        <tr key={r.line} className={r.status === "error" || r.status === "conflict" ? "flag" : ""}>
                          <td>{r.line}</td>
                          <td>{r.raw.ticket_id}</td>
                          <td>{r.raw.date}</td>
                          <td>{r.raw.from_id}</td>
                          <td>{r.raw.to_id}</td>
                          <td className="num">{r.raw.volume_yd3}</td>
                          <td><b className={STATUS[r.status].cls}>{STATUS[r.status].label}</b>{r.messages.length ? <div className="small">{r.messages.join("; ")}</div> : null}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {logConflicts > 0 && (
                  <label className="chk">
                    <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace the {logConflicts} logged ticket{logConflicts > 1 ? "s" : ""} with the version in this file
                  </label>
                )}
                {(preview.counts.error > 0 || preview.counts.conflict > 0) && (
                  <p className="muted small">Lines with problems are skipped. Fix them in the spreadsheet and import again: lines already counted will be recognised and not added twice.</p>
                )}
                <button className="primary" disabled={willAdd === 0} onClick={apply}>
                  {willAdd === 0 ? "Nothing new to add" : `Add ${preview.counts.new} new ticket${preview.counts.new === 1 ? "" : "s"}${replace && logConflicts ? ` and replace ${logConflicts}` : ""}`}
                </button>
              </>
            )}
          </div>
        )}

        <div className="card">
          <h3>How quantities are measured</h3>
          <label>Ticket volumes are
            <select value={project.ticketBasis} onChange={(e) => change((p) => ({ ...p, ticketBasis: e.target.value as Basis }))}>
              {(Object.keys(BASIS_LABEL) as Basis[]).map((b) => <option key={b} value={b}>{BASIS_LABEL[b]}</option>)}
            </select>
          </label>
          <p className="muted small">A ditch target only gets a percent-complete when it is stated on this same basis.</p>
        </div>
      </section>

      <section className="col">
        <div className="card">
          <h3>Totals, all dates</h3>
          <table className="tbl">
            <thead><tr><th>Ditch</th><th className="num">Inbound</th><th className="num">Outbound</th><th className="num">Net</th><th className="num">Tickets</th></tr></thead>
            <tbody>
              {project.ditches.map((d) => {
                const t = totals.ditches[d.id];
                return <tr key={d.id}><td><b>{d.id}</b> <span className="muted">{d.name}</span></td><td className="num">{fmtYd(t.inbound)}</td><td className="num">{fmtYd(t.outbound)}</td><td className="num">{fmtYd(t.net, true)}</td><td className="num">{t.tickets.length}</td></tr>;
              })}
              <tr className="total"><td>Whole site (in from off site minus out to off site)</td><td className="num">{fmtYd(totals.site.imported)}</td><td className="num">{fmtYd(totals.site.exported)}</td><td className="num">{fmtYd(totals.site.net, true)}</td><td className="num">{project.tickets.length}</td></tr>
            </tbody>
          </table>
          <p className="muted small">A ditch-to-ditch ticket counts once as outbound for the ditch it left and once as inbound for the ditch it reached, and adds nothing to the site net.</p>
        </div>
        <div className="card">
          <div className="row gap">
            <h3>Haul log ({project.tickets.length})</h3>
            <span className="spacer" />
            {project.tickets.length > 0 && <button className="danger" onClick={() => confirm(`Remove all ${project.tickets.length} tickets from this project?`) && change((p) => ({ ...p, tickets: [] }))}>Remove all</button>}
          </div>
          {orphans.length > 0 && <div className="warn">{orphans.length} ticket{orphans.length > 1 ? "s" : ""} name a ditch ID that no longer exists ({[...new Set(orphans.flatMap((t) => [t.from_id, t.to_id]).filter((x) => !known.has(x)))].join(", ")}). They are left out of the ditch totals.</div>}
          {project.tickets.length === 0 ? (
            <p className="muted">No tickets yet.</p>
          ) : (
            <div className="scroll tall">
              <table className="tbl">
                <thead><tr><th>Date</th><th>Ticket</th><th>From</th><th>To</th><th className="num">yd³</th><th /></tr></thead>
                <tbody>
                  {project.tickets.map((t) => (
                    <tr key={t.ticket_id}>
                      <td>{t.date}</td><td>{t.ticket_id}</td>
                      <td className={known.has(t.from_id) ? "" : "bad"}>{t.from_id}</td>
                      <td className={known.has(t.to_id) ? "" : "bad"}>{t.to_id}</td>
                      <td className="num">{fmtYd(t.volume_yd3)}</td>
                      <td className="num"><button className="link" title={`Remove ticket ${t.ticket_id}`} onClick={() => change((p) => ({ ...p, tickets: p.tickets.filter((x) => x.ticket_id !== t.ticket_id) }))}>remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
