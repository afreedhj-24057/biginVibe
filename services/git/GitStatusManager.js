const fs = require("fs");
const { EVENTS } = require("../../shared/events");
const bus = require("../runtimeBus");

const REMOTE_REFRESH_INTERVAL = 60_000;

function emptyStatus(projectPath = null) {
  return {
    projectPath,
    branch: null,
    isDirty: false,
    ahead: null,
    behind: null,
    isRepository: false,
    isRefreshing: false,
    remoteStatus: "unknown",
    error: null,
  };
}

class GitStatusManager {
  constructor({ workspaceManager, gitManager }) {
    this.workspaceManager = workspaceManager;
    this.gitManager = gitManager;
    this.projectPath = null;
    this.generation = 0;
    this.status = emptyStatus();
    this.watcher = null;
    this.watchTimer = null;
    this.remoteTimer = null;
    this.refreshPromise = null;
    this.onRuntimeEvent = this.onRuntimeEvent.bind(this);
  }

  start() {
    bus.on("runtime-event", this.onRuntimeEvent);
    this.setProject(this.workspaceManager.getActiveProject()?.path || null);
  }

  stop() {
    bus.removeListener("runtime-event", this.onRuntimeEvent);
    this.clearProjectResources();
  }

  onRuntimeEvent(evt) {
    if (evt.type === EVENTS.WORKSPACE_OPENED || evt.type === EVENTS.WORKSPACE_SWITCHED) {
      this.setProject(evt.payload?.projectPath || evt.payload?.project?.path || null);
    } else if (evt.type === EVENTS.WORKSPACE_CLOSED) {
      this.setProject(null);
    } else if (evt.type === EVENTS.AGENT_FILE_CHANGED) {
      this.scheduleLocalRefresh();
    }
  }

  setProject(projectPath) {
    if (projectPath === this.projectPath) return;
    this.clearProjectResources();
    this.projectPath = projectPath;
    this.generation += 1;
    this.status = emptyStatus(projectPath);
    this.emitStatus();
    if (!projectPath) return;

    try {
      this.watcher = fs.watch(projectPath, { recursive: true }, () => this.scheduleLocalRefresh());
    } catch {
      this.watcher = null;
    }
    this.remoteTimer = setInterval(() => this.refresh({ fetchRemote: true }).catch(() => {}), REMOTE_REFRESH_INTERVAL);
    this.refresh({ fetchRemote: true }).catch(() => {});
  }

  clearProjectResources() {
    this.generation += 1;
    if (this.watcher) this.watcher.close();
    this.watcher = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    if (this.remoteTimer) clearInterval(this.remoteTimer);
    this.remoteTimer = null;
    this.refreshPromise = null;
  }

  scheduleLocalRefresh() {
    if (!this.projectPath || this.watchTimer) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      this.refresh().catch(() => {});
    }, 250);
  }

  async refresh({ fetchRemote = false } = {}) {
    const projectPath = this.workspaceManager.getActiveProject()?.path || null;
    if (!projectPath || projectPath !== this.projectPath) {
      this.setProject(projectPath);
      return this.status;
    }
    if (this.refreshPromise) return this.refreshPromise;

    const generation = this.generation;
    this.status = { ...this.status, projectPath, isRefreshing: true, error: null };
    this.emitStatus();
    const refreshPromise = this.gitManager.getStatus(projectPath, { fetchRemote })
      .then((result) => {
        if (generation !== this.generation || this.workspaceManager.getActiveProject()?.path !== projectPath) return this.status;
        this.status = { ...result, projectPath, isRefreshing: false, error: null };
        this.emitStatus();
        return this.status;
      })
      .catch((err) => {
        if (generation !== this.generation || this.workspaceManager.getActiveProject()?.path !== projectPath) return this.status;
        if (!fetchRemote) {
          this.status = {
            ...this.status,
            projectPath,
            isRefreshing: false,
            error: err?.message || String(err),
          };
          this.emitStatus();
          return this.status;
        }
        return this.gitManager.getStatus(projectPath)
          .then((local) => {
            if (generation !== this.generation || this.workspaceManager.getActiveProject()?.path !== projectPath) return this.status;
            this.status = {
              ...local,
              projectPath,
              isRefreshing: false,
              remoteStatus: "stale",
              error: err?.message || String(err),
            };
            this.emitStatus();
            return this.status;
          })
          .catch(() => {
            this.status = {
              ...this.status,
              projectPath,
              isRefreshing: false,
              remoteStatus: "stale",
              error: err?.message || String(err),
            };
            this.emitStatus();
            return this.status;
          });
      })
      .finally(() => {
        if (this.refreshPromise === refreshPromise) this.refreshPromise = null;
      });
    this.refreshPromise = refreshPromise;
    return refreshPromise;
  }

  emitStatus() {
    bus.emitEvent(EVENTS.GIT_STATUS, this.status);
  }

  getStatus() {
    return this.status;
  }
}

module.exports = GitStatusManager;
