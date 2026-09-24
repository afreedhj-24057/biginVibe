const OpenCodeService = require("../opencode/OpenCodeService");
class BigiBotService {
  constructor() {
    this.opencode = new OpenCodeService();
  }

  async ensureSession(project, options = {}) {
    let sessionId = options.sessionId || this.opencode.getActiveSessionId(project);

    if (!sessionId) {
      const sessions = await this.opencode.listSessions(project);
      sessionId = sessions[0]?.id || null;
    }

    if (!sessionId) {
      const session = await this.opencode.createSessionWithOptions(project, {
        title: options.title,
      });
      sessionId = session.id;
    }

    this.opencode.setActiveSessionId(project, sessionId);
    return sessionId;
  }

  async listSessions(project) {
    return this.opencode.listSessions(project);
  }

  async openSession(project, sessionId) {
    const session = await this.opencode.getSession(project, sessionId);
    this.opencode.setActiveSessionId(project, session.id);
    return session;
  }

  async getSessionMessages(project, sessionId, options = {}) {
    return this.opencode.getSessionMessages(project, sessionId, options);
  }

  async createSession(project, options = {}) {
    const session = await this.opencode.createSessionWithOptions(project, {
      title: options.title,
      parentID: options.parentID,
    });
    this.opencode.setActiveSessionId(project, session.id);
    return session;
  }

  async renameSession(project, sessionId, title) {
    return this.opencode.renameSession(project, sessionId, title);
  }

  async forkSession(project, sessionId) {
    return this.opencode.forkSession(project, sessionId);
  }

  async deleteSession(project, sessionId) {
    await this.opencode.deleteSession(project, sessionId);
  }

  async getModels(project, forceRefresh = false) {
    return this.opencode.getModels(project, forceRefresh);
  }

  async getAgents(project) {
    return this.opencode.getAgents(project);
  }

  async _sendWithRetry(project, sessionId, prompt, options) {
    try {
      return await this.opencode.sendPrompt(sessionId, prompt, options);
    } catch (err) {
      const message = String(err?.message || err || "");
      const isFetchFailure = /fetch failed|ECONNREFUSED|socket hang up|network error/i.test(message);
      if (!isFetchFailure) throw err;

      await this.opencode.shutdown().catch(() => {});
      const refreshedSessionId = await this.ensureSession(project);
      return this.opencode.sendPrompt(refreshedSessionId, prompt, options);
    }
  }

  async sendRequest(project, userRequest, options = {}) {
    const sessionId = await this.ensureSession(project, {
      sessionId: options.sessionId,
      title: options.title,
    });

    return this._sendWithRetry(project, sessionId, userRequest, {
      agent: options.agent,
      model: options.model,
    });
  }

  async cancel(project) {
    const sessionId = this.opencode.getActiveSessionId(project);
    if (sessionId) await this.opencode.cancelSession(sessionId);
  }

  async shutdown() {
    await this.opencode.shutdown();
  }

  async getCavemanStatus() {
    return this.opencode.getCavemanStatus();
  }
}

module.exports = BigiBotService;
