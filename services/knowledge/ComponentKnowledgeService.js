const fs = require("fs");
const path = require("path");

/**
 * Provides lightweight, on-demand access to a project's Bigin/Lyte
 * component knowledge base (see spec section 7):
 *
 *   .github/bigibot/component/component-registry.json
 *   .github/bigibot/component/<component>.md
 *   .github/bigibot/patterns/
 *   .github/bigibot/conventions.md
 *
 * The registry is small and cheap to load in full. Individual component
 * Markdown docs are only read from disk when a request actually references
 * that component, so BigiBot's prompt never balloons with the entire
 * knowledge base.
 */
class ComponentKnowledgeService {
  constructor(knowledgeBaseDir) {
    this.dir = knowledgeBaseDir;
    this.registry = null;
  }

  isAvailable() {
    return !!this.dir && fs.existsSync(this.dir);
  }

  loadRegistry() {
    if (!this.isAvailable()) return [];
    const registryPath = path.join(this.dir, "component", "component-registry.json");
    if (!fs.existsSync(registryPath)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(registryPath, "utf8"));
      // Support either { components: [...] } or a bare array.
      this.registry = Array.isArray(raw) ? raw : raw.components || [];
      return this.registry;
    } catch (err) {
      throw new Error(`Failed to parse component-registry.json: ${err.message}`);
    }
  }

  /**
   * Naive keyword matcher over the registry: matches a free-text user
   * request against each component's name/tags/description. Good enough as
   * a discovery step — BigiBot/OpenCode still verifies against the real
   * source before using anything.
   */
  findRelevantComponents(userRequest, limit = 5) {
    const registry = this.registry || this.loadRegistry();
    if (!registry.length) return [];

    const words = userRequest
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((w) => w.length > 2);

    const scored = registry.map((entry) => {
      const haystack = [entry.name, entry.description, ...(entry.tags || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const score = words.reduce((acc, w) => (haystack.includes(w) ? acc + 1 : acc), 0);
      return { entry, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.entry);
  }

  /** Loads the Markdown documentation for a single registry entry, if present. */
  loadComponentDoc(entry) {
    if (!this.isAvailable() || !entry || !entry.doc) return null;
    const docPath = path.join(this.dir, "component", entry.doc);
    if (!fs.existsSync(docPath)) return null;
    return fs.readFileSync(docPath, "utf8");
  }

  loadConventions() {
    if (!this.isAvailable()) return null;
    const conventionsPath = path.join(this.dir, "conventions.md");
    if (!fs.existsSync(conventionsPath)) return null;
    return fs.readFileSync(conventionsPath, "utf8");
  }

  /**
   * Builds the small, targeted context block to inject into the BigiBot
   * prompt for a given user request: matched component docs + conventions,
   * never the full knowledge base.
   */
  buildContextForRequest(userRequest) {
    if (!this.isAvailable()) return null;

    const matches = this.findRelevantComponents(userRequest);
    const sections = [];

    const conventions = this.loadConventions();
    if (conventions) {
      sections.push(`## Bigin/Lyte conventions\n${conventions}`);
    }

    for (const entry of matches) {
      const doc = this.loadComponentDoc(entry);
      if (doc) {
        sections.push(`## Component: ${entry.name}\n${doc}`);
      }
    }

    if (!sections.length) return null;
    return sections.join("\n\n---\n\n");
  }
}

module.exports = ComponentKnowledgeService;
