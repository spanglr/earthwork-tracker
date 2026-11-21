import type { Basis, Target, Ticket } from "../types";

export const OFFSITE = "OFFSITE";
export const COLUMNS = ["ticket_id", "date", "from_id", "to_id", "volume_yd3"] as const;

// ------------------------------------------------------------------ CSV
/** Minimal RFC-4180 reader: quoted fields, doubled quotes, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** YYYY-MM-DD or M/D/YYYY -> YYYY-MM-DD; null when it is not a real date. */
export function normaliseDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let mt = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (mt) [y, m, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else if ((mt = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) [m, d, y] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseVolume(raw: string): number | null {
  const s = raw.trim().replace(/,/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

export type RowStatus = "new" | "duplicate" | "conflict" | "error";
export interface PreviewRow {
  line: number;
  raw: Record<string, string>;
  ticket: Ticket | null;
  status: RowStatus;
  messages: string[];
  /** conflict with a ticket already in the log (can be replaced on request) */
  conflictsWithLog: boolean;
}
export interface ImportPreview {
  headerError: string | null;
  rows: PreviewRow[];
  counts: Record<RowStatus, number>;
}

const sameTicket = (a: Ticket, b: Ticket) =>
  a.ticket_id === b.ticket_id && a.date === b.date && a.from_id === b.from_id && a.to_id === b.to_id && Math.abs(a.volume_yd3 - b.volume_yd3) < 1e-9;

/**
 * Check a CSV against the project before anything is changed.
 *  new        valid and not in the log yet
 *  duplicate  identical to a ticket already in the log (or to an earlier line): skipped, so re-importing never double-counts
 *  conflict   same ticket_id as another ticket but different contents
 *  error      unknown ditch ID, invalid date, non-positive quantity, missing value
 */
export function previewImport(csv: string, ditchIds: string[], existing: Ticket[]): ImportPreview {
  const table = parseCsv(csv);
  const counts: Record<RowStatus, number> = { new: 0, duplicate: 0, conflict: 0, error: 0 };
  if (!table.length) return { headerError: "The file is empty.", rows: [], counts };
  const header = table[0].map((h) => h.trim().toLowerCase());
  const missing = COLUMNS.filter((c) => !header.includes(c));
  if (missing.length)
    return { headerError: `Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. The first line must be: ${COLUMNS.join(",")}`, rows: [], counts };
  const col = Object.fromEntries(COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<(typeof COLUMNS)[number], number>;
  const known = new Map(ditchIds.map((id) => [id.trim().toUpperCase(), id]));
  const inLog = new Map(existing.map((t) => [t.ticket_id, t]));
  const firstInFile = new Map<string, PreviewRow>();
  const rows: PreviewRow[] = [];

  const place = (raw: string, which: string, messages: string[]): string | null => {
    const v = raw.trim();
    if (!v) {
      messages.push(`${which} is empty`);
      return null;
    }
    if (v.toUpperCase() === OFFSITE) return OFFSITE;
    const hit = known.get(v.toUpperCase());
    if (!hit) {
      messages.push(`unknown ditch ID "${v}" in ${which}`);
      return null;
    }
    return hit;
  };

  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    const raw = Object.fromEntries(COLUMNS.map((c) => [c, (cells[col[c]] ?? "").trim()])) as Record<string, string>;
    const messages: string[] = [];
    const id = raw.ticket_id;
    if (!id) messages.push("ticket_id is empty");
    const date = normaliseDate(raw.date);
    if (!date) messages.push(`invalid date "${raw.date}" (use YYYY-MM-DD)`);
    const from = place(raw.from_id, "from_id", messages);
    const to = place(raw.to_id, "to_id", messages);
    if (from && to && from === to) messages.push(from === OFFSITE ? "from_id and to_id are both OFFSITE" : "from_id and to_id are the same ditch");
    const vol = parseVolume(raw.volume_yd3);
    if (vol == null) messages.push(`volume_yd3 "${raw.volume_yd3}" is not a number`);
    else if (vol <= 0) messages.push("volume_yd3 must be greater than zero");
    const row: PreviewRow = { line: i + 1, raw, ticket: null, status: "error", messages, conflictsWithLog: false };
    if (!messages.length) {
      const ticket: Ticket = { ticket_id: id, date: date as string, from_id: from as string, to_id: to as string, volume_yd3: vol as number };
      row.ticket = ticket;
      const earlier = firstInFile.get(id);
      const logged = inLog.get(id);
      if (earlier && earlier.ticket && !sameTicket(earlier.ticket, ticket)) {
        row.status = "conflict";
        row.messages.push(`ticket_id ${id} is also on line ${earlier.line} with different values`);
        if (earlier.status !== "conflict") {
          earlier.status = "conflict";
          earlier.messages.push(`ticket_id ${id} is also on line ${row.line} with different values`);
        }
      } else if (earlier) {
        row.status = "duplicate";
        row.messages.push(`repeats line ${earlier.line}`);
      } else if (logged && sameTicket(logged, ticket)) {
        row.status = "duplicate";
        row.messages.push("already in the log (identical), skipped");
      } else if (logged) {
        row.status = "conflict";
        row.conflictsWithLog = true;
        row.messages.push(
          `ticket_id ${id} is already in the log with different values (${logged.date}, ${logged.from_id} to ${logged.to_id}, ${logged.volume_yd3} yd³)`,
        );
      } else row.status = "new";
      if (!earlier) firstInFile.set(id, row);
    } else if (id && !firstInFile.has(id)) firstInFile.set(id, row);
    rows.push(row);
  }
  for (const r of rows) counts[r.status]++;
  return { headerError: null, rows, counts };
}

/** Apply a checked import.  Only `new` rows are added; with replaceConflicts,
 *  rows that differ from a logged ticket overwrite it.  Never adds a ticket twice. */
export function applyImport(existing: Ticket[], preview: ImportPreview, replaceConflicts = false): Ticket[] {
  const byId = new Map(existing.map((t) => [t.ticket_id, t]));
  const inFileConflict = new Set(preview.rows.filter((r) => r.status === "conflict" && !r.conflictsWithLog).map((r) => r.raw.ticket_id));
  for (const r of preview.rows) {
    if (!r.ticket) continue;
    if (r.status === "new" && !byId.has(r.ticket.ticket_id)) byId.set(r.ticket.ticket_id, r.ticket);
    else if (r.status === "conflict" && r.conflictsWithLog && replaceConflicts && !inFileConflict.has(r.ticket.ticket_id)) byId.set(r.ticket.ticket_id, r.ticket);
  }
  return [...byId.values()].sort((a, b) => (a.date === b.date ? a.ticket_id.localeCompare(b.ticket_id) : a.date.localeCompare(b.date)));
}

// ------------------------------------------------------------------ totals
export interface DitchTotals {
  inbound: number;
  outbound: number;
  net: number;
  tickets: Ticket[];
}
export interface SiteTotals {
  /** brought onto the site from OFFSITE */
  imported: number;
  /** hauled away to OFFSITE */
  exported: number;
  /** imported - exported.  Ditch-to-ditch transfers contribute zero. */
  net: number;
  /** moved between ditches on site */
  transferred: number;
}

/**
 * Totals through (and including) `throughDate`.
 * A ticket adds its volume to `outbound` of from_id and to `inbound` of to_id.
 * OFFSITE is not a ditch: it only shows up in the site totals.
 */
export function computeTotals(tickets: Ticket[], ditchIds: string[], throughDate: string | null): { ditches: Record<string, DitchTotals>; site: SiteTotals } {
  const ditches: Record<string, DitchTotals> = {};
  for (const id of ditchIds) ditches[id] = { inbound: 0, outbound: 0, net: 0, tickets: [] };
  const site: SiteTotals = { imported: 0, exported: 0, net: 0, transferred: 0 };
  for (const t of tickets) {
    if (throughDate && t.date > throughDate) continue;
    const v = t.volume_yd3;
    if (t.from_id !== OFFSITE && ditches[t.from_id]) {
      ditches[t.from_id].outbound += v;
      ditches[t.from_id].tickets.push(t);
    }
    if (t.to_id !== OFFSITE && ditches[t.to_id]) {
      ditches[t.to_id].inbound += v;
      ditches[t.to_id].tickets.push(t);
    }
    if (t.from_id === OFFSITE && t.to_id !== OFFSITE) site.imported += v;
    else if (t.to_id === OFFSITE && t.from_id !== OFFSITE) site.exported += v;
    else if (t.from_id !== OFFSITE && t.to_id !== OFFSITE) site.transferred += v;
  }
  for (const id of ditchIds) ditches[id].net = ditches[id].inbound - ditches[id].outbound;
  site.net = site.imported - site.exported;
  return { ditches, site };
}

export function ticketDates(tickets: Ticket[]): string[] {
  return [...new Set(tickets.map((t) => t.date))].sort();
}

/** Every calendar day from the first ticket to the last. */
export function dayRange(tickets: Ticket[]): string[] {
  const ds = ticketDates(tickets);
  if (!ds.length) return [];
  const out: string[] = [];
  const end = Date.parse(ds[ds.length - 1] + "T00:00:00Z");
  for (let t = Date.parse(ds[0] + "T00:00:00Z"); t <= end && out.length < 3660; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// ------------------------------------------------------------------ targets
export const BASIS_LABEL: Record<Basis, string> = {
  loose: "loose (truck-measured) yd³",
  bank: "bank (in-place, undisturbed) yd³",
  compacted: "compacted (in-place, after compaction) yd³",
};
export const MEASURE_LABEL: Record<Target["measures"], string> = {
  inbound: "inbound hauling",
  outbound: "outbound hauling",
  net_fill: "net fill (in minus out)",
  net_cut: "net cut (out minus in)",
};

export interface Progress {
  logged: number;
  comparable: boolean;
  percent: number | null;
  reason: string | null;
}

/**
 * Progress against a target.  A percentage is only given when the target is
 * stated on the same volume basis as the tickets: a cubic yard in a truck is
 * not a cubic yard in the ground.
 */
export function targetProgress(target: Target, totals: DitchTotals, ticketBasis: Basis): Progress {
  const logged =
    target.measures === "inbound" ? totals.inbound : target.measures === "outbound" ? totals.outbound : target.measures === "net_fill" ? totals.net : -totals.net;
  if (!(target.quantity > 0)) return { logged, comparable: false, percent: null, reason: "Enter a target quantity greater than zero." };
  if (target.basis !== ticketBasis)
    return {
      logged,
      comparable: false,
      percent: null,
      reason: `Target is in ${BASIS_LABEL[target.basis]} but tickets are logged in ${BASIS_LABEL[ticketBasis]}. These are not the same volume, so no percentage is shown.`,
    };
  return { logged, comparable: true, percent: (logged / target.quantity) * 100, reason: null };
}

export function fmtYd(v: number, signed = false): string {
  const r = Math.round(v * 10) / 10;
  const s = Number.isInteger(r) ? r.toLocaleString("en-US") : r.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return signed && r > 0 ? "+" + s : s;
}
