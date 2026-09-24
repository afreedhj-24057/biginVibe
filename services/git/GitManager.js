const { spawn } = require("child_process");

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
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
        const indexStatus = line[0] || " ";
        const worktreeStatus = line[1] || " ";
        const status = `${indexStatus}${worktreeStatus}`.trim();
        const filePath = line.slice(3);
        return {
          path: filePath,
          status,
          indexStatus,
          worktreeStatus,
          staged: indexStatus !== " " && indexStatus !== "?",
          untracked: indexStatus === "?" && worktreeStatus === "?",
        };
      });
  }

  async getStatus(cwd, { fetchRemote = false } = {}) {
    const repository = await this.isRepo(cwd);
    if (!repository) {
      return {
        branch: null,
        isDirty: false,
        ahead: null,
        behind: null,
        isRepository: false,
        remoteStatus: "unknown",
      };
    }

    if (fetchRemote) {
      await this.fetch(cwd);
    }

    const [porcelain, branchResult, upstreamResult] = await Promise.all([
      run("git", ["status", "--porcelain=v1"], cwd),
      run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd).catch(() => ""),
      run("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], cwd).catch(() => null),
    ]);

    const counts = upstreamResult?.trim().split(/\s+/).map(Number);
    const hasCounts = counts?.length === 2 && counts.every(Number.isFinite);
    return {
      branch: branchResult.trim() || null,
      isDirty: porcelain.trim().length > 0,
      ahead: hasCounts ? counts[1] : null,
      behind: hasCounts ? counts[0] : null,
      isRepository: true,
      remoteStatus: hasCounts ? "fresh" : "unavailable",
    };
  }

  async fetch(cwd) {
    return run("git", ["fetch", "--quiet"], cwd);
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
