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

### Office

**Office**:
The top-level section that shows every live agent conversation on the machine as a
Character in a 3D office, including conversations WPXen did not start. It only
watches. It never launches, steers or stops an Agent.
_Avoid_: Agent Verse, dashboard, monitor

**Room**:
The part of the Office given to one Agent (Claude Code or Antigravity), with its own
look. Exactly one Room is on screen at a time.
_Avoid_: Floor, tab (the tab only switches Rooms)

**Character**:
One live agent conversation as the Office shows it: a figure at a desk whose pose
shows its Agent State. A Character can be a Session WPXen spawned, or one started in
any other terminal or app.
_Avoid_: Session (a Session is a pty WPXen hosts for a Site; the Office's
code keeps its source project's `Session` name for a Character, but prose says
Character), avatar, agent

**Intern**:
A subagent of a Character, seated beside its parent's desk while the subagent runs.
It leaves when the subagent finishes.
_Avoid_: Child session, helper, sub-character

**Pod**:
The cluster of desks for one Project Key, marked by a floor sign.
_Avoid_: Team, group, cluster

**Project Key**:
The name that groups Characters into a Pod. It is the git repository's name for the
Character's working directory, or the folder's own name when there is no repository.
_Avoid_: Project (the Agents sidebar's Projects are Sites), Site, workspace

**Agent State**:
What a Character is doing: working (with its current tool), thinking, idle, error,
ended, or Waiting on You. An ended Character lingers at its desk for a few seconds
before it leaves, and is not counted as live.
_Avoid_: Status (the Agents section's Session status is a different set: idle,
working, done, needs-input, exited, error)

**Waiting on You**:
The Agent State of a Character blocked on the user, such as a permission prompt or a
question. The Hook reports it exactly. Without the Hook, it is inferred from a tool
call that has run past the waiting threshold.
_Avoid_: Needs input (the Agents section's term for a Session), blocked, paused

**Break**:
A Character idle past the break threshold, which walks from its desk to the lounge
and walks back when it has work again. Being on a Break qualifies idle and is not an
Agent State of its own.
_Avoid_: Away, AFK, sleeping

**Domain Event**:
One observed fact about the machine's agents (a conversation appeared, a transcript
line was written, the Hook fired, a clock tick) that the Office is rebuilt from.
_Avoid_: Message, update, snapshot (a snapshot is the Office after the events)

**Hook**:
The optional Claude Code hook WPXen installs from Settings, so that Claude Code
reports its state the moment it changes and Waiting on You becomes exact instead of
inferred. WPXen shows the change to the Claude settings file and asks before it
writes, and the hook pins the absolute path of the `node` it was installed with.
_Avoid_: Plugin, integration, webhook
