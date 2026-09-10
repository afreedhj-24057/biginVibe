"use client";
import { useEffect, useState, useCallback } from "react";
import { bridge } from "../lib/bridge";
import { useRuntimeEvents } from "../lib/useRuntimeEvents";
import ProjectControls from "../components/ProjectControls/ProjectControls";
import ChatPanel from "../components/Chat/ChatPanel";
import ChangesPanel from "../components/Changes/ChangesPanel";
import PreviewPanel from "../components/Preview/PreviewPanel";
import TerminalPanel from "../components/Terminal/TerminalPanel";
import WelcomeScreen from "../components/Welcome/WelcomeScreen";

const SIDEBAR_MIN_WIDTH = 300;
const SIDEBAR_MAX_WIDTH = 500;
const SIDEBAR_DEFAULT_WIDTH = 400;

function deriveSessionTitle(prompt) {
  if (!prompt || typeof prompt !== "string") return "New chat";
  const cleaned = prompt
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^requirements?\s*:/i.test(line))
    .filter((line) => !/^[-*]\s+/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "New chat";
  const sentence = cleaned.split(/[.!?]/)[0].trim() || cleaned;
  const compact = sentence
    .replace(/^please\s+/i, "")
    .replace(/^implement\s+/i, "")
    .replace(/^add\s+/i, "")
    .replace(/^create\s+/i, "")
    .trim();
  const title = compact.length > 56 ? `${compact.slice(0, 56).trimEnd()}...` : compact;
  return title || "New chat";
}

export default function Page() {
  const [project, setProject] = useState(null);
  const [envStatus, setEnvStatus] = useState(null);
  const [messages, setMessages] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [activeModel, setActiveModel] = useState(null);
  const [cavemanStatus, setCavemanStatus] = useState(null);
  const [selectedAgentMode, setSelectedAgentMode] = useState("build");
  const [sidebarTab, setSidebarTab] = useState("chat"); // chat | changes
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [terminalCollapsed, setTerminalCollapsed] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(220);
  const [agentWorking, setAgentWorking] = useState(false);
  const [agentActivities, setAgentActivities] = useState([]);
  const [agentActivityExpanded, setAgentActivityExpanded] = useState(false);
  const [changesRefreshToken, setChangesRefreshToken] = useState(0);
  const [recentProjects, setRecentProjects] = useState([]);
  const [welcomeBusy, setWelcomeBusy] = useState(false);
  const [welcomeError, setWelcomeError] = useState(null);
  // Bumped whenever the dev server (re)starts and establishes a fresh
  // initial preview URL. PreviewPanel resets its address bar to the new
  // previewUrl only when this changes — never on every render — so a
  // manually-typed URL/path survives unrelated re-renders and is only
  // overridden by an explicit start/restart, per its own address-bar spec.
  const [previewGeneration, setPreviewGeneration] = useState(0);

  useEffect(() => {
    // Hydrate from the authoritative workspace snapshot on mount.
    // workspace:current returns { project, devServer, previewUrl, ... }.
    bridge.workspace.current().then((ws) => {
      if (ws?.project) setProject(ws.project);
      if (ws?.opencodeSessionId) setActiveSessionId(ws.opencodeSessionId);
      if (ws?.project) {
        setSelectedAgentMode(ws.project.hasBigiBotAgent ? "bigibot" : "build");
      }
      if (ws?.devServer || ws?.previewUrl) {
        setEnvStatus({ devServer: ws.devServer, previewUrl: ws.previewUrl });
      }
    });
    Promise.resolve(bridge.chat.model()).then((model) => {
      if (model) setActiveModel(model);
    }).catch(() => {});
    Promise.resolve(bridge.chat.cavemanStatus?.()).then((status) => {
      if (status) setCavemanStatus(status);
    }).catch(() => {});
    Promise.resolve(bridge.project.recents?.()).then((recents) => {
      setRecentProjects(Array.isArray(recents) ? recents : []);
    }).catch(() => {
      setRecentProjects([]);
    });
  }, []);

  const refreshRecents = useCallback(() => {
    Promise.resolve(bridge.project.recents?.()).then((recents) => {
      setRecentProjects(Array.isArray(recents) ? recents : []);
    }).catch(() => {
      setRecentProjects([]);
    });
  }, []);

  const handleWelcomeOpenProject = useCallback(async () => {
    setWelcomeError(null);
    setWelcomeBusy(true);
    try {
      const dir = await bridge.project.pickDirectory();
      if (!dir) return;
      const opened = await bridge.project.open(dir);
      setProject(opened || null);
      refreshRecents();
    } catch (err) {
      setWelcomeError(err?.message || String(err));
    } finally {
      setWelcomeBusy(false);
    }
  }, [refreshRecents]);

  const handleWelcomeOpenRecent = useCallback(async (recent) => {
    if (!recent?.path) return;
    setWelcomeError(null);
    setWelcomeBusy(true);
    try {
      const opened = await bridge.project.open(recent.path);
      setProject(opened || null);
      refreshRecents();
    } catch (err) {
      setWelcomeError(err?.message || String(err));
      refreshRecents();
    } finally {
      setWelcomeBusy(false);
    }
  }, [refreshRecents]);

  const refreshCavemanStatus = useCallback(() => {
    Promise.resolve(bridge.chat.cavemanStatus?.()).then((status) => {
      if (status) setCavemanStatus(status);
    }).catch(() => {});
  }, []);

  // The dev server now runs inside the integrated Terminal's own PTY
  // session, which TerminalPanel already keeps correctly sized (via
  // xterm.js's FitAddon, driven by the panel's actual pixel dimensions —
  // far more accurate than a window-size heuristic). No separate
  // environment-level resize plumbing is needed.

  const addMessage = useCallback((msg) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const sortSessions = useCallback((list) => {
    return [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, []);

  const refreshSessions = useCallback(async (opts = {}) => {
    const listed = await bridge.chat.listSessions();
    const next = sortSessions(Array.isArray(listed) ? listed : []);
    setSessions(next);

    const preferred = opts.preferredSessionId;
    const current = opts.currentSessionId;
    const fallback = preferred || current || null;
    if (fallback && next.some((s) => s.id === fallback)) {
      setActiveSessionId(fallback);
      return { sessions: next, active: fallback };
    }

    if (!next.length) {
      setActiveSessionId(null);
      setMessages([]);
    }

    return { sessions: next, active: null };
  }, [sortSessions]);

  const loadSessionMessages = useCallback(async (sessionId) => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    const loaded = await bridge.chat.sessionMessages(sessionId);
    setMessages(Array.isArray(loaded) ? loaded : []);
  }, []);

  const openSession = useCallback(async (sessionId) => {
    if (!sessionId) return;
    const previousSessionId = activeSessionId;
    try {
      const session = await bridge.chat.openSession(sessionId);
      setActiveSessionId(session.id);
      await loadSessionMessages(session.id);
      await refreshSessions({ preferredSessionId: session.id });
      setAgentWorking(false);
      setAgentActivities([]);
      setAgentActivityExpanded(false);
    } catch (err) {
      addMessage({ role: "error", text: err?.message || String(err) });
      await refreshSessions();
      setActiveSessionId(previousSessionId || null);
    }
  }, [activeSessionId, loadSessionMessages, refreshSessions, addMessage]);

  const createNewSession = useCallback(async ({ title } = {}) => {
    const payload = {
      mode: selectedAgentMode,
      ...(title ? { title } : {}),
    };
    const createSession = bridge.chat.newSession;
    if (typeof createSession !== "function") {
      const err = new Error("Chat session controls are unavailable. Restart BiginVibe to load the latest chat bridge.");
      addMessage({ role: "error", text: err.message });
      throw err;
    }
    const created = await bridge.chat.newSession(payload);
    if (!created?.id) {
      const err = new Error("Could not create a new chat session. Restart BiginVibe and try again.");
      addMessage({ role: "error", text: err.message });
      throw err;
    }
    setActiveSessionId(created.id);
    setMessages([]);
    setAgentWorking(false);
    setAgentActivities([]);
    setAgentActivityExpanded(false);
    await refreshSessions({ preferredSessionId: created.id });
    return created;
  }, [selectedAgentMode, refreshSessions, addMessage]);

  const sendPrompt = useCallback(async (value) => {
    if (!project) {
      addMessage({
        role: "error",
        text: "No project is currently open.\n\nOpen a project before asking the agent to modify code.",
      });
      return;
    }

    const text = value.trim();
    if (!text) return;

    let targetSessionId = activeSessionId;
    let sessionTitle = "";

    if (!targetSessionId) {
      const created = await createNewSession({ title: deriveSessionTitle(text) });
      targetSessionId = created.id;
    }

    const activeSession = sessions.find((s) => s.id === targetSessionId);
    if (activeSession && (!activeSession.title || /^new chat$/i.test(activeSession.title))) {
      sessionTitle = deriveSessionTitle(text);
      try {
        await bridge.chat.renameSession(targetSessionId, sessionTitle);
      } catch {}
    }

    addMessage({ role: "user", text });
    try {
      await bridge.chat.sendMessage({
        text,
        mode: selectedAgentMode,
        sessionId: targetSessionId,
        ...(sessionTitle ? { sessionTitle } : {}),
      });
      await refreshSessions({ preferredSessionId: targetSessionId });
    } catch (err) {
      addMessage({ role: "error", text: err?.message || String(err) });
      throw err;
    }
  }, [project, activeSessionId, selectedAgentMode, sessions, createNewSession, addMessage, refreshSessions]);

  const renameSession = useCallback(async (sessionId, title) => {
    await bridge.chat.renameSession(sessionId, title);
    await refreshSessions({ preferredSessionId: sessionId });
  }, [refreshSessions]);

  const forkSession = useCallback(async (sessionId) => {
    const forked = await bridge.chat.forkSession(sessionId);
    await refreshSessions({ preferredSessionId: forked?.id });
    if (forked?.id) await openSession(forked.id);
  }, [refreshSessions, openSession]);

  const deleteSession = useCallback(async (sessionId) => {
    await bridge.chat.deleteSession(sessionId);
    const result = await refreshSessions({ currentSessionId: activeSessionId });
    if (!result.sessions.length) {
      setMessages([]);
      return;
    }
    const nextActive = result.active || result.sessions[0]?.id;
    if (nextActive) await openSession(nextActive);
  }, [refreshSessions, activeSessionId, openSession]);

  const isActiveSessionEvent = useCallback((payload) => {
    const sid = payload?.sessionId;
    if (!sid) return true;
    if (!activeSessionId) return false;
    return sid === activeSessionId;
  }, [activeSessionId]);

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
    const model = payload?.model || null;
    const agentMode = payload?.agentMode || "build";

    setMessages((prev) => {
      if (!messageId) {
        return [...prev, { role: "assistant", text, model: model || activeModel, agentMode }];
      }

      const idx = prev.findIndex(
        (m) => m.role === "assistant" && m.opencodeMessageId === messageId
      );

      if (idx === -1) {
        return [...prev, {
          role: "assistant",
          text,
          opencodeMessageId: messageId,
          model: model || activeModel,
          agentMode,
        }];
      }

      const next = [...prev];
      const existing = next[idx];
      next[idx] = {
        ...existing,
        model: existing.model || model || activeModel,
        agentMode: existing.agentMode || agentMode,
        text: kind === "delta" ? `${existing.text || ""}${text}` : text,
      };
      return next;
    });
  }, [activeModel]);

  const applyAgentActivity = useCallback((payload) => {
    const allowedKinds = new Set(["task", "subagent", "tool", "command", "processing"]);
    const allowedStatus = new Set(["running", "completed", "failed", "cancelled"]);
    const kind = typeof payload?.kind === "string" && allowedKinds.has(payload.kind)
      ? payload.kind
      : null;
    const status = typeof payload?.status === "string" && allowedStatus.has(payload.status)
      ? payload.status
      : null;
    const label = typeof payload?.label === "string" ? payload.label.trim() : "";
    if (!kind || !status || !label) return;

    setAgentActivities((prev) => {
      const now = Date.now();
      const next = prev.slice(-11);
      const last = next[next.length - 1];
      if (last && last.kind === kind && last.status === status && last.label === label && (now - last.at) < 900) {
        return next;
      }
      return [...next, { kind, status, label, at: now }];
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
        setSessions([]);
        setActiveSessionId(evt.payload.opencodeSessionId || null);
        setAgentActivities([]);
        setAgentActivityExpanded(false);
        setSelectedAgentMode(evt.payload.project?.hasBigiBotAgent ? "bigibot" : "build");
        setAgentWorking(false);
        if (evt.payload.devServer || evt.payload.previewUrl) {
          setEnvStatus({ devServer: evt.payload.devServer, previewUrl: evt.payload.previewUrl });
        } else {
          setEnvStatus(null);
        }
        refreshCavemanStatus();
        refreshRecents();
        break;
      case "workspace.closed":
        setProject(null);
        setEnvStatus(null);
        setMessages([]);
        setSessions([]);
        setActiveSessionId(null);
        setAgentActivities([]);
        setAgentActivityExpanded(false);
        setSelectedAgentMode("build");
        setAgentWorking(false);
        refreshCavemanStatus();
        refreshRecents();
        break;

      // -----------------------------------------------------------------------
      // Legacy project events (still emitted by ProjectManager for back-compat)
      // -----------------------------------------------------------------------
      case "project.opened":
        setProject(evt.payload);
        setMessages([]);
        setSessions([]);
        setActiveSessionId(null);
        setAgentActivities([]);
        setAgentActivityExpanded(false);
        setSelectedAgentMode(evt.payload?.hasBigiBotAgent ? "bigibot" : "build");
        setAgentWorking(false);
        refreshCavemanStatus();
        refreshRecents();
        break;
      case "project.closed":
        setProject(null);
        setEnvStatus(null);
        setMessages([]);
        setSessions([]);
        setActiveSessionId(null);
        setAgentActivities([]);
        setAgentActivityExpanded(false);
        setSelectedAgentMode("build");
        setAgentWorking(false);
        refreshCavemanStatus();
        refreshRecents();
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
        if (!isActiveSessionEvent(evt.payload)) break;
        setAgentWorking(true);
        setAgentActivities([]);
        setAgentActivityExpanded(false);
        break;
      case "agent.activity":
        if (!isActiveSessionEvent(evt.payload)) break;
        applyAgentActivity(evt.payload);
        break;
      case "agent.tool.started":
        break;
      case "agent.tool.completed":
        break;
      case "agent.file.changed":
        setChangesRefreshToken((t) => t + 1);
        break;
      case "agent.message":
        if (!isActiveSessionEvent(evt.payload)) break;
        setAgentWorking(false);
        applyAssistantMessage(evt.payload);
        break;
      case "agent.completed":
        if (!isActiveSessionEvent(evt.payload)) break;
        setAgentWorking(false);
        setAgentActivityExpanded(false);
        setChangesRefreshToken((t) => t + 1);
        refreshCavemanStatus();
        refreshSessions({ currentSessionId: activeSessionId }).catch(() => {});
        break;
      case "agent.error":
        if (!isActiveSessionEvent(evt.payload)) break;
        setAgentWorking(false);
        setAgentActivityExpanded(false);
        addMessage({ role: "error", text: evt.payload.error });
        refreshCavemanStatus();
        break;

      default:
        break;
    }
  }, [
    addMessage,
    applyAssistantMessage,
    applyAgentActivity,
    refreshCavemanStatus,
    refreshRecents,
    refreshSessions,
    openSession,
    activeSessionId,
    isActiveSessionEvent,
  ]);

  useEffect(() => {
    if (!project?.path) return;

    let cancelled = false;
    (async () => {
      try {
        await refreshSessions({ currentSessionId: activeSessionId });
        if (cancelled) return;
      } catch (err) {
        if (!cancelled) {
          addMessage({ role: "error", text: err?.message || String(err) });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [project?.path]);

  if (!project) {
    return (
      <div className="app-shell">
        <WelcomeScreen
          recents={recentProjects}
          busy={welcomeBusy}
          error={welcomeError}
          onOpenProject={handleWelcomeOpenProject}
          onOpenRecent={handleWelcomeOpenRecent}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <ProjectControls
        project={project}
        onProjectOpened={setProject}
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
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  onOpenSession={openSession}
                  onNewSession={createNewSession}
                  onRenameSession={renameSession}
                  onForkSession={forkSession}
                  onDeleteSession={deleteSession}
                  messages={messages}
                  onSend={sendPrompt}
                  agentWorking={agentWorking}
                  activeModel={activeModel}
                  cavemanStatus={cavemanStatus}
                  activityEntries={agentActivities}
                  activityExpanded={agentActivityExpanded}
                  onToggleActivityExpanded={() => setAgentActivityExpanded((v) => !v)}
                  selectedAgentMode={selectedAgentMode}
                  onAgentModeChange={setSelectedAgentMode}
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
      />
    </div>
  );
}
