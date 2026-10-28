# The Office is a one-time native port of claude-agent-verse, not an embedded server

## Context

claude-agent-verse was a finished standalone project: a pnpm/TypeScript monorepo
with a localhost HTTP + WebSocket server, browser and hook bearer tokens, an origin
check, a discovery file, and a browser-tab UI. It showed every live Claude Code and
Antigravity session as a character in a 3D office. Its Claude Code hook ran a
`tsx` forwarder that POSTed each hook event to that server. WPXen wanted the same
product beside Sites and Agents (spec #178). The spec's design interview made five
decisions about how to bring it in. Each one is easy to "fix" back the wrong way
without its reasoning.

## Decision

**1. Native port, not an embedded server.** The engine (registry scanner, transcript
tailers, Antigravity adapter, subagent discovery, poll loop and the pure reducer)
runs inside WPXen's main process as electron-free CommonJS modules under
`electron/services/office/`. Office snapshots reach the renderer over IPC
(`office-start`, `office-update`), and the HUD is rebuilt on WPXen's primitives and
tokens. The server, WebSocket, tokens, origin check and discovery file were deleted,
not ported.

- _Rejected: spawn the standalone server as a child process and show its web UI in a
  webview._ It would have kept upstream parity for free, but at the price of a
  second server with its own port and tokens, a dark-only UI that does not match
  WPXen's chrome, and a TypeScript toolchain in a plain-JS repo. That is the same
  friction that kept the standalone app closed in practice.

**2. Hook transport over a unix domain socket, not HTTP + tokens.** While the engine
runs, the main process listens on `<userData>/wpxen-hook.sock`. The socket is
created owner-only (0600). The forwarder derives that path from its own location,
writes one JSON line, and exits.

- _Rejected: keep the source's localhost HTTP endpoint with a bearer token._ Any
  local process, and any page in a browser, can reach a TCP port. That is why the
  source needed tokens, an origin check, and a discovery file to publish the port
  and token. A socket file with owner-only permissions uses the OS user boundary as
  its authentication, opens no port, and needs no discovery. A missing socket file
  means WPXen is not listening, so the forwarder can exit without trying anything.

**3. The system `node` runs the forwarder, not `ELECTRON_RUN_AS_NODE`.** The hook
command written into `~/.claude/settings.json` is
`'<node>' '<userData>/wpxen-hook-forwarder.cjs' # wpxen`, where `<node>` is the
system node's **absolute path**, resolved once at install through the login-shell
PATH (Claude Code runs hooks with its own PATH, which need not hold an nvm or
Volta node). The forwarder is a dependency-free script copied into userData at
install time. Install refuses with a hint when `node` does not resolve. Pinning
trades one silent failure for a detectable one: if that node is later removed, the
hook breaks, and Settings → Office reports it as needing a reinstall. Entries from
earlier builds wrote a bare `node`; the tag still identifies them.

- _Rejected: run the forwarder with WPXen's own binary under
  `ELECTRON_RUN_AS_NODE`._ It needs no node install, but it bakes the app bundle's
  path into the user's global Claude settings. That path goes stale without any
  signal when the app moves, is reinstalled elsewhere, or is renamed. WPXen has been
  renamed twice. A stale path would break the hook on every tool call of every
  Claude session.

**4. Upgrade WPXen to React 19, rather than downgrade React Three Fiber.** The scene
is written against React Three Fiber v9, drei v10 and react-spring v10, which
require React 19. The renderer upgrade landed first as its own fully verified
ticket (#179). The scene then ported with minimal change.

- _Rejected: port the scene back onto R3F v8 / drei v9, which support React 18._
  That means rewriting a finished, pixel-faithful scene against older APIs. The
  rewrite would put the art direction at risk, and it would leave WPXen one major
  version behind with the upgrade still to do later. Upgrading React put the risk in
  one bounded step, checked against every existing surface.

**5. A one-time port, not a kept-in-sync copy.** From the port onward, the WPXen copy
is authoritative. The standalone repository is free to diverge or be archived. The
source's tests were ported with the code (reducer, scanner, Antigravity adapter, and
hook installer), so the copy verifies itself.

- _Rejected: keep the two in sync._ After decisions 1–4 the copies share almost no
  code: the language, module system, transport and UI layer all differ. Every
  upstream change would need hand-porting, and that ongoing cost would buy nothing
  the product needs.

## Consequences

- The engine lazy-starts on the first Office visit and stays warm until quit.
  Nothing is scanned for a user who never opens the section. The hook socket lives
  only as long as the engine, so hook events from before that first visit are
  dropped and the Office infers waiting from then on.
- The forwarder is a copy, so a fix to `forwarder.cjs` reaches users only when they
  reinstall the hook. Field mapping therefore happens on the receiving side
  (`hookSocket.cjs`), which ships with every app update.
- The hook pins the `node` found at install time. Removing that node (an nvm
  version) or the forwarder breaks the hook until it is reinstalled; Settings →
  Office polls for this and offers Reinstall.
- Hook edits are previewed, then confirmed, then applied: `preview` returns the
  diff of `settings.json` (and of the legacy `~/.claude.json` sweep) and writes
  nothing, `apply` backs up to `.bak`, stages `.tmp` and renames, and refuses if a
  file changed since the preview. `office.hook` is an action row with a
  `settingsRegistry.js` entry and no schema key (the `dns.sudoers` precedent). This
  deliberately deviates from #187's "declared in both the schema and the settings
  registry": there is no stored value to validate, because the state lives in the
  Claude settings file.
- A finished conversation stays in the Office as `ended` for a short linger
  (`ENDED_LINGER_MS`) before a tick removes it, so it is seen to end (spec story 8).
  Its tailers stop immediately.
- The standalone project's hook entries (`# claude-agent-verse`) are a legacy
  generation. WPXen's install and uninstall both remove them, the way WPXen cleans
  up after its own renames.
- Fixes in either codebase stay there. A bug found in the standalone project does
  not reach WPXen unless someone ports it by hand.
