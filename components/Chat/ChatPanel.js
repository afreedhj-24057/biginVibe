"use client";
import { useState } from "react";
import { bridge } from "../../lib/bridge";
import ChatMessage from "./ChatMessage";

/**
 * BigiBot chat: user requests, assistant responses, and a live activity
 * trace (tool calls, file changes, errors, completion) driven by the
 * agent.* events forwarded from OpenCodeService.
 */
export default function ChatPanel({ project, messages, onSend }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value || sending) return;

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
      </div>
      <form className="chat-input" onSubmit={handleSubmit}>
        <textarea
          value={text}
          disabled={!project || sending}
          placeholder={project ? "Ask BigiBot to change something…" : "Open a project to chat"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) handleSubmit(e);
          }}
        />
        <button type="submit" disabled={!project || sending || !text.trim()}>
          {sending ? "Working…" : "Send"}
        </button>
      </form>
    </div>
  );
}
