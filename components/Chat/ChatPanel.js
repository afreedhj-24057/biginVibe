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
  messages,
  onSend,
  agentWorking,
  cavemanStatus = null,
  activityEntries = [],
  activityExpanded = false,
  onToggleActivityExpanded,
  selectedAgentMode = "build",
  onAgentModeChange,
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const processing = sending || agentWorking;
  const textareaRef = useRef(null);
  const hasBigiBotAgent = !!project?.hasBigiBotAgent;
  const effectiveAgentMode = hasBigiBotAgent ? selectedAgentMode : "build";

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const nextHeight = Math.min(el.scrollHeight, 150);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > 150 ? "auto" : "hidden";
  }, [text]);

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
      onSend({
        role: "error",
        text: "No project is currently open.\n\nOpen a project before asking the agent to modify code.",
      });
      return;
    }

    setText("");
    setSending(true);
    onSend({ role: "user", text: value });
    try {
      await bridge.chat.sendMessage(value, effectiveAgentMode);
    } catch (err) {
      onSend({ role: "error", text: err.message || String(err) });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">BigiBot Chat</div>
      <div className={`chat-caveman-status ${cavemanStatus?.routingActive ? "on" : "off"}`}>
        <span className="chat-caveman-dot" aria-hidden="true" />
        {cavemanStatus?.routingActive
          ? `Caveman: ON (${cavemanStatus.provider}${cavemanStatus.reachable ? ", reachable" : ", not reachable"})`
          : "Caveman: OFF"}
      </div>
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
        <div className="chat-composer">
          <textarea
            ref={textareaRef}
            value={text}
            disabled={!project || processing}
            placeholder={project ? "Ask BigiBot to change something..." : "Open a project to chat"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) handleSubmit(e);
            }}
          />
          <div className="chat-composer-actions">
            <div className="chat-agent-control">
              <label className="chat-agent-selector-label" htmlFor="chat-agent-selector">
                Agent
              </label>
              <select
                id="chat-agent-selector"
                className="chat-agent-selector"
                value={effectiveAgentMode}
                onChange={(e) => onAgentModeChange(e.target.value)}
                disabled={processing}
              >
                <option value="build">Build</option>
                {hasBigiBotAgent && <option value="bigibot">BigiBot</option>}
              </select>
            </div>
            <button
              type={processing ? "button" : "submit"}
              className={`chat-send-btn ${processing ? "is-cancel" : ""}`}
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
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M2 8L14 2L10.5 14L7.8 9.8L2 8Z"
                    fill="currentColor"
                    stroke="currentColor"
                    strokeWidth="0.4"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
