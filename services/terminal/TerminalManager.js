const crypto = require("crypto");
const { EVENTS } = require("../../shared/events");
const bus = require("../runtimeBus");

// node-pty is loaded lazily (see _loadPty) so a missing/failed native module
// only breaks terminal creation, not the whole app.
let ptyModule = null;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Manages the human-facing integrated terminal. This is intentionally
 * separate from the OpenCode "agent shell" — the AI agent's tool execution
 * goes through OpenCodeService/the OpenCode server sandboxed to the project
 * directory, never through this class. Keeping the two separate enforces
 * the process boundary called for in the spec (section 15).
 *
 * ---------------------------------------------------------------------------
 * Why a PTY, and why a persistent shell instead of "run one command"?
 * ---------------------------------------------------------------------------
 * The previous implementation spawned a brand-new plain child_process per
 * command (no PTY, pipes only). This meant:
 *
 *   - Ctrl+C did nothing: there was no PTY line discipline to translate the
 *     keystroke into a SIGINT for the foreground process, and nothing in the
 *     UI even captured/forwarded that keystroke in the first place.
 *   - `clear` did nothing useful: with no TTY, `clear` may not even emit its
 *     ANSI clear-screen sequence, and even if it did, the UI only ever
 *     *appended* text lines — it never interpreted ANSI codes at all.
 *
 * A real terminal emulator (Terminal.app, iTerm, VS Code's integrated
 * terminal, etc.) works by: (1) spawning ONE persistent interactive shell
 * inside a PTY, (2) forwarding every raw keystroke the user types directly
 * to that PTY's stdin, and (3) rendering the PTY's raw output through a
 * terminal-emulation engine that understands ANSI escape codes (cursor
 * movement, colors, clear-screen). Ctrl+C is not special-cased by the
 * terminal app at all — the byte 0x03 is simply written to the PTY, and the
 * PTY's own line discipline raises SIGINT on the foreground process group.
 *
 * This class now does exactly that: createSession() spawns one persistent
 * login shell per session (kept alive across multiple commands, so `cd`,
 * shell env vars, and command history persist naturally), write() forwards
 * raw bytes, and the renderer (TerminalPanel.js) uses xterm.js to both
 * capture every keystroke and render the ANSI output correctly.
 *
 * ---------------------------------------------------------------------------
 * Single execution surface: the dev server runs here too
 * ---------------------------------------------------------------------------
 * EnvironmentManager (the "Start Dev Server" flow) does NOT spawn its own
 * separate process/PTY. It calls ensureSession() to get (or create) the
 * SAME primary session this class already manages for the active project,
 * then simply write()s the resolved `lyte serve --port <n>` command into
 * it — exactly as if the user had typed it. This guarantees there is only
 * ONE terminal execution system: one PTY, one shell, one visible output
 * stream, whether the command came from the user's keyboard or from the
 * Start Dev Server button.
 * ---------------------------------------------------------------------------
 */
class TerminalManager {
  constructor() {
    this.sessions = new Map(); // id -> { id, cwd, ptyProcess, cols, rows }
    // The most recently created still-alive session. This is what
    // ensureSession() reuses so the renderer's TerminalPanel and
    // EnvironmentManager's "Start Dev Server" flow always converge on the
    // same single session for the active project, regardless of which one
    // happens to ask for it first.
    this._primarySessionId = null;
  }

  _loadPty() {
    if (!ptyModule) {
      ptyModule = require("node-pty");
    }
    return ptyModule;
  }

  /**
   * Creates a new persistent, interactive terminal session rooted at `cwd`.
   * Spawns the user's actual shell ($SHELL, falling back to /bin/zsh) —
   * not a one-shot `/bin/sh -c command` — so the session behaves like a
   * real terminal tab: shell config/aliases load normally, and the shell
   * process itself stays alive across many commands.
   *
   * Spawned as a LOGIN shell (`-l`) on POSIX so profile files (`.zprofile`,
   * `.bash_profile`, etc.) are sourced — the same default behavior as a new
   * Terminal.app/iTerm window. This matters beyond cosmetics: many dev
   * tools (e.g. Homebrew-installed CLIs) are only added to PATH by login
   * shell profile files, not interactive-only files like `.zshrc`.
   *
   * @param {object} opts
   * @param {string} opts.cwd
   * @param {number} [opts.cols]
   * @param {number} [opts.rows]
   */
  createSession({ cwd, cols = DEFAULT_COLS, rows = DEFAULT_ROWS }) {
    const pty = this._loadPty();
    const id = crypto.randomUUID();

    const shell = process.platform === "win32"
      ? (process.env.ComSpec || "cmd.exe")
      : (process.env.SHELL || "/bin/zsh");
    const shellArgs = process.platform === "win32" ? [] : ["-l"];

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    });

    const session = { id, cwd, ptyProcess, cols, rows };
    this.sessions.set(id, session);
    this._primarySessionId = id;

    ptyProcess.onData((data) => {
      bus.emitEvent(EVENTS.TERMINAL_OUTPUT, { sessionId: id, stream: "stdout", data });
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      bus.emitEvent(EVENTS.TERMINAL_EXIT, { sessionId: id, code: exitCode, signal });
      session.ptyProcess = null;
      if (this._primarySessionId === id) this._primarySessionId = null;
    });

    bus.emitEvent(EVENTS.TERMINAL_STARTED, { sessionId: id, cwd });

    return { id, cwd, cols, rows };
  }

  /**
   * Returns the existing primary session for `cwd` if it is still alive,
   * otherwise creates a new one. This is what makes "Start Dev Server" and
   * the visible Terminal panel share exactly one PTY: whichever of them
   * calls this first creates the session; the other transparently reuses
   * it, so the button's command always appears (and its output always
   * streams) in the same terminal the user sees.
   *
   * @param {object} opts
   * @param {string} opts.cwd
   * @param {number} [opts.cols]
   * @param {number} [opts.rows]
   * @returns {{ id: string, cwd: string, cols: number, rows: number, reused: boolean }}
   */
  ensureSession({ cwd, cols, rows }) {
    const existing = this.sessions.get(this._primarySessionId);
    if (existing && existing.ptyProcess && existing.cwd === cwd) {
      if (cols && rows) this.resize(existing.id, cols, rows);
      return { id: existing.id, cwd: existing.cwd, cols: existing.cols, rows: existing.rows, reused: true };
    }
    const created = this.createSession({ cwd, cols, rows });
    return { ...created, reused: false };
  }

  getPrimarySessionId() {
    return this._primarySessionId;
  }

  listSessions() {
    return [...this.sessions.values()].map(({ id, cwd, ptyProcess, cols, rows }) => ({
      id,
      cwd,
      cols,
      rows,
      running: !!ptyProcess,
    }));
  }

  /**
   * Writes raw bytes directly to the PTY's stdin. This is the ONLY way
   * input reaches the shell — including plain text the user types, Enter
   * (\r), and control characters such as Ctrl+C (\x03), Ctrl+D (\x04), and
   * arrow keys (multi-byte escape sequences). The renderer's xterm.js
   * instance forwards every keystroke here via its own onData callback,
   * exactly matching how a native terminal emulator works. EnvironmentManager
   * uses the exact same method to "type" the `lyte serve` command and to
   * send Ctrl+C when the user clicks Stop.
   *
   * @param {string} sessionId
   * @param {string} data
   */
  write(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (session && session.ptyProcess) {
      session.ptyProcess.write(data);
    }
    // Ctrl+C is a real, deliberate interrupt signal regardless of its
    // source (user keyboard vs. a Stop button). Emitting this here — the
    // single place all writes flow through — makes it the one reliable
    // signal EnvironmentManager needs to keep its "is the dev server still
    // running" state truthful, without maintaining a separate, potentially
    // stale boolean.
    if (data.includes("\x03")) {
      bus.emitEvent(EVENTS.TERMINAL_INTERRUPT, { sessionId });
    }
  }

  /**
   * Resize the PTY. Must be called whenever the UI's terminal component
   * resizes (window resize, panel drag-resize, collapse/expand) so
   * `clear`, full-screen programs, and any column-aware CLI render
   * correctly. This matters in particular for the Lyte CLI's `table`
   * package (used for build summaries/errors), which reads
   * process.stdout.columns/rows and produces `Error: Invalid config.`
   * (width: NaN) if they are ever undefined — a real PTY with a valid size
   * is what prevents that.
   *
   * @param {string} sessionId
   * @param {number} cols
   * @param {number} rows
   */
  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session || !cols || !rows) return;
    session.cols = cols;
    session.rows = rows;
    if (session.ptyProcess) {
      try {
        session.ptyProcess.resize(cols, rows);
      } catch {
        // Process may have just exited; ignore.
      }
    }
  }

  /**
   * Terminates the session's shell process entirely. Note: this is a full
   * kill of the whole terminal (equivalent to closing a terminal tab) —
   * it is NOT how Ctrl+C should be implemented. To interrupt just the
   * current foreground command, write("\x03") instead (see write() above).
   */
  stop(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.ptyProcess) {
      try {
        session.ptyProcess.kill();
      } catch {
        /* noop */
      }
      session.ptyProcess = null;
    }
    if (this._primarySessionId === sessionId) this._primarySessionId = null;
  }

  closeSession(sessionId) {
    this.stop(sessionId);
    this.sessions.delete(sessionId);
  }

  closeAll() {
    for (const id of this.sessions.keys()) this.closeSession(id);
  }
}

module.exports = TerminalManager;
