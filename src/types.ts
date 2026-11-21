/** Sheet coordinates: PDF points on the displayed page, x right, y down. */
export type Pt = [number, number];

export type ReviewStatus = "pending" | "accepted" | "rejected";
export interface Review {
  status: ReviewStatus;
  /** Height typed or confirmed by the operator; overrides the automatic one. */
  elevation: number | null;
  confirmed: boolean;
  note: string;
}

export interface LabelEvidence {
  text: string;
  center: Pt;
  how: string;
  distancePt: number;
  reader: "stroke-font" | "pdf-text";
  matchError?: number | null;
  matchMargin?: number | null;
}

export interface AutoInfo {
  elevation: number | null;
  source: "label" | "inferred" | null;
  labels: LabelEvidence[];
  inference: null | {
    method: "between" | "extended";
    votes: number;
    agree: number;
    crossLines: number;
    between?: [number, number];
    linesBetween?: number;
    continuedFrom?: [number, number];
    linesFromNearestKnown?: number;
  };
  neighbours: null | { consistent: number; inconsistent: number; adjacentHeights: number[] };
  dashGaps: number;
  bridges: { label: string; from: Pt; to: Pt }[];
  flags: string[];
}

export interface Contour {
  id: string;
  surface: "existing" | "proposed";
  kind: "index" | "intermediate";
  origin: "vector" | "traced" | "adopted";
  style?: string | null;
  points: Pt[];
  lengthPt?: number;
  auto: AutoInfo | null;
  review: Review;
}

export interface SheetLabel {
  text: string;
  value: number;
  center: Pt;
  bbox: [number, number, number, number];
  angleDeg: number;
  reader: "stroke-font" | "pdf-text";
  italic: boolean;
  matchError?: number | null;
  style?: string | null;
  attached: boolean;
}

export type RefersTo = "existing-ground" | "existing-curb" | "proposed-grade" | "wall" | "floor" | "utility" | "other";
export interface CheckPoint {
  id: string;
  label: string;
  x: number;
  y: number;
  printed: number;
  refersTo: RefersTo;
  /** independent: not used anywhere in building the surface. evidence: the
   *  reviewer looked at it when confirming a height. excluded: not ground. */
  role: "independent" | "evidence" | "excluded";
  where?: string;
  note?: string;
}

export type Basis = "loose" | "bank" | "compacted";
export type TargetMeasure = "inbound" | "outbound" | "net_fill" | "net_cut";
export interface Target {
  quantity: number;
  measures: TargetMeasure;
  basis: Basis;
}

export interface Ditch {
  id: string;
  name: string;
  polygon: Pt[];
  sample?: boolean;
  target: Target | null;
}

export interface Ticket {
  ticket_id: string;
  date: string; // YYYY-MM-DD
  from_id: string;
  to_id: string;
  volume_yd3: number;
}

export interface Calibration {
  method: "two-point" | "printed-scale";
  a?: Pt;
  b?: Pt;
  distanceFt?: number;
  feetPerPoint: number;
  note?: string;
  printedScale?: { inches: number; feet: number } | null;
}

export interface PageSummary {
  page: number;
  widthPt: number;
  heightPt: number;
  rotation: number;
  vectorPaths: number;
  textWords: number;
  numericTextWords: number;
  images: { widthPx: number; heightPx: number; pageCoverage: number }[];
  kind: "vector" | "raster" | "mixed" | "sparse";
}

export interface StyleRow {
  key: string;
  color: [number, number, number];
  width: number;
  paths: number;
  totalLengthPt: number;
  medianSizePt: number;
  dashGapPt: number | null;
  dashedShare: number;
  glyphLike: boolean;
}

export type StyleRole = "existing-index" | "existing-intermediate" | "existing-mixed" | "proposed";

export interface ExtractionConfig {
  roles: Record<string, StyleRole>;
  labelStyles?: string[] | null;
  existingLabelSlant?: "italic" | "upright" | "any";
  elevationRange?: [number, number] | null;
  dashGaps?: Record<string, number> | null;
}

export interface Project {
  schema: number;
  id: string;
  name: string;
  isDemo: boolean;
  demoNote?: string;
  createdAt: string;
  updatedAt?: string;
  source: {
    fileName: string;
    originalName: string;
    kind: "pdf" | "image";
    pages: PageSummary[];
    page: number | null;
    widthPt?: number;
    heightPt?: number;
    underlay?: { file: string; widthPx: number; heightPx: number; pxPerPt: number };
    styles?: StyleRow[];
    sampleText?: string[];
    url?: string;
    sheet?: string;
  };
  calibration: Calibration | null;
  contourInterval: number;
  indexInterval: number;
  extraction: null | { config: ExtractionConfig; report: Record<string, any>; ranAt: string };
  contours: Contour[];
  labels: SheetLabel[];
  spotNumbers: SheetLabel[];
  marks: Pt[];
  checkPoints: CheckPoint[];
  terrain: { maxEdgeFt: number; sampleFt: number };
  ditches: Ditch[];
  tickets: Ticket[];
  ticketBasis: Basis;
}

export interface ProjectListItem {
  id: string;
  name: string;
  isDemo: boolean;
  updatedAt?: string;
  contours: number;
  ditches: number;
  tickets: number;
}
