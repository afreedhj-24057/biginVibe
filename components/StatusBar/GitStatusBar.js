"use client";

export default function GitStatusBar({ status, onRefresh }) {
  if (!status?.projectPath) return null;

  const branch = status.isRepository
    ? status.branch || "Detached HEAD"
    : "Not a Git repository";
  const sync = status.ahead !== null && status.behind !== null
    ? `${status.behind}↓ ${status.ahead}↑`
    : "—";
  const title = status.error
    ? `Git status error: ${status.error}`
    : status.isRepository
      ? `${status.branch ? `Branch ${status.branch}` : "Detached HEAD"}. Working tree ${status.isDirty ? "has uncommitted changes" : "clean"}. Remote: ${status.remoteStatus}.`
      : "The active project is not a Git repository.";

  return (
    <div className="status-bar-git" title={title}>
      <span className="status-bar-git-branch" title={branch}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="4" cy="4" r="1.7" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="12" cy="12" r="1.7" stroke="currentColor" strokeWidth="1.3" />
          <path d="M4 5.8V8.2C4 10.3 5.7 12 7.8 12H10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <span>{branch}{status.isRepository && status.isDirty ? "*" : ""}</span>
      </span>
      <button
        type="button"
        className={`status-bar-git-refresh ${status.isRefreshing ? "is-refreshing" : ""}`}
        onClick={onRefresh}
        disabled={status.isRefreshing || !status.isRepository}
        aria-label="Refresh Git status"
        title="Refresh Git status"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M13 5.5A5 5 0 1 0 13.2 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <path d="M13 2.8V5.8H10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <span className="status-bar-git-sync" title={`Remote status: ${status.remoteStatus}`}>
        {status.isRepository ? sync : ""}
      </span>
    </div>
  );
}
