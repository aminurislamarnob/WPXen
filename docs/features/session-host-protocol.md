# Session Host Protocol

The Session Host (`electron/services/sessionHost.cjs`) is a standalone Node server that owns pseudo-terminals (`node-pty`) on behalf of WPXen (`electron/services/sessionHostClient.cjs`). It listens on a private Unix domain socket in the app's data folder and speaks line-delimited UTF-8 JSON (one JSON object per `\n`-terminated line).

## Authentication & Socket Security

- The socket is bound under a restrictive `0o177` umask and explicitly `chmod`ded to `0600` (`rw-------`).
- File-mode `0600` on the Unix domain socket is the authentication boundary, matching the Agents Verse hook socket (`electron/services/office/hookSocket.cjs`).

## Additive-Only Rule (Compatibility Contract)

Because WPXen updates by drag-and-replace and a newer app version connects to live Session Hosts started by older versions:

1. **Every message carries `v`** (integer protocol version, starting at `1`).
2. **Additive only, forever:** new message types and new optional fields on existing requests, replies, or events may be added, but existing message types and fields must **never** be renamed, removed, or given a different meaning.
3. **Unknown fields are ignored** by readers; unknown request types receive `{ v, id, ok: false, error }` without closing the connection or crashing the host.
4. `test/fixtures/session-host-protocol-v1.jsonl` (tested in `test/session-host.test.js`) replays every message of protocol version 1 against `parseClientMessage` and `parseHostMessage` and fails if any message ceases to be understood.

## Client → Host Requests

Every client request is a JSON object with:

| Field  | Type     | Description                                |
| ------ | -------- | ------------------------------------------ |
| `v`    | `number` | Protocol version (`1`)                     |
| `id`   | `number` | Client-chosen request correlation id       |
| `type` | `string` | Request verb (`hello`, `list`, `start`, …) |

Host replies carry `{ v, id, ok: true, ... }` on success or `{ v, id, ok: false, error: "<reason>" }` on error.

### `hello`

Handshakes with the host and discovers its app and protocol versions.

- **Request:** `{ "v": 1, "id": 1, "type": "hello" }`
- **Reply:** `{ "v": 1, "id": 1, "ok": true, "appVersion": "0.6.3", "protocolVersion": 1 }`

### `list`

Lists every Session held by the host.

- **Request:** `{ "v": 1, "id": 2, "type": "list" }`
- **Reply:**
  ```json
  {
    "v": 1,
    "id": 2,
    "ok": true,
    "sessions": [
      {
        "sessionId": "s-1",
        "pid": 4242,
        "cwd": "/Users/me/Sites/shop",
        "startedAt": 1700000000000,
        "exited": false,
        "exitCode": null
      }
    ]
  }
  ```

### `start`

Spawns a new pty in the host (or returns the existing one if `sessionId` is already live).

- **Request:**
  ```json
  {
    "v": 1,
    "id": 3,
    "type": "start",
    "sessionId": "s-1",
    "file": "/bin/zsh",
    "args": ["-il"],
    "cwd": "/Users/me/Sites/shop",
    "cols": 80,
    "rows": 24,
    "name": "xterm-256color",
    "env": { "TERM": "xterm-256color" }
  }
  ```
- **Reply:** `{ "v": 1, "id": 3, "ok": true, "sessionId": "s-1", "pid": 4242 }`

### `write`

Writes UTF-8 input to a live Session's pty.

- **Request:** `{ "v": 1, "id": 4, "type": "write", "sessionId": "s-1", "data": "ls\r" }`
- **Reply:** `{ "v": 1, "id": 4, "ok": true }`

### `resize`

Resizes a live Session's pty grid (`cols` > 0, `rows` > 0).

- **Request:** `{ "v": 1, "id": 5, "type": "resize", "sessionId": "s-1", "cols": 120, "rows": 40 }`
- **Reply:** `{ "v": 1, "id": 5, "ok": true }`

### `attach`

Fetches the buffered terminal output for `sessionId` and its current exit status.

- **Request:** `{ "v": 1, "id": 6, "type": "attach", "sessionId": "s-1" }`
- **Reply:**
  ```json
  {
    "v": 1,
    "id": 6,
    "ok": true,
    "sessionId": "s-1",
    "data": "hello world\r\n",
    "exited": false,
    "exitCode": null
  }
  ```

### `clear-buffer`

Clears the buffered output for `sessionId` (e.g. on `⌘K`).

- **Request:** `{ "v": 1, "id": 7, "type": "clear-buffer", "sessionId": "s-1" }`
- **Reply:** `{ "v": 1, "id": 7, "ok": true }`

### `stop`

Terminates `sessionId` gracefully (`SIGTERM`, escalating to `SIGKILL` after the grace window) and removes it from the host.

- **Request:** `{ "v": 1, "id": 8, "type": "stop", "sessionId": "s-1" }`
- **Reply:** `{ "v": 1, "id": 8, "ok": true }`

### `mark-read`

Updates the Session's `unread` state in the host (`read` defaults to `true`). Also added in #232: `list` and `attach` replies include `state`, `title`, `changedAt`, and `unread`, and `start` accepts optional `agent: boolean`.

- **Request:** `{ "v": 1, "id": 9, "type": "mark-read", "sessionId": "s-1", "read": true }`
- **Reply:** `{ "v": 1, "id": 9, "ok": true, "sessionId": "s-1", "state": "done", "title": "...", "changedAt": 1700000000000, "unread": false }`

## Host → Client Events

Every connected client receives asynchronous events as JSON lines with `v` and `type` (and no `id`).

### `output`

Emitted in order whenever `sessionId`'s pty produces output, never after `exit`.

```json
{ "v": 1, "type": "output", "sessionId": "s-1", "data": "chunk" }
```

### `status`

Emitted whenever a Session's derived `state`, `title`, or `unread` changes (from `agentStatus.cjs` inside the host).

```json
{
  "v": 1,
  "type": "status",
  "sessionId": "s-1",
  "state": "done",
  "title": "Fixed auth",
  "changedAt": 1700000000000,
  "unread": true
}
```

### `exit`

Emitted at most once when `sessionId`'s pty process exits.

```json
{ "v": 1, "type": "exit", "sessionId": "s-1", "exitCode": 0 }
```

## Host Lifecycle

- When a client disconnects, all live Sessions keep running and buffering output.
- When the last Session has ended **and** no client is connected, the host closes its socket, unlinks the socket file, and exits automatically.
