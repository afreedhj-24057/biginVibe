"use client";
import { useState } from "react";
import { bridge } from "../../lib/bridge";

export default function ProjectControls({ project, onProjectOpened }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleOpen() {
    setError(null);
    const dir = await bridge.project.pickDirectory();
    if (!dir) return;
    setBusy(true);
    try {
      const opened = await bridge.project.open(dir);
      onProjectOpened(opened);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSwitch() {
    setError(null);
    const dir = await bridge.project.pickDirectory();
    if (!dir) return;
    setBusy(true);
    try {
      const switched = await bridge.project.switch(dir);
      onProjectOpened(switched);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleClose() {
    setError(null);
    setBusy(true);
    try {
      await bridge.project.close();
      onProjectOpened(null);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="topbar">
      <div className="topbar-brand">
        <div className="topbar-title">BiginVibe</div>
        <div className="topbar-credit-badge">Crafted by Bigin UI Team</div>
      </div>
      <div className="topbar-controls">
        {project ? (
          <>
            <span className="project-name" title={project.path}>
              {project.name}
              {project.isLyteProject ? (
                <span
                  className="badge-ok"
                  title={`Lyte detected via ${project.lyteSignal || "project files"}`}
                >
                  ✓ Lyte
                </span>
              ) : (
                <span className="badge-warning" title="No Lyte indicators found in this project">
                  ⚠ not detected as Lyte
                </span>
              )}
              {!project.hasBigiBotConfig && (
                <span
                  className="badge-warning"
                  title={project.bigiBotConfigError || "Project BigiBot config is incomplete."}
                >
                  ⚠ Running without project BigiBot config.
                </span>
              )}
            </span>
            <button disabled={busy} onClick={handleSwitch}>
              Switch Project
            </button>
            <button disabled={busy} onClick={handleClose}>
              Close Project
            </button>
          </>
        ) : (
          <button disabled={busy} onClick={handleOpen}>
            Open Project
          </button>
        )}
        {error ? <span className="error-text">{error}</span> : null}
      </div>
    </div>
  );
}
