# Bigin Vibe Code Editor

A desktop vibe-coding IDE for the Bigin frontend team, built on Electron +
Next.js. Open an existing Bigin/Lyte project, run its dev environment, see
it live in an embedded preview, and chat with **BigiBot** to make changes
via the OpenCode SDK.

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

This starts the Next.js dev server on `:3210` and launches Electron once
it's ready (`wait-on` + `concurrently`).

## Bigin project requirements

- The opened directory must contain a `package.json` with a `dev` or
  `start` script.
- A Lyte dependency is detected heuristically; if not found, the project can
  still be opened but the UI will flag it.
- Optional Redirector configuration: `<project>/.bigin/redirector.json`
  (see `services/environment/RedirectorManager.js` for the contract). If
  absent, the environment falls back to the raw detected dev-server URL.
- Optional BigiBot knowledge base: `<project>/.github/bigibot/` with
  `component/component-registry.json` as the discovery index and per-component
  Markdown docs loaded on demand (see `services/knowledge/ComponentKnowledgeService.js`).

## Notes / follow-ups

- The integrated terminal uses `child_process` with a shell rather than a
  full PTY (avoids native module builds); swapping in `node-pty` later is a
  drop-in replacement inside `TerminalManager`.
- `RedirectorManager`'s exact command/URL contract should be adjusted to
  match the real Bigin Redirector once run against an actual Bigin repo.
- Git commit/push are intentionally not exposed — committing stays a manual
  terminal action.
