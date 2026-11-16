# Session Host: persistent out-of-process ptys behind a terminal provider interface

**Status:** Accepted (supersedes [0001-main-process-pty-no-daemon.md](./0001-main-process-pty-no-daemon.md))

## Context

Under ADR 0001, every Agent Session's `node-pty` process ran inside WPXen's Electron main process and was torn down when WPXen quit.

WPXen updates by drag-and-replace: the user quits WPXen, drags the new `.app` over the old one in Applications, and reopens it. Every update therefore killed all running Agents and wiped the record that they existed. Even an ordinary quit or main-process crash lost running work and terminal history.

## Decision

1. **Remembered Sessions (`agentSessions` store key).** Session records persist in `wpxen-data.json` as they change (launch, title/transcript pin change, exit). After any quit, crash, or Mac restart, non-live Sessions reappear under their Project as ended, with `Resume` (for Agents with a `resumeFlag` and `transcriptId`, e.g. Claude Code) or `Open Again` in the same folder.
2. **One terminal interface, two providers (`services/terminalProvider.cjs`).** `services/agents.cjs` talks to a single provider contract (`start`, `write`, `resize`, `stop`, `attach`, `clearBuffer`, `getPid`, `onOutput`, `onExit`, plus the host client's optional `markRead`, `onStatus` and `onDisconnect`). Everything above it (status tracking, chat view, notifications, Projects list) is unaware of where the pty runs.
   - **In-app provider:** spawns `node-pty` in the main process (default when `agents.keepRunningOnQuit` is off, and automatic fallback if the Session Host fails to start).
   - **Session Host client (`services/sessionHostClient.cjs`):** talks to a detached **Session Host** process (`services/sessionHost.cjs`) over a `0600` Unix domain socket speaking an additive-only, versioned line-delimited JSON protocol (`docs/features/session-host-protocol.md`).
3. **Thick host.** The Session Host owns the ptys, runs the shared status engine (`services/agentStatus.cjs`), tracks `unread`, and appends each Session's output to a `0600` per-Session history file under `wpxen-session-history/` (folder `0700`, capped at 5 MB keeping the newest bytes).
4. **Detached Electron-as-Node execution.** `services/sessionHostManager.cjs` spawns the Session Host with `process.execPath` and `ELECTRON_RUN_AS_NODE=1` (`detached: true`, `stdio: 'ignore'`, `unref()`), so no system Node installation is required.

### Deliberate departures from Orca's daemon

Orca (`stablyai/orca`) was the reference for a thick background terminal daemon. This design departs from Orca in three ways:

1. **One socket per app version, with no takeover.** Each version binds its own socket (`wpxen-host-<version>.sock`) and never takes over another version's socket (avoiding the socket-takeover race bugs recorded in Orca's daemon history). On launch, WPXen connects to every live host it finds: Sessions started by an older version stay in that older host, while new Sessions start in a host of the running app's version. Dead sockets are unlinked without killing unknown processes on a guess.
2. **Private copy of runtime files in `userData`.** Because drag-and-replace moves the old `.app` bundle to the Trash while an older host is still running, the host must not load scripts or native `.node` addons from inside the app bundle. At launch, WPXen copies `sessionHost.cjs`, `agentStatus.cjs`, `sessionHistory.cjs`, and `node-pty` (`lib/` + `pty.node` + `0755` `spawn-helper`) into `<userData>/wpxen-session-host/<version>/` and starts the host from there. Unused version folders with no live host are deleted on launch.
3. **Fixed 24-hour disconnected limit.** Because WPXen Agents commonly run with permission prompts skipped, a Session Host stops all its Sessions and exits if no WPXen client has connected for 24 hours (`MAX_IDLE_MS`). A host also exits automatically once its last Session ends and no client is connected.

## Alternatives rejected

- **Single shared daemon socket with version takeover:** Rejected because socket handoff / takeover races were a recurring source of bugs in Orca, and drag-and-replace updates make mixed-version coexistence safer via additive-only protocol negotiation (`hello` capabilities).
- **Running the host directly from `app.asar.unpacked`:** Rejected because replacing the `.app` bundle on macOS deletes or moves the old bundle while the host is running.
- **Keeping nginx/PHP-FPM/MySQL or keep-awake running after quit:** Rejected; local web services and `caffeinate` still stop when WPXen quits (the quit dialog warns that Sites go offline).

## Consequences

- Agents (and Floating Workspace terminals) survive quitting, crashing, and drag-and-replace updates when `agents.keepRunningOnQuit` is enabled, with status, unread marks, and 5 MB disk history intact.
- An older host keeps the `agentStatus.cjs` classification logic of the version that started it until its Sessions end.
- If a Session Host fails to start or connect, WPXen falls back to the in-app provider and surfaces a visible notice that Sessions will not survive quitting.
- Quitting with live Agent Sessions and `agents.keepRunningOnQuit` on shows a 3-button dialog (`Keep running and quit` default, `Stop agents and quit`, `Cancel`), respecting `app.confirmOnQuit`.
