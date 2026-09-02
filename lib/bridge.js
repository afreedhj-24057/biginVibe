/**
 * Thin, defensive wrapper around the `window.biginVibe` API exposed by the
 * Electron preload script. Falls back to no-ops when not running inside
 * Electron (e.g. plain browser preview) so the renderer never crashes.
 */
function getBridge() {
  if (typeof window !== "undefined" && window.biginVibe) return window.biginVibe;
  return null;
}

export const bridge = {
  get available() {
    return !!getBridge();
  },
  workspace: {
    current: () => getBridge()?.workspace.current(),
  },
  project: {
    pickDirectory: () => getBridge()?.project.pickDirectory(),
    open: (p) => getBridge()?.project.open(p),
    switch: (p) => getBridge()?.project.switch(p),
    close: () => getBridge()?.project.close(),
    current: () => getBridge()?.project.current(),
    recents: () => getBridge()?.project.recents(),
  },
  environment: {
    start: () => getBridge()?.environment.start(),
    stop: () => getBridge()?.environment.stop(),
    restart: () => getBridge()?.environment.restart(),
    status: () => getBridge()?.environment.status(),
  },
  terminal: {
    create: (cols, rows) => getBridge()?.terminal.create(cols, rows),
    write: (id, input) => getBridge()?.terminal.write(id, input),
    resize: (id, cols, rows) => getBridge()?.terminal.resize(id, cols, rows),
    stop: (id) => getBridge()?.terminal.stop(id),
    list: () => getBridge()?.terminal.list(),
  },
  chat: {
    sendMessage: (text) => getBridge()?.chat.sendMessage(text),
    cancel: () => getBridge()?.chat.cancel(),
  },
  git: {
    status: () => getBridge()?.git.status(),
    diff: (path) => getBridge()?.git.diff(path),
  },
  events: {
    subscribe: (cb) => getBridge()?.events.subscribe(cb) || (() => {}),
  },
};
