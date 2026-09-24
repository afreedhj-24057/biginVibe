"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import { bridge } from "../lib/bridge";
import { useRuntimeEvents } from "../lib/useRuntimeEvents";
import ProjectControls from "../components/ProjectControls/ProjectControls";
import ChatPanel from "../components/Chat/ChatPanel";
import ChangesPanel from "../components/Changes/ChangesPanel";
import PreviewPanel from "../components/Preview/PreviewPanel";
import TerminalPanel from "../components/Terminal/TerminalPanel";
import WelcomeScreen from "../components/Welcome/WelcomeScreen";
import GitStatusBar from "../components/StatusBar/GitStatusBar";

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
  const [sessionListStatus, setSessionListStatus] = useState("idle");
  const [sessionListError, setSessionListError] = useState("");
  const sessionListRequestRef = useRef(0);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [activeModel, setActiveModel] = useState(null);
  const [modelOptions, setModelOptions] = useState([]);
  const [selectedModelValue, setSelectedModelValue] = useState("");
  const [modelLoading, setModelLoading] = useState(false);
  const [modelLoadError, setModelLoadError] = useState("");
  const [cavemanStatus, setCavemanStatus] = useState(null);
  const [agents, setAgents] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [sidebarTab, setSidebarTab] = useState("chat"); // chat | changes
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [terminalCollapsed, setTerminalCollapsed] = useState(true);
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
  const [gitStatus, setGitStatus] = useState(null);

  useEffect(() => {
    // Hydrate from the authoritative workspace snapshot on mount.
    // workspace:current returns { project, devServer, previewUrl, ... }.
    bridge.workspace.current().then((ws) => {
      if (ws?.project) setProject(ws.project);
      if (ws?.opencodeSessionId) setActiveSessionId(ws.opencodeSessionId);
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

  useEffect(() => {
    let cancelled = false;
    bridge.git.statusModel?.().then((status) => {
      if (!cancelled) setGitStatus(status || null);
    }).catch(() => {
      if (!cancelled) setGitStatus(null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const normalizeModelValue = useCallback((input) => {
    if (!input) return "";
    if (typeof input === "string") {
      const trimmed = input.trim();
      if (!trimmed.includes("/")) return "";
      return trimmed;
    }
    if (typeof input === "object") {
      const providerID = typeof input.providerID === "string" ? input.providerID.trim() : "";
      const modelID = typeof input.modelID === "string" ? input.modelID.trim() : "";
      if (!providerID || !modelID) return "";
      return `${providerID}/${modelID}`;
    }
    return "";
  }, []);

  const parseModelValue = useCallback((value) => {
    if (!value || typeof value !== "string") return null;
    const trimmed = value.trim();
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash >= trimmed.length - 1) return null;
    const providerID = trimmed.slice(0, slash).trim();
    const modelID = trimmed.slice(slash + 1).trim();
    if (!providerID || !modelID) return null;
    return { providerID, modelID };
  }, []);

  const loadModels = useCallback(async (forceRefresh = false) => {
    if (!project?.path) {
      setModelOptions([]);
      setSelectedModelValue("");
      setModelLoadError("");
      setModelLoading(false);
      return;
    }

    setModelLoading(true);
    setModelLoadError("");
    try {
      const payload = await bridge.chat.models?.(forceRefresh);
      const models = Array.isArray(payload?.models)
        ? payload.models
            .filter((m) => m && typeof m.value === "string" && m.value.trim())
            .map((m) => ({
              value: m.value.trim(),
              providerID: typeof m.providerID === "string" ? m.providerID.trim() : "",
              providerName: typeof m.providerName === "string" && m.providerName.trim()
                ? m.providerName.trim()
                : "",
              modelID: typeof m.modelID === "string" ? m.modelID.trim() : "",
              modelName: typeof m.modelName === "string" && m.modelName.trim()
                ? m.modelName.trim()
                : (typeof m.label === "string" && m.label.trim() ? m.label.trim() : m.value.trim()),
            }))
        : [];

      const canonicalize = (value) => {
        const parsed = parseModelValue(value);
        if (!parsed) return "";
        const providerID = parsed.providerID === "github" ? "github-copilot" : parsed.providerID;
        return `${providerID}/${parsed.modelID}`;
      };
       const canonicalModels = models.map((m) => ({
         ...m,
         value: canonicalize(m.value) || m.value,
       }));

      const knownValues = new Set(canonicalModels.map((m) => m.value));
      const current = canonicalize(normalizeModelValue(selectedModelValue || activeModel));
      const serverDefault = canonicalize(normalizeModelValue(payload?.defaultModel));
      const nextSelected = knownValues.has(current)
        ? current
        : knownValues.has(serverDefault)
          ? serverDefault
          : canonicalModels[0]?.value || "";

      setModelOptions(canonicalModels);
      setSelectedModelValue(nextSelected);
      if (nextSelected) setActiveModel(nextSelected);
    } catch (err) {
      setModelOptions([]);
      setSelectedModelValue("");
      setModelLoadError(err?.message || "Failed to load models.");
    } finally {
      setModelLoading(false);
    }
  }, [project?.path, selectedModelValue, activeModel, normalizeModelValue]);

  const loadAgents = useCallback(async () => {
    if (!project?.path) {
      setAgents([]);
      setSelectedAgent("");
      return;
    }

    try {
      const payload = await bridge.chat.agents?.();
      const available = Array.isArray(payload)
        ? payload
            .filter((agent) => agent && typeof agent.name === "string" && agent.name.trim())
            .filter((agent) => agent.hidden !== true)
            .filter((agent) => agent.mode !== "subagent")
        : [];
      setAgents(available);
      setSelectedAgent((current) => (
        available.some((agent) => agent.name === current)
          ? current
          : available[0]?.name || ""
      ));
    } catch {
      setAgents([]);
      setSelectedAgent("");
    }
  }, [project?.path]);

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

  const handleWelcomeRenameRecent = useCallback(async (recent, displayName) => {
    if (!recent?.path) return;
    setWelcomeError(null);
    try {
      await bridge.project.renameRecent(recent.path, displayName);
      refreshRecents();
    } catch (err) {
      setWelcomeError(err?.message || String(err));
      throw err;
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
    const requestId = ++sessionListRequestRef.current;
    const projectPath = project?.path;
    if (!projectPath) {
      setSessionListStatus("idle");
      setSessionListError("");
      return { sessions: [], active: null };
    }

    setSessionListStatus("loading");
    setSessionListError("");
    try {
      const listed = await bridge.chat.listSessions();
      if (requestId !== sessionListRequestRef.current || project?.path !== projectPath) {
        return { sessions: [], active: null };
      }

      const next = sortSessions(Array.isArray(listed) ? listed : []);
      setSessions(next);
      setSessionListStatus("success");

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
    } catch (err) {
      if (requestId === sessionListRequestRef.current && project?.path === projectPath) {
        setSessionListStatus("error");
        setSessionListError(err?.message || String(err));
      }
      throw err;
    } finally {
      // A stale request must not clear the status for a newer project/request.
      if (requestId === sessionListRequestRef.current && project?.path === projectPath) {
        setSessionListStatus((status) => status === "loading" ? "error" : status);
      }
    }
  }, [project?.path, sortSessions]);

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
  }, [refreshSessions, addMessage]);

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
      const selectedModel = parseModelValue(selectedModelValue);
      await bridge.chat.sendMessage({
        text,
        ...(selectedAgent ? { agent: selectedAgent } : {}),
        sessionId: targetSessionId,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(sessionTitle ? { sessionTitle } : {}),
      });
      await refreshSessions({ preferredSessionId: targetSessionId });
    } catch (err) {
      const nextText = err?.message || String(err);
      setMessages((prev) => {
        if (!Array.isArray(prev) || prev.length === 0) {
          return [...prev, { role: "error", text: nextText }];
        }
        const last = prev[prev.length - 1];
        if (last?.role === "error" && String(last?.text || "") === String(nextText || "")) {
          return prev;
        }
        return [...prev, { role: "error", text: nextText }];
      });
      throw err;
    }
  }, [project, activeSessionId, selectedAgent, sessions, createNewSession, refreshSessions, selectedModelValue, parseModelValue]);

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

  const refreshGitStatus = useCallback(() => {
    bridge.git.refresh?.().then((status) => {
      if (status) setGitStatus(status);
    }).catch(() => {});
  }, []);

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
        sessionListRequestRef.current += 1;
        setWorkspaceRevision((revision) => revision + 1);
        setProject(evt.payload.project);
        setMessages([]);
        setSessions([]);
        setSessionListStatus("idle");
        setSessionListError("");
        setActiveSessionId(evt.payload.opencodeSessionId || null);
        setAgentActivities([]);
        setAgentActivityExpanded(false);
        setAgents([]);
        setSelectedAgent("");
        setAgentWorking(false);
        if (evt.payload.devServer || evt.payload.previewUrl) {
          setEnvStatus({ devServer: evt.payload.devServer, previewUrl: evt.payload.previewUrl });
        } else {
          setEnvStatus(null);
        }
        refreshCavemanStatus();
        refreshRecents();
        loadModels(false);
        break;
      case "workspace.closed":
        sessionListRequestRef.current += 1;
        setWorkspaceRevision((revision) => revision + 1);
        setProject(null);
        setEnvStatus(null);
        setMessages([]);
        setSessions([]);
        setSessionListStatus("idle");
        setSessionListError("");
        setActiveSessionId(null);
        setAgentActivities([]);
        setAgentActivityExpanded(false);
        setAgents([]);
        setSelectedAgent("");
        setAgentWorking(false);
        setModelOptions([]);
        setSelectedModelValue("");
        setModelLoadError("");
        setModelLoading(false);
        refreshCavemanStatus();
        refreshRecents();
        break;

      // -----------------------------------------------------------------------
      // Legacy project events (still emitted by ProjectManager for back-compat)
      // -----------------------------------------------------------------------
      case "project.opened":
        sessionListRequestRef.current += 1;
        setWorkspaceRevision((revision) => revision + 1);
        setProject(evt.payload);
        setMessages([]);
        setSessions([]);
        setSessionListStatus("idle");
        setSessionListError("");
        setActiveSessionId(null);
        setAgentActivities([]);
        setAgentActivityExpanded(false);
        setAgents([]);
        setSelectedAgent("");
        setAgentWorking(false);
        loadModels(false);
        refreshCavemanStatus();
        refreshRecents();
        break;
      case "project.closed":
        sessionListRequestRef.current += 1;
        setWorkspaceRevision((revision) => revision + 1);
        setProject(null);
        setEnvStatus(null);
        setMessages([]);
        setSessions([]);
        setSessionListStatus("idle");
        setSessionListError("");
        setActiveSessionId(null);
        setAgentActivities([]);
        setAgentActivityExpanded(false);
        setAgents([]);
        setSelectedAgent("");
        setAgentWorking(false);
        setModelOptions([]);
        setSelectedModelValue("");
        setModelLoadError("");
        setModelLoading(false);
        refreshCavemanStatus();
        refreshRecents();
        break;
      case "project.error":
        addMessage({ role: "error", text: evt.payload.error });
        break;

      case "git.status.updated":
        setGitStatus(evt.payload || null);
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
        setMessages((prev) => {
          if (!Array.isArray(prev) || prev.length === 0) {
            return [...prev, { role: "error", text: evt.payload.error }];
          }
          const last = prev[prev.length - 1];
          if (last?.role === "error" && String(last?.text || "") === String(evt.payload.error || "")) {
            return prev;
          }
          return [...prev, { role: "error", text: evt.payload.error }];
        });
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
    loadModels,
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
  }, [project?.path, workspaceRevision]);

  useEffect(() => {
    if (!project?.path) return;
    loadModels(false).catch(() => {});
    loadAgents().catch(() => {});
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
          onRenameRecent={handleWelcomeRenameRecent}
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
                   sessionListStatus={sessionListStatus}
                   sessionListError={sessionListError}
                  activeSessionId={activeSessionId}
                  onOpenSession={openSession}
                  onNewSession={createNewSession}
                  onRenameSession={renameSession}
                  onForkSession={forkSession}
                  onDeleteSession={deleteSession}
                  messages={messages}
                  onSend={sendPrompt}
                  agentWorking={agentWorking}
                  cavemanStatus={cavemanStatus}
                  activityEntries={agentActivities}
                  activityExpanded={agentActivityExpanded}
                  onToggleActivityExpanded={() => setAgentActivityExpanded((v) => !v)}
                   agents={agents}
                   selectedAgent={selectedAgent}
                   onAgentChange={setSelectedAgent}
                  models={modelOptions}
                  selectedModelValue={selectedModelValue}
                   onModelChange={(value) => {
                     setSelectedModelValue(value);
                     if (value) setActiveModel(value);
                   }}
                  modelLoading={modelLoading}
                  modelLoadError={modelLoadError}
                  onRefreshModels={() => loadModels(true)}
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
      <GitStatusBar status={gitStatus} onRefresh={refreshGitStatus} />
    </div>
  );
}
