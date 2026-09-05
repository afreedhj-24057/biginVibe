const fs = require("fs");
const path = require("path");

function resolveBigiBotPaths(projectPath) {
  const agentPath = path.join(projectPath, ".opencode", "agent", "BigiBot.md");
  const registryPath = path.join(projectPath, "bigibot", "components", "component-registry.json");
  return { agentPath, registryPath };
}

function validateBigiBotProjectConfig(projectPath) {
  const { agentPath, registryPath } = resolveBigiBotPaths(projectPath);
  const missing = [];
  if (!fs.existsSync(agentPath)) missing.push({ type: "agent", path: agentPath });
  if (!fs.existsSync(registryPath)) missing.push({ type: "knowledge", path: registryPath });

  return {
    ok: missing.length === 0,
    missing,
    paths: { agentPath, registryPath },
  };
}

function buildBigiBotConfigError(validation) {
  const lines = [];
  for (const item of validation.missing) {
    if (item.type === "agent") lines.push(`BigiBot agent not found at ${item.path}`);
    if (item.type === "knowledge") lines.push(`Knowledge base not found at ${item.path}`);
  }
  return lines.join("\n");
}

module.exports = {
  resolveBigiBotPaths,
  validateBigiBotProjectConfig,
  buildBigiBotConfigError,
};
