#!/usr/bin/env node

const { spawnSync } = require("child_process");

function fail(message) {
  process.stderr.write(`\n[dev:caveman] ${message}\n\n`);
  process.exit(1);
}

function runCheck(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
}

if (!runCheck("caveman", ["--help"])) {
  fail(
    "`caveman` command not found. Install and setup first:\n"
      + "  npm install -g @caveman-ai/cli\n"
      + "  caveman setup --install"
  );
}

if (!runCheck("opencode", ["--help"])) {
  fail("`opencode` command not found in PATH. Install OpenCode CLI before running BigiBot.");
}

process.stdout.write("[dev:caveman] preflight ok: caveman + opencode are available.\n");
