"use client";
import { useEffect, useMemo, useRef, useState } from "react";

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
  onRenameRecent,
}) {
  const latestFive = useMemo(() => recents.slice(0, 5), [recents]);
  const [renamingPath, setRenamingPath] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef(null);

  useEffect(() => {
    if (renamingPath) renameInputRef.current?.focus();
  }, [renamingPath]);

  function startRename(event, item) {
    event.stopPropagation();
    setRenamingPath(item.path);
    setRenameDraft(item.displayName || item.name || "");
  }

  async function submitRename(item) {
    const displayName = renameDraft.trim();
    if (!displayName || !onRenameRecent) return;
    try {
      await onRenameRecent(item, displayName);
      setRenamingPath(null);
      setRenameDraft("");
    } catch {
      // The parent surfaces persistence errors and leaves the edit open.
    }
  }

  function cancelRename() {
    setRenamingPath(null);
    setRenameDraft("");
  }

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
            <div
              key={item.path}
              className="welcome-recent-tile"
            >
              {renamingPath === item.path ? (
                <div className="welcome-recent-heading">
                  <div className="welcome-recent-rename-wrap">
                    <input
                      ref={renameInputRef}
                      type="text"
                      className="welcome-recent-rename-input"
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          submitRename(item);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelRename();
                        }
                      }}
                      aria-label="Project display name"
                    />
                    <button type="button" onClick={() => submitRename(item)} disabled={!renameDraft.trim()} aria-label="Save project name">Save</button>
                    <button type="button" onClick={cancelRename} aria-label="Cancel project rename">Cancel</button>
                  </div>
                  <div className="welcome-recent-path">{formatPathForCard(item.path)}</div>
                  <div className="welcome-recent-time">{formatLastOpened(item.lastOpenedAt)}</div>
                </div>
              ) : (
                <button
                  type="button"
                  className="welcome-recent-open"
                  onClick={() => onOpenRecent(item)}
                  disabled={busy}
                  aria-label={`Open ${item.displayName || item.name || "project"}`}
                >
                  <div className="welcome-recent-heading">
                    <div className="welcome-recent-name">{item.displayName || item.name || "Unnamed project"}</div>
                  </div>
                  <div className="welcome-recent-path">{formatPathForCard(item.path)}</div>
                  <div className="welcome-recent-time">{formatLastOpened(item.lastOpenedAt)}</div>
                </button>
              )}
              {renamingPath !== item.path ? (
                <button type="button" className="welcome-recent-rename-btn" onClick={(event) => startRename(event, item)} disabled={busy} aria-label={`Rename ${item.displayName || item.name || "project"}`} title="Rename project">Rename</button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {error ? <div className="welcome-error">{error}</div> : null}
    </div>
  );
}
