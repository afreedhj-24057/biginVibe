"use client";
import { useEffect, useRef, useState } from "react";
import { bridge } from "../../lib/bridge";
import ChatMessage from "./ChatMessage";

/**
 * Chat: user requests, assistant responses, and a live activity trace
 * (tool calls, file changes, errors, completion) driven by agent.* events
 * forwarded from OpenCodeService.
 */
export default function ChatPanel({
  project,
  sessions = [],
  activeSessionId = null,
  onOpenSession,
  onNewSession,
  onRenameSession,
  onForkSession,
  onDeleteSession,
  messages,
  onSend,
  agentWorking,
  activeModel,
  cavemanStatus = null,
  activityEntries = [],
  activityExpanded = false,
  onToggleActivityExpanded,
  selectedAgentMode = "build",
  onAgentModeChange,
}) {
  const [text, setText] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionListOpen, setSessionListOpen] = useState(true);
  const [actingSessionId, setActingSessionId] = useState(null);
  const [sessionMenuOpenId, setSessionMenuOpenId] = useState(null);
  const [sessionMenuPosition, setSessionMenuPosition] = useState({ top: 0, left: 0 });
  const [renamingSessionId, setRenamingSessionId] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleteConfirmSessionId, setDeleteConfirmSessionId] = useState(null);
  const [sending, setSending] = useState(false);
  const processing = sending || agentWorking;
  const textareaRef = useRef(null);
  const hasBigiBotAgent = !!project?.hasBigiBotAgent;
  const effectiveAgentMode = hasBigiBotAgent ? selectedAgentMode : "build";

  const filteredSessions = sessions.filter((session) => {
    if (!sessionQuery.trim()) return true;
    return String(session.title || "")
      .toLowerCase()
      .includes(sessionQuery.trim().toLowerCase());
  });

  function groupLabel(updatedAt) {
    const ts = Number(updatedAt || 0);
    if (!ts) return "OLDER";

    const d = new Date(ts);
    const now = new Date();
    const startOfNow = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfTarget = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.floor((startOfNow - startOfTarget) / 86400000);

    if (days <= 0) return "TODAY";
    if (days === 1) return "YESTERDAY";
    if (days <= 7) return "LAST 7 DAYS";
    return "OLDER";
  }

  const grouped = filteredSessions.reduce((acc, session) => {
    const label = groupLabel(session.updatedAt);
    if (!acc[label]) acc[label] = [];
    acc[label].push(session);
    return acc;
  }, {});

  const orderedGroups = ["TODAY", "YESTERDAY", "LAST 7 DAYS", "OLDER"];
  const activeSessionTitle = sessions.find((session) => session.id === activeSessionId)?.title || "New chat";

  function prettyModelName(model) {
    if (!model) return "Unknown model";
    const raw = model.includes("/") ? model.split("/")[1] : model;
    if (!raw) return "Unknown model";
    return raw
      .split("-")
      .map((part) => {
        if (/^gpt$/i.test(part)) return "GPT";
        if (/^codex$/i.test(part)) return "Codex";
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(" ");
  }

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const nextHeight = Math.min(el.scrollHeight, 150);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > 150 ? "auto" : "hidden";
  }, [text]);

  useEffect(() => {
    if (processing && sessionSearchOpen) {
      setSessionSearchOpen(false);
    }
  }, [processing, sessionSearchOpen]);

  useEffect(() => {
    if (!activeSessionId) {
      setSessionListOpen(true);
    }
  }, [activeSessionId]);

  useEffect(() => {
    if (!deleteConfirmSessionId) return;
    const t = setTimeout(() => setDeleteConfirmSessionId(null), 2400);
    return () => clearTimeout(t);
  }, [deleteConfirmSessionId]);

  useEffect(() => {
    if (!sessionMenuOpenId) return;
    const onWindowClick = () => setSessionMenuOpenId(null);
    const onWindowResize = () => setSessionMenuOpenId(null);
    const onWindowScroll = () => setSessionMenuOpenId(null);
    window.addEventListener("click", onWindowClick);
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("scroll", onWindowScroll, true);
    return () => {
      window.removeEventListener("click", onWindowClick);
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("scroll", onWindowScroll, true);
    };
  }, [sessionMenuOpenId]);

  async function handleCancel() {
    if (!processing) return;
    setSending(false);
    try {
      await bridge.chat.cancel();
    } catch {}
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value || processing) return;

    // Enforce the workspace guard at the renderer level as well. The main
    // process enforces it too (chat:sendMessage throws when no project is
    // open), but surfacing it here gives immediate, clear feedback without
    // a round-trip to the main process.
    if (!project) {
      return;
    }

    setText("");
    setSending(true);
    try {
      await onSend(value);
    } catch {
      // Parent pipeline emits error rows; avoid duplicate renderer-side rows.
    } finally {
      setSending(false);
    }
  }

  async function handleNewChat() {
    if (!onNewSession || processing) return;
    setActingSessionId("new");
    try {
      await onNewSession();
      setSessionSearchOpen(false);
      setSessionListOpen(false);
      setSessionMenuOpenId(null);
    } finally {
      setActingSessionId(null);
    }
  }

  async function handleOpenSession(sessionId) {
    if (!onOpenSession) return;
    setActingSessionId(sessionId);
    try {
      await onOpenSession(sessionId);
      setSessionSearchOpen(false);
      setSessionListOpen(false);
      setSessionMenuOpenId(null);
    } finally {
      setActingSessionId(null);
    }
  }

  function handleBackToSessions() {
    setSessionSearchOpen(false);
    setSessionListOpen(true);
    setSessionMenuOpenId(null);
  }

  function toggleSessionMenu(evt, sessionId) {
    evt.stopPropagation();
    const rect = evt.currentTarget.getBoundingClientRect();
    const menuWidth = 136;
    const menuHeight = 102;
    const gap = 4;
    const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8));
    const top = Math.max(8, Math.min(rect.bottom + gap, window.innerHeight - menuHeight - 8));

    setSessionMenuPosition({ top, left });
    setSessionMenuOpenId((current) => (current === sessionId ? null : sessionId));
  }

  async function handleSessionAction(action, session) {
    if (!session?.id || processing) return;

    if (action === "rename" && onRenameSession) {
      setRenamingSessionId(session.id);
      setRenameDraft(session.title || "New chat");
      setSessionMenuOpenId(null);
      return;
    }

    if (action === "fork" && onForkSession) {
      setActingSessionId(session.id);
      try {
        await onForkSession(session.id);
        setSessionMenuOpenId(null);
      } finally {
        setActingSessionId(null);
      }
      return;
    }

    if (action === "delete" && onDeleteSession) {
      if (deleteConfirmSessionId !== session.id) {
        setDeleteConfirmSessionId(session.id);
        return;
      }
      setActingSessionId(session.id);
      try {
        await onDeleteSession(session.id);
      } finally {
        setDeleteConfirmSessionId(null);
        setSessionMenuOpenId(null);
        setActingSessionId(null);
      }
    }
  }

  async function handleRenameSubmit(sessionId) {
    if (!onRenameSession) return;
    const title = renameDraft.trim();
    if (!title) return;

    setActingSessionId(sessionId);
    try {
      await onRenameSession(sessionId, title);
      setRenamingSessionId(null);
      setRenameDraft("");
      setSessionMenuOpenId(null);
    } finally {
      setActingSessionId(null);
    }
  }

  function handleRenameCancel() {
    setRenamingSessionId(null);
    setRenameDraft("");
  }

  return (
    <div className="chat-panel">
      <div className="chat-header chat-header-row">
        {sessionListOpen ? (
          <>
            <div className="chat-header-title-wrap">
              <span>BigiBot Sessions</span>
            </div>
            <div className="chat-header-actions">
              <button
                type="button"
                className={`chat-session-search-btn ${sessionSearchOpen ? "active" : ""}`}
                onClick={() => setSessionSearchOpen((v) => !v)}
                disabled={!project || processing}
                title={sessionSearchOpen ? "Hide Search" : "Search Sessions"}
                aria-label={sessionSearchOpen ? "Hide Search" : "Search Sessions"}
                aria-expanded={sessionSearchOpen}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M10.3 10.3L13.2 13.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                className="chat-session-new-btn"
                onClick={handleNewChat}
                disabled={!project || processing || actingSessionId === "new"}
                title="New Chat"
                aria-label="New Chat"
              >
                +
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            className="chat-session-back-btn"
            onClick={handleBackToSessions}
            title="Back to sessions"
            aria-label="Back to sessions"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10.8 2.8L5.6 8L10.8 13.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="chat-session-title-text" title={activeSessionTitle}>{activeSessionTitle}</span>
          </button>
        )}
      </div>
      {sessionListOpen && sessionSearchOpen && (
        <div className="chat-session-search-popover">
          <input
            type="text"
            className="chat-sessions-search"
            placeholder="Search sessions..."
            value={sessionQuery}
            onChange={(e) => setSessionQuery(e.target.value)}
            autoFocus
          />
        </div>
      )}
      {sessionListOpen ? (
        <div className="chat-sessions-wrap">
          {/* <div className="chat-sessions-title">Sessions</div> */}
          <div className="chat-sessions-list" role="listbox" aria-label="Sessions">
            {orderedGroups.map((group) => {
              const list = grouped[group] || [];
              if (!list.length) return null;
              return (
                <div key={group} className="chat-sessions-group">
                  <div className="chat-sessions-group-label">{group}</div>
                  {list.map((session) => {
                    const active = session.id === activeSessionId;
                    const disabled = actingSessionId === session.id;
                    const isRenaming = renamingSessionId === session.id;
                    const menuOpen = sessionMenuOpenId === session.id;
                    return (
                      <div key={session.id} className={`chat-session-row ${active ? "active" : ""}`}>
                        {isRenaming ? (
                          <div className="chat-session-rename-wrap">
                            <input
                              type="text"
                              className="chat-session-rename-input"
                              value={renameDraft}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  handleRenameSubmit(session.id);
                                } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  handleRenameCancel();
                                }
                              }}
                              autoFocus
                            />
                            <div className="chat-session-rename-actions">
                              <button type="button" onClick={() => handleRenameSubmit(session.id)} disabled={disabled || !renameDraft.trim()} title="Save rename" aria-label="Save rename">Save</button>
                              <button type="button" onClick={handleRenameCancel} disabled={disabled} title="Cancel rename" aria-label="Cancel rename">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="chat-session-open"
                            onClick={() => handleOpenSession(session.id)}
                            disabled={disabled}
                            title={session.title || "New chat"}
                          >
                            {session.title || "New chat"}
                          </button>
                        )}
                        <div className="chat-session-actions" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            className={`chat-session-more-btn ${menuOpen ? "open" : ""}`}
                            onClick={(evt) => toggleSessionMenu(evt, session.id)}
                            disabled={disabled || isRenaming}
                            title="More actions"
                            aria-label="Session actions"
                            aria-expanded={menuOpen}
                          >
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                              <circle cx="3.2" cy="8" r="1.2" />
                              <circle cx="8" cy="8" r="1.2" />
                              <circle cx="12.8" cy="8" r="1.2" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {!filteredSessions.length && (
              <div className="chat-sessions-empty">No sessions found.</div>
            )}
          </div>
          {sessionMenuOpenId && (
            <div
              className="chat-session-menu chat-session-menu-floating"
              role="menu"
              aria-label="Session actions menu"
              style={{ top: `${sessionMenuPosition.top}px`, left: `${sessionMenuPosition.left}px` }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => handleSessionAction("rename", { id: sessionMenuOpenId, title: sessions.find((s) => s.id === sessionMenuOpenId)?.title || "New chat" })}
              >
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => handleSessionAction("fork", { id: sessionMenuOpenId, title: sessions.find((s) => s.id === sessionMenuOpenId)?.title || "New chat" })}
              >
                Fork
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => handleSessionAction("delete", { id: sessionMenuOpenId, title: sessions.find((s) => s.id === sessionMenuOpenId)?.title || "New chat" })}
                className={deleteConfirmSessionId === sessionMenuOpenId ? "chat-session-delete-confirm" : ""}
              >
                {deleteConfirmSessionId === sessionMenuOpenId ? "Confirm delete" : "Delete"}
              </button>
            </div>
          )}
        </div>
      ) : (
      <>
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            Ask BigiBot to change something in your Bigin project, e.g. “Change the deal card to
            show company name above deal name.”
          </div>
        )}
        {messages.map((m, i) => (
          <ChatMessage key={i} message={m} />
        ))}
        <div
          className={`chat-working-indicator ${processing ? "visible" : ""}`}
          aria-hidden={!processing}
          role="button"
          tabIndex={processing ? 0 : -1}
          aria-expanded={activityExpanded}
          aria-label="Toggle BigiBot live activity"
          onClick={processing ? onToggleActivityExpanded : undefined}
          onKeyDown={(e) => {
            if (!processing) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleActivityExpanded?.();
            }
          }}
        >
          <span className="chat-working-dot" />
          <span className="chat-working-text">BigiBot is working</span>
          <span className="chat-working-ellipsis" aria-hidden="true">
            <span>.</span>
            <span>.</span>
            <span>.</span>
          </span>
          <span className={`chat-working-chevron ${activityExpanded ? "open" : ""}`} aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M4.5 6L8 10L11.5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
        {processing && activityExpanded && (
          <div className="chat-activity-panel" role="status" aria-live="polite">
            {activityEntries.length === 0 ? (
              <div className="chat-activity-item running">
                <span className="chat-activity-bullet" aria-hidden="true" />
                <span>Preparing task...</span>
              </div>
            ) : (
              activityEntries.map((item, idx) => (
                <div
                  key={`${item.kind}-${item.status}-${item.at}-${idx}`}
                  className={`chat-activity-item ${item.status === "running" ? "running" : "done"}`}
                >
                  <span className="chat-activity-bullet" aria-hidden="true" />
                  <span>{item.label}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      <form className="chat-input" onSubmit={handleSubmit}>
        <div className="chat-composer-shell">
          <textarea
            ref={textareaRef}
            value={text}
            disabled={!project || processing}
            placeholder={project ? "Ask BigiBot to change something..." : "Open a project to chat"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
          />
          <div className="chat-composer-footer">
            <div className="chat-composer-configs">
              {/*
                Reserved for future context picker entry point.
              */}
              {/* <button type="button" className="chat-composer-icon" disabled={!project || processing} aria-label="Add context">
                +
              </button> */}
              <div className="chat-inline-select-wrap">
              <select
                id="chat-agent-selector"
                className="chat-inline-select"
                value={effectiveAgentMode}
                onChange={(e) => onAgentModeChange(e.target.value)}
                disabled={processing}
              >
                <option value="build">Build</option>
                {hasBigiBotAgent && <option value="bigibot">BigiBot</option>}
              </select>
              </div>
              <button type="button" className="chat-inline-pill" disabled>
                {prettyModelName(activeModel)}
              </button>
              {processing && cavemanStatus?.routingActive && (
                <div
                  className="chat-caveman-runtime chat-caveman-runtime-inline"
                  title={`Caveman runtime (${cavemanStatus.provider || "provider"})`}
                >
                  <span className="chat-caveman-runtime-dot" aria-hidden="true" />
                  <span className="chat-caveman-runtime-text">Caveman</span>
                </div>
              )}
            </div>
            <button
              type={processing ? "button" : "submit"}
              className={`chat-send-btn chat-send-pill ${processing ? "is-cancel" : ""}`}
              disabled={!project || (!processing && !text.trim())}
              onClick={processing ? handleCancel : undefined}
              aria-label={processing ? "Cancel request" : "Send message"}
              title={processing ? "Cancel request" : "Send message"}
            >
              {processing ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <rect x="3" y="3" width="10" height="10" rx="1.5" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M8 13.5V2.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                  <path
                    d="M3.5 7L8 2.5L12.5 7"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
      </form>
      </>
      )}
    </div>
  );
}
