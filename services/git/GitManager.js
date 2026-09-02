const { spawn } = require("child_process");

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code !== 0 && stderr) return reject(new Error(stderr.trim()));
      resolve(stdout);
    });
    child.on("error", reject);
  });
}

/**
 * Read-only Git helper for the Changes/Diff UI. Deliberately does NOT expose
 * commit/push — committing remains a manual, deliberate user action
 * performed from the terminal.
 */
class GitManager {
  async isRepo(cwd) {
    try {
      await run("git", ["rev-parse", "--is-inside-work-tree"], cwd);
      return true;
    } catch {
      return false;
    }
  }

  /** Returns a list of { path, status } for changed files (porcelain format). */
  async status(cwd) {
    const out = await run("git", ["status", "--porcelain=v1"], cwd);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const status = line.slice(0, 2).trim();
        const filePath = line.slice(3);
        return { path: filePath, status };
      });
  }

  async diff(cwd, filePath) {
    const args = filePath ? ["diff", "--", filePath] : ["diff"];
    return run("git", args, cwd);
  }

  async diffCached(cwd, filePath) {
    const args = filePath ? ["diff", "--cached", "--", filePath] : ["diff", "--cached"];
    return run("git", args, cwd);
  }
}

module.exports = GitManager;
