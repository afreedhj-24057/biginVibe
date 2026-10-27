"use client";
import { useState } from "react";
import MarkdownText from "./MarkdownText";
import AttachmentPreviewModal from "./AttachmentPreviewModal";

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentList({ attachments = [] }) {
  const [previewAttachment, setPreviewAttachment] = useState(null);
  if (!attachments.length) return null;
  return (
    <>
      <div className="chat-message-attachments" aria-label="Attachments">
        {attachments.map((attachment, index) => (
          <button type="button" className="chat-message-attachment" key={`${attachment.name}-${index}`} onClick={() => setPreviewAttachment(attachment)} aria-label={`Open preview for ${attachment.name || "attachment"}`}>
          {attachment.mime?.startsWith("image/") && attachment.dataUrl ? (
            <img src={attachment.dataUrl} alt={attachment.name || "Attached image"} className="chat-message-attachment-image" />
          ) : <span className="chat-message-attachment-icon" aria-hidden="true">FILE</span>}
          <span>
            <strong>{attachment.name || "Attached file"}</strong>
            {attachment.size ? <small>{formatBytes(attachment.size)} · {attachment.mime}</small> : <small>{attachment.mime}</small>}
          </span>
          </button>
        ))}
      </div>
      <AttachmentPreviewModal attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />
    </>
  );
}

const ICONS = {
  tool_completed: "✓",
  tool_started: "…",
  file_changed: "✓",
  error: "✗",
};

export default function ChatMessage({ message }) {
  const [copied, setCopied] = useState(false);

  async function copyMessage() {
    const text = message?.text || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  function prettyModelName(model) {
    if (!model) return "";
    const raw = model.includes("/") ? model.split("/")[1] : model;
    if (!raw) return "";
    return raw
      .split("-")
      .map((part) => {
        if (/^gpt$/i.test(part)) return "GPT";
        if (/^codex$/i.test(part)) return "Codex";
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(" ");
  }

  if (message.role === "user") {
    return (
      <div className="chat-message chat-message-user">
        <div className="chat-message-label">You</div>
        <AttachmentList attachments={message.attachments} />
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
       <div className="chat-message-label">Assistant</div>
       {Array.isArray(message.activities) && message.activities.length > 0 && (
         <div className="chat-message-activities" aria-label="Assistant activity">
           {message.activities.map((activity, index) => (
             <div className="chat-message-assistant-activity" key={`${activity.kind}-${activity.status}-${activity.at}-${index}`}>
               <span className="activity-icon">{activity.status === "completed" ? "✓" : "•"}</span>
               <span>{activity.label}</span>
             </div>
           ))}
         </div>
       )}
       <MarkdownText text={message.text} />
      <div className="chat-message-meta">
        <button
          className="chat-copy-icon-btn"
          onClick={copyMessage}
          type="button"
          title={copied ? "Copied" : "Copy"}
          aria-label={copied ? "Copied" : "Copy message"}
        >
          {copied ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3.5 8.5L6.8 11.5L12.5 4.8"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="6" y="3" width="7" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path
                d="M3 10V5.5C3 4.67 3.67 4 4.5 4H10"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
        <span className="chat-model-name">{prettyModelName(message.model) || "Unknown model"}</span>
      </div>
    </div>
  );
}
