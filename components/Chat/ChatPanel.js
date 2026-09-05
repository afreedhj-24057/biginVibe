"use client";
import { useEffect, useRef, useState } from "react";
import { bridge } from "../../lib/bridge";
import ChatMessage from "./ChatMessage";

/**
 * BigiBot chat: user requests, assistant responses, and a live activity
 * trace (tool calls, file changes, errors, completion) driven by the
 * agent.* events forwarded from OpenCodeService.
 */
export default function ChatPanel({ project, messages, onSend, agentWorking }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const processing = sending || agentWorking;
  const textareaRef = useRef(null);

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
        text: "No project is currently open.\n\nOpen a project before asking BigiBot to modify code.",
      });
      return;
    }

    setText("");
    setSending(true);
    onSend({ role: "user", text: value });
    try {
      await bridge.chat.sendMessage(value);
    } catch (err) {
      onSend({ role: "error", text: err.message || String(err) });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">BigiBot</div>
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
          className={`chat-working-indicator ${agentWorking ? "visible" : ""}`}
          aria-hidden={!agentWorking}
        >
          <span className="chat-working-dot" />
          <span className="chat-working-text">BigiBot is working</span>
          <span className="chat-working-ellipsis" aria-hidden="true">
            <span>.</span>
            <span>.</span>
            <span>.</span>
          </span>
        </div>
      </div>
      <form className="chat-input" onSubmit={handleSubmit}>
        <div className="chat-composer">
          <textarea
            ref={textareaRef}
            value={text}
            disabled={!project || processing}
            placeholder={project ? "Ask BigiBot to change something…" : "Open a project to chat"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) handleSubmit(e);
            }}
          />
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
      </form>
    </div>
  );
}
