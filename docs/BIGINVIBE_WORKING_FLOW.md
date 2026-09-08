# BiginVibe Working Flow (Current Implementation)

This document describes the code as it exists today.

## PM Overview

```mermaid
flowchart TD
  U[User opens/switches folder] --> W[Workspace set to active project path]
  W --> T[Terminal + Dev Server run in that workspace]
  T --> P[Preview loads app URL]
  P --> N[CDN static requests intercepted to localhost active port]
  W --> C[Chat -> BigiBot -> OpenCode]
  C --> O[Agent tools read/write files in active workspace]
  O --> G[Git changes refresh in Changes panel]
  C --> V[Caveman optional proxy for provider routing]
```

| Topic | Current behavior |
|---|---|
| Folder import | Top bar `Open Project`/`Switch Project` selects directory and sets active workspace via `WorkspaceManager`. |
| Workspace scope | Active workspace path is propagated to terminal, dev server, OpenCode agent, and Git operations. |
| Port allocation | Lyte dev server uses first free port in `3000..3009` (`lyte serve --port <n>`). |
| Network interception | Preview intercepts CDN `static.localzohocdn.com/.../biginclient/...` and rewrites to `http://localhost:<active-port>/...`. |
| OpenCode flow | Chat -> BigiBot -> OpenCode SDK client -> local `opencode serve` process rooted at project `cwd`. |
| Caveman flow | Optional provider proxy routing; enabled by env/script (`npm run dev:caveman`), visible as chat status ON/OFF. |
| File editing | Agent tool edits emit events; UI refreshes Changes panel from Git status/diff. |
| SSL for LocalZoho | Preview uses scoped client-certificate selection (`select-client-certificate`) for approved LocalZoho hosts and preview partition only. |

## 1) Architecture

```mermaid
flowchart TD
  subgraph Renderer[Renderer (Next.js)]
    P[app/page.js]
    C1[components/ProjectControls]
    C2[components/Chat]
    C3[components/Terminal]
    C4[components/Preview]
    C5[components/Changes]
  end

  subgraph Bridge[Preload/Bridge]
    PR[electron/preload.js]
    BR[lib/bridge.js]
  end

  subgraph Main[Electron Main]
    M[electron/main.js]
    RB[services/runtimeBus.js]
  end

  subgraph Services[Services]
    WS[WorkspaceManager]
    PM[ProjectManager]
    TB[TerminalManager]
    EM[EnvironmentManager]
    BB[BigiBotService]
    OC[OpenCodeService]
    GM[GitManager]
    RM[RedirectorManager]
  end

  subgraph External[External Process]
    OP[opencode serve]
    CV[caveman start/proxy]
    PTY[node-pty shell]
    GIT[git CLI]
  end

  subgraph Preview[Preview]
    WV[Renderer webview partition=persist:bigin-preview]
    CCP[PreviewClientCertificatePolicy]
    SRI[PreviewStaticResourceInterceptor]
  end

  P --> BR --> PR --> M
  M --> WS
  M --> PM
  M --> TB
  M --> EM
  M --> BB
  M --> GM
  EM --> RM
  TB --> PTY
  OC --> OP
  OC --> CV
  GM --> GIT
  C4 --> WV
  M --> CCP
  M --> SRI
  RB --> M --> P
```

| Layer | Actual files | Notes |
|---|---|---|
| Renderer | `app/page.js`, `components/*` | UI + state, no direct Node API |
| Preload/Bridge | `electron/preload.js`, `lib/bridge.js` | `window.biginVibe` API surface |
| Main | `electron/main.js` | IPC handlers + service wiring |
| Services | `services/*` | Project/workspace/terminal/env/chat/git/preview policies |
| External | `opencode`, `caveman`, `node-pty`, `git` | Spawned by services |

## 2) Startup & Workspace

### Application startup

```mermaid
flowchart TD
  subgraph Main[Electron Main]
    A[app.whenReady]
    B[configurePreviewClientCertificatePolicy]
    C[configurePreviewStaticResourceInterceptor]
    D[createWindow BrowserWindow]
    E[register IPC handlers]
  end
  A --> B --> C --> D --> E
```

- `electron/main.js` constructs singleton services (`TerminalManager`, `EnvironmentManager`, `GitManager`, `BigiBotService`) and injects dependencies into `WorkspaceManager`.
- Runtime events are forwarded on a single channel: `runtime-event` (`services/runtimeBus.js` -> `electron/main.js` -> renderer subscription).

### Open project

```mermaid
flowchart TD
  subgraph Renderer
    R1[ProjectControls handleOpen/handleSwitch]
  end
  subgraph Bridge
    B1[bridge.project.open/switch]
  end
  subgraph Main
    M1[ipc project:open / project:switch]
    M2[WorkspaceManager openProject/switchProject]
    M3[ProjectManager openProject]
  end
  subgraph Filesystem
    F1[detect package.json/bower/build files]
    F2[read/write recents file]
  end
  R1 --> B1 --> M1 --> M2 --> M3 --> F1
  M3 --> F2
```

- `WorkspaceManager` is the authoritative owner of active workspace state (`_project`, `_opencodeSessionId`, `_devServer`, `_previewUrl`) in `services/workspace/WorkspaceManager.js`.
- There is no variable literally named `activeProjectPath`; active path is stored as `this._project.path` and exposed as `snapshot.projectPath`.
- `project:open` switches atomically when a project already exists.

### Active workspace propagation

```mermaid
flowchart TD
  subgraph Main
    WS[WorkspaceManager _project.path]
  end
  subgraph Services
    TM[TerminalManager ensureSession cwd=project.path]
    EM[EnvironmentManager start project.path]
    OC[OpenCodeService spawn opencode cwd=project.path]
    GM[GitManager status/diff cwd=project.path]
    KB[ComponentKnowledgeService dir=<project>/bigibot]
  end
  subgraph Preview
    PRV[PreviewPanel projectPath + previewUrl]
  end
  WS --> TM
  WS --> EM
  WS --> OC
  WS --> GM
  WS --> KB
  WS --> PRV
```

Workspace isolation status:
- Strong: Terminal (`terminal:create`), OpenCode server spawn (`cwd: project.path`), Git (`cwd` from active project), environment command execution (`ensureSession` with project cwd).
- Gap: `WORKSPACE_SWITCHED` event constant exists but is never emitted; UI still handles it in `app/page.js`.
- Gap: No file explorer implementation exists in current repo (only mentions in comments/docs).

## 3) BigiBot/OpenCode

### Chat -> BigiBot -> OpenCode

```mermaid
flowchart TD
  subgraph Renderer
    R1[ChatPanel handleSubmit]
  end
  subgraph Bridge
    B1[bridge.chat.sendMessage]
  end
  subgraph Main
    M1[ipc chat:sendMessage]
  end
  subgraph Services
    S1[BigiBotService sendRequest]
    S2[OpenCodeService sendPrompt]
  end
  subgraph OpenCode
    O1[opencode SDK client.session.prompt]
    O2[opencode server + tools]
  end
  R1 --> B1 --> M1 --> S1 --> S2 --> O1 --> O2
```

- Entry point: `chat:sendMessage` in `electron/main.js`.
- `BigiBotService.sendRequest()` composes prompt layers: workspace header + user request + optional matched KB context.
- Session handling: `BigiBotService.ensureSession()` and `OpenCodeService.createSession()`.
- OpenCode server lifecycle is per active project, spawned by `OpenCodeService._ensureServerForProject()`.

### Agent/subagent loop and event handling

```mermaid
flowchart TD
  subgraph OpenCode
    E1[event.subscribe stream]
    E2[message.updated / message.part.* / session.error / file.edited]
  end
  subgraph Services
    FWD[OpenCodeService _forwardServerEvent]
    BUS[runtimeBus emit agent.*]
  end
  subgraph Renderer
    UI[app/page.js useRuntimeEvents]
    CHAT[ChatPanel + message/activity state]
    CHG[Changes refresh token]
  end
  E1 --> E2 --> FWD --> BUS --> UI
  UI --> CHAT
  UI --> CHG
```

Actual event mapping highlights (`services/opencode/OpenCodeService.js`):
- `message.part.*` with `part.type === "tool"` -> `agent.tool.started/completed` + `agent.activity` labels.
- `part.type === "text"` -> `agent.message` delta stream.
- `message.updated`/`message.created`/`message.completed` assistant text -> `agent.message` final.
- `file.edited` -> `agent.file.changed`.
- `session.error` -> `agent.activity failed`, `agent.error`, `agent.completed`.
- Prompt-level fallback paths attempt text extraction from multiple payload shapes and list APIs.

## 4) Terminal & Dev Server

### Terminal/PTY lifecycle

```mermaid
flowchart TD
  subgraph Renderer
    T1[TerminalPanel mount]
    T2[xterm onData]
    T3[bridge.terminal.create/write/resize/stop]
  end
  subgraph Main
    I1[ipc terminal:*]
  end
  subgraph Services
    TM[TerminalManager createSession/ensureSession]
  end
  subgraph ExternalProcess[External Process]
    PTY[node-pty shell -l]
  end
  T1 --> T3 --> I1 --> TM --> PTY
  T2 --> T3 --> I1 --> TM --> PTY
  PTY --> TM
```

- `TerminalManager` uses `node-pty` with login shell (`$SHELL` or `/bin/zsh`, args `-l`).
- Output: `onData` -> `terminal.output`; exit: `onExit` -> `terminal.exit`.
- Input: all raw bytes pass via `write()`; Ctrl+C (`\x03`) also emits `terminal.interrupt`.
- Resize path: renderer fit -> `terminal:resize` -> `pty.resize`.

### Start Dev Server flow

```mermaid
flowchart TD
  subgraph Renderer
    R[bridge.environment.start]
  end
  subgraph Main
    M[ipc environment:start]
  end
  subgraph Services
    E1[EnvironmentManager start]
    E2[_resolveDevCommand]
    E3[TerminalManager ensureSession]
    E4[write command + wait URL]
    E5[RedirectorManager start]
  end
  subgraph ExternalProcess
    P1[PTY shell command execution]
  end
  R --> M --> E1 --> E2 --> E3 --> E4 --> P1
  E4 --> E5
```

Current behavior details:
- Environment command is executed by typing into the same terminal session (`TerminalManager.write(sessionId, command + "\r")`).
- For Lyte projects: `_resolveDevCommand()` returns `<lyteBin or lyte> serve --port <first free 3000..3009>`.
- There is no renderer control currently calling `bridge.environment.start/stop/restart`; IPC and service exist, but no visible Start/Stop button in current components.

### Dev Server failure flow

```mermaid
flowchart TD
  subgraph Services
    A[EnvironmentManager start]
    B[command resolution failure]
    C[timeout/no URL]
    D[port unreachable fallback check fails]
    E[watchdog detects server died]
  end
  A --> B
  A --> C
  C --> D
  A --> E
```

Failure handling:
- Command resolution errors (`build-js`, `none`, ports exhausted) emit `environment.error` and throw.
- If URL is not detected for Lyte, it verifies `detectedPort` is listening; otherwise sends Ctrl+C and errors.
- Runtime watchdog polls serving port every 3s; if dead, marks environment stopped.

## 5) Preview

### Preview navigation lifecycle

```mermaid
flowchart TD
  subgraph Renderer
    P1[PreviewPanel loadedUrl/addressValue]
    P2[webview events did-navigate*]
    P3[back/forward/reload/loadURL]
  end
  subgraph Preview
    WV[webview partition persist:bigin-preview]
  end
  P1 --> WV --> P2 --> P1
  P3 --> WV
```

- Actual preview surface is renderer `<webview>` (`components/Preview/PreviewPanel.js`), not `BrowserView` or `WebContentsView`.
- BrowserWindow enables `webviewTag: true` in `electron/main.js`.
- Address bar is editable; Enter calls `webview.loadURL(target)` directly.

### URL editing flow

```mermaid
flowchart TD
  subgraph Renderer
    U1[input addressValue]
    U2[Enter -> handleAddressSubmit]
    U3[webview.loadURL]
    U4[did-navigate updates addressValue]
  end
  U1 --> U2 --> U3 --> U4
```

- `previewGeneration` from `app/page.js` resets preview URL only on real environment restart/start events.
- Manual URL edits persist across unrelated rerenders.

### LocalZoho SSL/client-certificate flow

```mermaid
flowchart TD
  subgraph Main
    C1[configurePreviewClientCertificatePolicy]
  end
  subgraph Preview
    W1[webview request from persist:bigin-preview]
  end
  subgraph ElectronMainEvent
    E1[app select-client-certificate]
  end
  C1 --> E1
  W1 --> E1
```

- `PreviewClientCertificatePolicy` handles `app.on("select-client-certificate")`.
- Scope checks: preview partition + host allowlist (`APPROVED_PREVIEW_HOSTS`) from `services/preview/PreviewSecurityConstants.js`.
- Current selection strategy: chooses first certificate from provided list.

Obsolete/duplicate SSL workaround status:
- No active `setCertificateVerifyProc()` module in codebase.
- Comments document a prior removed approach; current active SSL-related code is client-certificate selection plus static-resource interception.

## 6) Filesystem & Git

### File modification propagation

```mermaid
flowchart TD
  subgraph OpenCode
    O[file.edited event]
  end
  subgraph Services
    S[OpenCodeService -> agent.file.changed]
    B[runtimeBus]
  end
  subgraph Renderer
    R[app/page.js increments changesRefreshToken]
    C[ChangesPanel reloads git status]
  end
  O --> S --> B --> R --> C
```

- There is no in-app file explorer read/write implementation in current renderer/components.
- Filesystem interactions currently occur in services for project detection, recents, instance list file, BigiBot KB reads, environment lock cleanup.

### Git flow (read-only)

```mermaid
flowchart TD
  subgraph Renderer
    G1[ChangesPanel bridge.git.status/diff]
  end
  subgraph Main
    G2[ipc git:status / git:diff]
  end
  subgraph Services
    G3[GitManager run git in cwd=active project]
  end
  subgraph ExternalProcess
    G4[git CLI]
  end
  G1 --> G2 --> G3 --> G4
```

- `GitManager` executes `git status --porcelain=v1` and `git diff` in active project cwd.
- No commit/push APIs are exposed.

## 7) IPC Communication

```mermaid
flowchart TD
  subgraph Renderer
    R[bridge.* calls]
    E[bridge.events.subscribe]
  end
  subgraph Preload/Bridge
    P[electron/preload.js]
  end
  subgraph ElectronMain
    M[ipcMain.handle + runtime-event forward]
  end
  subgraph Services
    S[runtimeBus emitEvent]
  end
  R --> P --> M
  S --> M --> P --> E
```

Primary IPC channels in `electron/main.js`:
- Workspace: `workspace:current`
- Project: `project:pickDirectory`, `project:open`, `project:switch`, `project:close`, `project:current`, `project:recents`
- Environment: `environment:start`, `environment:stop`, `environment:restart`, `environment:status`
- Terminal: `terminal:create`, `terminal:write`, `terminal:resize`, `terminal:stop`, `terminal:list`
- Chat: `chat:sendMessage`, `chat:cancel`, `chat:model`, `chat:cavemanStatus`
- Preview: `preview:instances`
- Git: `git:status`, `git:diff`

## Workspace switching

```mermaid
flowchart TD
  subgraph Renderer
    R[ProjectControls handleSwitch]
  end
  subgraph Main
    M[ipc project:switch]
  end
  subgraph Services
    W1[WorkspaceManager switchProject]
    W2[_teardownCurrentWorkspace]
    E[EnvironmentManager.stop]
    B[BigiBotService.shutdown]
    T[TerminalManager.closeAll]
    W3[openProject(newPath)]
  end
  R --> M --> W1 --> W2
  W2 --> E
  W2 --> B
  W2 --> T
  W2 --> W3
```

- Teardown order is explicit in `WorkspaceManager._teardownCurrentWorkspace()`.
- `WorkspaceManager` does not emit `workspace.switched`; current code emits `workspace.opened` for the new workspace.

## Complete end-to-end workflow

```mermaid
flowchart TD
  subgraph Renderer
    A1[Open/Switch project]
    A2[Terminal session visible]
    A3[Preview webview]
    A4[Send chat request]
    A5[Changes panel refresh]
  end
  subgraph Main
    M1[Project + workspace IPC]
    M2[Terminal/Environment IPC]
    M3[Chat IPC]
    M4[Runtime event forward]
  end
  subgraph Services
    S1[WorkspaceManager]
    S2[TerminalManager]
    S3[EnvironmentManager + RedirectorManager]
    S4[BigiBotService + OpenCodeService]
    S5[GitManager]
  end
  subgraph OpenCode
    O1[opencode serve + tool loop]
  end
  subgraph Preview
    P1[webview load + nav]
  end
  A1 --> M1 --> S1
  S1 --> S2
  A2 --> M2 --> S2
  M2 --> S3 --> S2
  S3 --> P1
  A3 --> P1
  A4 --> M3 --> S4 --> O1
  O1 --> S4 --> M4 --> A5
  A5 --> S5
```

End-to-end notes:
- Open project sets active workspace in `WorkspaceManager`.
- Terminal is the execution surface for both user commands and environment start commands.
- Preview URL is derived by `EnvironmentManager` + `RedirectorManager` and loaded into renderer webview.
- Chat triggers BigiBot/OpenCode; tool/file events propagate back to UI via runtime bus.

---

## Current Architecture Summary

- One-window Electron app with Next.js renderer.
- Single IPC boundary via preload-exposed `window.biginVibe`.
- Workspace authority centralized in `WorkspaceManager`.
- AI path: `ChatPanel` -> `chat:sendMessage` -> `BigiBotService` -> `OpenCodeService` -> spawned `opencode serve`.
- Terminal path uses `node-pty`; environment start composes with same PTY session.
- Preview uses renderer `<webview>` partition with scoped client-cert policy and static resource interceptor.

## State Ownership

| State | Owner | File |
|---|---|---|
| Active project/workspace snapshot | `WorkspaceManager` | `services/workspace/WorkspaceManager.js` |
| Terminal sessions + primary session id | `TerminalManager` | `services/terminal/TerminalManager.js` |
| Dev server running/command/port/preview URL | `EnvironmentManager` | `services/environment/EnvironmentManager.js` |
| BigiBot KB cache + priming map | `BigiBotService` | `services/bigibot/BigiBotService.js` |
| OpenCode server/client/session maps | `OpenCodeService` | `services/opencode/OpenCodeService.js` |
| Renderer chat/preview/ui state | `app/page.js` + components | `app/page.js` |

## Known Gaps / Risks

- `workspace.switched` event is defined but never emitted; UI handles it anyway.
- Environment start/stop controls are exposed through IPC but no current renderer component triggers them.
- No file explorer implementation exists in current code (despite architectural mentions).
- OpenCode prompt body has `model` commented out; effective model selection depends on provider/OpenCode defaults and agent configuration.
- `TerminalPanel` creates sessions with `terminal:create` while `EnvironmentManager` uses internal `ensureSession`; they usually converge via primary-session logic but are independent call paths.

## Important Source Files

- `electron/main.js`
- `electron/preload.js`
- `lib/bridge.js`
- `app/page.js`
- `components/ProjectControls/ProjectControls.js`
- `components/Chat/ChatPanel.js`
- `components/Preview/PreviewPanel.js`
- `components/Terminal/TerminalPanel.js`
- `components/Changes/ChangesPanel.js`
- `services/workspace/WorkspaceManager.js`
- `services/project/ProjectManager.js`
- `services/environment/EnvironmentManager.js`
- `services/environment/RedirectorManager.js`
- `services/terminal/TerminalManager.js`
- `services/bigibot/BigiBotService.js`
- `services/opencode/OpenCodeService.js`
- `services/opencode/OpenCodeEventClassifier.js`
- `services/preview/PreviewClientCertificatePolicy.js`
- `services/preview/PreviewStaticResourceInterceptor.js`
- `services/git/GitManager.js`
- `services/runtimeBus.js`
- `shared/events.js`

## Developer Quick Reference

- Get current workspace snapshot: `workspace:current`.
- Open/switch/close project: `project:open`, `project:switch`, `project:close`.
- Send chat request: `chat:sendMessage(text, mode)`.
- Cancel chat: `chat:cancel`.
- Check Caveman routing status: `chat:cavemanStatus`.
- Terminal lifecycle: `terminal:create` -> `terminal:write` -> `terminal:resize` -> `terminal:stop`.
- Start/stop/restart environment (IPC exists): `environment:start`, `environment:stop`, `environment:restart`.
- Preview host/instance list source: `~/.bigin-vibe/instances.json` via `preview:instances`.
- Git read-only views: `git:status`, `git:diff`.
