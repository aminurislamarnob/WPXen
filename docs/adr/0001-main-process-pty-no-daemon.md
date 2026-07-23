# Agent Sessions run as main-process ptys, with no persistence daemon

## Context

WPHerd is adding an Agent Launcher: a per-Site terminal that runs an AI-provider
CLI (Claude Code, Codex, …) in a pseudo-terminal (pty) scoped to the Site's
webroot. The reference implementation, Superset (`reference/superset-main`), runs
its ptys in a standalone `pty-daemon` process that outlives the app, with a
cross-process session protocol so terminals survive an application restart.

## Decision

Each Session's pty is spawned by `node-pty` **inside WPHerd's Electron main
process** — supervised alongside the existing services — rather than in a separate
long-lived daemon. A Session survives the window hiding to the tray (the main
process stays alive), but is **torn down when WPHerd quits**. Reattach after a
window reopen is served by an in-memory ring buffer replayed into a fresh xterm,
not by a persistent cross-process protocol.

## Consequences

- No Session survives a full app restart — an accepted loss, and arguably safer for
  a local tool than leaving agents running unattended across restarts.
- Quitting while a Session is live is the one destructive moment, so quit confirms
  when Sessions are active and then terminates them gracefully.
- Moving to Superset-style restart-survival later means introducing a daemon and a
  reconnection protocol — a real refactor. We chose to defer that entire second
  process rather than build it speculatively.
