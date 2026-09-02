"use client";
import { useState } from "react";
import { bridge } from "../../lib/bridge";

export default function ProjectControls({ project, envStatus, onProjectOpened, onEnvChange, onBeforeStart }) {
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

  async function handleStartEnv() {
    setError(null);
    setBusy(true);
    // Bring the integrated Terminal into view and focus it BEFORE the
    // command is typed there, so the user sees "$ lyte serve --port 3000"
    // appear as it happens rather than discovering it after the fact.
    onBeforeStart?.();
    try {
      const status = await bridge.environment.start();
      onEnvChange(status);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleStopEnv() {
    setBusy(true);
    try {
      await bridge.environment.stop();
      onEnvChange({ devServer: { running: false }, previewUrl: null });
    } finally {
      setBusy(false);
    }
  }

  const running = envStatus?.devServer?.running;

  return (
    <div className="topbar">
      <div className="topbar-title">BiginVibe</div>
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
            </span>
            {running ? (
              <button disabled={busy} onClick={handleStopEnv}>
                Stop Dev Server
              </button>
            ) : (
              <button disabled={busy} onClick={handleStartEnv}>
                Start Dev Server
              </button>
            )}
          </>
        ) : (
          <button disabled={busy} onClick={handleOpen}>
            Open Project
          </button>
        )}
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}
