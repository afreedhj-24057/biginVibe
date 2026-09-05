"use client";
import MarkdownText from "./MarkdownText";

const ICONS = {
  tool_completed: "✓",
  tool_started: "…",
  file_changed: "✓",
  error: "✗",
};

export default function ChatMessage({ message }) {
  if (message.role === "user") {
    return (
      <div className="chat-message chat-message-user">
        <div className="chat-message-label">You</div>
        <MarkdownText text={message.text} />
      </div>
    );
  }

  if (message.role === "activity") {
    return (
      <div className="chat-message chat-message-activity">
        <span className="activity-icon">{ICONS[message.kind] || "•"}</span>
        {message.text}
      </div>
    );
  }

  if (message.role === "error") {
    return (
      <div className="chat-message chat-message-error">
        <div className="chat-message-label">Error</div>
        <MarkdownText text={message.text} />
      </div>
    );
  }

  // assistant
  return (
    <div className="chat-message chat-message-assistant">
      <div className="chat-message-label">BigiBot</div>
      <MarkdownText text={message.text} />
    </div>
  );
}
