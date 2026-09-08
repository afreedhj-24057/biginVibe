const fs = require("fs");
const path = require("path");
const os = require("os");
const { EVENTS } = require("../../shared/events");
const bus = require("../runtimeBus");
const {
  validateBigiBotProjectConfig,
  buildBigiBotConfigError,
} = require("../bigibot/BigiBotProjectConfig");
const { BIGIBOT_FALLBACK_MODE } = require("../../shared/opencodeConfig");

const RECENTS_FILE = path.join(os.homedir(), ".bigin-vibe", "recent-projects.json");

// ---------------------------------------------------------------------------
// Lyte / Bigin project detection
//
// BiginClient and related Bigin frontend projects do NOT declare Lyte as an
// npm dependency. The framework is managed through Bower and a custom build
// pipeline. Detection must therefore look at multiple signals rather than
// only package.json dependencies.
//
// Signal priority (first match wins "isLyteProject = true"):
//
//  1. bower.json  — dependency named "lyte", "lyte-dom", or "lyte-framework",
//                   OR the top-level "name" field is "lyte-framework".
//                   This is the most authoritative single-file signal.
//
//  2. bower_components/lyte/  — Lyte has already been installed via Bower.
//                   Reliable even when bower.json is absent or malformed.
//
//  3. components/templates/  — Lyte projects define custom elements as
//                   <template tag-name="…"> HTML files in this conventional
//                   directory. Presence of at least one such file is
//                   strong evidence of a Lyte project.
//
//  4. package.json deps  — fallback for npm-managed Lyte projects (future or
//                   hybrid setups) where a dep name matches /lyte/i.
//
// Signals are checked in order; as soon as one fires the others are skipped,
// keeping detection fast even for large projects.
// ---------------------------------------------------------------------------

/**
 * Returns true if bower.json at `projectPath` declares Lyte as a dependency
 * or identifies itself as the Lyte framework package.
 */
function _bowerJsonDeclaresLyte(projectPath) {
  const bowerPath = path.join(projectPath, "bower.json");
  if (!fs.existsSync(bowerPath)) return false;
  try {
    const bower = JSON.parse(fs.readFileSync(bowerPath, "utf8"));
    // "name": "lyte-framework" — the project IS the Lyte framework or a
    // project that self-identifies as such.
    if (/lyte/i.test(bower.name || "")) return true;
    // Any dependency with "lyte" in its name.
    const deps = {
      ...(bower.dependencies || {}),
      ...(bower.devDependencies || {}),
    };
    return Object.keys(deps).some((dep) => /lyte/i.test(dep));
  } catch {
    return false;
  }
}

/**
 * Returns true if Lyte has been installed into bower_components/lyte/.
 */
function _bowerComponentsHasLyte(projectPath) {
  return fs.existsSync(path.join(projectPath, "bower_components", "lyte"));
}

/**
 * Returns true if the project contains at least one Lyte component template.
 * Lyte projects define custom elements as <template tag-name="…"> in
 * HTML files conventionally stored under components/templates/.
 *
 * We check for the directory's existence first (cheap), then verify at least
 * one .html file inside it starts with a <template tag-name= declaration.
 */
function _hasLyteComponentTemplates(projectPath) {
  const templatesDir = path.join(projectPath, "components", "templates");
  if (!fs.existsSync(templatesDir)) return false;
  // Walk one level deep to find a qualifying HTML file without reading the
  // entire tree (avoids performance issues on large projects).
  try {
    const entries = fs.readdirSync(templatesDir);
    for (const entry of entries) {
      const entryPath = path.join(templatesDir, entry);
      const stat = fs.statSync(entryPath);
      if (stat.isFile() && entry.endsWith(".html")) {
        const head = _readHead(entryPath, 512);
        if (/<template\s[^>]*tag-name=/i.test(head)) return true;
      } else if (stat.isDirectory()) {
        // One sub-level (e.g. components/templates/ux-menu/ux-menu.html).
        const subEntries = fs.readdirSync(entryPath);
        for (const sub of subEntries) {
          if (!sub.endsWith(".html")) continue;
          const head = _readHead(path.join(entryPath, sub), 512);
          if (/<template\s[^>]*tag-name=/i.test(head)) return true;
        }
      }
    }
  } catch {
    /* ignore read errors */
  }
  return false;
}

/**
 * Returns true if any dep in package.json matches /lyte/i.
 * Fallback for npm-managed or hybrid Lyte projects.
 */
function _npmDepsHasLyte(pkg) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return Object.keys(deps).some((name) => /lyte/i.test(name));
}

/**
 * Read the first `maxBytes` of a file as a string without loading the whole
 * file into memory.
 */
function _readHead(filePath, maxBytes) {
  let fd;
  try {
    const buf = Buffer.alloc(maxBytes);
    fd = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.slice(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* noop */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Dev-server / package-manager detection
//
// BiginClient and other Bigin/Lyte projects do NOT use npm scripts for their
// dev workflow. They use the Lyte CLI (`lyte serve`), which builds the project
// and starts a local HTTP server. Detection priority:
//
//  1. lyte-cli project  — bower.json exists AND build/build.js exists AND the
//                         `lyte` CLI binary can be found on the system.
//                         devEntryPoint = "lyte-cli"
//
//  2. npm script        — package.json has scripts.dev / scripts.start / scripts.serve
//                         devEntryPoint = "npm-script"
//
//  3. bare build.js     — build/build.js exists but no lyte CLI found.
//                         devEntryPoint = "build-js"  (manual fallback)
//
//  4. none              — No dev entry-point detected.
// ---------------------------------------------------------------------------

/**
 * Locate the `lyte` CLI binary. Checks common installation paths so the
 * correct binary is found even when Electron's PATH is minimal.
 *
 * Returns the absolute path to the lyte binary, or null if not found.
 */
function _findLyteBinary() {
  const { execSync } = require("child_process");
  const candidates = [
    // Homebrew on Apple Silicon / Intel
    "/opt/homebrew/bin/lyte",
    "/usr/local/bin/lyte",
    // npm global installs
    "/usr/local/lib/node_modules/@zoho/lyte-cli/bin/lyte",
    "/opt/homebrew/lib/node_modules/@zoho/lyte-cli/bin/lyte",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Try locating via `which lyte` as a last resort (works when Electron has a
  // richer PATH, e.g. when launched from a terminal).
  try {
    const result = execSync("which lyte", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    /* not in PATH */
  }
  return null;
}

/**
 * Returns the Node.js binary path that should be used to run the lyte CLI.
 * Needed because the lyte shebang (#!/usr/bin/env node) may not find node
 * in Electron's minimal PATH.
 */
function _findNodeBinary() {
  const { execSync } = require("child_process");
  const candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const result = execSync("which node", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch { /* not in PATH */ }
  return "node"; // fallback — may fail in Electron without a rich PATH
}

/**
 * Determine how to start the development server / watcher for this project.
 *
 * Returned shape:
 * {
 *   packageManager:  "yarn" | "pnpm" | "npm"
 *   devScript:       string | null  — npm/yarn script name (null for lyte projects)
 *   devEntryPoint:   "lyte-cli" | "npm-script" | "build-js" | "none"
 *   lyteBin:         string | null  — absolute path to lyte binary (lyte-cli only)
 *   nodeBin:         string | null  — absolute path to node binary (lyte-cli only)
 * }
 */
function _detectDevSetup(projectPath, pkg) {
  const packageManager = fs.existsSync(path.join(projectPath, "yarn.lock"))
    ? "yarn"
    : fs.existsSync(path.join(projectPath, "pnpm-lock.yaml"))
      ? "pnpm"
      : "npm";

  // --- Priority 1: Lyte CLI project ----------------------------------------
  // Bigin/Lyte projects use `lyte serve`, not npm scripts. The presence of
  // bower.json + build/build.js together is the reliable fingerprint for a
  // project driven by the Lyte CLI.
  const hasBowerJson = fs.existsSync(path.join(projectPath, "bower.json"));
  const hasBuildJs   = fs.existsSync(path.join(projectPath, "build", "build.js"));
  if (hasBowerJson && hasBuildJs) {
    const lyteBin = _findLyteBinary();
    if (lyteBin) {
      return {
        packageManager,
        devScript: null,
        devEntryPoint: "lyte-cli",
        lyteBin,
        nodeBin: _findNodeBinary(),
      };
    }
  }

  // --- Priority 2: npm/yarn script -----------------------------------------
  const scripts = (pkg && pkg.scripts) || {};
  const devScript =
    scripts.dev   ? "dev"   :
    scripts.start ? "start" :
    scripts.serve ? "serve" : null;

  if (devScript) {
    return { packageManager, devScript, devEntryPoint: "npm-script", lyteBin: null, nodeBin: null };
  }

  // --- Priority 3: bare build.js (lyte CLI not installed) ------------------
  if (hasBuildJs) {
    return { packageManager, devScript: null, devEntryPoint: "build-js", lyteBin: null, nodeBin: null };
  }

  return { packageManager, devScript: null, devEntryPoint: "none", lyteBin: null, nodeBin: null };
}

// ---------------------------------------------------------------------------
// Main detector
// ---------------------------------------------------------------------------

/**
 * Inspects `projectPath` and returns a project metadata object.
 *
 * Returned shape:
 * {
 *   supported:        boolean   — false only if the path cannot be used at all
 *   reason?:          string    — human-readable error when supported=false
 *   name:             string
 *   framework:        "lyte" | "unknown"
 *   projectType:      "bigin" | "generic"
 *   isLyteProject:    boolean   — true when framework === "lyte"
 *   lyteSignal:       string    — which signal triggered detection (for diagnostics)
 *   hasKnowledgeBase: boolean
 *   knowledgeBaseDir: string | null
 *   packageManager:   "yarn" | "pnpm" | "npm"
 *   devScript:        string | null
 *   devEntryPoint:    "npm-script" | "build-js" | "none"
 *   capabilities: {
 *     devServer:  boolean
 *     preview:    boolean
 *     terminal:   boolean
 *     opencode:   boolean
 *   }
 * }
 *
 * NOTE: A missing package.json is no longer fatal. Bigin/Lyte projects may
 * use Bower as their primary dependency manager and have a minimal or absent
 * package.json.
 */
function detectProject(projectPath) {
  // --- Determine project name -----------------------------------------------
  // Prefer package.json name → bower.json name → directory basename.
  let pkg = null;
  const pkgPath = path.join(projectPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch { /* ignore */ }
  }

  let bowerName = null;
  const bowerPath = path.join(projectPath, "bower.json");
  if (fs.existsSync(bowerPath)) {
    try {
      const bower = JSON.parse(fs.readFileSync(bowerPath, "utf8"));
      bowerName = bower.name || null;
    } catch { /* ignore */ }
  }

  // Use package.json name, but prefer the directory basename for BiginClient-
  // style projects where package.json name is empty ("name": "").
  const rawPkgName = pkg?.name?.trim() || "";
  const name = rawPkgName || bowerName || path.basename(projectPath);

  // --- Require at least one of: package.json or bower.json ------------------
  // A plain directory with neither is almost certainly not a web project.
  if (!pkg && !fs.existsSync(bowerPath)) {
    return {
      supported: false,
      reason: "No package.json or bower.json found in the selected directory.",
    };
  }

  // --- Lyte detection (ordered by reliability) ------------------------------
  let isLyteProject = false;
  let lyteSignal = "none";

  if (_bowerJsonDeclaresLyte(projectPath)) {
    isLyteProject = true;
    lyteSignal = "bower.json";
  } else if (_bowerComponentsHasLyte(projectPath)) {
    isLyteProject = true;
    lyteSignal = "bower_components/lyte";
  } else if (_hasLyteComponentTemplates(projectPath)) {
    isLyteProject = true;
    lyteSignal = "components/templates";
  } else if (pkg && _npmDepsHasLyte(pkg)) {
    isLyteProject = true;
    lyteSignal = "package.json";
  }

  const framework   = isLyteProject ? "lyte" : "unknown";
  const projectType = isLyteProject ? "bigin" : "generic";

  // --- Knowledge base -------------------------------------------------------
  // Source of truth is strictly <project>/bigibot.
  const knowledgeBaseDir = path.join(projectPath, "bigibot");
  const hasKnowledgeBase = fs.existsSync(knowledgeBaseDir);

  // --- BigiBot config preflight ---------------------------------------------
  const bigiBotConfig = validateBigiBotProjectConfig(projectPath);
  const bigiBotConfigError = bigiBotConfig.ok ? null : buildBigiBotConfigError(bigiBotConfig);
  const hasBigiBotAgent = !bigiBotConfig.missing.some((item) => item.type === "agent");

  // --- Dev setup ------------------------------------------------------------
  const { packageManager, devScript, devEntryPoint, lyteBin, nodeBin } = _detectDevSetup(projectPath, pkg);

  return {
    supported: true,
    name,
    framework,
    projectType,
    isLyteProject,
    lyteSignal,
    hasKnowledgeBase,
    knowledgeBaseDir: hasKnowledgeBase ? knowledgeBaseDir : null,
    hasBigiBotAgent,
    hasBigiBotConfig: bigiBotConfig.ok,
    bigiBotConfigError,
    bigiBotFallbackMode: BIGIBOT_FALLBACK_MODE,
    packageManager,
    devScript,
    devEntryPoint,
    lyteBin,
    nodeBin,
    capabilities: {
      devServer: devEntryPoint !== "none",
      preview: true,
      terminal: true,
      opencode: true,
    },
  };
}

// ---------------------------------------------------------------------------
// ProjectManager
// ---------------------------------------------------------------------------

class ProjectManager {
  constructor() {
    this.currentProject = null;
    this._ensureRecentsFile();
  }

  _ensureRecentsFile() {
    const dir = path.dirname(RECENTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(RECENTS_FILE)) fs.writeFileSync(RECENTS_FILE, JSON.stringify([]));
  }

  getRecentProjects() {
    try {
      return JSON.parse(fs.readFileSync(RECENTS_FILE, "utf8"));
    } catch {
      return [];
    }
  }

  _addToRecents(projectPath) {
    const recents = this.getRecentProjects().filter((p) => p.path !== projectPath);
    recents.unshift({ path: projectPath, openedAt: Date.now() });
    fs.writeFileSync(RECENTS_FILE, JSON.stringify(recents.slice(0, 10), null, 2));
  }

  async openProject(projectPath) {
    if (!projectPath || !fs.existsSync(projectPath)) {
      const error = "The selected path does not exist.";
      bus.emitEvent(EVENTS.PROJECT_ERROR, { error });
      throw new Error(error);
    }

    const stat = fs.statSync(projectPath);
    if (!stat.isDirectory()) {
      const error = "The selected path is not a directory.";
      bus.emitEvent(EVENTS.PROJECT_ERROR, { error });
      throw new Error(error);
    }

    const detection = detectProject(projectPath);
    if (!detection.supported) {
      bus.emitEvent(EVENTS.PROJECT_ERROR, { error: detection.reason });
      throw new Error(detection.reason);
    }

    this.currentProject = {
      path: projectPath,
      ...detection,
    };

    this._addToRecents(projectPath);
    bus.emitEvent(EVENTS.PROJECT_OPENED, this.currentProject);
    return this.currentProject;
  }

  closeProject() {
    this.currentProject = null;
    bus.emitEvent(EVENTS.PROJECT_CLOSED, {});
  }

  getCurrentProject() {
    return this.currentProject;
  }
}

module.exports = new ProjectManager();
module.exports.detectProject = detectProject;
