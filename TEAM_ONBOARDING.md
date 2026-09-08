# Team Onboarding (Fresh Machine)

This guide is for teammates who do not have OpenCode installed yet.

## 1) Install system prerequisites (macOS)

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node git
xcode-select --install
```

Verify:

```bash
node -v
npm -v
git --version
```

## 2) Install OpenCode CLI (required)

Install from official docs:

- https://opencode.ai/docs/

Then verify:

```bash
opencode --help
```

## 3) Connect OpenCode to your provider (required)

Open OpenCode once:

```bash
opencode
```

In the OpenCode TUI:

1. Run `/connect`
2. Choose your provider (for example GitHub Copilot)
3. Complete auth flow
4. Run `/models` and ensure your model is available

Then quit OpenCode.

## 4) Install Caveman (required for team flow)

```bash
npm install -g @caveman-ai/cli
caveman setup --install
```

Verify:

```bash
caveman --help
```

## 5) Clone and install BiginVibe

```bash
git clone <your-repo-url>
cd biginVibe
npm install
```

## 6) Run with Caveman enabled

```bash
npm run dev:caveman
```

What this does:

- runs preflight (`caveman` + `opencode` must be available)
- starts app with Caveman env vars enabled

## 7) Use the app

1. Click `Open Project` and select a Bigin/Lyte project.
2. Use top bar buttons:
   - `Switch Project` to change active repo
   - `Close Project` to clear active workspace
3. Open Chat and check the status badge:
   - `Caveman: ON (...)` means routing is active.

## 8) Verify Caveman status (hard check)

In Electron DevTools console:

```js
window.biginVibe.chat.cavemanStatus().then(console.log)
```

Expected:

- `enabled: true`
- `reachable: true`
- `routingActive: true` (once OpenCode session is running)

## Troubleshooting

- Preflight fails on `opencode`
  - OpenCode CLI not installed or not in PATH.
- Preflight fails on `caveman`
  - Run:

    ```bash
    npm install -g @caveman-ai/cli
    caveman setup --install
    ```

- Chat shows `Caveman: OFF`
  - Launch from terminal with `npm run dev:caveman`.
  - Do not launch app from Dock when validating env-based setup.
  - Re-check with:

    ```js
    window.biginVibe.chat.cavemanStatus().then(console.log)
    ```
