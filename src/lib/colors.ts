import type { Provenance } from "./terrain";

/** Chart surface and ink (light theme). */
export const INK = { primary: "#0b0b0b", secondary: "#52514e", muted: "#898781", grid: "#e1e0d9", surface: "#fcfcfb" };

/** Magnitude (inbound / outbound): one hue, light to dark. */
const SEQ = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
/** Polarity (net): blue = net fill (+), red = net cut (-), neutral grey at zero. */
const DIV_NEG = ["#f0efec", "#f3c1bd", "#ec8b86", "#e34948", "#b93232", "#8f2020"];
const DIV_POS = ["#f0efec", "#bcd7f8", "#86b6ef", "#3987e5", "#1c5cab", "#104281"];
export const NO_DATA = "#f0efec";

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function ramp(stops: string[], t: number): string {
  const u = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(u));
  const f = u - i;
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

export type Metric = "inbound" | "outbound" | "net";
export const METRIC_LABEL: Record<Metric, string> = { inbound: "Inbound", outbound: "Outbound", net: "Net (in minus out)" };

export interface Scale {
  metric: Metric;
  /** largest magnitude the scale covers (fixed across the date slider) */
  max: number;
  color(v: number): string;
  /** CSS gradient for the legend bar */
  gradient: string;
  ticks: { at: number; label: string }[];
}

function niceMax(v: number): number {
  if (!(v > 0)) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function makeScale(metric: Metric, maxAbs: number): Scale {
  const max = niceMax(maxAbs);
  if (metric === "net") {
    return {
      metric, max,
      color: (v) => (v >= 0 ? ramp(DIV_POS, v / max) : ramp(DIV_NEG, -v / max)),
      gradient: `linear-gradient(to right, ${[...DIV_NEG].reverse().join(",")}, ${DIV_POS.slice(1).join(",")})`,
      ticks: [
        { at: 0, label: `-${max}` },
        { at: 0.5, label: "0" },
        { at: 1, label: `+${max}` },
      ],
    };
  }
  return {
    metric, max,
    color: (v) => (v <= 0 ? NO_DATA : ramp(SEQ, 0.12 + 0.88 * (v / max))),
    gradient: `linear-gradient(to right, ${NO_DATA}, ${SEQ.join(",")})`,
    ticks: [
      { at: 0, label: "0" },
      { at: 0.5, label: String(max / 2) },
      { at: 1, label: String(max) },
    ],
  };
}

/** Readable text colour on top of a fill. */
export function textOn(fill: string): string {
  const [r, g, b] = hexToRgb(fill).map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? INK.primary : "#ffffff";
}

/** Line colours in the review overlay.  Each also has its own dash pattern so
 *  the categories do not rely on colour alone. */
export const PROVENANCE: Record<Provenance | "pending" | "rejected" | "proposed", { color: string; dash: string; label: string; help: string }> = {
  label: { color: "#2a78d6", dash: "", label: "Printed label", help: "Height read from an elevation label printed on this line." },
  inferred: { color: "#1baf7a", dash: "9 4", label: "Inferred", help: "No label on this piece; height found by counting lines between labeled contours." },
  manual: { color: "#6250d6", dash: "2 3", label: "Manually confirmed", help: "Height typed or confirmed by the reviewer." },
  pending: { color: "#eb6834", dash: "5 2 1 2", label: "Needs review", help: "Not accepted yet, so not part of the terrain." },
  proposed: { color: "#eda100", dash: "12 3", label: "Proposed grade", help: "Proposed contour. Kept separate from existing ground and not in the terrain." },
  rejected: { color: "#898781", dash: "1 4", label: "Rejected", help: "Marked as not a contour." },
};

/** Subtle elevation tint for the 3D terrain (sequential, warm neutral). */
export function terrainTint(t: number): [number, number, number] {
  const stops = ["#8a8372", "#a59e8a", "#bfb8a3", "#d6d0bd", "#e9e5d6"];
  const [r, g, b] = hexToRgb(ramp(stops, t));
  return [r / 255, g / 255, b / 255];
}
