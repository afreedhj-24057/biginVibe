# Bigin Vibe Code Editor

A desktop Electron + Next.js IDE for opening a user-selected Bigin/Lyte or
compatible frontend project. BiginVibe provides a project-scoped terminal,
development-environment startup, embedded preview, Git status and diffs, and
OpenCode-backed BigiBot chat. The top bar and Welcome page support opening,
switching, closing, and reopening recent projects.

## Quick Start

```bash
npm install
npm run dev
```

Development starts Next.js on port `3210`, waits for it to become available,
and launches Electron. `npm install` also rebuilds the native `node-pty`
dependency for Electron.

For full fresh-machine setup, including OpenCode and provider authentication,
see `TEAM_ONBOARDING.md`.

## Runtime Architecture

```text
React renderer
  -> lib/bridge.js
  -> electron/preload.js contextBridge
  -> Electron IPC handlers in electron/main.js
  -> WorkspaceManager and service layer
```

The renderer does not access Node.js or Electron APIs directly. Runtime events
travel in the opposite direction:

```text
services/runtimeBus.js
  -> electron/main.js
  -> preload events.subscribe()
  -> renderer useRuntimeEvents()
```

| Layer | Responsibilities |
|---|---|
| `electron/` | BrowserWindow creation, IPC handlers, preload bridge, service wiring |
| `app/`, `components/`, `lib/` | Next.js renderer, UI state, bridge wrappers, and runtime-event handling |
| `services/workspace/` | Authoritative active-project and runtime workspace state |
| `services/project/` | Project detection and durable recent-project metadata |
| `services/environment/` | Development-command startup, readiness, redirector contract, and preview URL state |
| `services/terminal/` | Persistent interactive terminal sessions backed by `node-pty` |
| `services/opencode/` | OpenCode SDK integration and server lifecycle |
| `services/bigibot/` | BigiBot request handling and project context |
| `services/knowledge/` | Optional project knowledge-base lookup |
| `services/git/` | Repository status, refresh, and working-tree/cached diffs |
| `services/runtimeBus.js` | Process-wide event bus forwarded to the renderer |

## Development Flow

```text
npm run dev
  -> Next.js dev server on :3210
  -> Electron BrowserWindow
  -> renderer bridge and IPC
  -> project-scoped WorkspaceManager
  -> terminal, environment, preview, chat, and Git services
```

In development, Electron loads the Next.js development URL. In a packaged
application it loads the generated `out/index.html`. The BrowserWindow uses
`contextIsolation: true`, `nodeIntegration: false`, and the preload bridge.

## Active Workspace Lifecycle

`WorkspaceManager` is the authoritative owner of the active project and its
runtime state. The active project is identified by its filesystem `path`.

### Open

```text
ProjectControls or WelcomeScreen
  -> project:open
  -> WorkspaceManager.openProject()
  -> ProjectManager.openProject()
  -> project detection and recent-history update
  -> workspace.opened event
```

### Switch

Switching performs an orderly teardown before opening the new project:

1. Stop the development environment and redirector.
2. Shut down the project-scoped OpenCode server.
3. Close terminal sessions tied to the old project.
4. Clear workspace state and preview/session state.
5. Open the new project.

This prevents terminal, OpenCode, development-server, Git, and preview state
from crossing project boundaries.

### Close

Closing performs the same teardown and returns the renderer to the Welcome
page with no active project.

## Project Detection

A selected directory must contain a usable `package.json` or `bower.json`.
Project detection reports a project object containing fields such as:

```js
{
  supported,
  path,
  name,
  framework,
  projectType,
  isLyteProject,
  lyteSignal,
  hasKnowledgeBase,
  knowledgeBaseDir,
  packageManager,
  devScript,
  devEntryPoint,
  lyteBin,
  nodeBin,
  capabilities: {
    devServer,
    preview,
    terminal,
    opencode
  }
}
```

The selected folder basename is used as the technical project `name`. Lyte
detection checks, in order:

- Lyte-related metadata or dependencies in `bower.json`.
- An installed `bower_components/lyte` directory.
- Lyte component templates under `components/templates`.
- Lyte-related npm dependencies in `package.json`.

The project can still open as a generic project when Lyte is not detected.

Supported development entry points are:

- `lyte-cli`: `bower.json` plus `build/build.js` with the Lyte CLI available.
- `npm-script`: a `dev`, `start`, or `serve` script in `package.json`.
- `build-js`: `build/build.js` exists but the Lyte CLI is unavailable.
- `none`: no supported development command is available.

Projects with a `build-js` or `none` entry point can still be opened, but
starting their development environment reports a diagnostic error.

## Recent Projects

Recent projects are persisted by `ProjectManager` in:

```text
Electron: app.getPath("userData")/recent-projects.json
Fallback: ~/.bigin-vibe/recent-projects.json
```

Records have this shape:

```js
{
  path: "/absolute/path/to/project",
  name: "project-folder-name",
  lastOpenedAt: "2026-09-24T12:34:56.000Z",
  displayName: "Customer Portal"
}
```

`displayName` is optional. Existing records without it continue to display
the basename-derived `name`. The Welcome page loads recent records through
`project:recents`, filters out missing paths, sorts by `lastOpenedAt`, and
displays the five most recent entries.

Recent-card rename is inline and supports keyboard interaction:

- Enter or Save confirms a trimmed non-empty name.
- Escape or Cancel restores the previous value.
- Persistence errors remain visible in the existing Welcome error area.
- Renaming changes only `displayName`; it never renames the directory.
- Opening a renamed project still passes its original filesystem `path`.

## Terminal and Development Environment

The integrated terminal uses `node-pty` and xterm.js. It maintains a
persistent interactive login shell for the active project. The visible
terminal and development-environment flow use the same PTY execution surface.

`EnvironmentManager` writes the detected development command into that PTY:

- Lyte projects use `lyte serve --port <first available port from 3000..3009>`.
- npm projects use the detected `dev`, `start`, or `serve` script.
- Yarn projects use the corresponding Yarn command when `yarn.lock` exists.

Environment readiness is detected from terminal output and port availability.
Stopping sends Ctrl+C to the PTY. A watchdog detects servers that exit without
an explicit interrupt. Lyte interactive confirmation prompts are automatically
answered `Y` when detected.

## Preview

The preview uses an Electron `<webview>` with a persistent preview partition,
not an iframe. It supports project web content that depends on authentication,
cookies, redirects, CSP, or SPA navigation. The address bar is editable, and
navigation events keep it synchronized with the webview.

The preview URL comes from `EnvironmentManager` and is either:

- The detected local development-server URL.
- A URL produced by the optional `.bigin/redirector.json` contract.

The current Redirector integration can spawn a configured command and
construct a URL using project name and development-port substitutions, but it
does not implement a full Redirector readiness or health handshake.

Bigin CDN static-resource requests matching the configured Bigin URL pattern
are intercepted and rewritten to the active local development-server port.
The port is tracked dynamically and is not assumed to be `3000`. Preview
instances/bookmarks are loaded from `~/.bigin-vibe/instances.json`.

## Chat and Sessions

OpenCode is spawned with its working directory set to the active project path.
BigiBot chat therefore runs project-scoped file, search, shell, and Git work.

The current session API supports:

- Listing sessions for the active project.
- Creating, opening, and loading session messages.
- Renaming, forking, and deleting sessions.
- Cancelling the active request.
- Loading available models and selecting an agent.
- Streaming assistant text, tool activity, file changes, and errors through
  runtime events.

The main request path is:

```text
ChatPanel
  -> chat:sendMessage
  -> BigiBotService
  -> OpenCodeService
  -> opencode serve with cwd = active project path
```

## Git

The Git UI exposes read-oriented repository operations:

- Repository, branch, and dirty-state information.
- Ahead/behind tracking.
- Optional remote refresh through `git fetch --quiet`.
- Changed-file status.
- Working-tree diffs.
- Cached diffs.
- Git status-bar updates and Changes-panel refreshes.

Commit, push, staging, reset, checkout, and other mutating Git operations are
not exposed through IPC. They remain available as manual terminal operations.

## Project Knowledge Base

If `<project>/bigibot/` exists, it is reported as the project's knowledge-base
directory. The detector does not require a specific agent file or registry
file for the project to open. Knowledge-base files such as component registry
data, component Markdown documentation, patterns, and conventions may be
loaded by the project's knowledge services when available.

## Project Controls

- `Open Project`: selects a directory and sets it as the active workspace.
- `Switch Project`: tears down the current workspace and opens the selected
  project.
- `Close Project`: stops the workspace and returns to the Welcome page.
- Welcome recent cards: reopen a recent project by its filesystem path.
- Welcome rename: changes a recent card's display title without changing its
  filesystem path.

## Troubleshooting

- **Project cannot be opened**
  - Verify the selected directory contains `package.json` or `bower.json`.
  - Check the Welcome or project error message for the detection failure.

- **Development environment cannot start**
  - Confirm the project has a supported Lyte setup or a `dev`, `start`, or
    `serve` script.
  - For Lyte projects, verify the Lyte CLI is installed and available in the
    environment used to launch Electron.

- **OpenCode preflight fails**
  - Install the OpenCode CLI and verify `opencode --help` works in the same
    shell used to start BiginVibe.

## Notes and Follow-ups

- `RedirectorManager` uses a provisional command/URL contract that should be
  aligned with the real Bigin Redirector after validation against an actual
  Bigin repository.
- OpenCode prompt model selection currently depends on provider/OpenCode
  defaults and agent configuration.
- Git commit and push are intentionally not exposed; committing remains a
  manual terminal operation.
