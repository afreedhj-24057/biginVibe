/**
 * BigiBot / OpenCode model configuration.
 *
 * The spawned `opencode serve` process is rooted at the user's active
 * project directory (see OpenCodeService.spawnOpencodeServer), not at the
 * biginVibe repo, so an `opencode.json` living in this repo is never read
 * by the server. The model must instead be passed explicitly on each
 * `session.prompt` call.
 *
 * Override via the BIGIBOT_MODEL env var (e.g. in a local .env file loaded
 * by the Electron main process), otherwise falls back to the default below.
 */
const DEFAULT_MODEL = "github-copilot/gpt-5.3-codex";
const DEFAULT_AGENT = "BigiBot";

function readBool(name, fallback = false) {
  if (!(name in process.env)) return fallback;
  return process.env[name] === "true";
}

const BIGIBOT_MODEL = process.env.BIGIBOT_MODEL || DEFAULT_MODEL;
const BIGIBOT_AGENT = process.env.BIGIBOT_AGENT || DEFAULT_AGENT;
const BIGIBOT_FALLBACK_MODE = readBool("BIGIBOT_FALLBACK_MODE", false);

const BIGIBOT_CAVEMAN_ENABLED = readBool("BIGIBOT_CAVEMAN_ENABLED", false);
const BIGIBOT_CAVEMAN_AUTOSTART = readBool("BIGIBOT_CAVEMAN_AUTOSTART", false);
const BIGIBOT_CAVEMAN_URL = process.env.BIGIBOT_CAVEMAN_URL || "http://127.0.0.1:8787";
const BIGIBOT_CAVEMAN_PROVIDER = (process.env.BIGIBOT_CAVEMAN_PROVIDER || "openai").toLowerCase();
const BIGIBOT_CAVEMAN_BASE_URL = process.env.BIGIBOT_CAVEMAN_BASE_URL || "";
const BIGIBOT_CAVEMAN_MODE = process.env.BIGIBOT_CAVEMAN_MODE || "compress";
const BIGIBOT_CAVEMAN_CONFIG = process.env.BIGIBOT_CAVEMAN_CONFIG || "";

module.exports = {
  BIGIBOT_MODEL,
  DEFAULT_MODEL,
  BIGIBOT_AGENT,
  DEFAULT_AGENT,
  BIGIBOT_FALLBACK_MODE,
  BIGIBOT_CAVEMAN_ENABLED,
  BIGIBOT_CAVEMAN_AUTOSTART,
  BIGIBOT_CAVEMAN_URL,
  BIGIBOT_CAVEMAN_PROVIDER,
  BIGIBOT_CAVEMAN_BASE_URL,
  BIGIBOT_CAVEMAN_MODE,
  BIGIBOT_CAVEMAN_CONFIG,
};
