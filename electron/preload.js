const { contextBridge, ipcRenderer } = require("electron");

/**
 * The only surface the renderer ever sees. No direct Node/Electron APIs are
 * exposed — every privileged operation is a named IPC call into the main
 * process, which owns the filesystem, process management, terminal, and
 * environment/redirector logic.
 */
contextBridge.exposeInMainWorld("biginVibe", {
  workspace: {
    current: () => ipcRenderer.invoke("workspace:current"),
  },
  project: {
    pickDirectory: () => ipcRenderer.invoke("project:pickDirectory"),
    open: (projectPath) => ipcRenderer.invoke("project:open", projectPath),
    switch: (projectPath) => ipcRenderer.invoke("project:switch", projectPath),
    close: () => ipcRenderer.invoke("project:close"),
    current: () => ipcRenderer.invoke("project:current"),
    recents: () => ipcRenderer.invoke("project:recents"),
  },
  environment: {
    start: () => ipcRenderer.invoke("environment:start"),
    stop: () => ipcRenderer.invoke("environment:stop"),
    restart: () => ipcRenderer.invoke("environment:restart"),
    status: () => ipcRenderer.invoke("environment:status"),
  },
  terminal: {
    create: (cols, rows) => ipcRenderer.invoke("terminal:create", cols, rows),
    write: (sessionId, input) => ipcRenderer.invoke("terminal:write", sessionId, input),
    resize: (sessionId, cols, rows) => ipcRenderer.invoke("terminal:resize", sessionId, cols, rows),
    stop: (sessionId) => ipcRenderer.invoke("terminal:stop", sessionId),
    list: () => ipcRenderer.invoke("terminal:list"),
  },
  chat: {
    sendMessage: (text) => ipcRenderer.invoke("chat:sendMessage", text),
    cancel: () => ipcRenderer.invoke("chat:cancel"),
  },
  git: {
    status: () => ipcRenderer.invoke("git:status"),
    diff: (filePath) => ipcRenderer.invoke("git:diff", filePath),
  },
  events: {
    subscribe: (callback) => {
      const listener = (_evt, payload) => callback(payload);
      ipcRenderer.on("runtime-event", listener);
      return () => ipcRenderer.removeListener("runtime-event", listener);
    },
  },
});
