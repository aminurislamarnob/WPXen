# Development Plan — AI Assistant Panel

**Roadmap:** Tier 5 #19 (`docs/features/FEATURES.md`) · _Provided by: Studio (Studio Code)_
**Reference:** [Studio Code](https://developer.wordpress.com/docs/developer-tools/studio/studio-code/)

## Overview & goals

A conversational assistant inside WPHerd that manages local sites: answer questions
about a site, run WP-CLI commands, read/edit theme & plugin files, and inspect
service status — backed by the Claude API with a user-supplied API key. This is the
differentiator feature: only WordPress Studio (Studio Code) ships anything comparable.

## Architecture & approach

- **All Claude API traffic runs in the main process** — the renderer has no HTTP
  client and no key access; it talks to the assistant purely over IPC (chat request
  in, streamed events out), matching the existing progress-channel style.
- **SDK:** `@anthropic-ai/sdk` (new runtime dep, main-process only; JS uses the
  TypeScript SDK). Default model `claude-opus-4-8` with `thinking: {type: "adaptive"}`
  and **streaming** (`client.messages.stream`) — long tool-use turns would otherwise
  hit HTTP timeouts. Model selectable in settings (Opus 4.8 default, Sonnet 5 /
  Haiku 4.5 as cheaper options).
- **Agent loop:** a manual tool-use loop in main (not the SDK tool runner) because we
  need human-in-the-loop approval for write tools — loop on `stop_reason === "tool_use"`,
  execute whitelisted tools, feed `tool_result`s back, forward text deltas to the
  renderer as they stream.
- **Key storage:** Electron `safeStorage` (`encryptString` → base64 under
  `settings.ai.apiKey` in the JsonStore; decrypt on use, never sent to the renderer).
  Refuse to save the key if `safeStorage.isEncryptionAvailable()` is false.

## Main-process work

1. **`electron/services/ai.cjs`** (new):
   - `setApiKey/hasApiKey/clearApiKey` (safeStorage), `getConfig/setConfig`
     (model, per-site scope defaults).
   - `chat(conversationId, siteId, messages, callbacks)` — builds the system prompt
     (WPHerd context: the scoped site's domain/path/PHP version, service status,
     capability descriptions), runs the streaming tool-use loop, invokes
     `callbacks.onDelta(text)` / `onToolUse(tool, input)` / `onDone(finalMessage)` /
     `onError`. Typed error handling chain (`RateLimitError`, `AuthenticationError`
     → "check your API key", `APIConnectionError`) mapped to friendly messages.
   - Conversation history kept in main per `conversationId` (persisted to
     `userData/ai-conversations/` as JSON so chats survive restart); prompt caching
     via `cache_control` on the stable system prompt.
2. **Tool set** (each a `{name, description, input_schema}` + executor; prescriptive
   "call this when…" descriptions):
   - `run_wp_cli` — runs against the scoped site via the existing
     `wordpress.wpAsync(args, sitePath)` (array-argv, injection-safe). Verb
     allowlist v1: read-heavy (`plugin list`, `option get`, `post list`, `db size`,
     …) auto-run; mutating verbs gated behind approval.
   - `read_file` / `write_file` / `list_files` — **path-jailed to the site
     directory** (canonicalize with `fs.realpathSync` + prefix check, reject
     symlink escapes — same posture as `archive.cjs`'s zip-slip guards); size caps
     (read ≤ 256KB, write requires approval).
   - `get_site_info` / `get_service_status` — read from store +
     `computeServiceStatus()` cache. Auto-run.
   - `open_in_browser` (via existing `shell.openExternal` path) — approval-gated.
   - **Approval flow:** approval-gated tool calls pause the loop, emit an
     `ai-approval-request` event to the renderer, and resume on the
     `respond-ai-approval` IPC reply (deny returns a `tool_result` with
     `is_error: true` and the user's reason).
3. **Safety rails:** per-conversation site scoping (tools cannot touch other sites),
   never expose the API key or store secrets to the model, cap tool-loop iterations
   (e.g. 25) per user turn, treat `stop_reason === "refusal"` gracefully.

## IPC / preload

- Handlers: `ai-get-config` / `ai-set-config` (incl. key set/clear — key write-only),
  `ai-list-conversations` / `ai-get-conversation` / `ai-delete-conversation`,
  `ai-send-message` (kicks off `chat`), `ai-cancel` (abort the stream),
  `respond-ai-approval`.
- Event channels (whitelist in `preload.cjs` `VALID_EVENT_CHANNELS`):
  `ai-stream` (payload `{conversationId, type: 'delta'|'tool_use'|'tool_result'|'done'|'error', ...}`),
  `ai-approval-request`.

## Renderer work

- **New "Assistant" page** `src/components/Assistant.jsx` — route in `App.jsx`,
  entry in `Layout.jsx` `NAV_GROUPS` + `PAGE_TITLES`. Modeled on `Mail.jsx`:
  master/detail (conversation list left, chat right), a gating card when no API key
  is set (like Mail's `InstallCard`) linking to settings.
- **Chat pane:** message bubbles; assistant text rendered as **sanitized markdown**
  (no raw HTML injection — plain-text render or a minimal own markdown-to-React,
  never `dangerouslySetInnerHTML` on model output; `Mail.jsx`'s sandboxed-iframe
  pattern is the fallback for rich content). Tool calls render as collapsible
  chips ("Ran `wp plugin list`"); tool output in the fixed `bg-zinc-900` terminal
  style. Approval requests render as an inline Allow / Deny card. Site-scope
  `<select>` at the top of a new conversation.
- **`Settings.jsx`:** "AI Assistant" section — API key field (write-only, shows
  "configured" state), model select, clear-key button.
- **Per-site entry point:** "Ask Assistant" action on `SiteDetail` Overview opening
  the Assistant page pre-scoped to that site.

## Data model

- `settings.ai: { apiKeyEncrypted, model, enabled }` (key never in plaintext).
- Conversations in `userData/ai-conversations/<id>.json`
  (`{id, siteId, title, messages, createdAt}`) + a light index in store — same
  store-list + userData-file pattern as `blueprints.cjs`.

## Testing

- Unit (vitest): path-jail resolver (traversal, symlink, absolute-path escapes),
  WP-CLI verb allowlist classification (auto vs approval vs rejected), system-prompt
  builder, conversation persistence round-trip. Mock the Anthropic client for
  loop tests (tool_use → result → end_turn; approval-deny path; iteration cap).
- Manual: configure a real key; ask "what plugins are on <site>?" (auto tool run);
  ask it to edit a theme file (approval card → allow → file changed); deny a write
  and confirm graceful continuation; kill mid-stream with Cancel; invalid key shows
  the auth error; restart app and reopen the conversation.

## Phased milestones

1. **Phase 1:** key storage + settings UI + `ai.cjs` chat with streaming, no tools
   (pure Q&A with site context in the system prompt).
2. **Phase 2:** read-only tools (`get_site_info`, `run_wp_cli` read verbs,
   `read_file`/`list_files`) — auto-run, tool chips in UI.
3. **Phase 3:** write tools + approval flow (`write_file`, mutating WP-CLI).
4. **Phase 4:** polish — conversation persistence/list, per-site entry point,
   prompt caching, cancel, iteration/token budgets.

**During implementation, load the `claude-api` skill** for current SDK syntax,
model ids, and streaming/tool-use patterns — do not code the API surface from memory.

## Risks & open questions

- **Prompt injection via site content:** file contents and WP-CLI output fed back as
  tool results can contain adversarial text (e.g. inside a plugin README). Mitigations:
  approval gates on all writes, path jail, verb allowlist — the model can be
  influenced, but its blast radius is capped. Document this in the feature's help
  copy.
- **Cost transparency:** show per-conversation token usage (from `response.usage`)
  so users on their own key aren't surprised.
- **BYO-key onboarding friction** is accepted for v1 (Studio bundles auth; we don't
  have a proxy service). A hosted-key option is a business decision, out of scope.
- **`safeStorage` unavailability** (rare keychain issues): refuse key storage with a
  clear message rather than falling back to plaintext.
