"use client";
import { useEffect, useState } from "react";
import { bridge } from "../../lib/bridge";

const STATUS_COLORS = {
  M: "#e5c07b",
  A: "#98c379",
  D: "#e06c75",
  R: "#61afef",
  "?": "#c678dd",
};

function fileStatus(file, stagedView) {
  if (file.untracked) return "U";
  return stagedView ? file.indexStatus : file.worktreeStatus;
}

function fileName(filePath) {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return slash === -1 ? filePath : filePath.slice(slash + 1);
}

function fileDirectory(filePath) {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return slash === -1 ? "" : filePath.slice(0, slash);
}

export default function ChangesPanel({ project, refreshToken }) {
  const [files, setFiles] = useState([]);
  const [selected, setSelected] = useState(null);
  const [diff, setDiff] = useState("");
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState({ staged: true, changes: true, untracked: true });

  useEffect(() => {
    if (!project) {
      setFiles([]);
      return;
    }
    bridge.git
      .status()
      .then((list) => setFiles(list || []))
      .catch((err) => setError(err.message || String(err)));
  }, [project, refreshToken]);

  async function openDiff(file) {
    setSelected(file);
    try {
      const d = file.staged
        ? await bridge.git.diffCached?.(file.path)
        : await bridge.git.diff(file.path);
      setDiff(d || "(no textual diff)");
    } catch (err) {
      setDiff(`Failed to load diff: ${err.message || err}`);
    }
  }

  if (!project) return <div className="changes-empty">Open a project to see changes.</div>;
  if (error) return <div className="changes-error">{error}</div>;

  const groups = [
    {
      key: "staged",
      label: "Staged Changes",
      stagedView: true,
      files: files.filter((file) => file.staged),
    },
    {
      key: "changes",
      label: "Changes",
      stagedView: false,
      files: files.filter((file) => !file.untracked && file.worktreeStatus !== " "),
    },
    {
      key: "untracked",
      label: "Untracked",
      stagedView: false,
      files: files.filter((file) => file.untracked),
    },
  ];

  function toggleGroup(key) {
    setExpanded((current) => ({ ...current, [key]: !current[key] }));
  }

  return (
    <div className="changes-panel">
      <div className="changes-list">
        {files.length === 0 && <div className="changes-empty">No changes.</div>}
        {groups.map((group) => group.files.length > 0 && (
          <section className="changes-group" key={group.key}>
            <button className="changes-group-header" onClick={() => toggleGroup(group.key)}>
              <span className={`changes-chevron ${expanded[group.key] ? "expanded" : ""}`}>›</span>
              <span>{group.label}</span>
              <span className="changes-group-count">{group.files.length}</span>
            </button>
            {expanded[group.key] && group.files.map((file) => {
              const status = fileStatus(file, group.stagedView);
              const diffFile = { ...file, staged: group.stagedView };
              return (
                <button
                  key={`${group.key}-${file.path}`}
                  className={`changes-item ${selected?.path === file.path && selected?.staged === group.stagedView ? "selected" : ""}`}
                  onClick={() => openDiff(diffFile)}
                  title={file.path}
                >
                  <span className="changes-file-copy">
                    <span className="changes-file-name">{fileName(file.path)}</span>
                    <span className="changes-file-directory">{fileDirectory(file.path)}</span>
                  </span>
                  <span
                    className="changes-status-letter"
                    style={{ color: STATUS_COLORS[status] || "#abb2bf" }}
                  >
                    {status}
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
      {selected && (
        <pre className="changes-diff">{diff}</pre>
      )}
    </div>
  );
}
