/**
 * Caveman Proxy temporarily disabled.
 * BiginVibe currently uses the default OpenCode SDK flow without token compression.
 * Keep this flag for future re-enablement — change to `true` to restore Caveman routing.
 */
const USE_CAVEMAN_PROXY = false;

function readBool(name, fallback = false) {
  if (!(name in process.env)) return fallback;
  return process.env[name] === "true";
}

const BIGIBOT_CAVEMAN_ENABLED = readBool("BIGIBOT_CAVEMAN_ENABLED", false);
const BIGIBOT_CAVEMAN_AUTOSTART = readBool("BIGIBOT_CAVEMAN_AUTOSTART", false);
const BIGIBOT_CAVEMAN_URL = process.env.BIGIBOT_CAVEMAN_URL || "http://127.0.0.1:8787";
const BIGIBOT_CAVEMAN_PROVIDER = (process.env.BIGIBOT_CAVEMAN_PROVIDER || "openai").toLowerCase();
const BIGIBOT_CAVEMAN_BASE_URL = process.env.BIGIBOT_CAVEMAN_BASE_URL || "";
const BIGIBOT_CAVEMAN_MODE = process.env.BIGIBOT_CAVEMAN_MODE || "compress";
const BIGIBOT_CAVEMAN_CONFIG = process.env.BIGIBOT_CAVEMAN_CONFIG || "";

module.exports = {
  USE_CAVEMAN_PROXY,
  BIGIBOT_CAVEMAN_ENABLED,
  BIGIBOT_CAVEMAN_AUTOSTART,
  BIGIBOT_CAVEMAN_URL,
  BIGIBOT_CAVEMAN_PROVIDER,
  BIGIBOT_CAVEMAN_BASE_URL,
  BIGIBOT_CAVEMAN_MODE,
  BIGIBOT_CAVEMAN_CONFIG,
};
