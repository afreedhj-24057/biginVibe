const OpenCodeService = require("../opencode/OpenCodeService");
const ComponentKnowledgeService = require("../knowledge/ComponentKnowledgeService");
const { BIGIBOT_AGENT, BIGIBOT_FALLBACK_MODE } = require("../../shared/opencodeConfig");
const {
  validateBigiBotProjectConfig,
  buildBigiBotConfigError,
} = require("./BigiBotProjectConfig");

const SYSTEM_PRIMER = `You are BigiBot, the coding agent for the Bigin frontend team.

Rules you must always follow:
- This is a Bigin application built on the Lyte framework. Do not assume
  generic React/Vue/Angular idioms apply.
- Never invent Bigin/Lyte component APIs. If you are not certain a prop,
  event, or component exists, search the repository first.
- Prefer reusing existing Bigin UX components over writing new ones.
- Follow the existing repository conventions and file structure.
- Make the minimal change necessary to satisfy the request. Preserve
  existing behavior that wasn't part of the request.
- After making changes, verify them (re-read the modified files / run
  relevant checks) before reporting completion.
- Keep responses concise by default.
- Prefer short answers (3-6 bullets max) unless the user explicitly asks
  for deep detail.
- For catalog/list requests, return a compact sample and ask whether to
  expand, instead of dumping long inventories.`;

/**
 * Returns the workspace-context block that is prepended to every user
 * request sent to OpenCode.
 *
 * This is DEFENSE-IN-DEPTH only. The primary enforcement is at the process
 * level: `opencode serve` is spawned with cwd = project.path, so all of
 * its tools (bash, file, search, git) are already rooted there. The prompt
 * block makes the constraint visible to the model so it does not accidentally
 * navigate outside the project using relative paths.
 *
 * @param {object} project
 * @returns {string}
 */
function buildWorkspaceContext(project) {
  return `ACTIVE PROJECT: ${project.path}
PROJECT NAME: ${project.name}

IMPORTANT WORKSPACE RULE:
All repository investigation, file reads, file writes, bash commands, and
code changes MUST be performed inside the ACTIVE PROJECT directory above.

Do NOT inspect or modify any other directory, including the Bigin Vibe Editor
application's own source repository. If a tool or command would operate
outside the ACTIVE PROJECT, do not use it — ask the user to clarify instead.`;
}

/**
 * The Bigin-specific coding agent. Wraps OpenCodeService (generic agent
 * runtime) with:
 *   - a persistent, per-project session
 *   - Bigin/Lyte system priming
 *   - targeted component-knowledge retrieval, injected only for the
 *     component(s) relevant to the current request (never the full KB)
 */
class BigiBotService {
  constructor() {
    this.opencode = new OpenCodeService();
    this.knowledgeByProject = new Map(); // projectPath -> ComponentKnowledgeService
    this.primedProjects = new Set();
  }

  _knowledgeFor(project) {
    if (!this.knowledgeByProject.has(project.path)) {
      this.knowledgeByProject.set(
        project.path,
        new ComponentKnowledgeService(project.knowledgeBaseDir)
      );
    }
    return this.knowledgeByProject.get(project.path);
  }

  _resolveAgentForProject(project) {
    const validation = validateBigiBotProjectConfig(project.path);
    const missingAgent = validation.missing.some((m) => m.type === "agent");

    if (missingAgent) {
      if (!BIGIBOT_FALLBACK_MODE) {
        throw new Error(buildBigiBotConfigError(validation));
      }
      return null;
    }

    return BIGIBOT_AGENT;
  }

  async ensureSession(project, options = {}) {
    const mode = this._normalizeMode(options.mode);
    const agent = mode === "bigibot" ? this._resolveAgentForProject(project) : null;
    let sessionId = this.opencode.getSessionId(project);
    if (!sessionId) {
      const session = await this.opencode.createSession(project);
      sessionId = session.id;
    }
    if (mode === "bigibot" && !this.primedProjects.has(project.path)) {
      // noReply priming: gives the model its Bigin-specific instructions as
      // context without triggering a visible assistant turn.
      // Access the SDK client through the OpenCodeService's public opencode property.
      const client = this.opencode.opencode?.client;
      if (client) {
        const body = {
          noReply: true,
          parts: [{ type: "text", text: SYSTEM_PRIMER }],
        };
        if (agent) body.agent = agent;
        await client.session.prompt({ path: { id: sessionId }, body });
      }
      this.primedProjects.add(project.path);
    }
    return sessionId;
  }

  _normalizeMode(mode) {
    return mode === "bigibot" ? "bigibot" : "build";
  }

  _assertBigiBotModeAllowed(project) {
    if (!project?.hasBigiBotAgent) {
      throw new Error("BigiBot agent is not available for this project.");
    }
    const validation = validateBigiBotProjectConfig(project.path);
    if (!validation.ok) {
      throw new Error(buildBigiBotConfigError(validation));
    }
  }

  async _sendWithRetry(project, sessionId, prompt, options) {
    try {
      return await this.opencode.sendPrompt(sessionId, prompt, options);
    } catch (err) {
      const message = String(err?.message || err || "");
      const isFetchFailure = /fetch failed|ECONNREFUSED|socket hang up|network error/i.test(message);
      if (!isFetchFailure) throw err;

      await this.opencode.shutdown().catch(() => {});
      const refreshedSessionId = await this.ensureSession(project, { mode: options.mode });
      return this.opencode.sendPrompt(refreshedSessionId, prompt, options);
    }
  }

  async sendRequest(project, userRequest, options = {}) {
    const mode = this._normalizeMode(options.mode);
    if (mode === "bigibot") this._assertBigiBotModeAllowed(project);

    const agent = mode === "bigibot" ? this._resolveAgentForProject(project) : null;
    const sessionId = await this.ensureSession(project, { mode });
    const context = mode === "bigibot"
      ? this._knowledgeFor(project).buildContextForRequest(userRequest)
      : null;

    // Build the prompt in layers:
    //   1. Workspace context header (defense-in-depth path scoping)
    //   2. User's actual request
    //   3. Relevant Bigin/Lyte component knowledge (when matched)
    const workspaceHeader = buildWorkspaceContext(project);

    let prompt = `${workspaceHeader}\n\n---\n\n${userRequest}`;
    if (context) {
      prompt += `\n\n---\nRelevant Bigin/Lyte reference material (use only if applicable, verify against actual source before relying on it):\n\n${context}`;
    }

    return this._sendWithRetry(project, sessionId, prompt, { agent, mode });
  }

  async cancel(project) {
    const sessionId = this.opencode.getSessionId(project);
    if (sessionId) await this.opencode.cancelSession(sessionId);
  }

  async shutdown() {
    await this.opencode.shutdown();
    // Clear priming state so the new session created after a project switch
    // (or a reopen of the same project) always receives the Bigin system
    // primer. Without this, the primer is skipped for any project that was
    // previously primed in the same app session.
    this.primedProjects.clear();
  }

  async getCavemanStatus() {
    return this.opencode.getCavemanStatus();
  }
}

module.exports = BigiBotService;
