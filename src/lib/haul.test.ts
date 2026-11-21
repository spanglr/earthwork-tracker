import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyImport, computeTotals, normaliseDate, parseCsv, previewImport, targetProgress } from "./haul";
import type { Ticket } from "../types";

const EXAMPLE = readFileSync(new URL("../../samples/haul-tickets-example.csv", import.meta.url), "utf8");
const DITCHES = ["D-01", "D-02", "D-03"];
const DAY1 = "2026-11-16";
const DAY2 = "2026-11-17";

function importInto(log: Ticket[], csv: string, replace = false) {
  const preview = previewImport(csv, DITCHES, log);
  return { preview, log: applyImport(log, preview, replace) };
}

describe("the three sample tickets", () => {
  const { preview, log } = importInto([], EXAMPLE);

  it("are all accepted as new", () => {
    expect(preview.headerError).toBeNull();
    expect(preview.counts).toEqual({ new: 3, duplicate: 0, conflict: 0, error: 0 });
    expect(log).toHaveLength(3);
  });

  it("Day 1: D-01 is +100, D-02 is zero", () => {
    const { ditches, site } = computeTotals(log, DITCHES, DAY1);
    expect(ditches["D-01"]).toMatchObject({ inbound: 100, outbound: 0, net: 100 });
    expect(ditches["D-02"]).toMatchObject({ inbound: 0, outbound: 0, net: 0 });
    expect(site.net).toBe(100);
  });

  it("end of Day 2: D-01 100 in / 30 out / +70, D-02 30 in / 10 out / +20, site +90", () => {
    const { ditches, site } = computeTotals(log, DITCHES, DAY2);
    expect(ditches["D-01"]).toMatchObject({ inbound: 100, outbound: 30, net: 70 });
    expect(ditches["D-02"]).toMatchObject({ inbound: 30, outbound: 10, net: 20 });
    expect(ditches["D-03"]).toMatchObject({ inbound: 0, outbound: 0, net: 0 });
    expect(site).toEqual({ imported: 100, exported: 10, net: 90, transferred: 30 });
  });

  it("a ditch-to-ditch transfer is one outbound and one inbound entry and nets to zero site-wide", () => {
    const only = log.filter((t) => t.from_id === "D-01" && t.to_id === "D-02");
    const { ditches, site } = computeTotals(only, DITCHES, null);
    expect(ditches["D-01"].outbound).toBe(30);
    expect(ditches["D-01"].tickets).toHaveLength(1);
    expect(ditches["D-02"].inbound).toBe(30);
    expect(ditches["D-02"].tickets).toHaveLength(1);
    expect(site.net).toBe(0);
    expect(ditches["D-01"].net + ditches["D-02"].net).toBe(0);
  });

  it("importing the same file twice gives the same result", () => {
    const again = importInto(log, EXAMPLE);
    expect(again.preview.counts).toEqual({ new: 0, duplicate: 3, conflict: 0, error: 0 });
    expect(again.log).toEqual(log);
    const third = importInto(again.log, EXAMPLE);
    expect(computeTotals(third.log, DITCHES, DAY2)).toEqual(computeTotals(log, DITCHES, DAY2));
  });

  it("sum of ditch nets equals the site net", () => {
    const { ditches, site } = computeTotals(log, DITCHES, DAY2);
    expect(DITCHES.reduce((s, id) => s + ditches[id].net, 0)).toBe(site.net);
  });
});

describe("import checks", () => {
  const head = "ticket_id,date,from_id,to_id,volume_yd3\n";

  it("flags unknown ditch IDs, invalid dates and non-positive quantities", () => {
    const p = previewImport(
      head +
        "A,2026-11-16,OFFSITE,D-09,10\n" + // unknown ditch
        "B,2026-02-30,OFFSITE,D-01,10\n" + // not a date
        "C,16 Nov,OFFSITE,D-01,10\n" + // not a date
        "D,2026-11-16,OFFSITE,D-01,0\n" + // zero
        "E,2026-11-16,OFFSITE,D-01,-5\n" + // negative
        "F,2026-11-16,OFFSITE,D-01,ten\n" + // not a number
        "G,2026-11-16,D-01,D-01,5\n" + // same place
        "H,2026-11-16,OFFSITE,OFFSITE,5\n" + // nowhere
        ",2026-11-16,OFFSITE,D-01,5\n", // no id
      DITCHES,
      [],
    );
    expect(p.counts).toEqual({ new: 0, duplicate: 0, conflict: 0, error: 9 });
    expect(p.rows[0].messages[0]).toContain('unknown ditch ID "D-09"');
    expect(p.rows[1].messages[0]).toContain("invalid date");
    expect(p.rows[3].messages[0]).toContain("greater than zero");
    expect(applyImport([], p)).toEqual([]);
  });

  it("flags a ticket_id that conflicts with the log and keeps the logged ticket unless told to replace it", () => {
    const { log } = importInto([], EXAMPLE);
    const changed = head + "T-1001,2026-11-16,OFFSITE,D-01,125\n";
    const kept = importInto(log, changed);
    expect(kept.preview.counts.conflict).toBe(1);
    expect(kept.log).toEqual(log);
    const replaced = importInto(log, changed, true);
    expect(replaced.log.find((t) => t.ticket_id === "T-1001")?.volume_yd3).toBe(125);
    expect(replaced.log).toHaveLength(3);
  });

  it("flags a ticket_id used twice in one file with different values, and adds neither", () => {
    const p = previewImport(head + "X,2026-11-16,OFFSITE,D-01,10\nX,2026-11-16,OFFSITE,D-01,12\nX,2026-11-16,OFFSITE,D-01,10\n", DITCHES, []);
    expect(p.rows.map((r) => r.status)).toEqual(["conflict", "conflict", "duplicate"]);
    expect(applyImport([], p, true)).toEqual([]);
  });

  it("treats an identical repeated line as a duplicate, counted once", () => {
    const { log, preview } = importInto([], head + "X,2026-11-16,OFFSITE,D-01,10\nX,2026-11-16,OFFSITE,D-01,10\n");
    expect(preview.counts).toEqual({ new: 1, duplicate: 1, conflict: 0, error: 0 });
    expect(computeTotals(log, DITCHES, null).ditches["D-01"].inbound).toBe(10);
  });

  it("reports missing columns before reading any rows", () => {
    expect(previewImport("ticket,date,from,to,yards\n1,2026-11-16,OFFSITE,D-01,10\n", DITCHES, []).headerError).toContain("Missing columns");
    expect(previewImport("", DITCHES, []).headerError).toContain("empty");
  });

  it("reads quoted fields, CRLF, a BOM, extra columns and offsite in any case", () => {
    const csv = '﻿Date,Ticket_ID,from_id,to_id,volume_yd3,notes\r\n11/16/2026,"T,1",offsite,d-02,"1,250.5","wet, heavy"\r\n';
    const p = previewImport(csv, DITCHES, []);
    expect(p.rows[0].ticket).toEqual({ ticket_id: "T,1", date: "2026-11-16", from_id: "OFFSITE", to_id: "D-02", volume_yd3: 1250.5 });
    expect(parseCsv('a,"b ""q"" c"\n')).toEqual([["a", 'b "q" c']]);
  });

  it("only accepts real calendar dates", () => {
    expect(normaliseDate("2026-11-16")).toBe("2026-11-16");
    expect(normaliseDate("2/29/2028")).toBe("2028-02-29");
    expect(normaliseDate("2027-02-29")).toBeNull();
    expect(normaliseDate("2026-13-01")).toBeNull();
    expect(normaliseDate("yesterday")).toBeNull();
  });
});

describe("targets", () => {
  const totals = { inbound: 100, outbound: 30, net: 70, tickets: [] };
  it("gives a percentage when target and tickets share a volume basis", () => {
    const p = targetProgress({ quantity: 150, measures: "inbound", basis: "loose" }, totals, "loose");
    expect(p.comparable).toBe(true);
    expect(p.percent).toBeCloseTo(66.67, 1);
    expect(targetProgress({ quantity: 140, measures: "net_fill", basis: "loose" }, totals, "loose").percent).toBe(50);
  });
  it("gives no percentage when the bases differ", () => {
    const p = targetProgress({ quantity: 40, measures: "net_fill", basis: "compacted" }, totals, "loose");
    expect(p.comparable).toBe(false);
    expect(p.percent).toBeNull();
    expect(p.logged).toBe(70);
    expect(p.reason).toContain("not the same volume");
  });
});
