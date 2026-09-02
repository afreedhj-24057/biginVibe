/**
 * Shared event name constants used across the Node/Electron runtime and the
 * Next.js renderer. Keeping this as a single source of truth avoids typos
 * and documents the full event-driven contract described in the project spec.
 */
const EVENTS = {
  // Project lifecycle
  PROJECT_OPENED: "project.opened",
  PROJECT_CLOSED: "project.closed",
  PROJECT_ERROR: "project.error",

  // Workspace lifecycle (WorkspaceManager — authoritative active-project state)
  WORKSPACE_OPENED: "workspace.opened",
  WORKSPACE_CLOSED: "workspace.closed",
  WORKSPACE_SWITCHED: "workspace.switched",

  // Environment / dev server / redirector
  //
  // NOTE: the dev server no longer has its own separate process/output
  // stream. It now runs INSIDE the integrated Terminal's PTY session (see
  // EnvironmentManager + TerminalManager), so its output is delivered via
  // TERMINAL_OUTPUT below, not a dedicated devserver.log event.
  ENVIRONMENT_STARTING: "environment.starting",
  ENVIRONMENT_STARTED: "environment.started",
  ENVIRONMENT_STOPPING: "environment.stopping",
  ENVIRONMENT_STOPPED: "environment.stopped",
  ENVIRONMENT_ERROR: "environment.error",
  ENVIRONMENT_STATUS: "environment.status",

  // Agent / BigiBot / OpenCode
  AGENT_SESSION_CREATED: "agent.session.created",
  AGENT_THINKING: "agent.thinking",
  AGENT_TOOL_STARTED: "agent.tool.started",
  AGENT_TOOL_COMPLETED: "agent.tool.completed",
  AGENT_FILE_CHANGED: "agent.file.changed",
  AGENT_MESSAGE: "agent.message",
  AGENT_COMPLETED: "agent.completed",
  AGENT_ERROR: "agent.error",

  // Terminal (human) — also the sole execution/output surface for the dev
  // server (see EnvironmentManager).
  TERMINAL_STARTED: "terminal.started",
  TERMINAL_OUTPUT: "terminal.output",
  TERMINAL_EXIT: "terminal.exit",
  // Emitted whenever a Ctrl+C (\x03) byte is written to a terminal session,
  // regardless of whether it came from the user typing it or from
  // EnvironmentManager's Stop button — both cases are the same real signal
  // reaching the same real PTY, so this is the single source of truth for
  // "the foreground process in this session was just interrupted."
  TERMINAL_INTERRUPT: "terminal.interrupt",

  // Preview
  PREVIEW_LOADING: "preview.loading",
  PREVIEW_LOADED: "preview.loaded",
  PREVIEW_ERROR: "preview.error",
};

module.exports = { EVENTS };
