import type { ExtractionConfig, Project, ProjectListItem, Pt } from "./types";

export interface DemoInfo {
  name: string;
  id: string;
  title: string;
  sourcePdf: string;
  sourceUrl?: string | null;
  sheet?: string | null;
  sourcePresent: boolean;
  built: boolean;
}

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const body = await r.json();
      msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* keep status text */
    }
    throw new Error(msg || `Request failed (${r.status})`);
  }
  return r.json();
}
const post = (url: string, body?: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

export const api = {
  list: () => fetch("/api/projects").then((r) => j<ProjectListItem[]>(r)),
  get: (id: string) => fetch(`/api/projects/${id}`).then((r) => j<Project>(r)),
  save: (p: Project) =>
    fetch(`/api/projects/${p.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) }).then((r) =>
      j<{ ok: boolean; updatedAt: string }>(r),
    ),
  create: (name: string, file: File) => {
    const fd = new FormData();
    fd.append("name", name);
    fd.append("file", file);
    return fetch("/api/projects", { method: "POST", body: fd }).then((r) => j<Project>(r));
  },
  remove: (id: string) => fetch(`/api/projects/${id}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
  setPage: (id: string, page: number) => post(`/api/projects/${id}/page`, { page }).then((r) => j<Project>(r)),
  extract: (id: string, cfg: ExtractionConfig) => post(`/api/projects/${id}/extract`, cfg).then((r) => j<Project>(r)),
  pick: (id: string, x: number, y: number, tol: number) =>
    post(`/api/projects/${id}/pick`, { x, y, tol }).then((r) => j<{ distancePt: number; style: string; points: Pt[] }>(r)),
  snap: (id: string, x: number, y: number, tol: number) => post(`/api/projects/${id}/snap`, { x, y, tol }).then((r) => j<{ point: Pt; snapped: boolean }>(r)),
  styleLines: (id: string, key: string) =>
    fetch(`/api/projects/${id}/style-lines?key=${encodeURIComponent(key)}`).then((r) => j<{ key: string; lines: Pt[][] }>(r)),
  demos: () => fetch("/api/demos").then((r) => j<DemoInfo[]>(r)),
  resetDemo: (id: string) => post("/api/demo/reset", { id }).then((r) => j<Project>(r)),
  underlayUrl: (p: Project) => `/api/projects/${p.id}/underlay?v=${p.source.page ?? 0}-${encodeURIComponent(p.createdAt)}`,
  exampleCsvUrl: "/api/example-csv",
};
