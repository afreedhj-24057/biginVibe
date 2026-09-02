const { EVENTS } = require("../../shared/events");
const bus = require("../runtimeBus");

/**
 * WorkspaceManager — the single authoritative source of truth for the
 * currently active user project and its associated runtime state.
 *
 * Every component that needs to know "which project are we working on?"
 * must go through this class. Nothing should read the active project path
 * from any other location.
 *
 * Conceptual workspace record:
 *   {
 *     projectPath,      // absolute path to the user's project — the cwd for
 *                       // OpenCode, terminal, dev server, git, file explorer
 *     projectName,      // human-readable name (from package.json or basename)
 *     opencodeSessionId,// the live OpenCode session id for this project
 *     devServer,        // { running, pid, command, cwd, startedAt }
 *     previewUrl,       // current preview URL (null when env stopped)
 *   }
 *
 * Lifecycle:
 *   openProject(projectPath)    — called by main.js when the user picks a
 *                                  folder. Sets projectPath as active workspace
 *                                  and broadcasts WORKSPACE_OPENED.
 *   switchProject(projectPath)  — atomically tears down the current workspace
 *                                  (stops env, resets OpenCode/terminal state)
 *                                  then calls openProject(). This is the ONLY
 *                                  correct way to move from one project to
 *                                  another. Prevents Project A state from
 *                                  leaking into Project B.
 *   closeProject()              — stops env, resets all state, broadcasts
 *                                  WORKSPACE_CLOSED.
 *   getActiveProject()          — returns the current project object or null.
 *                                  Use this instead of projectManager
 *                                  .getCurrentProject() everywhere in main.js.
 *   setOpenCodeSessionId(id)    — called by BigiBotService once a session is
 *                                  created so the workspace record stays in sync.
 *   updateEnvStatus(status)     — called by EnvironmentManager whenever the
 *                                  dev server / preview state changes.
 *   getSnapshot()               — returns the full workspace snapshot suitable
 *                                  for sending to the renderer.
 *
 * Security invariant:
 *   The Vibe Editor's own repository (__dirname / app source) is NEVER set as
 *   the active workspace. The active workspace is exclusively the directory
 *   the user explicitly opens through the Open Project dialog or recents list.
 */
class WorkspaceManager {
  constructor() {
    /** @type {import('../project/ProjectManager').Project | null} */
    this._project = null;

    /** @type {string | null} */
    this._opencodeSessionId = null;

    /** @type {object | null} devServer status from EnvironmentManager */
    this._devServer = null;

    /** @type {string | null} */
    this._previewUrl = null;

    // Injected in main.js after construction to avoid circular deps.
    this._environmentManager = null;
    this._bigiBot = null;
    this._terminalManager = null;
    this._projectManager = null;
  }

  /**
   * Inject service dependencies after construction. Called once in main.js.
   * @param {{ environmentManager, bigiBot, terminalManager, projectManager }} deps
   */
  injectDependencies({ environmentManager, bigiBot, terminalManager, projectManager }) {
    this._environmentManager = environmentManager;
    this._bigiBot = bigiBot;
    this._terminalManager = terminalManager;
    this._projectManager = projectManager;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Open a project as the active workspace. Does NOT tear down the previous
   * workspace first — call switchProject() if a project is already open.
   *
   * @param {string} projectPath
   * @returns {Promise<object>} the project object
   */
  async openProject(projectPath) {
    const project = await this._projectManager.openProject(projectPath);
    this._project = project;
    this._opencodeSessionId = null; // fresh project — no session yet
    this._devServer = null;
    this._previewUrl = null;
    bus.emitEvent(EVENTS.WORKSPACE_OPENED, this.getSnapshot());
    return project;
  }

  /**
   * Atomically switch from the current workspace to a new one.
   *
   * Sequence:
   *   1. Stop the running dev environment (if any).
   *   2. Shutdown the OpenCode server for the current project (if any).
   *   3. Close all terminal sessions rooted in the old project.
   *   4. Close the ProjectManager record for the old project.
   *   5. Open the new project.
   *
   * After this call, every subsequent operation (OpenCode, terminal, dev
   * server, git, file operations) is guaranteed to use the new projectPath.
   *
   * @param {string} projectPath
   * @returns {Promise<object>} the new project object
   */
  async switchProject(projectPath) {
    await this._teardownCurrentWorkspace();
    return this.openProject(projectPath);
  }

  /**
   * Close the active workspace entirely. Stops the environment, resets
   * OpenCode, clears terminal sessions, and emits WORKSPACE_CLOSED.
   */
  async closeProject() {
    await this._teardownCurrentWorkspace();
    this._projectManager.closeProject();
    bus.emitEvent(EVENTS.WORKSPACE_CLOSED, {});
  }

  /**
   * Returns the active project object, or null when no project is open.
   * This is the single place main.js (and services) should call to get the
   * current project path.
   *
   * @returns {object | null}
   */
  getActiveProject() {
    return this._project;
  }

  /**
   * Called by BigiBotService once an OpenCode session has been created for
   * the active project, so the workspace snapshot stays current.
   *
   * @param {string} sessionId
   */
  setOpenCodeSessionId(sessionId) {
    this._opencodeSessionId = sessionId;
  }

  /**
   * Called by EnvironmentManager (via IPC handlers in main.js) whenever the
   * dev server or preview URL state changes.
   *
   * @param {{ devServer: object, previewUrl: string|null }} status
   */
  updateEnvStatus({ devServer, previewUrl }) {
    if (devServer !== undefined) this._devServer = devServer;
    if (previewUrl !== undefined) this._previewUrl = previewUrl;
  }

  /**
   * Returns the full workspace snapshot.
   * The renderer receives this via workspace:current / WORKSPACE_OPENED events.
   *
   * @returns {{
   *   projectPath: string|null,
   *   projectName: string|null,
   *   opencodeSessionId: string|null,
   *   devServer: object|null,
   *   previewUrl: string|null,
   *   project: object|null
   * }}
   */
  getSnapshot() {
    return {
      projectPath: this._project?.path ?? null,
      projectName: this._project?.name ?? null,
      opencodeSessionId: this._opencodeSessionId,
      devServer: this._devServer,
      previewUrl: this._previewUrl,
      // Include the full project object so existing code that reads
      // project.isLyteProject, project.packageManager, etc. keeps working.
      project: this._project,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Stops all runtime state tied to the current workspace.
   * Safe to call even when no workspace is open.
   */
  async _teardownCurrentWorkspace() {
    // 1. Stop dev environment (dev server + redirector).
    if (this._environmentManager) {
      await this._environmentManager.stop().catch(() => {});
    }

    // 2. Shutdown the OpenCode server for this project. This also clears
    //    sessionsByProject so stale session IDs can never be reused for a
    //    different project or a reopened version of the same project.
    if (this._bigiBot) {
      await this._bigiBot.shutdown().catch(() => {});
    }

    // 3. Close terminal sessions so they are not left dangling with a cwd
    //    pointing at the old project directory.
    if (this._terminalManager) {
      this._terminalManager.closeAll();
    }

    // 4. Clear local workspace state.
    this._project = null;
    this._opencodeSessionId = null;
    this._devServer = null;
    this._previewUrl = null;
  }
}

module.exports = new WorkspaceManager();
