const fs = require("fs");
const net = require("net");
const path = require("path");
const { EVENTS } = require("../../shared/events");
const bus = require("../runtimeBus");
const RedirectorManager = require("./RedirectorManager");

// Match any localhost/127.0.0.1 URL in log output.
// Also matches the lyte serve ready line:
//   "Will be serving on http://localhost:3000/"
const URL_REGEX = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?[^\s]*/i;

// CLIs commonly color output (e.g. the Lyte CLI's confirmation prompts and
// ready line), so raw PTY bytes often contain ANSI escape sequences
// immediately adjacent to the text we need to pattern-match. Strip them
// before running any of the regexes below.
const ANSI_ESCAPE_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

// The Lyte CLI blocks on stdin with a Y/N confirmation in a few situations
// (e.g. "Do you want to kill the already running lyte process for the same
// folder.[Y/N]:", "Do you want to kill the process running on the same
// port.[Y/N]:"). Vibe Editor is the sole intended owner of the dev server
// for the active project, so "yes, take over" is always the correct
// automatic answer — see _maybeAutoAnswerPrompt below.
const INTERACTIVE_PROMPT_REGEX = /\[Y\/N\]:\s*$/i;

// Sequential port fallback range for `lyte serve`: if 3000 is occupied, try
// 3001, then 3002, ... up to this many attempts. Not hardcoded to "3000 or
// bust" — see _findAvailablePort.
const PORT_FALLBACK_START = 3000;
const PORT_FALLBACK_ATTEMPTS = 10;

/**
 * Attempts a raw TCP connect to `localhost:<port>` to confirm something is
 * genuinely listening there.
 *
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function _isPortListening(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

// ---------------------------------------------------------------------------
// Lyte CLI stale build-lock cleanup
// ---------------------------------------------------------------------------
// The Lyte CLI (`lyte serve`) keeps a small JSON cache at
// `<project>/<outputFolder>/build/buildConf.json` mapping the project's
// absolute path to the PID of the last `lyte serve` process. On startup it
// checks whether that recorded PID is still alive and, if so, blocks with
// an interactive prompt on stdin. This is a PID/folder-based lock —
// unrelated to which port is requested — so killing ports does not clear
// it. Proactively deleting this transient cache file (regenerated
// automatically on the next build) avoids the prompt in the common case;
// _maybeAutoAnswerPrompt is the defense-in-depth fallback for any case this
// doesn't prevent.
// ---------------------------------------------------------------------------

/**
 * Extracts the `outputFolder` value from a Lyte project's build/build.js by
 * reading the `configureFolders` function's `options.outputFolder = "..."`
 * assignment. Intentionally generic (not hardcoded to "biginclient") so any
 * Bigin/Lyte project using a differently-named output folder is supported.
 *
 * @param {string} projectPath
 * @returns {string|null}
 */
function _resolveLyteOutputFolder(projectPath) {
  const buildJsPath = path.join(projectPath, "build", "build.js");
  if (!fs.existsSync(buildJsPath)) return null;
  try {
    const src = fs.readFileSync(buildJsPath, "utf8");
    const match = src.match(/options\.outputFolder\s*=\s*["'`]([^"'`]+)["'`]/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Deletes the Lyte CLI's stale build-lock cache (buildConf.json) for the
 * given project, if present. Best-effort: any failure is swallowed.
 *
 * @param {object} project
 */
function _clearStaleLyteLock(project) {
  try {
    const outputFolder = _resolveLyteOutputFolder(project.path);
    if (!outputFolder) return;
    const lockPath = path.join(project.path, outputFolder, "build", "buildConf.json");
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Best-effort cleanup only — never fail environment start because of this.
  }
}

/**
 * The single entry point the rest of the app uses to bring a Bigin
 * project's development server up and down.
 *
 * ---------------------------------------------------------------------------
 * Architecture: the integrated Terminal is the ONLY execution surface
 * ---------------------------------------------------------------------------
 * This class does NOT spawn its own process or PTY. "Start Dev Server"
 * works by:
 *   1. Resolving the command to run (`lyte serve --port <n>` for Lyte
 *      projects, with sequential port fallback; `npm run <script>` etc.
 *      for others).
 *   2. Asking TerminalManager for the project's primary terminal session
 *      (created if it doesn't exist yet, reused if the Terminal panel
 *      already created one) via ensureSession().
 *   3. Writing the command into that session exactly as if the user had
 *      typed it — terminalManager.write(sessionId, command + "\r").
 *   4. Watching that session's TERMINAL_OUTPUT for the CLI's own "ready"
 *      line to resolve a previewUrl, and TERMINAL_EXIT/TERMINAL_INTERRUPT
 *      to know when the dev server actually stops.
 *
 * There is exactly one PTY, one shell, and one visible output stream per
 * project — whether the command came from the button or the user's own
 * keyboard. Composes with the Bigin Redirector abstraction
 * (RedirectorManager) to produce the one thing the UI actually needs: a
 * previewUrl.
 *
 * Supports the dev-server entry-points detected by ProjectManager:
 *
 *   "lyte-cli"    — Bigin/Lyte project. Runs `lyte serve --port <n>` with
 *                   automatic sequential port fallback (3000, 3001, ...).
 *
 *   "npm-script"  — Standard npm/yarn project. Runs `npm run dev` (or
 *                   start/serve).
 *
 *   "build-js"    — build/build.js exists but the Lyte CLI is not
 *                   installed. Surfaces a diagnostic error.
 *
 *   "none"        — No dev entry-point detected. Shows an informative error.
 */
class EnvironmentManager {
  /**
   * @param {object} deps
   * @param {import('../terminal/TerminalManager')} deps.terminalManager
   */
  constructor({ terminalManager } = {}) {
    this.terminalManager = terminalManager;
    this.redirector = new RedirectorManager();

    this.previewUrl = null;
    this.detectedPort = null;
    this.project = null;

    // Dev-server-over-terminal state. This mirrors (but is derived from)
    // the real PTY/session state — never an independently-maintained
    // boolean that can drift out of sync with it.
    this._activeSessionId = null;
    this._running = false;
    this._command = null;
    this._startedAt = null;
    this._recentSessionOutput = ""; // rolling tail, for prompt/URL detection
    this._eventHandler = null; // the persistent bus subscription, bound once
    this._pendingStart = null; // { resolve, reject, timeout } while awaiting readiness
    // Watches the resolved port after the dev server is confirmed running.
    // The shell/terminal session gives no generic signal for "the
    // foreground process exited normally on its own" (e.g. a build error
    // crashing lyte serve without Ctrl+C or the shell itself exiting) — but
    // the port it was serving on going away IS a reliable, generic signal.
    // Without this, `running` could stay stuck `true` after such a crash.
    this._watchdogInterval = null;

    this._subscribeToTerminalEvents();
  }

  /**
   * Injects (or replaces) the TerminalManager dependency. Used by main.js
   * if construction order requires it; safe to call multiple times.
   */
  setTerminalManager(terminalManager) {
    this.terminalManager = terminalManager;
  }

  // ---------------------------------------------------------------------------
  // Persistent terminal event subscription
  // ---------------------------------------------------------------------------

  /**
   * Subscribes once, for the lifetime of this instance, to the runtime bus
   * so dev-server state is always derived from the real terminal session —
   * regardless of whether the session ends via the Stop button, the user
   * typing Ctrl+C directly in the terminal, or the shell exiting outright.
   */
  _subscribeToTerminalEvents() {
    this._eventHandler = ({ type, payload }) => {
      if (!this._activeSessionId || payload?.sessionId !== this._activeSessionId) return;

      if (type === EVENTS.TERMINAL_OUTPUT) {
        this._handleSessionOutput(payload.data);
      } else if (type === EVENTS.TERMINAL_EXIT) {
        // The whole shell died — the dev server is definitely not running.
        this._handleSessionEnded(new Error(`Terminal session exited (code ${payload.code}).`));
      } else if (type === EVENTS.TERMINAL_INTERRUPT) {
        // Ctrl+C reached the PTY — whether from the Stop button or the user
        // typing it directly, the foreground `lyte serve`/`npm run dev` is
        // being interrupted.
        this._handleSessionEnded(null);
      }
    };
    bus.on("runtime-event", this._eventHandler);
  }

  _handleSessionOutput(data) {
    this._recentSessionOutput = (this._recentSessionOutput + data).slice(-400);

    this._maybeAutoAnswerPrompt();

    if (this._pendingStart) {
      const url = this._detectUrlFromLog(data);
      if (url) {
        this._pendingStart.resolve(url);
      }
    }
  }

  _handleSessionEnded(err) {
    const wasRunning = this._running || !!this._pendingStart;
    this._running = false;
    this._recentSessionOutput = "";
    this._stopWatchdog();

    if (this._pendingStart) {
      this._pendingStart.reject(err || new Error("Dev server was interrupted before it became ready."));
      this._pendingStart = null;
    } else if (wasRunning) {
      this.previewUrl = null;
      bus.emitEvent(EVENTS.ENVIRONMENT_STOPPED, {});
    }
  }

  /**
   * Starts polling the resolved port so a dev server that crashes/exits on
   * its own (e.g. a build error) — without Ctrl+C and without the shell
   * itself dying — is still correctly detected as stopped, keeping
   * `running` truthful instead of stuck.
   */
  _startWatchdog() {
    this._stopWatchdog();
    if (!this.detectedPort) return;
    this._watchdogInterval = setInterval(async () => {
      if (!this._running) return this._stopWatchdog();
      const alive = await _isPortListening(this.detectedPort, 1000);
      if (!alive && this._running) {
        this._handleSessionEnded(new Error("Development server process ended unexpectedly."));
      }
    }, 3000);
  }

  _stopWatchdog() {
    if (this._watchdogInterval) {
      clearInterval(this._watchdogInterval);
      this._watchdogInterval = null;
    }
  }

  /**
   * Watches recent terminal output for an interactive Y/N confirmation
   * prompt and automatically answers "Y" the moment one appears. Vibe
   * Editor runs headlessly with respect to this specific prompt (there is
   * no guarantee a human is watching the exact moment it appears), so
   * without this, "Start Dev Server" could hang indefinitely.
   */
  _maybeAutoAnswerPrompt() {
    if (!this._pendingStart || !this._activeSessionId) return;
    const stripped = this._recentSessionOutput.replace(ANSI_ESCAPE_REGEX, "");
    if (INTERACTIVE_PROMPT_REGEX.test(stripped)) {
      this.terminalManager.write(this._activeSessionId, "Y\r");
      this._recentSessionOutput = "";
    }
  }

  _detectUrlFromLog(data) {
    const stripped = data.replace(ANSI_ESCAPE_REGEX, "");
    const match = stripped.match(URL_REGEX);
    if (!match) return null;
    const url = match[0].replace(/[),.]+$/, "");
    try {
      this.detectedPort = Number(new URL(url).port) || this.detectedPort;
    } catch {
      /* ignore parse errors */
    }
    return url;
  }

  // ---------------------------------------------------------------------------
  // Port fallback
  // ---------------------------------------------------------------------------

  /**
   * Finds the first available port starting at `startPort`, trying up to
   * `attempts` sequential ports (3000, 3001, 3002, ...). Prefers detecting
   * availability up front over launching a command that immediately fails
   * because the port is occupied.
   *
   * @param {number} [startPort]
   * @param {number} [attempts]
   * @returns {Promise<number|null>} the first available port, or null if
   *   every port in the range is occupied.
   */
  async _findAvailablePort(startPort = PORT_FALLBACK_START, attempts = PORT_FALLBACK_ATTEMPTS) {
    for (let i = 0; i < attempts; i++) {
      const port = startPort + i;
      const occupied = await _isPortListening(port, 300);
      if (!occupied) return port;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Command resolution
  // ---------------------------------------------------------------------------

  /**
   * Builds the exact shell command to type into the terminal, based on the
   * project's detected devEntryPoint.
   *
   * @param {object} project
   * @returns {Promise<string>} the command string
   */
  async _resolveDevCommand(project) {
    const { devEntryPoint, devScript, packageManager, lyteBin } = project;

    switch (devEntryPoint) {
      case "lyte-cli": {
        const port = await this._findAvailablePort();
        if (port == null) {
          throw new Error(
            `All ports from ${PORT_FALLBACK_START} to ${PORT_FALLBACK_START + PORT_FALLBACK_ATTEMPTS - 1} ` +
            `are occupied. Free one of these ports and try again.`
          );
        }
        this.detectedPort = port;
        // Prefer the absolute resolved binary path (detected by
        // ProjectManager) over the bare "lyte" command name so this works
        // correctly even if the shell's own PATH doesn't happen to include
        // it, while still showing a clean, recognizable command in the
        // terminal.
        const lyteCommand = lyteBin || "lyte";
        return `${lyteCommand} serve --port ${port}`;
      }

      case "npm-script": {
        return packageManager === "yarn" ? `yarn ${devScript}` : `npm run ${devScript}`;
      }

      case "build-js": {
        throw new Error(
          `This project uses the Lyte CLI (build/build.js detected) but the ` +
          `\`lyte\` command was not found.\n\n` +
          `Install the Lyte CLI:\n  npm install -g @zoho/lyte-cli\n\n` +
          `Then restart the Bigin Vibe Editor.`
        );
      }

      default: {
        const diag = [
          `Unable to detect a development environment for "${project.name}".`,
          ``,
          `Diagnostics:`,
          `  Project type:    ${project.projectType || "unknown"}`,
          `  Framework:       ${project.framework || "unknown"}`,
          `  Lyte signal:     ${project.lyteSignal || "none"}`,
          `  bower.json:      ${fs.existsSync(path.join(project.path, "bower.json")) ? "found" : "not found"}`,
          `  build/build.js:  ${fs.existsSync(path.join(project.path, "build", "build.js")) ? "found" : "not found"}`,
          ``,
          `For a Bigin/Lyte project, ensure the Lyte CLI is installed:`,
          `  npm install -g @zoho/lyte-cli`,
        ].join("\n");
        throw new Error(diag);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async start(project) {
    if (!project) throw new Error("Cannot start environment: no project is open.");
    if (!this.terminalManager) throw new Error("Terminal is not available.");
    if (this._running) throw new Error("Dev server is already running. Stop it before starting a new one.");

    this.project = project;
    bus.emitEvent(EVENTS.ENVIRONMENT_STARTING, { project: project.path });

    let command;
    try {
      command = await this._resolveDevCommand(project);
    } catch (err) {
      bus.emitEvent(EVENTS.ENVIRONMENT_ERROR, { error: err.message });
      throw err;
    }

    if (project.devEntryPoint === "lyte-cli") {
      _clearStaleLyteLock(project);
    }

    // Get (or create) the project's primary terminal session — the exact
    // same session the visible Terminal panel uses.
    const session = this.terminalManager.ensureSession({ cwd: project.path });
    this._activeSessionId = session.id;
    this._command = command;
    this._startedAt = Date.now();
    this._recentSessionOutput = "";

    // Type the command into the terminal, exactly as the user would.
    this.terminalManager.write(this._activeSessionId, `${command}\r`);

    // Wait for the CLI's own "ready" line to appear in the terminal output.
    // lyte serve prints: "Will be serving on http://localhost:<port>/"
    // npm-based servers typically print: "Local: http://localhost:<port>"
    const urlWaitMs = project.devEntryPoint === "lyte-cli" ? 60000 : 20000;

    let resolvedDevUrl;
    try {
      resolvedDevUrl = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => resolve(null), urlWaitMs);
        this._pendingStart = {
          resolve: (url) => {
            clearTimeout(timeout);
            this._pendingStart = null;
            resolve(url);
          },
          reject: (err) => {
            clearTimeout(timeout);
            this._pendingStart = null;
            reject(err);
          },
        };
      });
    } catch (err) {
      bus.emitEvent(EVENTS.ENVIRONMENT_ERROR, { error: err.message });
      throw err;
    }

    // If the ready line was never seen (e.g. lost to ANSI spinner
    // rendering) for a Lyte project, fall back to the resolved port — but
    // ONLY after actively verifying something is really listening there.
    // Without this check, a dev server stuck at an unanswered prompt or
    // otherwise hung would be silently reported as "started".
    if (!resolvedDevUrl && project.devEntryPoint === "lyte-cli" && this.detectedPort) {
      const reallyListening = await _isPortListening(this.detectedPort);
      if (reallyListening) {
        resolvedDevUrl = `http://localhost:${this.detectedPort}/`;
      } else {
        this.terminalManager.write(this._activeSessionId, "\x03"); // interrupt the stuck process
        const error =
          `Development server did not become reachable on port ${this.detectedPort} within the ` +
          `expected time. Check the Terminal for details (it may be waiting on an unanswered ` +
          `prompt or failed to build).`;
        bus.emitEvent(EVENTS.ENVIRONMENT_ERROR, { error });
        throw new Error(error);
      }
    }

    if (!resolvedDevUrl) {
      const error = "Development server did not report a ready URL. Check the Terminal for details.";
      bus.emitEvent(EVENTS.ENVIRONMENT_ERROR, { error });
      throw new Error(error);
    }

    this._running = true;
    this._startWatchdog();

    try {
      const { previewUrl, mode } = await this.redirector.start({
        projectPath: project.path,
        projectName: project.name,
        devServerPort: this.detectedPort,
        devServerUrl: resolvedDevUrl,
      });

      if (!previewUrl) {
        const error =
          "Bigin Redirector could not be started or connected, and no dev server URL was detected.";
        bus.emitEvent(EVENTS.ENVIRONMENT_ERROR, { error });
        throw new Error(error);
      }

      this.previewUrl = previewUrl;
      bus.emitEvent(EVENTS.ENVIRONMENT_STARTED, { previewUrl, mode, port: this.detectedPort });
      return this.getStatus();
    } catch (err) {
      bus.emitEvent(EVENTS.ENVIRONMENT_ERROR, {
        error: `Redirector could not be started: ${err.message}`,
      });
      throw err;
    }
  }

  /**
   * Stops the dev server by sending Ctrl+C into its terminal session —
   * exactly what a user would do to interrupt it manually. This is the
   * ONLY way "Stop" is implemented: there is no separate kill path, so the
   * button and manual Ctrl+C are indistinguishable to the rest of the app,
   * which is what keeps the running/stopped state truthful.
   */
  async stop() {
    bus.emitEvent(EVENTS.ENVIRONMENT_STOPPING, {});
    this.redirector.stop();
    this._stopWatchdog();
    if (this._activeSessionId && this.terminalManager) {
      this.terminalManager.write(this._activeSessionId, "\x03");
    }
    // _handleSessionEnded (triggered by the TERMINAL_INTERRUPT event this
    // write() call emits) sets _running=false and emits ENVIRONMENT_STOPPED.
    // If for some reason the session is already gone, ensure state doesn't
    // stay stuck as "running".
    if (!this._activeSessionId) {
      this._running = false;
      this.previewUrl = null;
      bus.emitEvent(EVENTS.ENVIRONMENT_STOPPED, {});
    }
  }

  async restart(project) {
    await this.stop();
    return this.start(project || this.project);
  }

  getStatus() {
    return {
      devServer: {
        running: this._running,
        command: this._command,
        cwd: this.project?.path || null,
        startedAt: this._startedAt,
        sessionId: this._activeSessionId,
        port: this.detectedPort,
      },
      redirectorRunning: this.redirector.isRunning(),
      previewUrl: this.previewUrl,
    };
  }

  getPreviewUrl() {
    return this.previewUrl;
  }
}

module.exports = EnvironmentManager;
