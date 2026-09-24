# Recent Project Display Name Investigation

## Existing data model

Recent project records are currently normalized to this shape by
`services/project/ProjectManager.js`:

```js
{
  path: "/absolute/path/to/project",
  name: "project-folder-name",
  lastOpenedAt: "2026-09-24T12:34:56.000Z"
}
```

The persisted file may also contain legacy `openedAt` numeric timestamps;
`ProjectManager._normalizeRecentEntry()` converts those to `lastOpenedAt`.
`name` is derived from `path.basename(path)` and is currently used by the
Welcome card.

## Storage flow

```text
WelcomeScreen
    ↓ props from app/page.js
bridge.project.recents()
    ↓ contextBridge / IPC
project:recents in electron/main.js
    ↓
ProjectManager.getRecentProjects()
    ↓
userData/recent-projects.json
```

When a project is opened, `WorkspaceManager.openProject()` calls
`ProjectManager.openProject()`, which detects the project and calls
`ProjectManager._addToRecents()`. `getRecentProjects()` is also called when
the renderer mounts and after a project is opened, so it is the startup and
refresh source for the Welcome page.

## Relevant files

- `components/Welcome/WelcomeScreen.js`: Welcome page and recent project card.
- `app/page.js`: loads recents, opens a recent path, and owns Welcome errors.
- `services/project/ProjectManager.js`: recent metadata normalization,
  insertion, and JSON persistence.
- `electron/main.js`: `project:recents` and project IPC handlers.
- `electron/preload.js`: exposes `project.recents()` and the new rename bridge.
- `lib/bridge.js`: renderer-side defensive bridge wrapper.
- `services/workspace/WorkspaceManager.js`: authoritative active project; it
  continues to identify the active project by filesystem `path`.
- `app/globals.css`: Welcome card styling and existing inline rename styles.

## Architecture findings

- Persistence is a JSON file under Electron's `app.getPath("userData")`, not
  localStorage or a separate metadata service.
- Recent-project history is shared through `ProjectManager`; the Welcome page
  is currently the only renderer consumer of `project:recents`.
- There is no existing project rename utility. Chat session rename is an
  established UI pattern but uses a different persistence service.
- `name` is not a suitable custom title field because it is regenerated from
  the filesystem path during normalization and insertion.
- Active project identity and all project opening operations remain path-based.

## Recommendation

Extend each existing recent record with an optional `displayName`, preserve it
through normalization and when reopening a project, and add a
`ProjectManager.renameRecentProject(projectPath, displayName)` method. Expose
that method through the existing main-process IPC and preload bridge. The
Welcome card should display `displayName` when present and otherwise fall back
to the existing basename-derived `name`. This requires no migration: old
records without `displayName` remain valid and gain the field only when they
are renamed or subsequently normalized.
