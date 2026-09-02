"use client";
import { useEffect, useState, useCallback } from "react";
import { bridge } from "../lib/bridge";
import { useRuntimeEvents } from "../lib/useRuntimeEvents";
import ProjectControls from "../components/ProjectControls/ProjectControls";
import ChatPanel from "../components/Chat/ChatPanel";
import ChangesPanel from "../components/Changes/ChangesPanel";
import PreviewPanel from "../components/Preview/PreviewPanel";
import TerminalPanel from "../components/Terminal/TerminalPanel";

export default function Page() {
  const [project, setProject] = useState(null);
  const [envStatus, setEnvStatus] = useState(null);
  const [messages, setMessages] = useState([]);
  const [sidebarTab, setSidebarTab] = useState("chat"); // chat | changes
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [terminalCollapsed, setTerminalCollapsed] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(220);
  const [changesRefreshToken, setChangesRefreshToken] = useState(0);
  // Bumped whenever the dev server (re)starts and establishes a fresh
  // initial preview URL. PreviewPanel resets its address bar to the new
  // previewUrl only when this changes — never on every render — so a
  // manually-typed URL/path survives unrelated re-renders and is only
  // overridden by an explicit start/restart, per its own address-bar spec.
  const [previewGeneration, setPreviewGeneration] = useState(0);
  // Bumped whenever the Terminal should be opened + focused (e.g. the user
  // clicked "Start Dev Server"). TerminalPanel watches this and calls
  // term.focus() — it doesn't matter what the value is, only that it changes.
  const [terminalFocusToken, setTerminalFocusToken] = useState(0);

  useEffect(() => {
    // Hydrate from the authoritative workspace snapshot on mount.
    // workspace:current returns { project, devServer, previewUrl, ... }.
    bridge.workspace.current().then((ws) => {
      if (ws?.project) setProject(ws.project);
      if (ws?.devServer || ws?.previewUrl) {
        setEnvStatus({ devServer: ws.devServer, previewUrl: ws.previewUrl });
      }
    });
  }, []);

  // The dev server now runs inside the integrated Terminal's own PTY
  // session, which TerminalPanel already keeps correctly sized (via
  // xterm.js's FitAddon, driven by the panel's actual pixel dimensions —
  // far more accurate than a window-size heuristic). No separate
  // environment-level resize plumbing is needed.

  // Opens/expands the Terminal and focuses it. Passed to ProjectControls so
  // clicking "Start Dev Server" brings the Terminal into view before typing
  // the command there.
  const activateTerminal = useCallback(() => {
    setTerminalCollapsed(false);
    setTerminalFocusToken((t) => t + 1);
  }, []);

  const addMessage = useCallback((msg) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  useRuntimeEvents((evt) => {
    switch (evt.type) {
      // -----------------------------------------------------------------------
      // Workspace events (authoritative active-project state from WorkspaceManager)
      // -----------------------------------------------------------------------
      case "workspace.opened":
      case "workspace.switched":
        // Full workspace snapshot — update project + reset chat.
        setProject(evt.payload.project);
        setMessages([]);
        if (evt.payload.devServer || evt.payload.previewUrl) {
          setEnvStatus({ devServer: evt.payload.devServer, previewUrl: evt.payload.previewUrl });
        } else {
          setEnvStatus(null);
        }
        break;
      case "workspace.closed":
        setProject(null);
        setEnvStatus(null);
        setMessages([]);
        break;

      // -----------------------------------------------------------------------
      // Legacy project events (still emitted by ProjectManager for back-compat)
      // -----------------------------------------------------------------------
      case "project.opened":
        setProject(evt.payload);
        setMessages([]);
        break;
      case "project.closed":
        setProject(null);
        setEnvStatus(null);
        setMessages([]);
        break;
      case "project.error":
        addMessage({ role: "error", text: evt.payload.error });
        break;

      case "environment.starting":
        addMessage({ role: "activity", kind: "tool_started", text: "Starting Bigin development environment…" });
        break;
      case "environment.started":
        setEnvStatus((s) => ({ ...s, previewUrl: evt.payload.previewUrl, devServer: { ...(s?.devServer || {}), running: true } }));
        // A genuine (re)start just established a fresh initial preview URL —
        // bump the generation so PreviewPanel knows to reset its address bar
        // to it, overriding any URL the user had manually typed before.
        setPreviewGeneration((g) => g + 1);
        addMessage({ role: "activity", kind: "tool_completed", text: `Bigin dev environment started (${evt.payload.mode}).` });
        break;
      case "environment.stopped":
        setEnvStatus((s) => ({ ...s, previewUrl: null, devServer: { ...(s?.devServer || {}), running: false } }));
        break;
      case "environment.error":
        addMessage({ role: "error", text: evt.payload.error });
        break;

      case "agent.thinking":
        addMessage({ role: "activity", kind: "tool_started", text: "Analyzing request…" });
        break;
      case "agent.tool.started":
        addMessage({ role: "activity", kind: "tool_started", text: `Running ${evt.payload.tool}…` });
        break;
      case "agent.tool.completed":
        addMessage({ role: "activity", kind: "tool_completed", text: `${evt.payload.tool} completed` });
        break;
      case "agent.file.changed":
        addMessage({ role: "activity", kind: "file_changed", text: `Updated ${evt.payload.path}` });
        setChangesRefreshToken((t) => t + 1);
        break;
      case "agent.message":
        addMessage({ role: "assistant", text: evt.payload.text });
        break;
      case "agent.completed":
        addMessage({ role: "activity", kind: "tool_completed", text: "Preview updated." });
        setChangesRefreshToken((t) => t + 1);
        break;
      case "agent.error":
        addMessage({ role: "error", text: evt.payload.error });
        break;

      default:
        break;
    }
  });

  return (
    <div className="app-shell">
      <ProjectControls
        project={project}
        envStatus={envStatus}
        onProjectOpened={setProject}
        onEnvChange={setEnvStatus}
        onBeforeStart={activateTerminal}
      />
      <div className="app-body">
        <div className={`sidebar ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
          <div className="sidebar-tabs">
            {!sidebarCollapsed && (
              <>
                <button
                  className={sidebarTab === "chat" ? "active" : ""}
                  onClick={() => setSidebarTab("chat")}
                >
                  Chat
                </button>
                <button
                  className={sidebarTab === "changes" ? "active" : ""}
                  onClick={() => setSidebarTab("changes")}
                >
                  Changes
                </button>
              </>
            )}
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarCollapsed((c) => !c)}
              aria-expanded={!sidebarCollapsed}
              aria-label={sidebarCollapsed ? "Expand chat panel" : "Collapse chat panel"}
              title={sidebarCollapsed ? "Expand chat panel" : "Collapse chat panel"}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                style={{ transform: sidebarCollapsed ? "rotate(180deg)" : "none" }}
              >
                <path
                  d="M10 3L5 8l5 5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
          <div className="sidebar-content" style={{ display: sidebarCollapsed ? "none" : "flex" }}>
            {sidebarTab === "chat" ? (
              <ChatPanel project={project} messages={messages} onSend={addMessage} />
            ) : (
              <ChangesPanel project={project} refreshToken={changesRefreshToken} />
            )}
          </div>
        </div>
        <div className="main-area">
          <PreviewPanel
            previewUrl={envStatus?.previewUrl}
            envRunning={envStatus?.devServer?.running}
            previewGeneration={previewGeneration}
            projectPath={project?.path}
          />
        </div>
      </div>
      <TerminalPanel
        project={project}
        collapsed={terminalCollapsed}
        onToggleCollapse={() => setTerminalCollapsed((c) => !c)}
        height={terminalHeight}
        onResize={setTerminalHeight}
        focusToken={terminalFocusToken}
      />
    </div>
  );
}
