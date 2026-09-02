"use client";
import { useEffect, useRef, useState } from "react";

/**
 * PreviewManager-equivalent for the renderer: controls an Electron <webview>
 * pointed at a URL, with a Chrome-style editable address bar.
 *
 * A <webview> (backed by its own process/session) is used instead of an
 * <iframe> because the Bigin Redirector development flow can involve auth,
 * cookies, redirects, CSP and X-Frame-Options that a same-page iframe
 * cannot reliably handle.
 *
 * ---------------------------------------------------------------------------
 * Address bar behavior (like a real browser)
 * ---------------------------------------------------------------------------
 * The bar is a genuine editable <input>, not a read-only status display:
 *   - Click anywhere in it to place the cursor at that position, or
 *     select/replace the whole value — standard <input> text-editing
 *     behavior, nothing special-cased.
 *   - Pressing Enter navigates the webview to EXACTLY what was typed (no
 *     normalization/mutation of the string).
 *   - After navigation completes, the bar updates to reflect the webview's
 *     actual current location (via the "did-navigate"/"did-navigate-in-page"
 *     webview events) — including in-app SPA route changes the user
 *     triggers by clicking around inside the preview itself.
 *   - The dev server's resolved URL (previewUrl prop) only overrides
 *     whatever the user has typed when a fresh dev-server (re)start
 *     establishes a new initial URL (see previewGeneration below) — never
 *     on every unrelated re-render.
 * ---------------------------------------------------------------------------
 */
export default function PreviewPanel({ previewUrl, envRunning, previewGeneration, projectPath }) {
  const webviewRef = useRef(null);
  const addressInputRef = useRef(null);
  const [status, setStatus] = useState("idle"); // idle | loading | loaded | error
  const [errorMessage, setErrorMessage] = useState(null);

  // The URL actually bound to <webview src>. Only ever set by: (a) the
  // initial/fresh-restart previewUrl, or (b) the user pressing Enter.
  const [loadedUrl, setLoadedUrl] = useState(null);
  // What the address bar's <input> displays. Kept in sync with the real
  // current location after navigation; diverges from loadedUrl while the
  // user is actively typing an edit that hasn't been submitted yet.
  const [addressValue, setAddressValue] = useState("");

  const hasLoadedRef = useRef(false);
  const lastGenerationRef = useRef(0);

  // Reset everything when the active project changes — a different
  // project's dev server/URL must never linger in the preview.
  useEffect(() => {
    setLoadedUrl(null);
    setAddressValue("");
    setStatus("idle");
    setErrorMessage(null);
    hasLoadedRef.current = false;
  }, [projectPath]);

  // Establish (or re-establish) the initial address-bar/webview URL from
  // the dev server's resolved previewUrl — but only on the first-ever load
  // for this project, or when previewGeneration signals a genuine
  // start/restart. A manually-typed URL/path is preserved across any other
  // re-render, per spec.
  useEffect(() => {
    if (!previewUrl) return;
    const isFreshStart = previewGeneration !== lastGenerationRef.current;
    const isFirstEverLoad = !hasLoadedRef.current;
    if (isFreshStart || isFirstEverLoad) {
      setLoadedUrl(previewUrl);
      setAddressValue(previewUrl);
      hasLoadedRef.current = true;
      lastGenerationRef.current = previewGeneration;
    }
  }, [previewUrl, previewGeneration]);

  useEffect(() => {
    const el = webviewRef.current;
    if (!el) return;

    const onStartLoading = () => setStatus("loading");
    const onStopLoading = () => setStatus((s) => (s === "error" ? s : "loaded"));
    const onFailLoad = (e) => {
      if (e.errorCode === -3) return; // aborted, usually a redirect in progress
      setStatus("error");
      setErrorMessage(`${e.errorDescription} (${e.errorCode})`);
    };
    // Keep the address bar reflecting the webview's ACTUAL current location
    // — after the user presses Enter, after redirects, and after the user
    // navigates around inside the app itself (SPA route changes), exactly
    // like a real browser's address bar.
    const onDidNavigate = (e) => setAddressValue(e.url);
    const onDidNavigateInPage = (e) => setAddressValue(e.url);

    el.addEventListener("did-start-loading", onStartLoading);
    el.addEventListener("did-stop-loading", onStopLoading);
    el.addEventListener("did-fail-load", onFailLoad);
    el.addEventListener("did-navigate", onDidNavigate);
    el.addEventListener("did-navigate-in-page", onDidNavigateInPage);
    return () => {
      el.removeEventListener("did-start-loading", onStartLoading);
      el.removeEventListener("did-stop-loading", onStopLoading);
      el.removeEventListener("did-fail-load", onFailLoad);
      el.removeEventListener("did-navigate", onDidNavigate);
      el.removeEventListener("did-navigate-in-page", onDidNavigateInPage);
    };
  }, [loadedUrl]);

  /**
   * Enter in the address bar: navigate to EXACTLY what the user typed.
   * Uses the webview's imperative loadURL() (not just updating the src
   * binding) so pressing Enter on an unchanged URL still triggers a real
   * navigation/reload, matching real browser address-bar behavior.
   */
  function handleAddressSubmit(e) {
    e.preventDefault();
    const target = addressValue.trim();
    if (!target) return;
    setErrorMessage(null);
    setStatus("loading");
    if (webviewRef.current) {
      webviewRef.current.loadURL(target).catch((err) => {
        setStatus("error");
        setErrorMessage(err.message || String(err));
      });
    }
    setLoadedUrl(target);
    hasLoadedRef.current = true;
    addressInputRef.current?.blur();
  }

  function reload() {
    webviewRef.current?.reload();
  }

  function openDevTools() {
    webviewRef.current?.openDevTools();
  }

  return (
    <div className="preview-panel">
      <div className="preview-toolbar">
        <form className="preview-address-form" onSubmit={handleAddressSubmit}>
          <input
            ref={addressInputRef}
            className="preview-address-input"
            type="text"
            value={addressValue}
            onChange={(e) => setAddressValue(e.target.value)}
            placeholder={envRunning ? "Enter a URL and press Enter…" : "No preview yet"}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </form>
        <div className="preview-actions">
          <button disabled={!loadedUrl} onClick={reload}>
            Reload
          </button>
          <button disabled={!loadedUrl} onClick={openDevTools}>
            DevTools
          </button>
        </div>
      </div>
      <div className="preview-body">
        {!loadedUrl ? (
          <div className="preview-placeholder">
            {envRunning
              ? "Resolving Bigin preview URL…"
              : "Start the Bigin development environment to see the running application here."}
          </div>
        ) : (
          <webview
            ref={webviewRef}
            src={loadedUrl}
            className="preview-webview"
            // Named partition so the main process can scope client-certificate
            // (mutual TLS) selection for internal Bigin LocalZoho environments
            // to ONLY this preview browser (see
            // services/preview/PreviewClientCertificatePolicy.js). Must match
            // PREVIEW_PARTITION (PreviewSecurityConstants.js) exactly.
            partition="persist:bigin-preview"
          />
        )}
        {status === "error" && (
          <div className="preview-error-banner">Preview failed to load: {errorMessage}</div>
        )}
      </div>
    </div>
  );
}
