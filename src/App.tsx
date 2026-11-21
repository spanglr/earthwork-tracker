import { useEffect } from "react";
import { CrewView } from "./components/CrewView";
import { HaulView } from "./components/HaulView";
import { ReviewView } from "./components/ReviewView";
import { SetupView } from "./components/SetupView";
import { useStore, type View } from "./store";

const TABS: { id: View; label: string }[] = [
  { id: "crew", label: "Crew view" },
  { id: "review", label: "Terrain review" },
  { id: "haul", label: "Haul log" },
  { id: "setup", label: "Project setup" },
];

export function App() {
  const { project, list, loading, startingUp, error, view, saveState } = useStore();
  const { init, open, setView, setError, flush } = useStore.getState();
  useEffect(() => {
    init();
    const leave = () => void flush();
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, []);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">Earthwork Tracker</div>
        <select aria-label="Project" value={project?.id ?? ""} onChange={(e) => open(e.target.value)}>
          {list.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <nav className="tabs" aria-label="Views">
          {TABS.map((t) => (
            <button key={t.id} className={view === t.id ? "on" : ""} onClick={() => setView(t.id)}>{t.label}</button>
          ))}
        </nav>
        <span className="spacer" />
        {project && <span className={"save " + saveState}>{saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Unsaved changes"}</span>}
      </header>
      {error && (
        <div className="errbar" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      <main>
        {loading ? (
          <div className="empty"><p>{startingUp ? "Starting up. On the first run the demo terrain is extracted from the PDF, which takes about 15 seconds…" : "Loading…"}</p></div>
        ) : !project ? (
          view === "setup" ? <SetupView /> : (
            <div className="empty">
              <h2>No project open</h2>
              <button className="primary" onClick={() => setView("setup")}>Go to project setup</button>
            </div>
          )
        ) : view === "crew" ? (
          <CrewView />
        ) : view === "review" ? (
          <ReviewView />
        ) : view === "haul" ? (
          <HaulView />
        ) : (
          <SetupView />
        )}
      </main>
    </div>
  );
}
