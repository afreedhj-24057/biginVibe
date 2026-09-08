const { spawn } = require("child_process");
const http = require("http");
const https = require("https");
const { EVENTS } = require("../../shared/events");
const {
  BIGIBOT_MODEL,
  BIGIBOT_CAVEMAN_ENABLED,
  BIGIBOT_CAVEMAN_AUTOSTART,
  BIGIBOT_CAVEMAN_URL,
  BIGIBOT_CAVEMAN_PROVIDER,
  BIGIBOT_CAVEMAN_BASE_URL,
  BIGIBOT_CAVEMAN_MODE,
  BIGIBOT_CAVEMAN_CONFIG,
} = require("../../shared/opencodeConfig");
const bus = require("../runtimeBus");
const { extractVisibleAssistantText } = require("./OpenCodeEventClassifier");

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

function normalizeBaseUrl(url) {
  if (typeof url !== "string") return "";
  return url.trim().replace(/\/$/, "");
}

function buildCavemanProviderBaseUrl() {
  const explicit = normalizeBaseUrl(BIGIBOT_CAVEMAN_BASE_URL);
  if (explicit) return explicit;

  const proxyUrl = normalizeBaseUrl(BIGIBOT_CAVEMAN_URL);
  const provider = BIGIBOT_CAVEMAN_PROVIDER;
  if (!proxyUrl) return "";

  if (provider === "openai") return `${proxyUrl}/openai/v1`;
  if (provider === "anthropic") return `${proxyUrl}/anthropic/v1`;
  if (provider === "gemini") return `${proxyUrl}/gemini/v1beta`;
  if (provider === "bedrock") return `${proxyUrl}/bedrock`;
  throw new Error(
    `Unsupported BIGIBOT_CAVEMAN_PROVIDER value \"${provider}\". Supported values: openai, anthropic, gemini, bedrock.`
  );
}

function buildOpencodeProviderConfigForCaveman(baseUrl) {
  const provider = BIGIBOT_CAVEMAN_PROVIDER;
  if (provider === "openai") {
    return { openai: { options: { baseURL: baseUrl } } };
  }
  if (provider === "anthropic") {
    return { anthropic: { options: { baseURL: baseUrl } } };
  }
  if (provider === "gemini") {
    return { gemini: { options: { baseURL: baseUrl } } };
  }
  if (provider === "bedrock") {
    return { "amazon-bedrock": { options: { baseURL: baseUrl } } };
  }
  throw new Error(
    `Unsupported BIGIBOT_CAVEMAN_PROVIDER value \"${provider}\". Supported values: openai, anthropic, gemini, bedrock.`
  );
}

function waitForHttpReady(url, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();

    const attempt = () => {
      const parsed = new URL(url);
      const lib = parsed.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          method: "GET",
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: "/",
          timeout: 1200,
        },
        (res) => {
          res.resume();
          resolve();
        }
      );

      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });

      req.on("error", (err) => {
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`Could not connect to ${url}: ${err.message}`));
          return;
        }
        setTimeout(attempt, 180);
      });

      req.end();
    };

    attempt();
  });
}

function isHttpReachable(url, timeoutMs = 900) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          method: "GET",
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: "/",
          timeout: timeoutMs,
        },
        (res) => {
          res.resume();
          resolve(true);
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

async function maybeStartCavemanProxy() {
  if (!BIGIBOT_CAVEMAN_ENABLED) return null;

  const proxyUrl = normalizeBaseUrl(BIGIBOT_CAVEMAN_URL);
  if (!proxyUrl) {
    throw new Error("BIGIBOT_CAVEMAN_URL must be set when BIGIBOT_CAVEMAN_ENABLED=true.");
  }

  try {
    await waitForHttpReady(proxyUrl, 1300);
    return null;
  } catch {
    // Continue: proxy might not be up yet and we can auto-start below.
  }

  if (!BIGIBOT_CAVEMAN_AUTOSTART) {
    throw new Error(
      `Caveman proxy is enabled but not reachable at ${proxyUrl}. Start it first (for example: caveman start), or set BIGIBOT_CAVEMAN_AUTOSTART=true.`
    );
  }

  const parsed = new URL(proxyUrl);
  const args = ["start", "--host", parsed.hostname, "--port", String(parsed.port || 8787)];
  if (BIGIBOT_CAVEMAN_CONFIG) {
    args.push("--config", BIGIBOT_CAVEMAN_CONFIG);
  }

  const childEnv = { ...process.env };
  if (BIGIBOT_CAVEMAN_MODE) {
    childEnv.CAVEMAN_MODE = BIGIBOT_CAVEMAN_MODE;
  }

  const proc = spawn("caveman", args, {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await Promise.race([
    waitForHttpReady(proxyUrl, 9000),
    new Promise((_, reject) => {
      proc.once("exit", (code) => {
        const details = stderr.trim() ? `\n${stderr.trim()}` : "";
        reject(new Error(`caveman start exited early (code ${code}).${details}`));
      });
      proc.once("error", (err) => {
        reject(new Error(`Failed to launch caveman start: ${err.message}`));
      });
    }),
  ]);

  return proc;
}

function extractTextFromParts(parts, assistantMessageId) {
  if (!Array.isArray(parts) || !parts.length) return "";
  const strict = extractVisibleAssistantText(parts, assistantMessageId).trim();
  if (strict) return strict;
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function clampAssistantText(text) {
  if (typeof text !== "string") return "";
  const cleaned = text.trim();
  if (!cleaned) return "";

  const limit = Number(process.env.BIGIBOT_MAX_RESPONSE_CHARS || 2200);
  if (!Number.isFinite(limit) || limit < 400) return cleaned;
  if (cleaned.length <= limit) return cleaned;

  const clipped = cleaned.slice(0, limit).trimEnd();
  return `${clipped}\n\n[truncated to keep chat concise; ask "expand" for full details]`;
}

function extractTextFromPromptResult(result, assistantMessageId) {
  const data = result?.data || {};
  const partCandidates = [
    data.parts,
    data.message?.parts,
    data.output?.parts,
    Array.isArray(data.messages) ? data.messages[data.messages.length - 1]?.parts : null,
  ];

  for (const parts of partCandidates) {
    const text = extractTextFromParts(parts, assistantMessageId);
    if (text) return text;
  }

  const scalarCandidates = [
    data.text,
    data.outputText,
    data.output_text,
    data.message?.text,
  ];

  for (const value of scalarCandidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  if (Array.isArray(data.message?.content)) {
    const fromContent = data.message.content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text" && typeof item.text === "string") return item.text;
        return "";
      })
      .join("")
      .trim();
    if (fromContent) return fromContent;
  }

  return "";
}

function extractTextFromMessage(message) {
  if (!message || typeof message !== "object") return "";

  if (typeof message.text === "string" && message.text.trim()) {
    return message.text.trim();
  }

  if (Array.isArray(message.parts)) {
    const fromParts = message.parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("")
      .trim();
    if (fromParts) return fromParts;
  }

  if (Array.isArray(message.content)) {
    const fromContent = message.content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text" && typeof item.text === "string") return item.text;
        return "";
      })
      .join("")
      .trim();
    if (fromContent) return fromContent;
  }

  return "";
}

function extractTextFromMessageUpdatedProperties(properties) {
  if (!properties || typeof properties !== "object") return "";

  const candidates = [
    properties.message,
    properties.data,
    properties.info,
  ];

  for (const candidate of candidates) {
    const text = extractTextFromMessage(candidate);
    if (text) return text;
  }

  if (typeof properties.text === "string" && properties.text.trim()) {
    return properties.text.trim();
  }

  return "";
}

function extractSessionIdFromProperties(properties) {
  return (
    properties?.part?.sessionID
    || properties?.info?.sessionID
    || properties?.message?.sessionID
    || properties?.data?.sessionID
    || properties?.sessionID
    || null
  );
}

function extractMessageIdFromProperties(properties) {
  return (
    properties?.part?.messageID
    || properties?.info?.id
    || properties?.message?.id
    || properties?.data?.id
    || null
  );
}

function extractRoleFromProperties(properties) {
  return properties?.info?.role || properties?.message?.role || properties?.data?.role || null;
}

function collectTextFromUnknown(value, out, depth = 0) {
  if (depth > 4 || value == null) return;
  if (typeof value === "string") {
    const s = value.trim();
    if (s) out.push(s);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextFromUnknown(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  if (typeof value.text === "string") {
    const s = value.text.trim();
    if (s) out.push(s);
  }
  if (typeof value.delta === "string") {
    const s = value.delta.trim();
    if (s) out.push(s);
  }

  const keys = ["content", "parts", "message", "messages", "output", "data", "result"];
  for (const key of keys) {
    if (key in value) collectTextFromUnknown(value[key], out, depth + 1);
  }
}

function extractTextFromUnknown(value) {
  const chunks = [];
  collectTextFromUnknown(value, chunks);
  if (!chunks.length) return "";
  const text = chunks.join("\n").trim();
  if (!text) return "";
  return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
}

function isFetchFailure(err) {
  const msg = (err && err.message) ? String(err.message) : String(err || "");
  return /fetch failed|ECONNREFUSED|socket hang up|network error/i.test(msg);
}

function normalizeToolName(tool) {
  if (!tool) return "";
  if (typeof tool === "string") return tool.toLowerCase();
  if (typeof tool === "object") {
    const name = tool.name || tool.id || tool.tool;
    if (typeof name === "string") return name.toLowerCase();
  }
  return "";
}

function safeCommandFromToolState(state) {
  if (!state || typeof state !== "object") return "";
  const candidates = [
    state.command,
    state.input?.command,
    state.args?.command,
    Array.isArray(state.command) ? state.command.join(" ") : null,
  ];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const cmd = c.trim().replace(/\s+/g, " ");
    if (!cmd) continue;
    if (cmd.length > 120) continue;
    if (/[\n\r]/.test(cmd)) continue;
    if (!/^[a-zA-Z0-9_./:@ -]+$/.test(cmd)) continue;
    if (cmd.includes("=")) continue;
    return cmd;
  }
  return "";
}

function safeActivityFromToolEvent(tool, state, phase) {
  const toolName = normalizeToolName(tool);
  const command = safeCommandFromToolState(state);
  const done = phase === "completed";

  if (toolName.includes("bash") || toolName.includes("shell") || toolName.includes("terminal")) {
    if (command) {
      return {
        kind: "command",
        status: done ? "completed" : "running",
        label: done ? "Command completed" : `Running command: ${command}`,
      };
    }
    return {
      kind: "command",
      status: done ? "completed" : "running",
      label: done ? "Command completed" : "Running command...",
    };
  }

  if (toolName.includes("search") || toolName.includes("grep") || toolName.includes("glob") || toolName.includes("rg")) {
    return {
      kind: "tool",
      status: done ? "completed" : "running",
      label: done ? "Search completed" : "Searching files...",
    };
  }

  if (toolName.includes("read") || toolName.includes("view") || toolName.includes("open")) {
    return {
      kind: "tool",
      status: done ? "completed" : "running",
      label: done ? "Read completed" : "Reading files...",
    };
  }

  if (toolName.includes("write") || toolName.includes("edit") || toolName.includes("patch")) {
    return {
      kind: "tool",
      status: done ? "completed" : "running",
      label: done ? "Edit completed" : "Editing files...",
    };
  }

  return {
    kind: "tool",
    status: done ? "completed" : "running",
    label: done ? "Tool completed" : "Running a tool...",
  };
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
  const cavemanProc = await maybeStartCavemanProxy();
  const childEnv = { ...process.env };
  let cavemanProviderBaseUrl = null;

  if (BIGIBOT_CAVEMAN_ENABLED) {
    cavemanProviderBaseUrl = buildCavemanProviderBaseUrl();
    const provider = buildOpencodeProviderConfigForCaveman(cavemanProviderBaseUrl);
    childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider });
  }

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
      env: childEnv,
      // Pipe stdio so we can capture the ready line on stdout.
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  try {
    const url = await waitForServerReady(proc);
    return { url, proc, cavemanProc, cavemanProviderBaseUrl };
  } catch (err) {
    if (cavemanProc) {
      try { cavemanProc.kill(); } catch { /* noop */ }
    }
    throw err;
  }
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
    this.cancelRequestedBySession = new Set();
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
    const { url, proc, cavemanProc, cavemanProviderBaseUrl } = await spawnOpencodeServer(project.path);

    if (BIGIBOT_CAVEMAN_ENABLED) {
      const startupSource = cavemanProc ? "autostarted" : "existing";
      console.info(
        `[OpenCodeService] Caveman routing enabled (${startupSource} proxy): ${BIGIBOT_CAVEMAN_PROVIDER} -> ${cavemanProviderBaseUrl}`
      );
    }

    // Build the SDK client pointed at our server.
    const sdk = await this._loadSdk();
    const client = sdk.createOpencodeClient({ baseUrl: url });

    this.opencode = {
      client,
      server: {
        url,
        proc,
        cavemanProc,
        cavemanProviderBaseUrl,
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

          if (cavemanProc) {
            try { cavemanProc.kill(); } catch { /* noop */ }
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
      body: { title: `BiginVibe – ${project.name}` },
    });
    debugger;
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
   * @param {{ agent?: string, mode?: string }} [options]
   */
  async sendPrompt(sessionId, text, options = {}) {
    if (!this.opencode) throw new Error("OpenCode server is not running for this project.");
    const { client } = this.opencode;
    const activeState = {
      assistantMessageId: null,
      mode: options.mode || "build",
      hasVisibleOutput: false,
    };
    this.activePromptBySession.set(sessionId, activeState);
    bus.emitEvent(EVENTS.AGENT_THINKING, { sessionId });
    bus.emitEvent(EVENTS.AGENT_ACTIVITY, {
      sessionId,
      kind: "task",
      status: "running",
      label: "Task started",
    });
    try {
      const body = {
        // model: BIGIBOT_MODEL,
        parts: [{ type: "text", text }],
      };
      if (typeof options.agent === "string" && options.agent.trim()) {
        body.agent = options.agent;
      }

      const result = await client.session.prompt({
        path: { id: sessionId },
        body,
      });
      if (process.env.BIGINVIBE_CHAT_DEBUG === "true") {
        const shape = {
          hasData: !!result?.data,
          dataKeys: Object.keys(result?.data || {}),
          partsTypes: Array.isArray(result?.data?.parts)
            ? result.data.parts.map((p) => p?.type).filter(Boolean)
            : [],
          messagePartsTypes: Array.isArray(result?.data?.message?.parts)
            ? result.data.message.parts.map((p) => p?.type).filter(Boolean)
            : [],
          outputPartsTypes: Array.isArray(result?.data?.output?.parts)
            ? result.data.output.parts.map((p) => p?.type).filter(Boolean)
            : [],
        };
        bus.emitEvent(EVENTS.AGENT_MESSAGE, {
          sessionId,
          messageId: null,
          model: BIGIBOT_MODEL,
          text: `[debug] prompt result shape: ${JSON.stringify(shape)}`,
          kind: "final",
          agentMode: options.mode || "build",
        });
      }
      const active = this.activePromptBySession.get(sessionId);
      const assistantMessageId = result?.data?.info?.id || active?.assistantMessageId || null;
      if (assistantMessageId) {
        this._rememberMessageRole(sessionId, assistantMessageId, "assistant");
      }

      const visibleText = extractTextFromPromptResult(result, assistantMessageId);

      if (active?.cancelled) {
        bus.emitEvent(EVENTS.AGENT_ACTIVITY, {
          sessionId,
          kind: "task",
          status: "cancelled",
          label: "Task cancelled",
        });
        bus.emitEvent(EVENTS.AGENT_COMPLETED, { sessionId });
        return result.data;
      }

      if (visibleText) {
        const finalText = clampAssistantText(visibleText);
        bus.emitEvent(EVENTS.AGENT_MESSAGE, {
          sessionId,
          messageId: assistantMessageId,
          model: BIGIBOT_MODEL,
          text: finalText,
          kind: "final",
          agentMode: active?.mode || "build",
        });
        if (active) active.hasVisibleOutput = true;
      } else {
        if (!active?.hasVisibleOutput) {
          await this._waitForVisibleOutput(sessionId, 1400);

          if (active?.hasVisibleOutput) {
            bus.emitEvent(EVENTS.AGENT_COMPLETED, { sessionId });
            return result.data;
          }

          const unknownText = extractTextFromUnknown(result?.data);
          if (unknownText) {
            const finalText = clampAssistantText(unknownText);
            bus.emitEvent(EVENTS.AGENT_MESSAGE, {
              sessionId,
              messageId: assistantMessageId,
              model: BIGIBOT_MODEL,
              text: finalText,
              kind: "final",
              agentMode: active?.mode || "build",
            });
            if (active) active.hasVisibleOutput = true;
            bus.emitEvent(EVENTS.AGENT_COMPLETED, { sessionId });
            return result.data;
          }

          const recoveredText = await this._recoverAssistantTextFromSession(client, sessionId);
          if (recoveredText) {
            const finalText = clampAssistantText(recoveredText);
            bus.emitEvent(EVENTS.AGENT_MESSAGE, {
              sessionId,
              messageId: assistantMessageId,
              model: BIGIBOT_MODEL,
              text: finalText,
              kind: "final",
              agentMode: active?.mode || "build",
            });
            if (active) active.hasVisibleOutput = true;
          }

          if (active?.hasVisibleOutput) {
            bus.emitEvent(EVENTS.AGENT_COMPLETED, { sessionId });
            return result.data;
          }

          if (process.env.BIGINVIBE_CHAT_DEBUG === "true") {
            const debugPayload = JSON.stringify(result?.data || {});
            const clipped = debugPayload.length > 1200
              ? `${debugPayload.slice(0, 1200)}...`
              : debugPayload;
            bus.emitEvent(EVENTS.AGENT_MESSAGE, {
              sessionId,
              messageId: null,
              model: BIGIBOT_MODEL,
              text: `[debug] no visible text payload: ${clipped}`,
              kind: "final",
              agentMode: active?.mode || "build",
            });
          }
          bus.emitEvent(EVENTS.AGENT_ERROR, {
            sessionId,
            error: "Agent finished but returned no visible text response.",
            agentMode: active?.mode || "build",
          });
        }
      }

      bus.emitEvent(EVENTS.AGENT_COMPLETED, { sessionId });
      bus.emitEvent(EVENTS.AGENT_ACTIVITY, {
        sessionId,
        kind: "task",
        status: "completed",
        label: "Task completed",
      });
      return result.data;
    } catch (err) {
      if (isFetchFailure(err)) {
        bus.emitEvent(EVENTS.AGENT_ACTIVITY, {
          sessionId,
          kind: "task",
          status: "failed",
          label: "Task failed",
        });
        bus.emitEvent(EVENTS.AGENT_ERROR, {
          sessionId,
          error: `Agent request failed: ${err.message}`,
          agentMode: options.mode || "build",
        });
        bus.emitEvent(EVENTS.AGENT_COMPLETED, { sessionId });
        throw err;
      }
      bus.emitEvent(EVENTS.AGENT_ACTIVITY, {
        sessionId,
        kind: "task",
        status: "failed",
        label: "Task failed",
      });
      bus.emitEvent(EVENTS.AGENT_ERROR, {
        sessionId,
        error: `Agent could not complete the requested change: ${err.message}`,
        agentMode: options.mode || "build",
      });
      throw err;
    } finally {
      this.cancelRequestedBySession.delete(sessionId);
      setTimeout(() => {
        if (this.activePromptBySession.get(sessionId) === activeState) {
          this.activePromptBySession.delete(sessionId);
        }
      }, 4000);
    }
  }

  async _waitForVisibleOutput(sessionId, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const active = this.activePromptBySession.get(sessionId);
      if (!active || active.hasVisibleOutput) return;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  async cancelSession(sessionId) {
    if (!this.opencode) return;
    this.cancelRequestedBySession.add(sessionId);
    const active = this.activePromptBySession.get(sessionId);
    if (active) active.cancelled = true;
    try {
      await this.opencode.client.session.abort({ path: { id: sessionId } });
    } finally {
      bus.emitEvent(EVENTS.AGENT_COMPLETED, { sessionId });
    }
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
        if (active?.cancelled) break;
        if (active && info.role === "assistant" && !active.assistantMessageId) {
          active.assistantMessageId = info.id;
        }

      if (active && info.role === "assistant") {
        const text = extractTextFromMessageUpdatedProperties(properties);
        if (text) {
          bus.emitEvent(EVENTS.AGENT_ACTIVITY, {
            sessionId: info.sessionID,
            kind: "processing",
            status: "running",
            label: "Processing results...",
          });
          active.hasVisibleOutput = true;
          bus.emitEvent(EVENTS.AGENT_MESSAGE, {
            sessionId: info.sessionID,
              messageId: info.id,
              model: BIGIBOT_MODEL,
              text,
              kind: "final",
              agentMode: active.mode || "build",
            });
          }
        }
        break;
      }
      case "message.created":
      case "message.added":
      case "message.completed": {
        const sessionId = extractSessionIdFromProperties(properties);
        if (!sessionId) break;
        const active = this.activePromptBySession.get(sessionId);
        if (!active) break;
        if (active.cancelled) break;

        const role = extractRoleFromProperties(properties);
        if (role && role !== "assistant") break;

        const text = extractTextFromMessageUpdatedProperties(properties) || extractTextFromUnknown(properties);
        if (!text) break;

        bus.emitEvent(EVENTS.AGENT_ACTIVITY, {
          sessionId,
          kind: "subagent",
          status: "running",
          label: "Subagent is working...",
        });

        const messageId = extractMessageIdFromProperties(properties);
        if (messageId && !active.assistantMessageId) active.assistantMessageId = messageId;
        active.hasVisibleOutput = true;
        bus.emitEvent(EVENTS.AGENT_MESSAGE, {
          sessionId,
          messageId: messageId || active.assistantMessageId || null,
          model: BIGIBOT_MODEL,
          text,
          kind: "final",
          agentMode: active.mode || "build",
        });
        break;
      }
      case "message.part.added":
      case "message.part.updated": {
        const part = properties?.part;
        const sessionId = part?.sessionID;
        if (!part || !sessionId) break;

        const active = this.activePromptBySession.get(sessionId);
        if (!active) break;
        if (active.cancelled) break;

        const role = this._roleForMessage(sessionId, part.messageID);
        if (role && role !== "assistant") break;

        if (part?.type === "tool") {
          const evt = part.state?.status === "completed"
            ? EVENTS.AGENT_TOOL_COMPLETED
            : EVENTS.AGENT_TOOL_STARTED;
          bus.emitEvent(evt, { sessionId, tool: part.tool, state: part.state });
          const safe = safeActivityFromToolEvent(part.tool, part.state, part.state?.status === "completed" ? "completed" : "started");
          bus.emitEvent(EVENTS.AGENT_ACTIVITY, { sessionId, ...safe });
          break;
        }

        if (part?.type === "agent" || part?.type === "subtask") {
          bus.emitEvent(EVENTS.AGENT_ACTIVITY, {
            sessionId,
            kind: "subagent",
            status: "running",
            label: "Started a subagent",
          });
          break;
        }

        if (part?.type === "step-start" || part?.type === "retry") {
          bus.emitEvent(EVENTS.AGENT_ACTIVITY, {
            sessionId,
            kind: "processing",
            status: "running",
            label: "Processing results...",
          });
          break;
        }

        if (part?.type === "step-finish") {
          bus.emitEvent(EVENTS.AGENT_ACTIVITY, {
            sessionId,
            kind: "processing",
            status: "completed",
            label: "Processing step completed",
          });
          break;
        }

        const textChunk = typeof properties?.delta === "string"
          ? properties.delta
          : typeof part?.text === "string"
            ? part.text
            : "";

        if (part?.type === "text" && textChunk.length) {
          if (!active.assistantMessageId && part.messageID) {
            active.assistantMessageId = part.messageID;
          }

          if (active.assistantMessageId && part.messageID !== active.assistantMessageId) {
            break;
          }

          active.hasVisibleOutput = true;
          bus.emitEvent(EVENTS.AGENT_MESSAGE, {
            sessionId,
            messageId: part.messageID,
            // model: BIGIBOT_MODEL,
            text: textChunk,
            kind: "delta",
            agentMode: active.mode || "build",
          });
        }
        break;
      }
      case "file.edited": {
        bus.emitEvent(EVENTS.AGENT_FILE_CHANGED, { path: properties?.file });
        break;
      }
      case "session.error": {
        const sessionId = properties?.sessionID;
        const isCancellation = this.cancelRequestedBySession.has(sessionId);
        if (isCancellation) {
          this.cancelRequestedBySession.delete(sessionId);
          bus.emitEvent(EVENTS.AGENT_ACTIVITY, {
            sessionId,
            kind: "task",
            status: "cancelled",
            label: "Task cancelled",
          });
          bus.emitEvent(EVENTS.AGENT_COMPLETED, { sessionId });
          break;
        }
        bus.emitEvent(EVENTS.AGENT_ACTIVITY, {
          sessionId,
          kind: "task",
          status: "failed",
          label: "Task failed",
        });
        bus.emitEvent(EVENTS.AGENT_ERROR, {
          sessionId,
          error: properties?.error?.message || "Unknown agent error",
          agentMode: this.activePromptBySession.get(sessionId)?.mode || "build",
        });
        bus.emitEvent(EVENTS.AGENT_COMPLETED, { sessionId });
        break;
      }
      default:
        break;
    }
  }

  async _recoverAssistantTextFromSession(client, sessionId) {
    const calls = [
      () => client?.session?.messages?.list?.({ path: { id: sessionId } }),
      () => client?.session?.message?.list?.({ path: { id: sessionId } }),
      () => client?.message?.list?.({ path: { id: sessionId } }),
      () => client?.session?.get?.({ path: { id: sessionId } }),
      () => client?.session?.retrieve?.({ path: { id: sessionId } }),
    ];

    const started = Date.now();
    while (Date.now() - started < 4000) {
      for (const call of calls) {
        try {
          const result = await call();
          const data = result?.data || {};
          const messages = Array.isArray(data)
            ? data
            : Array.isArray(data.messages)
              ? data.messages
              : Array.isArray(data.items)
                ? data.items
                : [];

          if (!messages.length) continue;

          for (let i = messages.length - 1; i >= 0; i -= 1) {
            const message = messages[i];
            if (message?.role !== "assistant") continue;
            const text = extractTextFromMessage(message);
            if (text) return text;
          }
        } catch {
          // Try the next possible SDK shape.
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 180));
    }

    return "";
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

  async getCavemanStatus() {
    const proxyUrl = normalizeBaseUrl(BIGIBOT_CAVEMAN_URL);
    let configuredBaseUrl = "";
    let configError = null;

    if (BIGIBOT_CAVEMAN_ENABLED) {
      try {
        configuredBaseUrl = buildCavemanProviderBaseUrl();
      } catch (err) {
        configError = err.message;
      }
    }

    const reachable = proxyUrl ? await isHttpReachable(proxyUrl) : false;
    const effectiveBaseUrl = this.opencode?.server?.cavemanProviderBaseUrl || configuredBaseUrl || "";
    const routingActive = !!(BIGIBOT_CAVEMAN_ENABLED && effectiveBaseUrl);

    return {
      enabled: BIGIBOT_CAVEMAN_ENABLED,
      autostart: BIGIBOT_CAVEMAN_AUTOSTART,
      provider: BIGIBOT_CAVEMAN_PROVIDER,
      proxyUrl,
      mode: BIGIBOT_CAVEMAN_MODE,
      reachable,
      configuredBaseUrl,
      effectiveBaseUrl,
      routingActive,
      serverRunning: !!this.opencode,
      proxyManagedByApp: !!this.opencode?.server?.cavemanProc,
      configError,
    };
  }
}

module.exports = OpenCodeService;
