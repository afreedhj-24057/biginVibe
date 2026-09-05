"use client";
import { useEffect, useState, useCallback } from "react";
import { bridge } from "../lib/bridge";
import { useRuntimeEvents } from "../lib/useRuntimeEvents";
import ProjectControls from "../components/ProjectControls/ProjectControls";
import ChatPanel from "../components/Chat/ChatPanel";
import ChangesPanel from "../components/Changes/ChangesPanel";
import PreviewPanel from "../components/Preview/PreviewPanel";
import TerminalPanel from "../components/Terminal/TerminalPanel";

const SIDEBAR_MIN_WIDTH = 300;
const SIDEBAR_MAX_WIDTH = 500;
const SIDEBAR_DEFAULT_WIDTH = 400;

export default function Page() {
  const [project, setProject] = useState(null);
  const [envStatus, setEnvStatus] = useState(null);
  const [messages, setMessages] = useState([]);
  const [sidebarTab, setSidebarTab] = useState("chat"); // chat | changes
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [terminalCollapsed, setTerminalCollapsed] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(220);
  const [agentWorking, setAgentWorking] = useState(false);
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

  const startSidebarResize = useCallback((e) => {
    if (sidebarCollapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    function onMouseMove(moveEvt) {
      const next = startWidth + (moveEvt.clientX - startX);
      const clamped = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, next));
      setSidebarWidth(clamped);
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [sidebarCollapsed, sidebarWidth]);

  const applyAssistantMessage = useCallback((payload) => {
    const text = payload?.text;
    if (!text) return;

    const messageId = payload?.messageId;
    const kind = payload?.kind || "final";

    setMessages((prev) => {
      if (!messageId) return [...prev, { role: "assistant", text }];

      const idx = prev.findIndex(
        (m) => m.role === "assistant" && m.opencodeMessageId === messageId
      );

      if (idx === -1) {
        return [...prev, { role: "assistant", text, opencodeMessageId: messageId }];
      }

      const next = [...prev];
      const existing = next[idx];
      next[idx] = {
        ...existing,
        text: kind === "delta" ? `${existing.text || ""}${text}` : text,
      };
      return next;
    });
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
        setAgentWorking(false);
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
        setAgentWorking(false);
        break;

      // -----------------------------------------------------------------------
      // Legacy project events (still emitted by ProjectManager for back-compat)
      // -----------------------------------------------------------------------
      case "project.opened":
        setProject(evt.payload);
        setMessages([]);
        setAgentWorking(false);
        break;
      case "project.closed":
        setProject(null);
        setEnvStatus(null);
        setMessages([]);
        setAgentWorking(false);
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
        setAgentWorking(true);
        break;
      case "agent.tool.started":
        break;
      case "agent.tool.completed":
        break;
      case "agent.file.changed":
        setChangesRefreshToken((t) => t + 1);
        break;
      case "agent.message":
        setAgentWorking(false);
        applyAssistantMessage(evt.payload);
        break;
      case "agent.completed":
        setAgentWorking(false);
        setChangesRefreshToken((t) => t + 1);
        break;
      case "agent.error":
        setAgentWorking(false);
        addMessage({ role: "error", text: evt.payload.error });
        break;

      default:
        break;
    }
  }, [addMessage, applyAssistantMessage]);

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
        <div
          className={`sidebar ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
          style={{ width: sidebarCollapsed ? 36 : sidebarWidth }}
        >
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
              <ChatPanel
                project={project}
                messages={messages}
                onSend={addMessage}
                agentWorking={agentWorking}
              />
            ) : (
              <ChangesPanel project={project} refreshToken={changesRefreshToken} />
            )}
          </div>
        </div>
        {!sidebarCollapsed && (
          <div
            className="sidebar-resize-handle"
            onMouseDown={startSidebarResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat panel"
          />
        )}
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
