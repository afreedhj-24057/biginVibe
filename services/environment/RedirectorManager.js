const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/**
 * Abstraction over the Bigin Redirector mechanism.
 *
 * Bigin's real local development setup does not serve the app directly off
 * a plain localhost URL — a local dev server is fronted by a Redirector that
 * maps a routed/hosted Bigin URL to the developer's local process. The exact
 * redirector binary/protocol is specific to the Bigin engineering org and is
 * NOT invented here. Instead this class defines the integration contract and
 * reads its configuration from the project itself, so a real Redirector
 * integration can be dropped in without touching the rest of the app.
 *
 * Expected (optional) project configuration file:
 *   <project>/.bigin/redirector.json
 *   {
 *     "command": "bigin-redirector start --port {devServerPort}",
 *     "previewUrlPattern": "https://redirector.bigin.local/app/{projectName}",
 *     "readyTimeoutMs": 15000
 *   }
 *
 * If no configuration is present, RedirectorManager falls back to treating
 * the raw dev server URL as the preview URL (useful for local development of
 * this editor itself against non-Bigin projects).
 */
class RedirectorManager {
  constructor() {
    this.proc = null;
    this.config = null;
  }

  _loadConfig(projectPath) {
    const configPath = path.join(projectPath, ".bigin", "redirector.json");
    if (!fs.existsSync(configPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new Error(`Invalid .bigin/redirector.json: ${err.message}`);
    }
  }

  /**
   * @param {object} opts
   * @param {string} opts.projectPath
   * @param {string} opts.projectName
   * @param {number} [opts.devServerPort]
   * @param {string} [opts.devServerUrl]
   * @returns {Promise<{previewUrl: string}>}
   */
  async start({ projectPath, projectName, devServerPort, devServerUrl }) {
    this.config = this._loadConfig(projectPath);

    if (!this.config) {
      // No Redirector configured for this project — fall back to the raw
      // dev server URL so the preview still works end to end.
      return { previewUrl: devServerUrl || null, mode: "direct" };
    }

    const command = (this.config.command || "")
      .replace("{devServerPort}", devServerPort != null ? String(devServerPort) : "")
      .replace("{projectName}", projectName || "");

    if (command.trim()) {
      const [cmd, ...args] = command.split(" ");
      this.proc = spawn(cmd, args, { cwd: projectPath, shell: true });
      this.proc.on("error", () => {
        this.proc = null;
      });
    }

    const previewUrl = (this.config.previewUrlPattern || "")
      .replace("{projectName}", projectName || "")
      .replace("{devServerPort}", devServerPort != null ? String(devServerPort) : "");

    return { previewUrl: previewUrl || devServerUrl || null, mode: "redirector" };
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* noop */
      }
    }
    this.proc = null;
  }

  isRunning() {
    return !!this.proc && !this.proc.killed;
  }
}

module.exports = RedirectorManager;
