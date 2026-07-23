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
The feature by which WPHerd detects the Agents installed on the user's machine and
spawns a chosen one in a terminal rooted at a Site's directory. WPHerd curates and
launches Agents rather than offering a bare shell.
_Avoid_: Terminal feature, console

**Session**:
One running Agent bound to one Site — a live pseudo-terminal (pty) hosted in the
app's main process. At most one Session per Site; it survives the main window
hiding to the tray and is torn down when WPHerd quits. Rendered inline in the
Site's Agents view (embedded in the main window, Superset-style — not a separate
window).
_Avoid_: Terminal, process, tab
