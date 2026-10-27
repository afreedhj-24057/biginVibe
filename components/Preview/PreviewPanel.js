"use client";
import { useEffect, useRef, useState } from "react";
import { bridge } from "../../lib/bridge";
import { normalizePreviewUrl } from "../../shared/previewUrl";
import { BOOKMARKS } from "../../shared/bookmarks";

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
export default function PreviewPanel({ previewUrl, envRunning, previewGeneration, projectPath, onElementSelected }) {
  const webviewRef = useRef(null);
  const addressInputRef = useRef(null);
  const bookmarksButtonRef = useRef(null);
  const [status, setStatus] = useState("idle"); // idle | loading | loaded | error
  const [errorMessage, setErrorMessage] = useState(null);

  // The URL actually bound to <webview src>. Only ever set by: (a) the
  // initial/fresh-restart previewUrl, or (b) the user pressing Enter.
  const [loadedUrl, setLoadedUrl] = useState(null);
  // What the address bar's <input> displays. Kept in sync with the real
  // current location after navigation; diverges from loadedUrl while the
  // user is actively typing an edit that hasn't been submitted yet.
  const [addressValue, setAddressValue] = useState("");
  // Chrome-style back/forward availability, mirrored from the webview's own
  // in-page navigation history after every navigation event.
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [instances, setInstances] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedSuggestionIndex, setHighlightedSuggestionIndex] = useState(0);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [pickerActive, setPickerActive] = useState(false);
  const pickerRunRef = useRef(null);
  const webviewReadyRef = useRef(false);

  const hasLoadedRef = useRef(false);
  const lastGenerationRef = useRef(0);
  const hideSuggestionsTimerRef = useRef(null);

  useEffect(() => {
    if (!bookmarksOpen) return undefined;

    function handleWindowKeyDown(event) {
      if (event.key === "Escape") {
        setBookmarksOpen(false);
        bookmarksButtonRef.current?.focus();
      }
    }

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [bookmarksOpen]);

  const filteredInstances = instances.filter((item) => {
    const q = addressValue.trim().toLowerCase();
    if (!q) return true;
    return item.name.toLowerCase().includes(q) || item.url.toLowerCase().includes(q);
  });

  // Reset everything when the active project changes — a different
  // project's dev server/URL must never linger in the preview.
  useEffect(() => {
    setLoadedUrl(null);
    setAddressValue("");
    setStatus("idle");
    setErrorMessage(null);
    hasLoadedRef.current = false;
    webviewReadyRef.current = false;
    setPickerActive(false);
    pickerRunRef.current = null;
  }, [projectPath]);

  useEffect(() => {
    cancelPicker();
    onElementSelected?.(null);
  }, [previewGeneration]);

  function executePickerScript(script) {
    const webview = webviewRef.current;
    if (!webview || !webviewReadyRef.current || typeof webview.executeJavaScript !== "function") {
      return Promise.resolve(null);
    }
    try {
      return Promise.resolve(webview.executeJavaScript(`(${script})()`, true)).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  const pickerCleanupScript = `function () {
    const state = window.__biginVibeElementPicker;
    if (!state) return true;
    state.active = false;
    document.removeEventListener("mousemove", state.onMouseMove, true);
    document.removeEventListener("click", state.onClick, true);
    document.removeEventListener("mousedown", state.onMouseDown, true);
    document.removeEventListener("mouseup", state.onMouseUp, true);
    document.removeEventListener("pointerdown", state.onPointerDown, true);
    document.removeEventListener("pointerup", state.onPointerUp, true);
    document.removeEventListener("touchstart", state.onTouchStart, true);
    document.removeEventListener("touchend", state.onTouchEnd, true);
    document.removeEventListener("contextmenu", state.onContextMenu, true);
    document.removeEventListener("keydown", state.onKeyDown, true);
    if (state.finalizeTimer) clearTimeout(state.finalizeTimer);
    state.highlight?.remove();
    state.tooltip?.remove();
    delete window.__biginVibeElementPicker;
    return true;
  }`;

  const pickerScript = `function () {
    const previous = window.__biginVibeElementPicker;
    if (previous) previous.active = false;
    const root = document.documentElement;
    if (!root) return null;
    const highlight = document.createElement("div");
    const tooltip = document.createElement("div");
    const baseStyle = "position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;";
    highlight.setAttribute("aria-hidden", "true");
    highlight.style.cssText = baseStyle + "border:2px solid #1976d2;background:rgba(25,118,210,.08);display:none;";
    tooltip.setAttribute("aria-hidden", "true");
    tooltip.style.cssText = baseStyle + "display:none;max-width:360px;padding:4px 7px;border-radius:4px;background:#17202b;color:#fff;font:12px/1.3 monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px rgba(0,0,0,.35);";
    root.append(highlight, tooltip);
    const state = { active: true, highlight, tooltip, target: null, pendingTarget: null, pendingContext: null, finalizeTimer: null };
    window.__biginVibeElementPicker = state;
    const labelFor = (element) => {
      const tag = element.tagName.toLowerCase();
      const id = element.id ? "#" + element.id : "";
      const classes = typeof element.className === "string" ? element.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).map((value) => "." + value).join("") : "";
      return tag + id + classes;
    };
    const visibleText = (element) => String(element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 240);
    const update = (element, event) => {
      if (!element || element === highlight || element === tooltip || element.nodeType !== 1) {
        highlight.style.display = "none";
        tooltip.style.display = "none";
        state.target = null;
        return;
      }
      const rect = element.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      state.target = element;
      highlight.style.display = "block";
      highlight.style.left = rect.left + "px";
      highlight.style.top = rect.top + "px";
      highlight.style.width = rect.width + "px";
      highlight.style.height = rect.height + "px";
      tooltip.textContent = labelFor(element);
      tooltip.style.display = "block";
      tooltip.style.left = Math.max(4, Math.min(window.innerWidth - 364, event.clientX + 12)) + "px";
      tooltip.style.top = Math.max(4, Math.min(window.innerHeight - 30, event.clientY + 12)) + "px";
    };
    const selectorPart = (element) => {
      const tag = element.tagName.toLowerCase();
      if (element.id && /^[A-Za-z][A-Za-z0-9_:\\-]*$/.test(element.id)) return "#" + CSS.escape(element.id);
      const data = Array.from(element.attributes || []).find((attribute) => /^data-/.test(attribute.name) && attribute.value && attribute.value.length < 100);
      if (data) return tag + "[" + data.name + '=\\\"' + CSS.escape(data.value) + '\\\"]';
      const classes = typeof element.className === "string" ? element.className.trim().split(/\\s+/).filter((value) => /^[A-Za-z0-9_-]+$/.test(value)).slice(0, 2) : [];
      return tag + classes.map((value) => "." + CSS.escape(value)).join("");
    };
    const selectorFor = (element) => {
      const parts = [];
      let current = element;
      for (let depth = 0; current && current.nodeType === 1 && depth < 6; depth += 1, current = current.parentElement) {
        const part = selectorPart(current);
        parts.unshift(part);
        if (part.startsWith("#")) break;
        if (current.parentElement) {
          const siblings = Array.from(current.parentElement.children).filter((item) => item.tagName === current.tagName);
          if (siblings.length > 1) parts[0] += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
      }
      return parts.join(" > ");
    };
    const attributesFor = (element) => {
      const result = {};
      const type = String(element.getAttribute("type") || "").toLowerCase();
      const sensitive = type === "password" || /password|token|secret/i.test(String(element.name || ""));
      for (const attribute of Array.from(element.attributes || [])) {
        if (!(/^(data-|aria-|role$|name$|type$|href$|title$|placeholder$)/i.test(attribute.name))) continue;
        if (!attribute.value || attribute.value.length > 240) continue;
        result[attribute.name] = attribute.value;
      }
      if (!sensitive && "value" in element && String(element.value || "").length < 240) result.value = String(element.value || "");
      return result;
    };
    const contextFor = (element) => {
      const hierarchy = [];
      let current = element;
      for (let depth = 0; current && current.nodeType === 1 && depth < 5; depth += 1, current = current.parentElement) hierarchy.unshift(labelFor(current));
      const rect = element.getBoundingClientRect();
      const type = String(element.getAttribute("type") || "").toLowerCase();
      const sensitive = type === "password" || /password|token|secret/i.test(String(element.name || ""));
      return {
        tagName: element.tagName.toLowerCase(), id: element.id || "", classes: typeof element.className === "string" ? element.className.trim().split(/\\s+/).filter(Boolean).slice(0, 20) : [],
        attributes: attributesFor(element), text: sensitive ? "" : visibleText(element), selector: selectorFor(element), hierarchy, path: hierarchy.join(" > "),
        boundingRect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      };
    };
    const finish = (result) => {
      state.active = false;
      document.removeEventListener("mousemove", state.onMouseMove, true);
      document.removeEventListener("click", state.onClick, true);
      document.removeEventListener("mousedown", state.onMouseDown, true);
      document.removeEventListener("mouseup", state.onMouseUp, true);
      document.removeEventListener("pointerdown", state.onPointerDown, true);
      document.removeEventListener("pointerup", state.onPointerUp, true);
      document.removeEventListener("touchstart", state.onTouchStart, true);
      document.removeEventListener("touchend", state.onTouchEnd, true);
      document.removeEventListener("contextmenu", state.onContextMenu, true);
      document.removeEventListener("keydown", state.onKeyDown, true);
      if (state.finalizeTimer) clearTimeout(state.finalizeTimer);
      highlight.remove(); tooltip.remove(); delete window.__biginVibeElementPicker;
      return result;
    };
    state.onMouseMove = (event) => update(document.elementFromPoint(event.clientX, event.clientY), event);
    state.captureTarget = (event) => {
      const target = state.target || document.elementFromPoint(event.clientX, event.clientY);
      if (target && target.nodeType === 1) state.pendingTarget = target;
    };
    state.finalizeSelection = () => {
      if (!state.pendingContext || !state.active) return;
      window.__biginVibePickerResult = finish(state.pendingContext);
    };
    state.scheduleSelection = (event) => {
      state.captureTarget(event);
      if (event.button !== undefined && event.button !== 0) state.pendingTarget = null;
      if (!state.pendingTarget) return;
      state.pendingContext = contextFor(state.pendingTarget);
      if (state.finalizeTimer) clearTimeout(state.finalizeTimer);
      // Normally the following click handler completes selection. The timer
      // covers platforms that suppress the synthetic click after preventDefault.
      state.finalizeTimer = setTimeout(state.finalizeSelection, 100);
    };
    state.onMouseDown = (event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); state.captureTarget(event); };
    state.onMouseUp = (event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); state.scheduleSelection(event); };
    state.onPointerDown = (event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); state.captureTarget(event); };
    state.onPointerUp = (event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); state.scheduleSelection(event); };
    state.onTouchStart = (event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); state.captureTarget(event.touches[0] || event); };
    state.onTouchEnd = (event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); state.scheduleSelection(event.changedTouches[0] || event); };
    state.onClick = (event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); state.captureTarget(event); const target = state.pendingTarget || state.target; if (target) { state.pendingContext = contextFor(target); state.finalizeSelection(); } };
    state.onContextMenu = (event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); };
    state.onKeyDown = (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); window.__biginVibePickerResult = finish(null); } };
    document.addEventListener("mousemove", state.onMouseMove, true);
    document.addEventListener("mousedown", state.onMouseDown, true);
    document.addEventListener("mouseup", state.onMouseUp, true);
    document.addEventListener("pointerdown", state.onPointerDown, true);
    document.addEventListener("pointerup", state.onPointerUp, true);
    document.addEventListener("touchstart", state.onTouchStart, true);
    document.addEventListener("touchend", state.onTouchEnd, true);
    document.addEventListener("click", state.onClick, true);
    document.addEventListener("contextmenu", state.onContextMenu, true);
    document.addEventListener("keydown", state.onKeyDown, true);
    return new Promise((resolve) => {
      const poll = () => { if (window.__biginVibePickerResult !== undefined) { const result = window.__biginVibePickerResult; delete window.__biginVibePickerResult; resolve(result); } else if (state.active) setTimeout(poll, 50); else resolve(null); };
      poll();
    });
  }`;

  async function cancelPicker() {
    pickerRunRef.current = null;
    setPickerActive(false);
    await executePickerScript(pickerCleanupScript).catch(() => {});
  }

  async function togglePicker() {
    if (pickerActive) {
      await cancelPicker();
      return;
    }
    if (!webviewRef.current || !webviewReadyRef.current || !loadedUrl) return;
    setPickerActive(true);
    const run = executePickerScript(pickerScript);
    pickerRunRef.current = run;
    try {
      const result = await run;
      if (pickerRunRef.current !== run) return;
      pickerRunRef.current = null;
      setPickerActive(false);
      if (result) onElementSelected?.(result);
    } catch {
      if (pickerRunRef.current === run) {
        pickerRunRef.current = null;
        setPickerActive(false);
      }
    }
  }

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
    let mounted = true;
    Promise.resolve(bridge.preview.instances?.())
      .then((data) => {
        if (!mounted) return;
        setInstances(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!mounted) return;
        setInstances([]);
      });
    return () => {
      mounted = false;
      if (hideSuggestionsTimerRef.current) {
        clearTimeout(hideSuggestionsTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const el = webviewRef.current;
    if (!el) return;

    const onDomReady = () => {
      webviewReadyRef.current = true;
    };
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
    const onDidNavigate = (e) => {
      webviewReadyRef.current = false;
      cancelPicker();
      onElementSelected?.(null);
      setAddressValue(e.url);
      setCanGoBack(el.canGoBack());
      setCanGoForward(el.canGoForward());
    };
    const onDidNavigateInPage = (e) => {
      cancelPicker();
      onElementSelected?.(null);
      setAddressValue(e.url);
      setCanGoBack(el.canGoBack());
      setCanGoForward(el.canGoForward());
    };

    el.addEventListener("dom-ready", onDomReady);
    el.addEventListener("did-start-loading", onStartLoading);
    el.addEventListener("did-stop-loading", onStopLoading);
    el.addEventListener("did-fail-load", onFailLoad);
    el.addEventListener("did-navigate", onDidNavigate);
    el.addEventListener("did-navigate-in-page", onDidNavigateInPage);
    return () => {
      el.removeEventListener("dom-ready", onDomReady);
      el.removeEventListener("did-start-loading", onStartLoading);
      el.removeEventListener("did-stop-loading", onStopLoading);
      el.removeEventListener("did-fail-load", onFailLoad);
      el.removeEventListener("did-navigate", onDidNavigate);
      el.removeEventListener("did-navigate-in-page", onDidNavigateInPage);
    };
  }, [loadedUrl, onElementSelected]);

  useEffect(() => () => {
    webviewReadyRef.current = false;
    executePickerScript(pickerCleanupScript).catch(() => {});
  }, [loadedUrl]);

  /**
   * Enter in the address bar: navigate to EXACTLY what the user typed.
   * Uses the webview's imperative loadURL() (not just updating the src
   * binding) so pressing Enter on an unchanged URL still triggers a real
   * navigation/reload, matching real browser address-bar behavior.
   */
  function handleAddressSubmit(e) {
    e.preventDefault();
    const target = normalizePreviewUrl(addressValue);
    if (!target) return;
    setAddressValue(target);
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
    setShowSuggestions(false);
  }

  function applySuggestion(item) {
    const target = normalizePreviewUrl(item?.url);
    if (!target) return;
    setAddressValue(target);
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
    setShowSuggestions(false);
    addressInputRef.current?.blur();
  }

  function openBookmark(bookmark) {
    const target = normalizePreviewUrl(bookmark?.url);
    if (!target) return;

    setAddressValue(target);
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
    setBookmarksOpen(false);
    bookmarksButtonRef.current?.focus();
  }

  function handleBookmarkKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      setBookmarksOpen(false);
      bookmarksButtonRef.current?.focus();
      return;
    }

    if ((event.key === "Enter" || event.key === " ") && BOOKMARKS.length === 0) {
      event.preventDefault();
    }
  }

  function handleAddressFocus() {
    if (hideSuggestionsTimerRef.current) {
      clearTimeout(hideSuggestionsTimerRef.current);
    }
    setShowSuggestions(true);
    setHighlightedSuggestionIndex(0);
    Promise.resolve(bridge.preview.instances?.())
      .then((data) => {
        setInstances(Array.isArray(data) ? data : []);
      })
      .catch(() => {});
  }

  function handleAddressBlur() {
    hideSuggestionsTimerRef.current = setTimeout(() => {
      setShowSuggestions(false);
    }, 120);
  }

  function handleAddressKeyDown(e) {
    if (!showSuggestions || !filteredInstances.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedSuggestionIndex((idx) => (idx + 1) % filteredInstances.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedSuggestionIndex((idx) => (idx - 1 + filteredInstances.length) % filteredInstances.length);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setShowSuggestions(false);
      return;
    }
    if (e.key === "Enter" && filteredInstances[highlightedSuggestionIndex]) {
      e.preventDefault();
      applySuggestion(filteredInstances[highlightedSuggestionIndex]);
    }
  }

  function reload() {
    cancelPicker();
    onElementSelected?.(null);
    webviewRef.current?.reload();
  }

  function goBack() {
    if (webviewRef.current?.canGoBack()) {
      webviewRef.current.goBack();
    }
  }

  function goForward() {
    if (webviewRef.current?.canGoForward()) {
      webviewRef.current.goForward();
    }
  }

  function openDevTools() {
    webviewRef.current?.openDevTools();
  }

  return (
    <div className="preview-panel">
      <div className="preview-toolbar">
        <div className="preview-nav-actions">
          <button
            className="preview-icon-btn"
            disabled={!loadedUrl || !canGoBack}
            onClick={goBack}
            aria-label="Back"
            title="Back"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M10 3L5 8L10 13"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="preview-icon-btn"
            disabled={!loadedUrl || !canGoForward}
            onClick={goForward}
            aria-label="Forward"
            title="Forward"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M6 3L11 8L6 13"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="preview-icon-btn"
            disabled={!loadedUrl}
            onClick={reload}
            aria-label="Reload"
            title="Reload"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M13.7 11A5.5 5.5 0 1 1 14 6"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <path
                d="M14 2V6H10"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <form className="preview-address-form" onSubmit={handleAddressSubmit}>
          <div className="preview-address-wrap">
            <input
              ref={addressInputRef}
              className="preview-address-input"
              type="text"
              value={addressValue}
              onChange={(e) => {
                setAddressValue(e.target.value);
                setHighlightedSuggestionIndex(0);
              }}
              onFocus={handleAddressFocus}
              onBlur={handleAddressBlur}
              onKeyDown={handleAddressKeyDown}
              placeholder={envRunning ? "Enter a URL and press Enter..." : "No preview yet"}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
            {showSuggestions && filteredInstances.length > 0 && (
              <div className="preview-instance-menu" role="listbox" aria-label="Bigin instances">
                <div className="preview-instance-menu-title">Bigin Instances</div>
                {filteredInstances.map((item, idx) => (
                  <button
                    key={item.id || `${item.url}-${idx}`}
                    type="button"
                    className={`preview-instance-item ${idx === highlightedSuggestionIndex ? "is-active" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applySuggestion(item);
                    }}
                  >
                    <span className={`preview-instance-badge env-${item.environment || "instance"}`}>
                      {item.environment || "instance"}
                    </span>
                    <span className="preview-instance-name">{item.name}</span>
                    <span className="preview-instance-url">{item.url}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </form>
        <div className="preview-bookmarks-wrap">
          <button
            ref={bookmarksButtonRef}
            type="button"
            className="preview-bookmarks-btn"
            aria-label="Open bookmarks"
            aria-haspopup="menu"
            aria-expanded={bookmarksOpen}
            onClick={() => setBookmarksOpen((open) => !open)}
            onKeyDown={handleBookmarkKeyDown}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 2.5h8v11l-4-2.5-4 2.5v-11Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
            <span>Bookmarks</span>
          </button>
          {bookmarksOpen && (
            <div className="preview-bookmarks-menu" role="menu" aria-label="Bookmarks">
              <div className="preview-bookmarks-title">Bookmarks</div>
              {BOOKMARKS.length === 0 ? (
                <div className="preview-bookmarks-empty">No bookmarks available</div>
              ) : (
                BOOKMARKS.map((bookmark) => (
                  <button
                    key={bookmark.id}
                    type="button"
                    className="preview-bookmark-item"
                    role="menuitem"
                    onClick={() => openBookmark(bookmark)}
                  >
                    <span className="preview-bookmark-name">{bookmark.name}</span>
                    <span className="preview-bookmark-url">{bookmark.url}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <div className="preview-actions">
          <button
            type="button"
            className={`preview-picker-btn ${pickerActive ? "is-active" : ""}`}
            disabled={!loadedUrl}
            onClick={togglePicker}
            aria-pressed={pickerActive}
            aria-label={pickerActive ? "Pick Element active" : "Pick Element"}
            title={pickerActive ? "Cancel element picker" : "Pick an element from the preview"}
          >
            {pickerActive ? "Pick Element — Active" : "Pick Element"}
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
