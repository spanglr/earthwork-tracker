import { create } from "zustand";
import { useMemo } from "react";
import { api } from "./api";
import { buildTin } from "./lib/terrain";
import type { Metric } from "./lib/colors";
import { dayRange } from "./lib/haul";
import type { Contour, Ditch, Project, ProjectListItem } from "./types";

export type View = "crew" | "review" | "haul" | "setup";
type SaveState = "saved" | "unsaved" | "saving" | "error";

interface State {
  list: ProjectListItem[];
  project: Project | null;
  loading: boolean;
  /** the local API has not answered yet */
  startingUp: boolean;
  error: string | null;
  saveState: SaveState;
  view: View;
  selectedDitchId: string | null;
  selectedContourId: string | null;
  /** Totals are shown through this date (inclusive). null = latest. */
  throughDate: string | null;
  metric: Metric;
  init(): Promise<void>;
  refreshList(): Promise<void>;
  open(id: string): Promise<void>;
  /** Replace the project with a copy returned by the server. */
  adopt(p: Project): void;
  /** Change the project.  Return a new object; untouched parts keep identity. */
  change(fn: (p: Project) => Project): void;
  updateContour(id: string, fn: (c: Contour) => Contour): void;
  updateDitch(id: string, fn: (d: Ditch) => Ditch): void;
  flush(): Promise<void>;
  setView(v: View): void;
  selectDitch(id: string | null): void;
  selectContour(id: string | null): void;
  setThroughDate(d: string | null): void;
  setMetric(m: Metric): void;
  setError(e: string | null): void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> = Promise.resolve();

export const useStore = create<State>((set, get) => {
  const saveNow = async () => {
    const p = get().project;
    if (!p || get().saveState === "saved") return;
    set({ saveState: "saving" });
    try {
      await api.save(p);
      if (get().project === p) set({ saveState: "saved" });
      else scheduleSave();
    } catch (e: any) {
      set({ saveState: "error", error: "Could not save: " + e.message });
    }
  };
  const scheduleSave = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      inflight = inflight.then(saveNow);
    }, 500);
  };
  return {
    list: [], project: null, loading: true, startingUp: false, error: null, saveState: "saved", view: "crew",
    selectedDitchId: null, selectedContourId: null, throughDate: null, metric: "net",
    async init() {
      try {
        // On the very first start the API builds the demo terrain from the PDF
        // before it answers, so wait for it instead of failing straight away.
        let list = null as Awaited<ReturnType<typeof api.list>> | null;
        for (let attempt = 0; list == null; attempt++) {
          try {
            list = await api.list();
          } catch (e) {
            if (attempt >= 60) throw e;
            set({ startingUp: true });
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        set({ startingUp: false });
        set({ list });
        const last = localStorage.getItem("earthwork.project");
        const id =
          (last && list.find((p) => p.id === last)?.id) || list.find((p) => p.id === "pittsburgh-demo")?.id || list.find((p) => p.isDemo)?.id || list[0]?.id;
        if (id) await get().open(id);
        else set({ loading: false });
      } catch (e: any) {
        set({ loading: false, startingUp: false, error: "Cannot reach the local API on port 8787. Is `npm start` running? (" + e.message + ")" });
      }
    },
    async refreshList() {
      set({ list: await api.list() });
    },
    async open(id) {
      await get().flush();
      set({ loading: true, error: null });
      try {
        const project = await api.get(id);
        localStorage.setItem("earthwork.project", id);
        set({ project, loading: false, saveState: "saved", selectedDitchId: null, selectedContourId: null, throughDate: null });
      } catch (e: any) {
        set({ loading: false, error: e.message });
      }
    },
    adopt(p) {
      set({ project: p, saveState: "saved" });
      get().refreshList().catch(() => {});
    },
    change(fn) {
      const p = get().project;
      if (!p) return;
      const next = fn(p);
      if (next === p) return;
      set({ project: next, saveState: "unsaved" });
      scheduleSave();
    },
    updateContour(id, fn) {
      get().change((p) => ({ ...p, contours: p.contours.map((c) => (c.id === id ? fn(c) : c)) }));
    },
    updateDitch(id, fn) {
      get().change((p) => ({ ...p, ditches: p.ditches.map((d) => (d.id === id ? fn(d) : d)) }));
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        inflight = inflight.then(saveNow);
      }
      await inflight;
    },
    setView: (view) => set({ view }),
    selectDitch: (selectedDitchId) => set({ selectedDitchId }),
    selectContour: (selectedContourId) => set({ selectedContourId }),
    setThroughDate: (throughDate) => set({ throughDate }),
    setMetric: (metric) => set({ metric }),
    setError: (error) => set({ error }),
  };
});

/** The existing-ground surface for the open project (rebuilt only when the
 *  contours, calibration or terrain settings change). */
export function useTin() {
  const contours = useStore((s) => s.project?.contours);
  const calibration = useStore((s) => s.project?.calibration);
  const terrain = useStore((s) => s.project?.terrain);
  return useMemo(() => (contours && terrain ? buildTin({ contours, calibration: calibration ?? null, terrain }) : null), [contours, calibration, terrain]);
}

/** Calendar days covered by the haul log and the day currently selected. */
export function useDays() {
  const tickets = useStore((s) => s.project?.tickets);
  const through = useStore((s) => s.throughDate);
  return useMemo(() => {
    const days = dayRange(tickets ?? []);
    const current = through && days.includes(through) ? through : days[days.length - 1] ?? null;
    return { days, current };
  }, [tickets, through]);
}
