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

const BIGIBOT_MODEL = process.env.BIGIBOT_MODEL || DEFAULT_MODEL;
const BIGIBOT_AGENT = process.env.BIGIBOT_AGENT || DEFAULT_AGENT;
const BIGIBOT_FALLBACK_MODE = process.env.BIGIBOT_FALLBACK_MODE === "true";

module.exports = {
  BIGIBOT_MODEL,
  DEFAULT_MODEL,
  BIGIBOT_AGENT,
  DEFAULT_AGENT,
  BIGIBOT_FALLBACK_MODE,
};
