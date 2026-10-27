"use client";

import { useEffect } from "react";

function decodeText(attachment) {
  if (!attachment?.dataUrl || !attachment.dataUrl.includes(",")) return "";
  try {
    const encoded = attachment.dataUrl.slice(attachment.dataUrl.indexOf(",") + 1);
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function isTextAttachment(attachment) {
  return attachment?.mime?.startsWith("text/")
    || /\.(json|js|jsx|ts|tsx|html?|css|less|md|markdown|txt)$/i.test(attachment?.name || "");
}

export default function AttachmentPreviewModal({ attachment, onClose }) {
  useEffect(() => {
    if (!attachment) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [attachment, onClose]);

  if (!attachment) return null;

  const isImage = attachment.mime?.startsWith("image/") && attachment.dataUrl;
  const isText = isTextAttachment(attachment);
  const text = isText ? decodeText(attachment) : "";

  return (
    <div className="attachment-preview-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="attachment-preview-modal" role="dialog" aria-modal="true" aria-label={`Preview ${attachment.name || "attachment"}`}>
        <header className="attachment-preview-header">
          <div className="attachment-preview-title">
            <strong>{attachment.name || "Attached file"}</strong>
            <span>{attachment.mime || "Unknown file type"}</span>
          </div>
          <button type="button" className="attachment-preview-close" onClick={onClose} aria-label="Close attachment preview">Close</button>
        </header>
        <div className="attachment-preview-content">
          {isImage ? (
            <img src={attachment.dataUrl} alt={attachment.name || "Attached image"} className="attachment-preview-image" />
          ) : isText && text ? (
            <pre className="attachment-preview-text">{text}</pre>
          ) : (
            <div className="attachment-preview-unavailable">Preview is not available for this file type.</div>
          )}
        </div>
      </section>
    </div>
  );
}
