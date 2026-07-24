# WPHerd

WPHerd is a macOS menu-bar app that runs local WordPress `.test` sites on top of
Homebrew services. This glossary defines the domain language used across the app.

## Language

**Site**:
A single local WordPress `.test` installation WPHerd manages, backed by a webroot
directory on disk and a database.
_Avoid_: Project, install, instance

**Agent**:
An AI-provider CLI tool (e.g. Claude Code, Codex) that WPHerd can launch in a
terminal scoped to a Site.
_Avoid_: AI tool, provider, bot, assistant

**Agent Launcher**:
The top-level **Agents** section of the app. Its sidebar is a tree of Sites, each
collapsing to the Agents detected on the machine; choosing one spawns it in a
terminal rooted at that Site's directory. WPHerd curates and launches Agents
rather than offering a bare shell.
_Avoid_: Terminal feature, console

**Session**:
One running Agent bound to one Site — a live pseudo-terminal (pty) hosted in the
app's main process, identified by a unique sessionId. A Site may host **many**
concurrent Sessions (any mix of Agents, including several of the same provider);
each is a terminal tab in the Agents pane. A Session survives the main window
hiding to the tray and is torn down when its shell exits or WPHerd quits.
Rendered inline in the Agents section's main pane (embedded, Superset-style —
not a separate window).
_Avoid_: Terminal, process
