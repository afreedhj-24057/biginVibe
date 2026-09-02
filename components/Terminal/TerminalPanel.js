"use client";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { bridge } from "../../lib/bridge";

/**
 * Human-facing integrated terminal. Runs a persistent, real interactive
 * shell in the project directory via TerminalManager (separate process
 * boundary from the OpenCode agent shell — see spec section 15).
 *
 * Uses xterm.js as a genuine terminal emulator instead of a single-line
 * `<input>` + line-buffered command runner. This is what makes Ctrl+C and
 * `clear` actually work:
 *
 *   - Every keystroke (including control characters like Ctrl+C = \x03)
 *     is forwarded directly to the PTY via term.onData(), exactly like a
 *     native terminal app. The PTY's own line discipline is what turns
 *     Ctrl+C into a real SIGINT for the shell's foreground process — there
 *     is no special-casing needed here, it's the same mechanism Terminal.app
 *     or VS Code's terminal use.
 *   - The PTY's raw output (including ANSI clear-screen / cursor-movement
 *     escape codes emitted by `clear`, colored `git` output, etc.) is fed
 *     straight into xterm.js via term.write(), which has a full ANSI
 *     terminal-emulation engine — so `clear` genuinely clears the screen.
 */
export default function TerminalPanel({ project, collapsed, onToggleCollapse, height, onResize, focusToken }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const sessionIdRef = useRef(null);
  const [sessionId, setSessionId] = useState(null);
  const resizingRef = useRef(false);

  // Create the xterm.js terminal instance once, on mount, and forward every
  // keystroke the user types directly to the active PTY session.
  useEffect(() => {
    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: { background: "#18191b", foreground: "#e6e6e6", cursor: "#61afef" },
      cursorBlink: true,
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    if (containerRef.current) {
      term.open(containerRef.current);
      fitAddon.fit();
    }

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const dataDisposable = term.onData((data) => {
      if (sessionIdRef.current) {
        bridge.terminal.write(sessionIdRef.current, data);
      }
    });

    return () => {
      dataDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Open (or replace) the terminal session whenever the active project
  // changes. The old session (if any) is stopped first — a project switch
  // must never leave a stale shell running against the previous project's cwd.
  useEffect(() => {
    let cancelled = false;

    async function startSession() {
      if (sessionIdRef.current) {
        await bridge.terminal.stop(sessionIdRef.current);
        sessionIdRef.current = null;
        setSessionId(null);
      }

      const term = termRef.current;
      if (!project) {
        term?.clear();
        return;
      }

      const fitAddon = fitAddonRef.current;
      fitAddon?.fit();
      const cols = term?.cols || 80;
      const rows = term?.rows || 24;

      const session = await bridge.terminal.create(cols, rows);
      if (cancelled || !session) return;

      sessionIdRef.current = session.id;
      setSessionId(session.id);
      term?.clear();
      term?.writeln(`Terminal ready in ${session.cwd}\r`);
    }

    startSession();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.path]);

  // Forward runtime events (raw PTY output / shell exit) into xterm.js.
  useEffect(() => {
    const unsubscribe = bridge.events.subscribe((evt) => {
      if (evt.payload?.sessionId !== sessionIdRef.current) return;
      if (evt.type === "terminal.output") {
        termRef.current?.write(evt.payload.data);
      } else if (evt.type === "terminal.exit") {
        termRef.current?.writeln(`\r\n[shell exited — click Restart to open a new one]\r`);
      }
    });
    return unsubscribe;
  }, []);

  // Keep the PTY's size in sync with the panel's actual pixel size, so
  // `clear`, full-screen programs, and any column-aware CLI render
  // correctly. Re-fits on panel resize, collapse/expand, and window resize.
  useEffect(() => {
    if (collapsed) return;
    const fitAddon = fitAddonRef.current;
    const term = termRef.current;
    if (!fitAddon || !term) return;

    fitAddon.fit();
    if (sessionIdRef.current) {
      bridge.terminal.resize(sessionIdRef.current, term.cols, term.rows);
    }

    function onWindowResize() {
      fitAddon.fit();
      if (sessionIdRef.current) {
        bridge.terminal.resize(sessionIdRef.current, term.cols, term.rows);
      }
    }
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, [height, collapsed]);

  // Bring the Terminal into focus whenever the parent bumps focusToken —
  // e.g. when the user clicks "Start Dev Server", so the command they just
  // triggered is immediately visible and the terminal is ready for input.
  useEffect(() => {
    if (!focusToken) return;
    termRef.current?.focus();
  }, [focusToken]);

  async function restartSession() {
    if (sessionIdRef.current) {
      await bridge.terminal.stop(sessionIdRef.current);
      sessionIdRef.current = null;
      setSessionId(null);
    }
    if (!project) return;
    const fitAddon = fitAddonRef.current;
    const term = termRef.current;
    fitAddon?.fit();
    const session = await bridge.terminal.create(term?.cols || 80, term?.rows || 24);
    if (!session) return;
    sessionIdRef.current = session.id;
    setSessionId(session.id);
    term?.clear();
    term?.writeln(`Terminal ready in ${session.cwd}\r`);
  }

  function startResize(e) {
    resizingRef.current = true;
    const startY = e.clientY;
    const startHeight = height;
    function onMove(ev) {
      if (!resizingRef.current) return;
      const delta = startY - ev.clientY;
      onResize(Math.min(600, Math.max(120, startHeight + delta)));
    }
    function onUp() {
      resizingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div className="terminal-panel" style={{ height: collapsed ? 32 : height }}>
      <div className="terminal-resize-handle" onMouseDown={startResize} />
      <div className="terminal-header">
        <span>Terminal</span>
        <div className="terminal-header-actions">
          <button onClick={restartSession} disabled={!project} title="Kill and restart the shell">
            Restart
          </button>
          <button onClick={onToggleCollapse}>{collapsed ? "Expand" : "Collapse"}</button>
        </div>
      </div>
      <div
        className="terminal-xterm-container"
        ref={containerRef}
        style={{ display: collapsed ? "none" : "block" }}
      />
    </div>
  );
}
