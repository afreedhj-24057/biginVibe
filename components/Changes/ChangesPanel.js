"use client";
import { useEffect, useState } from "react";
import { bridge } from "../../lib/bridge";

const STATUS_LABELS = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  "??": "Untracked",
  R: "Renamed",
};

export default function ChangesPanel({ project, refreshToken }) {
  const [files, setFiles] = useState([]);
  const [selected, setSelected] = useState(null);
  const [diff, setDiff] = useState("");
  const [error, setError] = useState(null);

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
      const d = await bridge.git.diff(file.path);
      setDiff(d || "(no textual diff)");
    } catch (err) {
      setDiff(`Failed to load diff: ${err.message || err}`);
    }
  }

  if (!project) return <div className="changes-empty">Open a project to see changes.</div>;
  if (error) return <div className="changes-error">{error}</div>;

  return (
    <div className="changes-panel">
      <div className="changes-list">
        {files.length === 0 && <div className="changes-empty">No changes.</div>}
        {files.map((f) => (
          <button
            key={f.path}
            className={`changes-item ${selected?.path === f.path ? "selected" : ""}`}
            onClick={() => openDiff(f)}
          >
            <span className="changes-status">{STATUS_LABELS[f.status] || f.status}</span>
            <span className="changes-path">{f.path}</span>
          </button>
        ))}
      </div>
      {selected && (
        <pre className="changes-diff">{diff}</pre>
      )}
    </div>
  );
}
