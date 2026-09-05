const { spawn } = require("child_process");
const { EVENTS } = require("../../shared/events");
const { BIGIBOT_MODEL } = require("../../shared/opencodeConfig");
const bus = require("../runtimeBus");
const {
  CHAT_CLASSIFICATION,
  classifyMessagePart,
  extractVisibleAssistantText,
} = require("./OpenCodeEventClassifier");

// ---------------------------------------------------------------------------
// Root-cause context
// ---------------------------------------------------------------------------
// The @opencode-ai/sdk's createOpencodeServer() spawns the `opencode serve`
// process using cross-spawn WITHOUT a `cwd` option:
//
//   launch(`opencode`, args, { env: { ...process.env, OPENCODE_CONFIG_CONTENT } })
//
// Because no `cwd` is passed, the child process inherits the Electron
// application's cwd — which is the biginVibe editor repository, NOT the
// user's opened project. The config.cwd field passed via OPENCODE_CONFIG_CONTENT
// is silently ignored by the opencode binary (it has no "cwd" config key).
//
// As a result every tool the agent runs (bash, file read/write, search, git)
// uses the editor repository as its working directory, regardless of which
// project the user opened.
//
// Fix: bypass createOpencodeServer and spawn `opencode serve` ourselves,
// passing `cwd: project.path` directly to child_process.spawn. The spawned
// server is then rooted at the active project for all tool execution.
// We still use the SDK's generated client (OpencodeClient) to talk to it —
// only the *server launch* is replaced.
// ---------------------------------------------------------------------------

/**
 * Wait for the opencode server to print its ready line and parse the URL.
 *
 * The server writes exactly one line to stdout:
 *   opencode server listening on http://127.0.0.1:<port>
 *
 * @param {import('child_process').ChildProcess} proc
 * @param {number} timeoutMs
 * @returns {Promise<string>} the base URL of the running server
 */
function waitForServerReady(proc, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`opencode serve did not start within ${timeoutMs}ms`));
    }, timeoutMs);

    let buffer = "";

    function onData(chunk) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (line.startsWith("opencode server listening")) {
          const m = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (m) {
            clearTimeout(timer);
            proc.stdout.off("data", onData);
            proc.stderr.off("data", onStderr);
            resolve(m[1]);
          } else {
            clearTimeout(timer);
            proc.kill();
            reject(new Error(`opencode server ready line did not contain URL: ${line}`));
          }
          return;
        }
      }
    }

    let errBuf = "";
    function onStderr(chunk) { errBuf += chunk.toString(); }

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onStderr);

    proc.on("exit", (code) => {
      clearTimeout(timer);
      let msg = `opencode serve exited early (code ${code})`;
      if (errBuf.trim()) msg += `\n${errBuf.trim()}`;
      if (buffer.trim()) msg += `\n${buffer.trim()}`;
      reject(new Error(msg));
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start opencode serve: ${err.message}`));
    });
  });
}

/**
 * Spawn `opencode serve` with the given project path as the working directory
 * and return { url, proc } once the server signals readiness.
 *
 * This replaces the SDK's createOpencodeServer() for the sole purpose of
 * ensuring the spawned process has cwd = projectPath. Everything else
 * (client creation, session management) still uses the SDK.
 *
 * @param {string} projectPath  Absolute path to the active user project.
 * @returns {Promise<{ url: string, proc: ChildProcess }>}
 */
async function spawnOpencodeServer(projectPath) {
  const proc = spawn(
    "opencode",
    ["serve", "--hostname=127.0.0.1", "--port=0"],
    {
      // *** THE CRITICAL FIX ***
      // cwd is explicitly set to the active project path.
      // opencode inherits this as its working directory, so every file tool,
      // bash command, and search the agent runs is rooted here — not in the
      // Vibe Editor repository.
      cwd: projectPath,
      env: process.env,
      // Pipe stdio so we can capture the ready line on stdout.
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const url = await waitForServerReady(proc);
  return { url, proc };
}

// ---------------------------------------------------------------------------
// OpenCodeService
// ---------------------------------------------------------------------------

/**
 * Isolates all @opencode-ai/sdk usage behind a small, task-shaped API so the
 * rest of the app (and the renderer) never touches the SDK directly.
 *
 *   createSession(project)
 *   sendPrompt(sessionId, text)
 *   cancelSession(sessionId)
 *
 * One OpenCode server instance is created per opened project, rooted at the
 * project directory, so the agent can never read/write outside of it and a
 * session for Project A can never touch Project B.
 */
class OpenCodeService {
  constructor() {
    this.sdk = null;
    /** @type {{ client: any, server: { url: string, proc: ChildProcess, close(): void } } | null} */
    this.opencode = null;
    this.project = null;
    this.sessionsByProject = new Map(); // projectPath -> sessionId
    this.activePromptBySession = new Map(); // sessionId -> { assistantMessageId }
    this.messageRoleBySession = new Map(); // sessionId -> Map<messageId, role>
  }

  _rememberMessageRole(sessionId, messageId, role) {
    if (!sessionId || !messageId || !role) return;
    if (!this.messageRoleBySession.has(sessionId)) {
      this.messageRoleBySession.set(sessionId, new Map());
    }
    this.messageRoleBySession.get(sessionId).set(messageId, role);
  }

  _roleForMessage(sessionId, messageId) {
    return this.messageRoleBySession.get(sessionId)?.get(messageId) || null;
  }

  async _loadSdk() {
    if (!this.sdk) {
      this.sdk = await import("@opencode-ai/sdk");
    }
    return this.sdk;
  }

  async _ensureServerForProject(project) {
    if (this.opencode && this.project && this.project.path === project.path) {
      return this.opencode;
    }

    // Switching projects: tear down the previous server completely so there
    // is no possibility of a stale session touching the wrong repo.
    await this.shutdown();

    // Spawn opencode serve with cwd = the active user project path.
    // This is the fix for the workspace-context bug: by passing cwd here the
    // opencode process — and every tool it runs (bash, file, search, git) —
    // is rooted at the project the user explicitly opened, never at the Vibe
    // Editor application directory.
    const { url, proc } = await spawnOpencodeServer(project.path);

    // Build the SDK client pointed at our server.
    const sdk = await this._loadSdk();
    const client = sdk.createOpencodeClient({ baseUrl: url });

    this.opencode = {
      client,
      server: {
        url,
        proc,
        close() {
          try {
            // Kill the process tree on macOS/Linux so child shells also exit.
            if (process.platform !== "win32" && proc.pid) {
              process.kill(-proc.pid, "SIGTERM");
            } else {
              proc.kill();
            }
          } catch {
            try { proc.kill(); } catch { /* noop */ }
          }
        },
      },
    };

    this.project = project;
    this._subscribeToServerEvents();
    return this.opencode;
  }

  async createSession(project) {
    await this._ensureServerForProject(project);
    const { client } = this.opencode;
    const session = await client.session.create({
      body: { title: `BigiBot – ${project.name}` },
    });
    this.sessionsByProject.set(project.path, session.data.id);
    bus.emitEvent(EVENTS.AGENT_SESSION_CREATED, {
      sessionId: session.data.id,
      project: project.path,
    });
    return session.data;
  }

  getSessionId(project) {
    return this.sessionsByProject.get(project.path) || null;
  }

  /**
   * @param {string} sessionId
   * @param {string} text - the user's natural-language request, already
   *   enriched with any Bigin/Lyte component context by BigiBotService.
   * @param {{ agent?: string }} [options]
   */
  async sendPrompt(sessionId, text, options = {}) {
    if (!this.opencode) throw new Error("OpenCode server is not running for this project.");
    const { client } = this.opencode;
    this.activePromptBySession.set(sessionId, { assistantMessageId: null });
    bus.emitEvent(EVENTS.AGENT_THINKING, { sessionId });
    try {
      const result = await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: BIGIBOT_MODEL,
          agent: options.agent,
          parts: [{ type: "text", text }],
        },
      });
      const active = this.activePromptBySession.get(sessionId);
      const assistantMessageId = result?.data?.info?.id || active?.assistantMessageId || null;
      if (assistantMessageId) {
        this._rememberMessageRole(sessionId, assistantMessageId, "assistant");
      }

      const finalText = extractVisibleAssistantText(result?.data?.parts, assistantMessageId);
      if (finalText) {
        bus.emitEvent(EVENTS.AGENT_MESSAGE, {
          sessionId,
          messageId: assistantMessageId,
          text: finalText,
          kind: "final",
        });
      }

      bus.emitEvent(EVENTS.AGENT_COMPLETED, { sessionId });
      return result.data;
    } catch (err) {
      bus.emitEvent(EVENTS.AGENT_ERROR, {
        sessionId,
        error: `BigiBot could not complete the requested change: ${err.message}`,
      });
      throw err;
    } finally {
      this.activePromptBySession.delete(sessionId);
    }
  }

  async cancelSession(sessionId) {
    if (!this.opencode) return;
    await this.opencode.client.session.abort({ path: { id: sessionId } });
  }

  /**
   * Subscribes once per server instance to the OpenCode SSE event stream and
   * maps relevant event types onto this app's own event vocabulary so the
   * UI only ever needs to know about `agent.*` events.
   */
  async _subscribeToServerEvents() {
    const { client } = this.opencode;
    const events = await client.event.subscribe();
    (async () => {
      try {
        for await (const event of events.stream) {
          this._forwardServerEvent(event);
        }
      } catch {
        // Stream ends when the server shuts down; nothing to do.
      }
    })();
  }

  _forwardServerEvent(event) {
    const { type, properties } = event;
    switch (type) {
      case "message.updated": {
        const info = properties?.info;
        if (!info?.sessionID || !info?.id) break;
        this._rememberMessageRole(info.sessionID, info.id, info.role);

        const active = this.activePromptBySession.get(info.sessionID);
        if (active && info.role === "assistant" && !active.assistantMessageId) {
          active.assistantMessageId = info.id;
        }
        break;
      }
      case "message.part.updated": {
        const part = properties?.part;
        const sessionId = part?.sessionID;
        if (!part || !sessionId) break;

        const active = this.activePromptBySession.get(sessionId);
        if (!active) break;

        const role = this._roleForMessage(sessionId, part.messageID);
        if (role !== "assistant") break;

        if (part?.type === "tool") {
          const evt = part.state?.status === "completed"
            ? EVENTS.AGENT_TOOL_COMPLETED
            : EVENTS.AGENT_TOOL_STARTED;
          bus.emitEvent(evt, { sessionId, tool: part.tool, state: part.state });
          break;
        }

        const classification = classifyMessagePart(part, active.assistantMessageId);
        if (classification !== CHAT_CLASSIFICATION.USER_VISIBLE_ASSISTANT_RESPONSE) {
          break;
        }

        if (part.messageID !== active.assistantMessageId) {
          break;
        }

        if (typeof properties?.delta === "string" && properties.delta.length) {
          bus.emitEvent(EVENTS.AGENT_MESSAGE, {
            sessionId,
            messageId: part.messageID,
            text: properties.delta,
            kind: "delta",
          });
        }
        break;
      }
      case "file.edited": {
        bus.emitEvent(EVENTS.AGENT_FILE_CHANGED, { path: properties?.file });
        break;
      }
      case "session.error": {
        bus.emitEvent(EVENTS.AGENT_ERROR, {
          sessionId: properties?.sessionID,
          error: properties?.error?.message || "Unknown agent error",
        });
        break;
      }
      default:
        break;
    }
  }

  async shutdown() {
    if (this.opencode) {
      try {
        this.opencode.server.close();
      } catch {
        /* noop */
      }
    }
    this.opencode = null;
    this.project = null;
    // Clear all session IDs so stale session references from a previous
    // project (or a previous open of the same project) can never be reused
    // after a shutdown. A fresh session will be created on the next request.
    this.sessionsByProject.clear();
    this.activePromptBySession.clear();
    this.messageRoleBySession.clear();
  }
}

module.exports = OpenCodeService;
