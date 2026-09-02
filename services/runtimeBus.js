const { EventEmitter } = require("events");

/**
 * Process-wide event bus. Services emit high-level, UI-facing events here.
 * electron/main.js subscribes once and forwards everything to the renderer
 * over a single IPC channel, so services never need to know about
 * BrowserWindow/webContents directly.
 */
class RuntimeBus extends EventEmitter {
  emitEvent(type, payload = {}) {
    this.emit("runtime-event", { type, payload, timestamp: Date.now() });
  }
}

module.exports = new RuntimeBus();
