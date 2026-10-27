# Orca vs WPXen — feature comparison

Research date: 2026-10-27. Read-only investigation. Nothing under `referances/`
was modified, installed, built or executed, and no WPXen code was run.

- **Orca** checkout: `referances/orca`, commit `c915be1a223`, package version
  `1.4.214` (`referances/orca/package.json:3`), "Next-gen IDE for parallel
  agentic development" by stablyai. Electron + TypeScript pnpm monorepo.
- **WPXen**: branch `docs/lerd-feature-comparison` at `fbe5e5b` (one docs commit
  past `develop`'s `9498b09`).

**Path convention.** Orca paths are relative to `referances/orca/`. WPXen paths
are relative to the repo root (`electron/…`, `src/…`). `path:line` points at
the declaration (a function, class, IPC handler, type or setting default).
"Doc-only" means the claim comes from Orca's README or
`docs/site/content/docs/**/*.mdx` and was not found in code.

**Method.** Orca has ~32,000 files under `src/` alone, so its code was surveyed
in four parallel read-only passes (workspaces/terminal, agents/status,
git/editor/integrations, browser/CLI/remote). About 30 of the resulting Orca
citations were then re-opened and checked line by line, and all held. Every
WPXen claim was checked directly in `electron/**` and `src/**`. Where the docs
and code disagree, the code wins.

**A note on lineage.** WPXen already borrows heavily from Orca, and says so in
its comments: the title glyph sets (`electron/services/agentStatus.cjs:21`),
keep-awake (`electron/services/keepAwake.cjs:12`), the Claude/Codex chat decoders
(`electron/services/agentChatCodex.cjs:4`, `electron/services/agentChat.cjs:27`),
the handoff prompt wording (`electron/services/handoff.cjs:59-60`), repo-icon
detection (`electron/services/projectIcon.cjs:3`), the clone step
(`electron/services/gitClone.cjs:5`), the floating terminal
(`src/components/FloatingWorkspace.jsx:53`), the terminal link card
(`src/components/LinkActionCard.jsx:8`), the context meter
(`src/lib/contextMeter.js:1-4`) and the editor/browser-in-the-tab-strip layout
(`src/components/AgentsPane.jsx:202-205`). So the remaining gaps are not the
basics of an agent terminal. They are mostly the loops that run _from_ the
agent back into the app.

---

## 1. Summary

- **Agents can drive Orca; they can't drive WPXen.** Orca ships a CLI
  (`bin.orca` → `out/cli/index.js`, `package.json:7-8`) with about 30 command
  groups (`src/cli/specs/index.ts:31`). It talks to the running app over a
  token-authenticated Unix socket RPC (`src/cli/runtime/transport.ts:39`,
  `src/main/runtime/rpc/unix-socket-transport.ts:25`), and Orca installs skills
  that teach agents to use it (`skills/orca-cli`, `skills/orchestration`).
  WPXen has no CLI, no RPC and no MCP server (`README.md:278` lists MCP and
  browser automation as "Future"). Together with the Lerd finding (Lerd H2),
  this is the **highest-value adoption**: a local RPC in the main process that
  backs a `wpxen` CLI and skill first, and an MCP server later. Its first job
  is WordPress: site info, `wp`, DB, logs, mail, browser.
- **Design Mode / browser-to-agent is the most WordPress-relevant feature Orca
  has.** You click an element in the embedded `<webview>` and its HTML,
  computed CSS and a cropped screenshot go into the agent prompt
  (`src/main/browser/browser-manager-grab.ts:15`,
  `src/main/browser/browser-grab-screenshot.ts:22`,
  `src/renderer/src/components/browser-pane/annotate/use-browser-page-annotation-send.ts:16`).
  Orca also captures console and network output over CDP
  (`src/main/browser/cdp-debugger-events.ts:51`), and lets agents drive the
  visible tab through a CDP proxy (`src/main/browser/cdp-ws-proxy.ts:20`).
  WPXen has the same `<webview>` foundation (`electron/services/browser.cjs:146`)
  but nothing flows from the page to the agent. For theme and block work that
  is the gap that matters most.
- **The review loop stops halfway in WPXen.** Orca commits
  (`src/main/git/source-control/commit-changes.ts:6`), pushes and pulls
  (`src/main/git/remote.ts:26,91`), creates PRs on five forges
  (`src/main/ipc/hosted-review.ts:155`) and writes commit messages and PR text
  with a headless agent
  (`src/main/text-generation/commit-message-text-generation.ts:123,131`). Its
  "Annotate AI diffs" feature turns line comments into a prompt for the agent
  (`src/shared/diff-comments-format.ts:31`). WPXen can stage, unstage, discard
  and diff (`electron/services/git.cjs:318,325,334`), and it reads PRs
  (`electron/services/github.cjs:828`). It cannot commit, push, open a PR or
  send review notes.
- **Worktrees are created but never managed.** Orca adds and removes worktrees
  (`src/main/git/worktree-add.ts:183`, `src/main/git/worktree-removal.ts:24`).
  It runs `orca.yaml` setup and archive hooks behind a trust prompt
  (`src/shared/orca-yaml.ts:191`, `src/main/hooks.ts:107`), links or copies
  ignored files into each worktree
  (`src/main/git/worktree-shared-directories.ts:60`,
  `src/main/git/worktree-include-file.ts:16`), and gives each worktree's dev
  server a labeled `*.orca.localhost` hostname
  (`src/main/localhost-worktree-label-proxy.ts:24`). WPXen only creates
  worktrees from Tasks → Start (`electron/services/taskStart.cjs:141-166`) and
  has no list, remove or setup step. The hostname proxy is Orca's version of
  Lerd's "worktree served as a site" (Lerd H5).
- **Status detection.** Orca's primary channel is agent **hooks**. It writes
  hook entries into the global config of about 23 agents (e.g.
  `~/.claude/settings.json`, `src/main/claude/hook-settings.ts:53`). The hooks
  report to a loopback HTTP server
  (`src/main/agent-hooks/server/server-lifecycle.ts:213`). Orca does this **by
  default and without asking** (`agentStatusHooksEnabled: true`,
  `src/shared/default-global-settings.ts:229`). Title parsing and screen rules
  are fallbacks. WPXen derives status from OSC titles, BELs and exit codes only
  (`electron/services/agentStatus.cjs:84,149`). It already has a normalized
  `apply({ state, source })` entry point for hooks (CLAUDE.md, Agents), so an
  **opt-in** hook channel for Claude and Codex is a natural next step. Orca's
  install-without-asking default is not.
- **Don't copy the PTY daemon.** Orca's terminals survive app restarts because a
  separate launchd-registered daemon owns them
  (`src/main/daemon/daemon-main.ts:42`,
  `src/main/daemon/macos-daemon-launchd.ts:122`). It replays saved scrollback
  when the daemon itself died (`src/main/daemon/history-manager.ts:41`). WPXen
  rejected this on purpose (`docs/adr/0001-main-process-pty-no-daemon.md`). The
  cheap middle ground fits that ADR. WPXen already resumes an exited
  conversation with the agent's `--resume` flag
  (`electron/services/agents.cjs:959`). A session-history list that offers
  Resume after a restart gets most of the value without a second process.
- **Navigation is thin.** Orca has a Cmd-P Quick Open over worktree files
  (`src/renderer/src/components/QuickOpen.tsx:39`) and a Cmd-J jump palette over
  worktrees, tabs, sessions, PRs and tasks
  (`src/renderer/src/components/WorktreeJumpPalette.tsx:8`). It also has
  user-editable keybindings (`src/main/keybindings/keybinding-file.ts:27`).
  WPXen's shortcuts are hard-coded (`src/components/Layout.jsx:66`,
  `src/components/AgentsPane.jsx:274-308`). Its only file picker is the chat
  composer's `@` completion (`electron/ipc.cjs:425`).
- **There's no updater.** Orca ships `electron-updater` against GitHub releases
  (`src/main/updater.ts:52`). WPXen has no updater at all; a grep for
  `electron-updater` or `autoUpdater` across `electron/`, `src/` and
  `package.json` finds nothing.
- **Most of Orca's breadth doesn't fit WPXen.** That includes SSH, WSL and cloud
  VMs, the mobile companion with its cloud relay, the plugin marketplace,
  45-agent coverage, per-provider account switching, iOS/Android emulators,
  desktop computer use, cloud-shared artifacts and default-on telemetry. Each
  serves Orca's cross-platform, remote-first, general-purpose model. They don't
  serve a macOS app whose other half is a local WordPress stack.

---

## 2. Platform and architecture differences

| Dimension           | Orca                                                                                                                                                                                                                                         | WPXen                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Platforms           | macOS, Windows, Linux (`config/electron-builder.config.cjs:490-692`); "cross-platform" is a first-class rule (`AGENTS.md`, _First Class Citizens_)                                                                                           | macOS only                                                                                                                                 |
| Code                | TypeScript, electron-vite, pnpm workspaces; Electron 43.8.1 (`package.json:302`)                                                                                                                                                             | Plain JS/JSX, Vite renderer, `.cjs` main; Electron ^43.4.1 (`package.json:84`)                                                             |
| PTY hosting         | Separate detached Node **daemon** (`src/main/daemon/daemon-main.ts:42`), launchd job on macOS (`src/main/daemon/macos-daemon-launchd.ts:122`), NDJSON over a Unix socket (`src/main/daemon/daemon-server.ts:34`); headless xterm per session | `node-pty` **in the main process**, no daemon, 1 MB in-memory ring buffer (`electron/services/agents.cjs:678`; ADR 0001)                   |
| Restart survival    | Warm reattach to the live daemon; cold replay of `userData/terminal-history/<id>/` (`src/main/daemon/history-manager.ts:41`)                                                                                                                 | None by design (ADR 0001). Resume of an exited conversation via `--resume` (`electron/services/agents.cjs:959`)                            |
| Persistence         | SQLite (`node:sqlite`) `profiles/<id>/profile-state.db` (`src/main/persistence/profile-state/profile-state-database-schema.ts:15`)                                                                                                           | `JsonStore` at `userData/wpxen-data.json` (`electron/store.cjs`)                                                                           |
| Status detection    | Managed hooks → loopback HTTP (`src/main/agent-hooks/managed-agent-hook-registry.ts:44`), OSC 7501 (`src/shared/program-status/protocol.ts:121`), titles (`src/shared/agent-title-core.ts:38`), live-updatable screen rules                  | OSC title glyphs + BEL + exit code (`electron/services/agentStatus.cjs:25,84,149`)                                                         |
| Browser             | `<webview>` (`src/renderer/src/components/browser-pane/host-guest/browser-page-webview.ts:55`), CDP for logs/automation, a sidecar Electron for headless serve (`src/main/orcad/electron-serve-browser-process.ts:67`)                       | `<webview>` in a fixed body layer, never re-parented (`src/lib/browser/webviewCache.js`, `electron/services/browser.cjs:146`)              |
| Automation surface  | CLI + JSON RPC over Unix socket / named pipe, WebSocket for remote (`src/cli/runtime/transport.ts:39`, `src/cli/runtime/client.ts:46`); headless `orca serve` (`src/cli/runtime/launch.ts:130`)                                              | None                                                                                                                                       |
| Remote / mobile     | SSH (`ssh2`, deploys `orcad`, `src/main/ssh/orcad-remote-deploy.ts:75`), WSL, cloud VMs, Expo mobile app via LAN or E2E relay (`src/main/runtime/rpc/relay-transport.ts:44`)                                                                 | Local only                                                                                                                                 |
| Extensibility       | Plugins (forked Node workers, `src/main/plugins/plugin-host-process.ts:1`), skills, `orca.yaml`                                                                                                                                              | Data-shaped agent registry (`electron/services/agents.cjs:42`), user agents (`electron/services/settings.cjs:189`), Launch Targets/Presets |
| Agent coverage      | 45 agent ids (`src/shared/tui-agent.ts:1`), config table (`src/shared/tui-agent-config.ts:21`)                                                                                                                                               | 8 built in + shell + user-defined (`electron/services/agents.cjs:42-145,162`)                                                              |
| Telemetry / updates | PostHog, on by default for new installs (`src/main/persistence/loading-store/loaded-cohort-migrations.ts:102-107`); `electron-updater` (`src/main/updater.ts:52`)                                                                            | No telemetry, no updater                                                                                                                   |
| Second product half | None — Orca is a general-purpose agent IDE                                                                                                                                                                                                   | Homebrew nginx/PHP-FPM/MySQL/dnsmasq/Mailpit stack under `procman.cjs`                                                                     |

**What this means for portability:**

- **Ports cleanly** (main-process logic WPXen already has a home for):
  browser element grab and console capture (WPXen owns the guest
  `webContents`), commit/push/PR creation via `git` and `gh` (WPXen already
  depends on `gh`, `electron/services/github.cjs:31`), diff-comment
  formatting, worktree list/remove, Quick Open over `files.listFiles`
  (`electron/services/files.cjs:217`), keybinding overrides, `electron-updater`,
  and a session-history list built on the existing transcript locators
  (`electron/services/transcripts.cjs:233`).
- **Ports with a design decision first**: a local RPC/CLI (needs an ADR beside
  0001: socket location, auth token, what happens when the app isn't running),
  and hook-based status (it writes into files outside the bundle, so it hits
  both the consent principle and the legacy-name rule).
- **Doesn't transfer**: the PTY daemon (contradicts ADR 0001), SSH/WSL/VM
  runtimes, mobile + relay + push gateway (`cloud/`), Windows/Linux packaging,
  plugin marketplace, multi-account credential juggling.

---

## 3. Feature matrix

Status values: **Exists**, **Partial**, **Missing**, **N/A** (doesn't apply to
WPXen's model).

### 3.1 Workspaces and worktrees

| Feature                                 | Orca (how)                                                                                                                                                                  | WPXen   | WPXen evidence                                                                                                                                   | Notes                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Project list / workspace model          | Repos of kind `git \| folder` (`src/shared/repo-kind.ts:3`), each with many worktrees; nestable project groups (`src/shared/project-group-types.ts:3`)                      | Exists  | Agents Projects list of Sites and plain folders (`electron/services/agentProjects.cjs`, `electron/ipc.cjs:482` `agent-folder-add`)               | WPXen's unit is a Site, not a worktree                                                   |
| Create worktree                         | `git worktree add --no-track -b` (`src/main/git/worktree-add.ts:183,224`); IPC `worktrees:create` (`src/main/ipc/worktrees/create/register-worktree-create-handlers.ts:41`) | Partial | Only from Tasks → Start, mode `worktree` (`electron/services/taskStart.cjs:22,141-166`); saved as a Launch Target (`electron/ipc.cjs:722`)       | No "new worktree" outside an issue                                                       |
| Remove / archive worktree               | `git worktree remove` gated on an archive hook (`src/main/git/worktree-removal.ts:24`, `src/main/worktree-archive-hook-gate.ts:10`)                                         | Missing | No `worktree remove` anywhere in `electron/`                                                                                                     | Task worktrees accumulate beside the repo                                                |
| Worktree location and naming            | `~/orca/workspaces` default (`src/shared/constants.ts:84`), `computeWorktreePath` (`src/main/ipc/worktree-logic.ts:62`)                                                     | Exists  | Sibling of the repo named after both (`electron/services/taskStart.cjs:139-141`); branch template setting (`electron/services/settings.cjs:215`) |                                                                                          |
| Setup / archive hooks per repo          | `orca.yaml` `scripts.setup`/`scripts.archive`, `defaultTabs`, `issueCommand` (`src/shared/orca-yaml.ts:191`, `src/main/hooks.ts:107,184`), trust per content hash           | Missing | —                                                                                                                                                | For WP: `composer install`, `npm run build`, DB clone. See H4                            |
| Share/copy ignored files into worktree  | `worktree.sharedDirectories` (`src/main/git/worktree-shared-directories.ts:60`), `.worktreeinclude` (`src/main/git/worktree-include-file.ts:16`), APFS clone                | Missing | —                                                                                                                                                | `wp-config.php`, `uploads/`, `vendor/` are exactly the ignored files a WP worktree needs |
| Fan one prompt to N agents, pick winner | **Doc-only** (`README.md:51`, `docs/site/content/docs/recipes/parallel-agents.mdx` is a manual recipe)                                                                      | Missing | —                                                                                                                                                | Not real in Orca either                                                                  |
| Worktree comment / card status          | Free-text `comment` + status in worktree meta (`src/shared/worktree/meta-types.ts:35`); `orca worktree set --comment` (`src/cli/handlers/worktree.ts:236`)                  | Missing | —                                                                                                                                                | Orca's "checkpoints" are these comments, not snapshots                                   |
| Per-worktree dev-server hostname        | `LocalhostWorktreeLabelProxy` → `*.orca.localhost` (`src/main/localhost-worktree-label-proxy.ts:24`)                                                                        | Missing | —                                                                                                                                                | WPXen's equivalent would be nginx vhosts for worktrees (Lerd H5)                         |
| Listening-port detection                | `scanWorkspacePorts` (`src/main/ports/local-workspace-port-scanner.ts:21`), URLs printed in terminals (`advertised-url-watcher.ts:51`)                                      | Partial | URLs in terminal output are clickable (`src/lib/terminal/sessionCache.js:109`, `src/components/LinkActionCard.jsx`)                              | No port scan                                                                             |
| Disk-space analysis of workspaces       | "Orca Space" window (`src/main/workspace-space-analysis.ts:95`)                                                                                                             | Missing | —                                                                                                                                                | Low                                                                                      |

### 3.2 Agent launching and supported agents

| Feature                          | Orca (how)                                                                                                                                                                                     | WPXen      | WPXen evidence                                                                                                                                | Notes                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Agent registry                   | 45 ids (`src/shared/tui-agent.ts:1`), per-agent config (`src/shared/tui-agent-config.ts:21`)                                                                                                   | Exists     | 8 built in (`electron/services/agents.cjs:42-145`) + Shell (`:162`)                                                                           | Missing notable: Gemini, OpenCode, Amp, Goose, Cline, Droid. Each needs the CLAUDE.md brew check |
| `$PATH` detection                | Filesystem probe after re-reading the login-shell PATH (`src/main/preflight/installed-agent-detection.ts:14`)                                                                                  | Exists     | `resolveShellEnv` + `resolveBin` (`electron/services/agents.cjs:230,315`)                                                                     | Same approach                                                                                    |
| Version probe                    | `<cli> --version`, 5 s timeout (`src/main/agent-cli-version-probe.ts:20`)                                                                                                                      | Missing    | —                                                                                                                                             | Orca uses it only to gate structured chat                                                        |
| One-click install                | None. Undetected agents link to their homepage (`src/renderer/src/components/settings/AgentCatalogRow.tsx:234`)                                                                                | **Exists** | brew/npm/script installers (`electron/services/agents.cjs:424,463,533,592`)                                                                   | WPXen-only                                                                                       |
| User-defined agents              | Not possible; only command/args/env overrides per known id (`src/shared/agent-launch-settings.ts:39`)                                                                                          | **Exists** | `agents.custom` (`electron/services/settings.cjs:189`), command overrides `agents.commands` (`:161`)                                          | WPXen-only                                                                                       |
| Permission presets               | `yolo \| manual \| auto \| mixed` with per-agent flags (`src/shared/tui-agent-permissions.ts:4,12`)                                                                                            | Partial    | Launch Presets per agent (`electron/ipc.cjs:1055-1057`); built-in commands default to bypass flags (`electron/services/agents.cjs:47,95,141`) | WPXen has no named mode switch                                                                   |
| Per-directory launch recipes     | `defaultTabs` in `orca.yaml`; Quick Commands (`src/shared/terminal-quick-command-types.ts:32`)                                                                                                 | Exists     | Launch Targets per Site (`electron/ipc.cjs:1071-1100`, `CONTEXT.md`)                                                                          |                                                                                                  |
| Workspace-trust pre-seeding      | Writes Claude/Codex/Cursor/Copilot/… "trusted folder" records before launch (`src/main/agent-workspace-trust.ts:49`, `src/main/agent-trust-presets.ts:11`)                                     | Missing    | —                                                                                                                                             | Matters when a Start prompt is typed into a first-run trust dialog. See L-list                   |
| Structured launch (SDK/ACP)      | Claude Agent SDK, `codex app-server`, Pi RPC, ACP for Grok/OpenCode/OMP/Antigravity (`src/main/runtime/structured-agent-runtime-registrations.ts:181`, `src/main/acp/acp-launch-specs.ts:297`) | N/A        | WPXen always runs the real TUI in a pty and reads transcripts                                                                                 | A deliberate simplicity win for WPXen; ACP is the thing to watch                                 |
| Auto branch rename on first work | Headless agent names the branch/folder/title (`src/main/agent-hooks/first-work-branch-rename.ts:40`)                                                                                           | Missing    | Branch comes from a template (`electron/services/taskStart.cjs:102`)                                                                          |                                                                                                  |

### 3.3 Agent status, attention and notifications

| Feature                  | Orca (how)                                                                                                                                                                                                                      | WPXen   | WPXen evidence                                                                                                       | Notes                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Status states            | `working \| blocked \| waiting \| done` (`src/shared/agent-status-types.ts:50`)                                                                                                                                                 | Exists  | `idle \| working \| done \| needs-input \| exited \| error` + `unread` (`electron/services/agentStatus.cjs:140-149`) |                                                                   |
| Title-glyph parsing      | `src/shared/agent-title-core.ts:38`, `src/shared/agent-title-status.ts:72`                                                                                                                                                      | Exists  | `TITLE_GLYPHS` (`electron/services/agentStatus.cjs:25`), adapted from Orca (`:21`)                                   |                                                                   |
| Hook-based status        | Hooks for ~23 agents → loopback HTTP + token (`src/main/agent-hooks/managed-agent-hook-registry.ts:44`, `server/server-runtime-env.ts:18`); auto-installed at startup, default on (`src/shared/default-global-settings.ts:229`) | Missing | Entry point ready: `apply({ state, source })` (CLAUDE.md, Agents)                                                    | See M1. Orca asks no consent                                      |
| In-band status protocol  | OSC 7501 "Program Status Protocol" (`src/shared/program-status/protocol.ts:121`)                                                                                                                                                | Missing | —                                                                                                                    | Low; only a few agents emit it                                    |
| Screen/heuristic rules   | Rule engine, live-updated from a GitHub release asset (`src/main/runtime/agent-state-rules/agent-state-rules-live-update.ts:43`)                                                                                                | Missing | —                                                                                                                    | Remote rule updates are a supply-chain surface WPXen doesn't need |
| Native notifications     | `createNotificationDeliveryService`: cooldown, suppress-when-focused, mobile fan-out (`src/main/notifications/notification-delivery-service.ts:42`)                                                                             | Exists  | `createNotifier` (`electron/services/agentStatus.cjs:298`), delivered as `Notification` (`electron/ipc.cjs:816`)     |                                                                   |
| Notification sounds      | 10 built-in sounds or a custom file, volume (`src/shared/notification-settings-types.ts:6`)                                                                                                                                     | Partial | `system \| none` (`electron/services/settings.cjs:179`)                                                              | Low                                                               |
| Dock badge               | Unread count, "99+" cap (`src/main/dock/unread-badge.ts:14`)                                                                                                                                                                    | Exists  | `electron/main.cjs:145-146`                                                                                          |                                                                   |
| Tray attention           | Attention overlay icon (`src/main/tray/system-tray.ts:297`)                                                                                                                                                                     | Exists  | "Agents needing attention" menu (`electron/tray.cjs:26-40`)                                                          | WPXen lists sessions; Orca badges the icon                        |
| Manual mark unread       | `manual-mark-unread` reason (`src/renderer/src/attention/agent-attention-contract.ts:7`)                                                                                                                                        | Exists  | `agent-session-mark` (`electron/ipc.cjs:878`), `markRead` (`electron/services/agents.cjs:1190`)                      |                                                                   |
| Keep awake while working | `AgentAwakeService`, `on \| off \| auto` (`src/main/agent-awake-service.ts:45`)                                                                                                                                                 | Exists  | `electron/services/keepAwake.cjs:157`, `agents.keepAwake` default `off` (`electron/services/settings.cjs:187`)       | Ported from Orca                                                  |
| Agent hibernation        | Stops idle finished agents, relaunches with resume (`src/renderer/src/lib/agent-hibernation-coordinator.ts:287`); experimental                                                                                                  | N/A     | —                                                                                                                    | Exists to save daemon memory; WPXen has no long-lived daemon      |

### 3.4 Chat, transcripts, history and handoff

| Feature                                              | Orca (how)                                                                                                                | WPXen   | WPXen evidence                                                                                                                                                           | Notes                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Chat view over a terminal agent                      | Transcript decoders for Claude/Codex/Grok/OMP, OpenCode via SQLite (`src/main/native-chat/transcript-line-decoders-*.ts`) | Exists  | `electron/services/agentChat.cjs`, decoders `agentChatClaude.cjs` / `agentChatCodex.cjs` / `agentChatAntigravity.cjs`, `src/components/agents/ChatView.jsx`              | WPXen's decoders are ported from Orca's; the Antigravity one is WPXen's own |
| Question cards, model picker, images, slash commands | Doc: `docs/site/content/docs/agents/native-chat.mdx`; attachments `src/main/native-chat/agent-session-attachments`        | Exists  | `src/components/agents/QuestionCard.jsx`, models (`electron/services/agents.cjs:58-62`), `electron/services/chatImages.cjs:34`, `electron/services/chatCommands.cjs:116` |                                                                             |
| Subagent rows                                        | Orca transcript-only fallback (cited in `electron/services/agentChat.cjs:463`)                                            | Exists  | `src/components/agents/SubagentRow.jsx`                                                                                                                                  |                                                                             |
| Session history browser                              | `AI_VAULT_AGENT_SOURCES`, 20 agents (`src/main/ai-vault/session-scanner-agent-sources.ts:89`); resume, reveal, delete     | Missing | Locators exist per agent (`electron/services/transcripts.cjs:42,98,211,233`)                                                                                             | See M3                                                                      |
| Full-text search over transcripts                    | SQLite FTS5 (`src/main/ai-vault-search/session-search-schema.ts:65`)                                                      | Missing | —                                                                                                                                                                        | Low                                                                         |
| Resume a conversation                                | Hibernation and ai-vault relaunch with resume flags                                                                       | Partial | `resumeChatSession` for exited sessions (`electron/services/agents.cjs:959`); pinned `--session-id` (`:49,910`)                                                          | Not available after an app restart (sessions are in memory)                 |
| Handoff to another agent                             | Focused vs full transcript (`src/renderer/src/lib/agent-session-continuation.ts:55`)                                      | Exists  | `electron/services/handoff.cjs:61` (`mode = 'focused'` / `'full'`, `:36,67`), `src/components/agents/HandoffDialog.jsx`                                                  | Ported, plus WPXen's summary-file step (`handoff.cjs:127-162`)              |
| Send text to another agent's terminal                | RPC `terminal.send` (`src/main/runtime/rpc/methods/terminal/terminal-send-method.ts:36`), CLI `orca terminal send`        | Partial | In-app only, `agents.write` (`electron/services/agents.cjs:1158`), chat send (`electron/services/agentChatSend.cjs:18`)                                                  | No path from one agent to another                                           |
| Drag files/images into a prompt                      | Path insert; images become attachments for 8 agents (`src/shared/agent-image-paste.ts:10,23`)                             | Exists  | Terminal drop writes paths (`src/components/Terminal.jsx:128-150`); chat drop (`src/components/agents/ChatView.jsx:729`)                                                 |                                                                             |
| Context meter                                        | `claudeContextWindowHint` (cited in `src/lib/contextMeter.js:1-4`)                                                        | Exists  | `src/lib/contextMeter.js`                                                                                                                                                |                                                                             |

### 3.5 Terminal and layout

| Feature                       | Orca (how)                                                                                                                                             | WPXen   | WPXen evidence                                                                                                      | Notes                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| xterm.js + WebGL              | Lazy WebGL addon (`src/renderer/src/lib/pane-manager/terminal-webgl-addon-loader.ts:19`), kitty keyboard protocol (`terminal-keyboard-protocol.ts:34`) | Exists  | `src/lib/terminal/webgl.js:1`, `package.json:62-68`                                                                 | No kitty keyboard protocol in WPXen              |
| Split panes                   | Two levels of binary split trees (`src/shared/tab-types.ts:7`, `src/shared/terminal-tab-types.ts:88`)                                                  | Exists  | `splitPane` / `setPaneRatio` (`electron/services/agents.cjs:1213,1254`), `src/components/agents/SplitLayout.jsx:16` |                                                  |
| Mixed tab kinds in one strip  | Terminal, editor, diff, browser, simulator tabs (`src/shared/tab-types.ts:18`)                                                                         | Exists  | `file` / `diff` / `browser` tabs beside sessions (`src/components/AgentsPane.jsx:200-205,367,789`)                  | Ported                                           |
| Find in terminal              | `TerminalSearch` (`src/renderer/src/components/TerminalSearch.tsx:32`)                                                                                 | Exists  | `src/components/TerminalSearchBar.jsx:15`, `SearchAddon` (`src/lib/terminal/sessionCache.js:97`)                    |                                                  |
| File and URL links            | `terminal-link-handlers.ts`, OSC 8                                                                                                                     | Exists  | `src/lib/terminal/fileLinkProvider.js`, `src/components/LinkActionCard.jsx:8`                                       | Ported                                           |
| Floating terminal (Cmd+Opt+A) | `src/renderer/src/components/floating-terminal/`                                                                                                       | Exists  | `src/components/FloatingWorkspace.jsx:53,90`                                                                        | Ported; WPXen's also holds browser and note tabs |
| Shell integration             | zsh/bash wrappers, OSC 133 for PowerShell, OSC 7 cwd (`src/main/shell-templates.ts`, `src/main/daemon/osc7-uri-extraction.ts`)                         | Partial | zsh wrapper to put the Site's PHP on PATH (`electron/services/shellIntegration.cjs:23,84`)                          | No OSC 7/133 cwd or prompt marks                 |
| Scrollback across app restart | Daemon + `HistoryManager` (`src/main/daemon/history-manager.ts:41`)                                                                                    | N/A     | ADR 0001                                                                                                            | Deliberate                                       |
| Theme import (Ghostty, Warp)  | `src/main/ghostty/discovery.ts:51`, `src/main/warp-themes/index.ts:60`                                                                                 | Missing | Themes from `src/lib/theme.js`                                                                                      | Low; WPXen follows the Superset tokens           |

### 3.6 Editor, file explorer and search

| Feature                           | Orca (how)                                                                                                                                    | WPXen   | WPXen evidence                                                                          | Notes                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Code editor                       | Monaco (`src/renderer/src/components/editor/MonacoEditor.tsx:54`)                                                                             | Exists  | CodeMirror 6 incl. PHP (`src/components/CodeEditor.jsx`, `package.json:39-49`)          | Different engine, same role                                                         |
| Autosave                          | Built, **off by default** (`src/shared/default-global-settings.ts:51`), though `monaco.mdx` says it's on                                      | Missing | Explicit save with dirty tracking (`src/components/AgentsPane.jsx:210`)                 | Low                                                                                 |
| LSP                               | None                                                                                                                                          | Missing | —                                                                                       | Neither has one                                                                     |
| Markdown preview / rich edit      | `MarkdownPreview.tsx:30`, Tiptap `RichMarkdownEditor.tsx:36`, Mermaid                                                                         | Partial | Notes with Tiptap (`electron/services/notes.cjs:68`, `src/components/NotePane.jsx`)     | No preview of repo `.md` files                                                      |
| PDF, image, CSV, notebook viewers | `PdfViewer.tsx:44`, `MediaViewer.tsx:7`, `CsvGrid.tsx`, `IpynbViewer.tsx:46` with a Python kernel                                             | Missing | —                                                                                       | Low; images are the only one that matters for themes                                |
| File explorer CRUD                | New/rename/duplicate/delete/copy path (`src/renderer/src/components/right-sidebar/file-explorer-row-context-menu.tsx:157-297`), undo/redo     | Partial | create/rename/import (`electron/services/files.cjs:79,89,147,163`)                      | No delete or duplicate found in `files.cjs`                                         |
| Content search (ripgrep)          | Bundled `rg` (`src/main/ripgrep/bundled-ripgrep-path.ts:15`), `fs:search` (`src/main/ipc/filesystem/filesystem-content-search-handler.ts:21`) | Missing | —                                                                                       | Search across `wp-content` is a real need; brew `ripgrep` exists, or use `git grep` |
| Quick Open (Cmd-P)                | `QuickOpen.tsx:39`, ranks by score + recency (`src/shared/quick-open-filter.ts:174`)                                                          | Partial | `@` completion in chat only (`electron/ipc.cjs:425`, `electron/services/files.cjs:217`) | See M2                                                                              |
| Open in external editor           | Doc: editor launcher (`src/main/editor-launcher-name.ts`)                                                                                     | Exists  | `electron/services/externalTools.cjs:111,174`                                           |                                                                                     |

### 3.7 Git, diff, review and PRs

| Feature                                                              | Orca (how)                                                                                                                                                                       | WPXen   | WPXen evidence                                                                                                    | Notes                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Status / stage / unstage / discard                                   | `src/main/ipc/filesystem/filesystem-git-index-handlers.ts:26-132`, bulk variants                                                                                                 | Exists  | `electron/services/git.cjs:245,318,325,334`; multi-repo discovery inside a Site (`:191`)                          | WPXen finds nested plugin/theme repos, which Orca doesn't need |
| Diff viewer                                                          | Monaco `DiffEditor`, side-by-side or inline (`src/renderer/src/components/editor/DiffViewer.tsx:328,344`), combined multi-file diff                                              | Exists  | `@codemirror/merge` (`src/components/DiffView.jsx:13`)                                                            | No combined multi-file view                                    |
| Commit                                                               | `commitChanges` (`src/main/git/source-control/commit-changes.ts:6`); amend is **doc-only**                                                                                       | Missing | No `commit` in `electron/services/git.cjs`                                                                        | Lerd L6 too                                                    |
| Push / pull / fetch / rebase                                         | `src/main/git/remote.ts:26,91,120`, `--force-with-lease` (`:44`)                                                                                                                 | Missing | —                                                                                                                 |                                                                |
| Conflict resolution UI                                               | `ConflictReviewPanel` (`src/renderer/src/components/editor/ConflictComponents.tsx:205`)                                                                                          | Missing | —                                                                                                                 | Low                                                            |
| AI commit message / PR text                                          | Headless agent CLI (`src/main/text-generation/commit-message-text-generation.ts:123,131`, `source-control-local-generation.ts:21`); prompt forbids co-author trailers            | Missing | —                                                                                                                 | Fold into H3                                                   |
| Diff line comments → agent                                           | `DiffComment` (`src/shared/diff-comment-types.ts:23`) → `formatDiffComments` (`src/shared/diff-comments-format.ts:31`) → guarded paste (`active-agent-note-send-delivery.ts:49`) | Missing | —                                                                                                                 | See H3                                                         |
| AI-line attribution gutter                                           | **Doc-only** (`docs/site/content/docs/review/attribution.mdx`)                                                                                                                   | Missing | —                                                                                                                 |                                                                |
| Create PR / MR                                                       | `hostedReview:create` across GitHub/GitLab/Bitbucket/Azure DevOps/Gitea (`src/main/ipc/hosted-review.ts:155`, `src/main/source-control/forge-provider.ts:13-33`)                 | Missing | —                                                                                                                 | `gh pr create` is the cheap path                               |
| PR read (files, checks, timeline)                                    | `src/main/ipc/github-pr-read-handlers.ts:43`                                                                                                                                     | Exists  | `getPull` / `getPullFiles` / `getPullChecks` (`electron/services/github.cjs:828,852,872`)                         |                                                                |
| PR mutations (merge, reviewers, rerun checks, inline review threads) | `src/main/ipc/github-pr-mutation-handlers.ts:57,167`, `github-pr-review-handlers.ts:116`                                                                                         | Missing | Issues are mutable (`electron/services/github.cjs:1212-1281`); PRs are read-only                                  | Medium-low                                                     |
| Check out a PR                                                       | Via the worktree composer                                                                                                                                                        | Exists  | `checkoutPull` (`electron/services/github.cjs:1340`), `applyPullCheckout` (`electron/services/taskStart.cjs:196`) |                                                                |
| "Fix with AI" on a failing check                                     | `check-run-details-fix-with-ai.ts` (UI strings)                                                                                                                                  | Missing | —                                                                                                                 | Cheap once checks are already shown                            |

### 3.8 Issue trackers and forges

| Feature                                | Orca (how)                                                                                                                                                             | WPXen   | WPXen evidence                                                                                         | Notes                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| GitHub issues                          | List/create/update/comment (`src/main/ipc/github-work-item-handlers.ts:47,59`)                                                                                         | Exists  | `electron/services/github.cjs:348,683,1212,1225,1241,1261,1271,1281`                                   |                                             |
| GitHub Projects boards                 | `src/main/ipc/github-project-view-handlers.ts:40-86`                                                                                                                   | Exists  | `listProjects` / `getProject` / `setProjectItemOption` (`electron/services/github.cjs:1090,1097,1147`) |                                             |
| Issue → worktree + agent               | `new-workspace-composer` with `linkedWorkItem` (`src/renderer/src/components/task-page/use-task-page-workspace-actions.ts:19-33`)                                      | Exists  | Tasks → Start (`electron/services/taskStart.cjs:148,169`, `electron/ipc.cjs:724`)                      |                                             |
| GitLab, Bitbucket, Azure DevOps, Gitea | `src/main/ipc/gitlab-merge-request-mutation-handlers.ts:51`, `src/main/bitbucket/client.ts:175`, `src/main/azure-devops/client.ts:173`, `src/main/gitea/client.ts:217` | Missing | GitHub only via `gh` (`electron/services/github.cjs:31`)                                               | Low; most WP plugin/theme work is on GitHub |
| Linear, Jira                           | `src/main/ipc/linear/issue-handlers.ts:56,116`, `src/main/ipc/jira/register-handlers.ts:36`                                                                            | Missing | —                                                                                                      | Low; agencies on Jira may ask               |

### 3.9 Browser

| Feature                              | Orca (how)                                                                                                                                                                                                                                                                               | WPXen   | WPXen evidence                                                                                                      | Notes                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Embedded browser                     | `<webview>`, `webviewTag: true` (`src/main/window/createMainWindow.ts:142`)                                                                                                                                                                                                              | Exists  | `electron/services/browser.cjs:146`, `src/lib/browser/webviewCache.js`                                              | Same engine choice                          |
| Docked DevTools                      | `WebContentsView` dock (`src/main/browser/browser-guest-devtools-dock.ts:16-17`)                                                                                                                                                                                                         | Partial | Detached DevTools (`electron/services/browser.cjs:317`)                                                             |                                             |
| History                              | —                                                                                                                                                                                                                                                                                        | Exists  | `electron/services/browserHistory.cjs`, `electron/ipc.cjs:1158-1167`                                                |                                             |
| Profiles / partitions, cookie import | Per-profile partitions, Chrome/Edge cookie import (`src/main/browser/browser-session-registry.ts`, `browser-client-route-cookie-import.ts`)                                                                                                                                              | Partial | One fixed partition `persist:wpxen-browser` (`electron/services/browser.cjs:108`)                                   | Low; WP sites are local and use magic login |
| **Design Mode (element → prompt)**   | Guest scripts collect HTML, computed style and React source (`src/main/browser/grab-guest-element-context-script.ts:1`), secrets redacted (`browser-grab-payload.ts:11`), cropped screenshot (`browser-grab-screenshot.ts:22,66`), sent as Markdown (`browser-annotation-output.ts:152`) | Missing | —                                                                                                                   | **H2**                                      |
| Console / network capture            | CDP `Runtime.consoleAPICalled`, `Network.requestWillBeSent` (`src/main/browser/cdp-debugger-events.ts:51`, `cdp-navigation-operations.ts:117`)                                                                                                                                           | Missing | —                                                                                                                   | Lerd M2 too                                 |
| Agent-driven automation              | Wraps `agent-browser` against a CDP WebSocket proxy of the visible tab (`src/main/browser/cdp-ws-proxy.ts:20`, `agent-browser-bridge-execution.ts:94`)                                                                                                                                   | Missing | —                                                                                                                   | Needs the RPC from H1                       |
| Scheme guard                         | —                                                                                                                                                                                                                                                                                        | Exists  | `will-navigate` / `will-redirect` guard (`electron/services/browser.cjs:175`), `openExternalSafely` (`safeUrl.cjs`) |                                             |

### 3.10 CLI, automation, orchestration, skills and MCP

| Feature                      | Orca (how)                                                                                                                                                                                                                                                                                             | WPXen   | WPXen evidence                                                                                      | Notes                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| CLI                          | `COMMAND_SPECS` (`src/cli/specs/index.ts:31-60`): worktree, terminal, agent, repo, file, search, browser verbs, automations, orchestration, skills, ports…                                                                                                                                             | Missing | —                                                                                                   | **H1**                                                                        |
| App RPC transport            | Unix socket / named pipe with token from user-data metadata (`src/cli/runtime/metadata.ts:15`, `src/main/runtime/rpc/unix-socket-transport.ts:25`)                                                                                                                                                     | Missing | IPC is renderer-only (`electron/preload.cjs`)                                                       |                                                                               |
| Launch the app from the CLI  | `orca open` (`src/cli/runtime/launch.ts:61`); headless `orca serve` (`:130`)                                                                                                                                                                                                                           | N/A     | —                                                                                                   | WPXen is a menu-bar app that's normally running                               |
| Bundled skills               | `skills/` stubs that load a version-matched guide via `orca skills get` (`src/cli/specs/skills.ts:47`); installed to `~/.agents/skills` + agent dirs with a reviewable plan (`src/main/skills/skill-provider-destinations.ts:36`, `src/renderer/src/components/settings/AgentSkillSetupPanel.tsx:268`) | Missing | —                                                                                                   | The stub-plus-versioned-guide pattern avoids stale skills after an app update |
| Skill sharing (cloud)        | Unlisted revocable links, needs an Orca account (`src/main/skills/skill-cloud-service.ts`)                                                                                                                                                                                                             | N/A     | —                                                                                                   |                                                                               |
| MCP                          | **No MCP server.** Settings edit per-repo `.mcp.json` / `.cursor/mcp.json` (`src/shared/mcp-config.ts`, `src/renderer/src/components/settings/McpConfigSection.tsx:54`)                                                                                                                                | Missing | `README.md:278` ("Future … MCP")                                                                    | Lerd is the MCP reference; Orca is the CLI reference                          |
| Orchestration (multi-agent)  | Runs/tasks/dispatch/inbox/gates in SQLite (`src/cli/specs/orchestration.ts:6-294`, `src/main/runtime/orchestration/coordinator.ts`); experimental                                                                                                                                                      | Missing | —                                                                                                   | Low; heavy machinery                                                          |
| Automations (scheduled runs) | 60 s in-app scheduler, cron/RRULE, precheck command (`src/main/automations/service.ts:48,121`, `src/shared/automations-types.ts:19`)                                                                                                                                                                   | Missing | —                                                                                                   | Plausible later: nightly "update plugins and run tests" on a site             |
| Quick Commands               | Global or per-project terminal commands / agent prompts (`src/shared/terminal-quick-command-types.ts:32`)                                                                                                                                                                                              | Partial | Launch Targets (`electron/ipc.cjs:1071`); Tasks start prompt (`electron/services/settings.cjs:208`) |                                                                               |
| Plugins                      | `orca-plugin.json` manifest, forked workers, marketplace, kill list (`src/main/plugins/plugin-host-process.ts:1`, `examples/plugins/hello-orca/orca-plugin.json`)                                                                                                                                      | N/A     | —                                                                                                   | Not recommended                                                               |
| Computer use (desktop apps)  | AX/CGEvent Swift helper on macOS (`native/computer-use-macos/`, `src/main/computer/computer-sidecar.ts`)                                                                                                                                                                                               | N/A     | —                                                                                                   |                                                                               |
| Artifacts (publish HTML/MD)  | Cloud share links, off by default (`src/main/artifacts/artifact-publisher.ts:74`, `src/shared/default-global-settings.ts:151`)                                                                                                                                                                         | N/A     | —                                                                                                   | WPXen has Cloudflare tunnels for sharing a site                               |

### 3.11 Remote, cloud and mobile

| Feature                      | Orca (how)                                                                                                                                                                 | WPXen   | WPXen evidence | Notes                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------- | ------------------------------------------------------------------------------- |
| SSH worktrees + port forward | `ssh2` + `orcad` deploy (`src/main/ssh/orcad-remote-deploy.ts:75`), `SshPortForwardManager` (`src/main/ssh/port-forwarding/ssh-port-forward.ts:34`)                        | N/A     | —              | WPXen's stack is local by definition                                            |
| WSL                          | `src/main/wsl/wsl-orcad-deploy.ts`                                                                                                                                         | N/A     | —              | macOS only                                                                      |
| Per-workspace cloud VMs      | `environmentRecipes` in `orca.yaml` (`src/main/ephemeral-vm/runtime-service.ts:101`); experimental                                                                         | N/A     | —              |                                                                                 |
| iOS / Android emulators      | `simctl` + `serve-sim`, adb/scrcpy (`src/main/emulator/`, `src/cli/specs/emulator.ts:6`)                                                                                   | N/A     | —              | Mobile previews of a WP site are better served by the in-app browser's viewport |
| Mobile companion             | Expo app (`mobile/package.json:33`), LAN WebSocket RPC or E2E relay (`src/main/runtime/rpc/relay-transport.ts:44`, `e2ee-channel.ts:54`), push gateway (`cloud/apps/push`) | Missing | —              | Not recommended (needs a cloud service)                                         |
| Web client                   | Same renderer served to paired browsers (`src/main/runtime/rpc/static-web-client-handler.ts:26`)                                                                           | N/A     | —              |                                                                                 |

### 3.12 Usage and accounts

| Feature            | Orca (how)                                                                                                                                                                                 | WPXen   | WPXen evidence                                     | Notes                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Token / cost stats | Parses `~/.claude/projects` and Codex sessions with local price tables (`src/main/claude-usage/transcript-file-discovery.ts:7`, `src/main/codex-usage/codex-session-file-discovery.ts:62`) | Partial | Per-chat context meter (`src/lib/contextMeter.js`) | No aggregate view                                                                                |
| Rate-limit display | **Live network calls** with the user's OAuth token (`src/main/rate-limits/claude-oauth-usage-request.ts:19`), every 15 min; contradicts the docs' "No API calls"                           | Missing | —                                                  | Reading OAuth credentials to call private endpoints is a trust step WPXen shouldn't take lightly |
| Account switching  | Separate `CLAUDE_CONFIG_DIR` / `CODEX_HOME` per account (`src/main/claude-accounts/service.ts:20`, `src/main/codex-accounts/service.ts:79`)                                                | Missing | —                                                  | Not recommended                                                                                  |
| Voice dictation    | Offline sherpa-onnx STT (`src/main/speech/stt-worker.ts:1`, `stt-service.ts:17`)                                                                                                           | Missing | —                                                  | Low                                                                                              |

### 3.13 Settings, keyboard, updates and platform

| Feature                       | Orca (how)                                                                                                                      | WPXen   | WPXen evidence                                                                                                            | Notes                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Settings UI                   | ~18 sections (doc: `docs/site/content/docs/settings.mdx`)                                                                       | Exists  | Schema (`electron/services/settings.cjs`), registry + search (`src/lib/settingsRegistry.js`, `src/lib/settingsSearch.js`) | WPXen's validated schema is stricter    |
| Customizable keybindings      | `~/.orca/keybindings.json` with per-platform overrides (`src/main/keybindings/keybinding-file.ts:27`), ~93 actions, recorder UI | Missing | Hard-coded handlers (`src/components/Layout.jsx:66`, `src/components/AgentsPane.jsx:274-308`)                             | Low                                     |
| Jump palette (Cmd-J)          | Worktrees, tabs, sessions, PRs, tasks + quick actions (`src/renderer/src/components/WorktreeJumpPalette.tsx:8`)                 | Missing | —                                                                                                                         | See M2                                  |
| Auto-update                   | `electron-updater` from GitHub releases (`src/main/updater.ts:52`, `config/electron-builder.config.cjs:712-718`)                | Missing | —                                                                                                                         | M4                                      |
| Telemetry                     | PostHog, default on for new installs (`src/main/telemetry/client.ts:147`, `consent.ts:52-62`)                                   | N/A     | None                                                                                                                      | Keep it that way unless opt-in          |
| Crash reports                 | Local Crashpad only, no upload (`src/main/crash-reporting/crashpad-capture.ts:51-53`)                                           | Missing | —                                                                                                                         | Low                                     |
| i18n                          | 7 locales (`src/renderer/src/i18n/locales/`)                                                                                    | Missing | —                                                                                                                         | Low                                     |
| Profiles (separate app state) | `src/main/orca-profiles/profile-storage-paths.ts`                                                                               | N/A     | —                                                                                                                         |                                         |
| Memory monitor                | Process-tree snapshot + Swift footprint helper (`src/main/memory/collector.ts:49`, `native/process-footprint-macos/main.swift`) | Missing | —                                                                                                                         | Low; could cover FPM/MySQL children too |

---

## 4. Recommendations

Effort: **S** about a day, **M** a few days, **L** a week or more.

### High

**H1. A local app RPC with a `wpxen` CLI and bundled skill, and the same backend
later serving MCP.** — Effort **L** (an MVP of read-only commands is **M**)

- _Why:_ the README's positioning is agents as "first-class development
  participants" (`README.md:285-287`). Today an agent in a WPXen session can't
  ask WPXen anything. Orca proves the CLI route works well for TUI agents: a
  token-authenticated socket, one spec table (`src/cli/specs/index.ts:31`), and
  thin skill stubs that fetch a guide matching the installed version, so
  skills never go stale after an update (`skills/orca-per-workspace-env/SKILL.md`,
  `src/cli/specs/skills.ts:47`). Lerd proves the MCP route (Lerd report H2).
  Both can be front ends to one main-process RPC.
- _First commands, WordPress first:_ `site info` (URL, PHP version, DB name),
  `wp …` (through `wpAsync` with the site's PHP), `db snapshot|restore` (Lerd
  H1), `logs tail`, `mail wait|links` (`electron/services/mailpit.cjs`),
  `browser console|screenshot` (from H2), and `session list|send|wait` (Orca's
  `terminal.send`, `src/main/runtime/rpc/methods/terminal/terminal-send-method.ts:36`).
- _Touches:_ a new electron-free `services/rpcServer.cjs` (socket + token +
  dispatch table, testable under plain Node), `main.cjs` to start and stop it,
  a small `bin/wpxen` client, and `agents.cjs` to export `WPXEN_RPC_SOCKET` into
  session env next to the PHP PATH (`electron/services/shellIntegration.cjs:84`).
  It needs an ADR beside `0001`.
- _Constraints:_
  - No module-scope `require('electron')` in the RPC module, and the ratchet
    test allowlist must not grow.
  - The socket path, env var, skill folder and any `~/.claude/skills/wpxen`
    files carry the name outside the bundle, so make them named constants
    beside a `LEGACY_*` list (rename rule).
  - Installing skills into agent folders must be click-to-consent with a
    preview, following Orca's plan/dry-run/backup model
    (`src/renderer/src/components/settings/AgentSkillSetupPanel.tsx:268`).
    WPXen never installs unprompted.
  - Anything that mutates (`wp`, `db restore`) needs the same consent bar as
    Lerd's `confirm: true`.

**H2. Browser → agent: element grab ("Design Mode") plus console/network
capture.** — Effort **M**

- _Why:_ this is the half of "a site and the agent working on it sit side by
  side" that is still missing. For block themes and plugins, "this button's
  padding is wrong" is the commonest prompt. Orca's pipeline is the model:
  inject a picker script, collect `outerHTML` + computed styles, crop a
  `capturePage` screenshot, redact secrets, and paste Markdown into the agent
  (`src/main/browser/grab-guest-element-context-script.ts:1`,
  `browser-grab-payload.ts:11`, `browser-grab-screenshot.ts:22`,
  `browser-annotation-output.ts:152`). WordPress adds context Orca can't: block
  name from `wp-block-*` classes, the template part, and the theme file that
  likely owns it.
- _Touches:_ `browser.cjs` (guest `webContents.executeJavaScript`,
  `capturePage`, `debugger.attach` for `Runtime.consoleAPICalled`),
  `BrowserToolbar.jsx` (a "Pick element" toggle), and delivery through
  `agentChatSend.sendChat` (`electron/services/agentChatSend.cjs:18`, which
  already handles images) or `agents.write`.
- _Constraints:_
  - The webview must never be re-parented. An in-page picker overlay is fine,
    but anything the pane draws over the page must call `setCovered`.
  - IPC three-place rule.
  - `sanitizeUrl` and `PARTITION` stay in sync.
  - The payload formatter should be a pure function, tested without a DOM.
  - Keep the screenshot in the existing chat-image temp dir
    (`CHAT_IMAGE_PREFIX`, `electron/services/chatImages.cjs:9`) so cleanup
    already covers it.

**H3. Close the review loop: commit, push, open PR, and send diff notes to the
agent.** — Effort **M**

- _Why:_ the Changes pane shows what the agent did but can't finish the job.
  Orca's minimal set is commit (`src/main/git/source-control/commit-changes.ts:6`),
  push with `--force-with-lease` (`src/main/git/remote.ts:26,44`), PR create
  (`src/main/source-control/hosted-review-creation.ts:245`), and line notes
  formatted as `File / Line(s) / User comment` and pasted into the active agent
  with only unsent notes going out (`src/shared/diff-comments-format.ts:31`,
  `src/renderer/src/components/editor/DiffNotesSendMenu.tsx:53`). An optional
  "generate message" can run the session's own agent headless, as Orca does
  (`src/main/text-generation/source-control-local-generation.ts:21`).
- _Touches:_ `git.cjs` (`commit`, `push`, using the existing `runMutate`,
  `electron/services/git.cjs:293`), `github.cjs` (`gh pr create`), the Changes
  pane in `FileExplorer.jsx`, `DiffView.jsx` (gutter notes), and `agents.write`
  with bracketed paste (the terminal already knows the mode,
  `src/components/Terminal.jsx:145`).
- _Constraints:_
  - Superset primitives only (`Button`, `.settings-row`). Note markers use
    `highlight`, not `accent`.
  - IPC three places.
  - Respect the user's git identity and don't add trailers by default. Orca
    deliberately forbids co-author lines in generated messages
    (`src/shared/commit-message-generation.ts:46`).

**H4. Worktree lifecycle for Tasks: list, remove, setup hook, shared files.** —
Effort **M** (**L** together with Lerd H5's serving)

- _Why:_ `taskStart.cjs` creates sibling worktrees but nothing cleans them up.
  A WordPress worktree is also useless without its ignored files
  (`wp-config.php`, `wp-content/uploads`, `vendor/`, `node_modules/`). Orca
  solves both with `git worktree remove` gated on an archive hook
  (`src/main/git/worktree-removal.ts:24`), `sharedDirectories` symlinks and
  `.worktreeinclude` copies (`src/main/git/worktree-shared-directories.ts:60`,
  `src/main/git/worktree-include-file.ts:16`), and setup scripts that need trust
  approval, keyed by content hash (`src/shared/orca-yaml-hook-types.ts`).
- _Shape:_ a per-Site "worktree recipe" stored on the Site record next to Launch
  Targets: files to link or copy, and a setup command run in a visible
  Floating Workspace terminal (`launchFloating` with `command`,
  `electron/services/agents.cjs:991`). A committed `wpxen.json` is an
  alternative, but trust-gate it the way Orca gates `orca.yaml`. Removal checks
  for dirty state, drops the Launch Target, and later drops the worktree's
  vhost and DB (Lerd H5).
- _Touches:_ `taskStart.cjs`, `git.cjs`, `ipc.cjs` + `preload.cjs`, the Launch
  Targets dialog, and `nginx.cjs`/`mkcert.cjs`/`siteops.cjs` once worktrees are
  served.
- _Constraints:_ a committed config filename is a name-carrying artifact
  (rename rule). Running repo-provided commands needs explicit, remembered
  consent.

### Medium

**M1. Opt-in hook-based status for Claude Code and Codex.** — Effort **M.** Add
a loopback HTTP listener with a per-launch token, passed in session env the way
Orca passes `ORCA_AGENT_HOOK_PORT` / `ORCA_AGENT_HOOK_TOKEN`
(`src/main/agent-hooks/server/server-runtime-env.ts:18`). Write hook entries
for `Stop`, `UserPromptSubmit` and `PermissionRequest`
(`src/main/claude/claude-managed-hook-events.ts:9`) and map them onto
`agentStatus.apply({ state, source: 'hook' })`, keeping OSC titles as the
fallback. Two differences from Orca:

- WPXen asks first. Orca installs on startup with the setting defaulted on
  (`src/shared/default-global-settings.ts:229`,
  `src/main/agent-hooks/managed-agent-hook-startup.ts:10`).
- WPXen removes its entries cleanly when the setting is turned off.

Constraints: the setting needs both `settings.cjs` and `settingsRegistry.js`.
The hook marker and script directory are name-carrying edits to
`~/.claude/settings.json` and `~/.codex/hooks.json`, so put the constants by a
`LEGACY_*` list. Two WPXen generations must not leave duplicate hooks behind,
which is the same failure mode as the mu-plugins. The listener module stays
electron-free.

**M2. Quick Open (Cmd-P) and a jump palette (Cmd-J).** — Effort **M.** Cmd-P
fuzzy-matches the active Site's files, reusing `files.listFiles`
(`electron/services/files.cjs:217`), with Orca's score + recency ranking
(`src/shared/quick-open-filter.ts:174`) as a pure, testable function. Cmd-J
jumps across Sites, Sessions (with status glyphs), open tabs and Tasks, plus
quick actions: new session, open site in browser, wp-admin, magic login. The
Lerd report also found no palette. Constraints: the panel styling is
`.panel`/`popover` and must paint above the webview layer (`z-50`). Shortcut
handling must coexist with webview key interception
(`electron/services/browser.cjs:265`).

**M3. Session history with Resume after restart.** — Effort **M.** List past
transcripts for the active Site from the existing locators
(`electron/services/transcripts.cjs:42,98,211`). Offer Resume, which launches
with the agent's `resumeFlag` and the transcript id (the path
`resumeChatSession` already uses, `electron/services/agents.cjs:959`), and
Reveal in Finder. This is Orca's ai-vault
(`src/main/ai-vault/session-scanner-agent-sources.ts:89`) scaled down. It gives
most of the "survives restart" value the ADR deliberately gave up, without a
daemon, so it **fits ADR 0001 rather than reversing it**. The ADR itself says
moving to restart survival "means introducing a daemon"; this avoids that.
Constraint: chat fixtures copy shapes, not content (CLAUDE.md Testing), and run
`WPXEN_REAL_TRANSCRIPTS=1` after touching locators.

**M4. Auto-update.** — Effort **M.** `electron-updater` with the GitHub
provider, as Orca does (`src/main/updater.ts:52`,
`config/electron-builder.config.cjs:712-718`). This repeats Lerd L5. It needs
signing and notarization in the release flow, and lazy-requiring
`electron-updater` keeps it out of tested modules.

**M5. Dev-server port and URL detection for block builds.** — Effort **S–M.**
When an agent runs `npm start` / `wp-scripts start` in a Session, notice the
advertised URL or listening port (Orca:
`src/main/ports/advertised-url-watcher.ts:51`,
`local-workspace-port-scanner.ts:21`) and offer "Open in browser tab".
Terminal URLs are already clickable (`src/lib/terminal/sessionCache.js:109`),
so this is mostly the watcher.

### Low

- **L1. Workspace-trust pre-seeding** for Claude and Codex before a Tasks Start
  types its prompt, so a first-run "trust this folder?" dialog can't swallow
  it (Orca: `src/main/agent-trust-presets.ts:11`,
  `src/main/claude/claude-folder-trust-file.ts:95`). It writes outside the
  bundle (`~/.claude.json`, `~/.codex/config.toml`), so it's opt-in and
  disclosed. **S.**
- **L2. More agents**: Gemini CLI, OpenCode, Amp, Goose. Each needs the
  CLAUDE.md `brew info` artifact check before an `installer` is added. **S**
  each.
- **L3. PR mutations**: merge, request reviewers, rerun failed checks, and "Fix
  with AI" that sends a failing check's log to the session (Orca:
  `src/main/ipc/github-pr-mutation-handlers.ts:57,167`). **S–M.**
- **L4. Customizable keybindings**: a JSON overrides file validated through the
  settings schema rather than a separate file (Orca:
  `src/main/keybindings/keybinding-file.ts:27`). **M.**
- **L5. Content search** across the Site with `git grep` or brew `ripgrep`
  (Orca bundles `rg`, `src/main/ripgrep/bundled-ripgrep-path.ts:15`). WPXen
  doesn't bundle binaries, so prefer `git grep` with a walk fallback. **S–M.**
- **L6. Repo Markdown preview** (README, `readme.txt`) using the Notes Tiptap
  renderer. **S.**
- **L7. Notification sound choice** beyond `system | none`. **S.**
- **L8. A worktree/session status comment** an agent can set through the CLI
  (Orca's `comment` field, `src/shared/worktree/meta-types.ts:35`). It only
  makes sense after H1. **S.**

**Not recommended:**

- **The PTY daemon and cold scrollback restore.** ADR 0001 deliberately
  rejected them, and M3 covers the user need.
- **Remote and multi-platform reach:** SSH, WSL, cloud VMs, the mobile
  companion with its relay and push services, and the web client.
- **Extension and sharing machinery:** the plugin marketplace, cloud artifacts
  and skill sharing.
- **Account switching and OAuth-backed rate-limit polling.** These read user
  credentials to call private endpoints.
- **Default-on telemetry.**
- **Desktop computer use and emulators.**
- **Orchestration DAGs and live-updated screen rules.** They are heavy, and the
  remote rule fetch is a supply-chain surface.
- **Structured SDK/ACP launch paths.** WPXen's "real TUI + transcript" model is
  simpler and already works across agents. Revisit ACP only if transcripts stop
  being readable.

---

## 5. What WPXen has that Orca doesn't

- **The whole WordPress/service half.** WPXen runs a supervised Homebrew stack
  (nginx, PHP-FPM per version, MySQL, Mailpit) as app children
  (`electron/services/procman.cjs`), with dnsmasq `.test` DNS, mkcert HTTPS,
  phpMyAdmin auto-login, and Cloudflare tunnels with WordPress URL rewriting.
  It also has the WP install wizard, plugin/theme/core management, magic
  login, export/import including `.wpress`, clone, change-URL and Blueprints
  (see the Lerd report §5 for citations). Orca has no notion of a served site.
  The nearest thing is its `*.orca.localhost` proxy.
- **One-click agent CLI install** through brew, npm or a vendor script, with
  the guardrails stated in the UI (`electron/services/agents.cjs:424-592`).
  Orca links to homepages (`src/renderer/src/components/settings/AgentCatalogRow.tsx:234`).
- **User-defined agents** with their own id and command
  (`electron/services/settings.cjs:189`). Orca allows overrides only for known
  ids (`src/shared/agent-launch-settings.ts:39`).
- **An Antigravity transcript decoder for the chat view.** WPXen's comment
  notes Orca has none (`electron/services/agentChatAntigravity.cjs:4`). Orca
  drives Antigravity through ACP instead (`src/main/acp/acp-launch-specs.ts:297`).
- **The handoff summary step.** The source agent writes a summary file that the
  target reads (`electron/services/handoff.cjs:127-162`), on top of Orca's
  focused/full prompt.
- **Per-Site PHP on the session's PATH** (`electron/services/shellIntegration.cjs:84`),
  so `php`, `composer` and `wp` in a session match the site.
- **Multi-repo discovery inside one Site.** The Changes pane finds nested
  plugin and theme repos under `wp-content` (`electron/services/git.cjs:160-191`).
- **Consent-first defaults throughout.** WPXen installs no hooks, writes nothing
  into agent configs, sends no telemetry, and keeps keep-awake off by default
  (`electron/services/settings.cjs:184-187`). Orca defaults hooks and telemetry
  on.
- **One process, no daemon.** Nothing keeps running after quit. That makes
  WPXen's failure surface far smaller than Orca's daemon/socket-ownership
  protocol (`src/main/daemon/AGENTS.md`).

---

## 6. Open questions and unverified claims

**Orca claims that are doc-only or contradicted by code:**

- "Fan one prompt across five agents … merge the winner" (`README.md:51`) has
  no code. The recipe (`docs/site/content/docs/recipes/parallel-agents.mdx`) is
  manual.
- AI-line attribution gutter (`docs/site/content/docs/review/attribution.mdx`),
  commit amend (`commit-push.mdx`), and image-diff swipe/onion modes have no
  code. `ImageDiffViewer.tsx:88` offers only side-by-side and stacked.
- Autosave: `monaco.mdx` says files save on blur and idle, but
  `editorAutoSave` defaults to `false` (`src/shared/default-global-settings.ts:51`).
- Usage tracking: `usage-tracking.mdx` says "No API calls", but rate limits are
  fetched live from provider endpoints
  (`src/main/rate-limits/claude-oauth-usage-request.ts:19`,
  `codex-backend-usage-client.ts:69`).
- The MCP section is documented under "Settings → Integrations → MCP" but is
  mounted in the per-repository settings pane (`McpConfigSection.tsx:54`).
- `hooks-memory.mdx` describes reading repo `.claude/` / `.codex/` memory. That
  is the agents' own behaviour, not Orca code.

**Not traced in depth:** mobile app internals (`mobile/`), the `cloud/`
services, plugin API capabilities beyond the example manifest, orchestration
semantics, Windows and Linux code paths, and whether Orca's onboarding tells
the user before it auto-installs agent hooks. Line numbers were not pinned for
a few Orca files cited by name only (e.g. `browser-session-registry.ts`,
`coordinator.ts`, `McpConfigSection.tsx` callers).

**WPXen doc drift found while verifying:**

- `CONTEXT.md` (_Agent Launcher_) describes the sidebar as "a tree of Sites,
  each collapsing to the Agents detected". The code is a Projects list of
  Sites _and plain folders_ with Sessions under each
  (`electron/services/agentProjects.cjs`, `electron/ipc.cjs:482,508`), as
  CLAUDE.md describes.
- `README.md:278` still lists "agent workspaces" as future. The Agents section
  ships them (the Lerd report noted the same for `FEATURES.md`).

**Design questions before building H1, M1 and H4:**

- RPC transport and auth: a Unix socket in `userData` with a token file, as
  Orca does, or a loopback HTTP port that an MCP server could reuse? What does
  the CLI do when WPXen isn't running? Orca has `orca open`; WPXen could
  launch itself, but it starts all services on launch.
- Should the `wpxen` skill be installed globally (`~/.claude/skills`) or
  injected per session through env and flags only, so nothing lands in the
  user's repo or home without a click?
- Hooks vs titles: is the extra accuracy worth editing `~/.claude/settings.json`,
  which the user also edits by hand? Orca guards this with merge logic
  (`src/main/claude/hook-settings.ts:53`). WPXen would need the same care plus a
  clean uninstall.
- Worktree recipes: stored on the Site record (private, no trust prompt) or a
  committed file (shareable, needs trust gating)? And what is the DB model for
  served worktrees (Lerd report's open question)?
