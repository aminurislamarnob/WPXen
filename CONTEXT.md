# WPXen

WPXen is a macOS menu-bar app that runs local WordPress `.test` sites on top of
Homebrew services. This glossary defines the domain language used across the app.

## Language

**Site**:
A single local WordPress `.test` installation WPXen manages, backed by a webroot
directory on disk and a database.
_Avoid_: Project, install, instance

**Agent**:
An AI-provider CLI tool (e.g. Claude Code, Codex) that WPXen can launch in a
terminal scoped to a Site.
_Avoid_: AI tool, provider, bot, assistant

**Agent Launcher**:
The top-level **Agents** section of the app. Its sidebar is a tree of Sites, each
collapsing to the Agents detected on the machine; choosing one spawns it in a
terminal rooted at that Site's directory. WPXen curates and launches Agents
rather than offering a bare shell.
_Avoid_: Terminal feature, console

**Session**:
One running Agent bound to one Site — a live pseudo-terminal (pty) hosted in the
app's main process, identified by a unique sessionId. A Site may host **many**
concurrent Sessions (any mix of Agents, including several of the same provider);
each is a terminal tab in the Agents pane. A Session survives the main window
hiding to the tray and is torn down when its shell exits or WPXen quits.
Rendered inline in the Agents section's main pane (embedded, Superset-style —
not a separate window).
_Avoid_: Terminal, process

**Launch Preset**:
An Agent's **global** default flags, applied on every launch in any Site (e.g.
`claude --dangerously-skip-permissions`). Stored per-Agent under `agentPresets`
and appended to the command typed into the Session's shell. A Launch Target can
override it.
_Avoid_: Config, profile

**Launch Target**:
A **per-Site** saved launch recipe pinning a directory the Agent starts in — a
webroot subfolder (`wp-content/plugins/foo`) or an absolute path such as a git
worktree beside the webroot — plus optional flags that override the Agent's
Launch Preset. Stored on the Site record (`launchTargets`) so it travels with
the Site and is reclaimed on delete. Chosen from the Agents pane's "New session"
menu; the webroot with the Launch Preset is the default when none is picked.
_Avoid_: Preset (that's the global default), workspace, task
