"use client";
import { useMemo } from "react";

function formatLastOpened(value) {
  if (!value) return "Recently opened";
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return "Recently opened";

  const diffMs = Date.now() - ts;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;

  return new Date(ts).toLocaleDateString();
}

function formatPathForCard(projectPath) {
  if (!projectPath || typeof projectPath !== "string") return "";
  return projectPath
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~");
}

export default function WelcomeScreen({
  recents = [],
  busy = false,
  error = null,
  onOpenProject,
  onOpenRecent,
}) {
  const latestFive = useMemo(() => recents.slice(0, 5), [recents]);

  return (
    <div className="welcome-screen">
      <div className="welcome-brand" aria-label="BiginVibe">
        <img
          src="/assets/biginvibe-logo.png"
          alt="BiginVibe logo"
          className="welcome-logo"
          width="34"
          height="34"
        />
        <span className="welcome-name">BiginVibe</span>
      </div>

      <button className="welcome-open-btn" disabled={busy} onClick={onOpenProject}>
        Open Project
      </button>

      <div className="welcome-section-title">Recent Projects</div>

      {latestFive.length === 0 ? (
        <div className="welcome-empty-state">
          <div>No recent projects yet</div>
          <div>Open a project to get started.</div>
        </div>
      ) : (
        <div className="welcome-recents-grid">
          {latestFive.map((item) => (
            <button
              key={item.path}
              className="welcome-recent-tile"
              onClick={() => onOpenRecent(item)}
              disabled={busy}
              aria-label={`Open ${item.name || "project"}`}
            >
              <div className="welcome-recent-name">{item.name || "Unnamed project"}</div>
              <div className="welcome-recent-path">{formatPathForCard(item.path)}</div>
              <div className="welcome-recent-time">{formatLastOpened(item.lastOpenedAt)}</div>
            </button>
          ))}
        </div>
      )}

      {error ? <div className="welcome-error">{error}</div> : null}
    </div>
  );
}
