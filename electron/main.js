const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");

const projectManager = require("../services/project/ProjectManager");
const workspaceManager = require("../services/workspace/WorkspaceManager");
const EnvironmentManager = require("../services/environment/EnvironmentManager");
const TerminalManager = require("../services/terminal/TerminalManager");
const GitManager = require("../services/git/GitManager");
const BigiBotService = require("../services/bigibot/BigiBotService");
const runtimeBus = require("../services/runtimeBus");
const { configurePreviewClientCertificatePolicy } = require("../services/preview/PreviewClientCertificatePolicy");

const isDev = !app.isPackaged;
const NEXT_DEV_URL = "http://localhost:3210";

let mainWindow = null;
const terminalManager = new TerminalManager();
// EnvironmentManager runs the dev server INSIDE the integrated Terminal's
// PTY session (see EnvironmentManager's top-of-file comment) — it needs
// terminalManager constructed first so it can be injected here.
const environmentManager = new EnvironmentManager({ terminalManager });
const gitManager = new GitManager();
const bigiBot = new BigiBotService();

// Wire WorkspaceManager with all service dependencies. This is done once,
// here, so WorkspaceManager is the single place that orchestrates teardown
// and setup when the active project changes.
workspaceManager.injectDependencies({
  environmentManager,
  bigiBot,
  terminalManager,
  projectManager,
});

// Keep the workspace snapshot's env state in sync whenever EnvironmentManager
// emits environment lifecycle events. This lets workspace:current always
// return an up-to-date snapshot without polling.
runtimeBus.on("runtime-event", (evt) => {
  if (evt.type === "environment.started") {
    workspaceManager.updateEnvStatus({
      devServer: environmentManager.getStatus().devServer,
      previewUrl: evt.payload.previewUrl,
    });
  } else if (evt.type === "environment.stopped") {
    workspaceManager.updateEnvStatus({ devServer: { running: false }, previewUrl: null });
  } else if (evt.type === "environment.error") {
    workspaceManager.updateEnvStatus({ devServer: environmentManager.getStatus().devServer });
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Bigin Vibe Code Editor",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The preview webview needs to render a full, independent Bigin app
      // (auth, cookies, redirects, CSP) which an <iframe> cannot reliably do.
      webviewTag: true,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL(NEXT_DEV_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../out/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Forward every runtime event straight to the renderer over one channel.
runtimeBus.on("runtime-event", (evt) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("runtime-event", evt);
  }
});

app.whenReady().then(() => {
  // Client-certificate (mutual TLS) selection for the embedded preview
  // browser's own partition ONLY (internal Bigin LocalZoho environments)
  // — see PreviewClientCertificatePolicy.js for the full rationale,
  // scoping guarantees, and why an earlier server-certificate-trust
  // module (setCertificateVerifyProc-based) was removed after it was
  // found to cause intermittent load failures on unrelated public sites.
  configurePreviewClientCertificatePolicy();

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  await environmentManager.stop().catch(() => {});
  terminalManager.closeAll();
  await bigiBot.shutdown().catch(() => {});
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  await environmentManager.stop().catch(() => {});
  terminalManager.closeAll();
  await bigiBot.shutdown().catch(() => {});
});

// ---------------------------------------------------------------------------
// IPC: Workspace (authoritative active-project state)
// ---------------------------------------------------------------------------

/**
 * Returns the full workspace snapshot:
 *   { projectPath, projectName, opencodeSessionId, devServer, previewUrl, project }
 *
 * The renderer should call this instead of (or in addition to) project:current
 * to get the unified workspace state.
 */
ipcMain.handle("workspace:current", () => workspaceManager.getSnapshot());

// ---------------------------------------------------------------------------
// IPC: Project
// ---------------------------------------------------------------------------
ipcMain.handle("project:pickDirectory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

/**
 * Open a project as the active workspace.
 *
 * If a project is already open this performs a full atomic switch:
 *   stop environment → shutdown OpenCode → close terminals → open new project.
 *
 * The Vibe Editor's own repository is NEVER used as the working directory;
 * the projectPath here is exclusively the directory the user chose.
 */
ipcMain.handle("project:open", async (_evt, projectPath) => {
  const current = workspaceManager.getActiveProject();
  if (current) {
    // Atomic switch — tears down old workspace before activating the new one.
    return workspaceManager.switchProject(projectPath);
  }
  return workspaceManager.openProject(projectPath);
});

/**
 * Explicitly switch to a different project. Equivalent to project:open when
 * a project is already active, but named distinctly so callers can express
 * intent and the UI can show appropriate progress indicators.
 */
ipcMain.handle("project:switch", async (_evt, projectPath) => {
  return workspaceManager.switchProject(projectPath);
});

ipcMain.handle("project:close", async () => {
  await workspaceManager.closeProject();
  return true;
});

ipcMain.handle("project:current", () => workspaceManager.getActiveProject());
ipcMain.handle("project:recents", () => projectManager.getRecentProjects());

// ---------------------------------------------------------------------------
// IPC: Environment (dev server + redirector + preview URL)
//
// The dev server itself runs inside the integrated Terminal's PTY session
// (see EnvironmentManager) — there is no separate process/log stream to
// expose here. Its output is delivered to the renderer via the same
// terminal:output events the Terminal panel already consumes, and its PTY
// size is kept correct by the Terminal panel's own resize handling.
// ---------------------------------------------------------------------------
ipcMain.handle("environment:start", async () => {
  const project = workspaceManager.getActiveProject();
  if (!project) throw new Error("No project is open.");
  return environmentManager.start(project);
});

ipcMain.handle("environment:stop", async () => environmentManager.stop());
ipcMain.handle("environment:restart", async () => {
  const project = workspaceManager.getActiveProject();
  return environmentManager.restart(project);
});
ipcMain.handle("environment:status", () => environmentManager.getStatus());

// ---------------------------------------------------------------------------
// IPC: Terminal (human)
//
// The terminal's cwd is always workspaceManager.getActiveProject().path.
// This is enforced here at the IPC layer — TerminalManager only receives
// an already-validated project path and never falls back to the editor repo.
// ---------------------------------------------------------------------------
ipcMain.handle("terminal:create", (_evt, cols, rows) => {
  const project = workspaceManager.getActiveProject();
  if (!project) throw new Error("No project is open.");
  // ensureSession (not createSession): reuses the primary session for this
  // project if one already exists — e.g. because "Start Dev Server" already
  // created it — so the Terminal panel always attaches to the same PTY,
  // never a second hidden one.
  return terminalManager.ensureSession({ cwd: project.path, cols, rows });
});
ipcMain.handle("terminal:write", (_evt, sessionId, input) =>
  terminalManager.write(sessionId, input)
);
ipcMain.handle("terminal:resize", (_evt, sessionId, cols, rows) =>
  terminalManager.resize(sessionId, cols, rows)
);
ipcMain.handle("terminal:stop", (_evt, sessionId) => terminalManager.stop(sessionId));
ipcMain.handle("terminal:list", () => terminalManager.listSessions());

// ---------------------------------------------------------------------------
// IPC: BigiBot / OpenCode chat
//
// The OpenCode server is always rooted at workspaceManager.getActiveProject()
// .path (see OpenCodeService._ensureServerForProject). The renderer cannot
// influence the working directory — it only sends the natural-language text.
// ---------------------------------------------------------------------------
ipcMain.handle("chat:sendMessage", async (_evt, text) => {
  const project = workspaceManager.getActiveProject();
  if (!project) {
    throw new Error(
      "No project is currently open.\n\nOpen a project before asking BigiBot to modify code."
    );
  }
  const result = await bigiBot.sendRequest(project, text);
  // Update the workspace snapshot with the live session id so workspace:current
  // always reflects the currently active OpenCode session.
  const sessionId = bigiBot.opencode.getSessionId(project);
  if (sessionId) workspaceManager.setOpenCodeSessionId(sessionId);
  return result;
});
ipcMain.handle("chat:cancel", async () => {
  const project = workspaceManager.getActiveProject();
  if (project) await bigiBot.cancel(project);
});

// ---------------------------------------------------------------------------
// IPC: Git / Changes
// ---------------------------------------------------------------------------
ipcMain.handle("git:status", async () => {
  const project = workspaceManager.getActiveProject();
  if (!project) return [];
  return gitManager.status(project.path);
});
ipcMain.handle("git:diff", async (_evt, filePath) => {
  const project = workspaceManager.getActiveProject();
  if (!project) return "";
  return gitManager.diff(project.path, filePath);
});
