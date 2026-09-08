# Bigin Vibe Code Editor

A desktop vibe-coding IDE for the Bigin frontend team, built on Electron +
Next.js. Open an existing Bigin/Lyte project, run its dev environment, see
it live in an embedded preview, and chat with **BigiBot** to make changes
via the OpenCode SDK. The top bar supports opening, switching, and closing
the active project.

## Quick start (team)

```bash
npm install
npm run dev:caveman
```

`dev:caveman` runs a preflight check and starts the app with Caveman routing
enabled.

For full fresh-machine setup (including OpenCode + provider auth), see
`TEAM_ONBOARDING.md`.

## Architecture

```
electron/            Electron main process + preload (privileged runtime)
  main.js             Window creation, IPC handlers, service wiring
  preload.js           contextBridge-exposed API surface for the renderer

services/             Node runtime services (no Electron/React knowledge)
  project/             ProjectManager — open/close/detect/recent projects
  devserver/           DevServerManager — spawns/tracks the Bigin dev process
  environment/         EnvironmentManager + RedirectorManager — resolves previewUrl
  terminal/            TerminalManager — human-facing integrated terminal
  git/                 GitManager — read-only status/diff for Changes UI
  opencode/            OpenCodeService — isolates all @opencode-ai/sdk usage
  bigibot/             BigiBotService — Bigin/Lyte system priming + knowledge injection
  knowledge/           ComponentKnowledgeService — lazy component-registry/doc lookup
  runtimeBus.js        Process-wide EventEmitter forwarded to the renderer

app/, components/, lib/   Next.js renderer (Chat, Preview, Terminal, Changes, ProjectControls)
shared/events.js           Event name constants shared by main + renderer
```

The renderer never touches Node/Electron APIs directly — everything goes
through `window.biginVibe` (see `electron/preload.js`) into IPC handlers in
`electron/main.js`, which delegate to the services above.

## Running in development

```bash
npm install
npm run dev
```

To run with Caveman routing enabled in one command:

```bash
npm run dev:caveman
```

If you only want to run the preflight check:

```bash
npm run dev:caveman:preflight
```

This starts the Next.js dev server on `:3210` and launches Electron once
it's ready (`wait-on` + `concurrently`).

## Project controls (top bar)

- `Open Project`: opens a directory and sets it as active workspace.
- `Switch Project`: atomically tears down the current workspace (environment,
  OpenCode session, terminals) and opens the selected project.
- `Close Project`: stops the workspace and returns to no-project state.

## Bigin project requirements

- The opened directory must contain a `package.json` with a `dev` or
  `start` script.
- A Lyte dependency is detected heuristically; if not found, the project can
  still be opened but the UI will flag it.
- Optional Redirector configuration: `<project>/.bigin/redirector.json`
  (see `services/environment/RedirectorManager.js` for the contract). If
  absent, the environment falls back to the raw detected dev-server URL.
- BigiBot knowledge base: `<project>/bigibot/` (source of truth) with
  `components/component-registry.json` as the discovery index and per-component
  Markdown docs loaded on demand (see `services/knowledge/ComponentKnowledgeService.js`).
- Required BigiBot agent file: `<project>/.opencode/agent/BigiBot.md`.
- By default, project open fails fast if either BigiBot file is missing.
  To allow fallback mode, set `BIGIBOT_FALLBACK_MODE=true`:
  - missing agent file -> uses default OpenCode agent
  - missing knowledge base -> runs without BigiBot KB context
  - UI shows: `Running without project BigiBot config.`

## Optional: Caveman proxy (token compression)

The OpenCode SDK integration stays unchanged. If enabled, BigiBot starts
`opencode serve` with provider `baseURL` routed through Caveman, so traffic
flows as:

`BiginVibe -> OpenCode SDK -> OpenCode server -> Caveman proxy -> provider`

1. Install Caveman CLI (official path):

```bash
npm install -g @caveman-ai/cli
caveman setup --install
```

2. Set environment variables before launching the app:

```bash
# turn Caveman routing on/off
BIGIBOT_CAVEMAN_ENABLED=true

# optional: let BigiBot start Caveman if it is not already running
BIGIBOT_CAVEMAN_AUTOSTART=true

# optional: Caveman listen address (default shown)
BIGIBOT_CAVEMAN_URL=http://127.0.0.1:8787

# optional: provider route used behind Caveman
# supported: openai | anthropic | gemini | bedrock
BIGIBOT_CAVEMAN_PROVIDER=openai

# optional: explicit provider base URL override
# takes precedence over provider-derived route above
# example: http://127.0.0.1:8787/openai/v1
BIGIBOT_CAVEMAN_BASE_URL=

# optional: Caveman runtime mode passed to autostarted process
# common values: record | compress | pixel
BIGIBOT_CAVEMAN_MODE=compress

# optional: custom caveman.yaml path for autostart
BIGIBOT_CAVEMAN_CONFIG=
```

Behavior guarantees:

- If `BIGIBOT_CAVEMAN_ENABLED=false` (default), no Caveman logic runs.
- If Caveman is enabled but not reachable and autostart is off, request setup
  fails immediately with a clear startup error.
- If autostart is enabled, BigiBot runs `caveman start` and waits until the
  proxy is reachable before starting OpenCode.
- No renderer/frontend Caveman dependency is added.

## Troubleshooting

- **Chat badge shows `Caveman: OFF`**
  - launch with `npm run dev:caveman` (recommended).
  - in DevTools console run:

    ```js
    window.biginVibe.chat.cavemanStatus().then(console.log)
    ```

  - `enabled: false` means Electron did not inherit Caveman env vars; restart
    from the same terminal with `npm run dev:caveman`.
- **Preflight fails on caveman**
  - install Caveman CLI and runtime:

    ```bash
    npm install -g @caveman-ai/cli
    caveman setup --install
    ```

- **Preflight fails on opencode**
  - install OpenCode CLI and verify `opencode --help` works in the same shell.

## Notes / follow-ups

- To keep assistant output compact in the chat UI, set
  `BIGIBOT_MAX_RESPONSE_CHARS` (default `2200`). Long replies are truncated
  with an explicit note so you can ask for expansion when needed.

- The integrated terminal uses `child_process` with a shell rather than a
  full PTY (avoids native module builds); swapping in `node-pty` later is a
  drop-in replacement inside `TerminalManager`.
- `RedirectorManager`'s exact command/URL contract should be adjusted to
  match the real Bigin Redirector once run against an actual Bigin repo.
- Git commit/push are intentionally not exposed — committing stays a manual
  terminal action.
