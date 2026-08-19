// Pure terminal key/clipboard helpers — no xterm or DOM dependency beyond the
// shape of a KeyboardEvent / ClipboardEvent, so they unit-test in plain Node.
// WPXen is macOS-only, so these implement only the mac branches of Superset's
// platform switches.

// "meta only" — Cmd held, nothing else (Shift excluded).
function metaOnly(e) {
  return e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

// "alt only" — Option held, nothing else.
function altOnly(e) {
  return e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;
}

// "shift only" — Shift held, nothing else.
function shiftOnly(e) {
  return e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
}

// Cmd+A → select all terminal contents (VS Code's mac binding), instead of
// letting ^A reach the shell.
export function isSelectAllChord(e) {
  return e.code === 'KeyA' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

// Translate Mac Cmd/Option arrow, backspace, and newline chords into the byte
// sequences shells/agents expect. Returns the string to send to the pty, or
// null if the chord is not a line-edit translation.
//
// CONTRACT: only match named keys via e.key (Backspace, ArrowLeft/Right,
// Enter) — those are layout-stable. Never match printable characters via
// e.key; those vary by keyboard layout.
export function translateLineEditChord(e) {
  const { key } = e;

  // Shift+Enter and Cmd+Enter both emit ESC+CR — the insert-newline sequence
  // Claude Code's /terminal-setup installs; Codex/Gemini/OpenCode parse it as
  // Alt+Enter. Sent directly so multiline prompts never depend on a terminal
  // handshake.
  if (key === 'Enter' && shiftOnly(e)) return '\x1b\r';
  if (metaOnly(e)) {
    if (key === 'Enter') return '\x1b\r';
    if (key === 'Backspace') return '\x15'; // ^U — kill line
    if (key === 'ArrowLeft') return '\x01'; // ^A — line start
    if (key === 'ArrowRight') return '\x05'; // ^E — line end
  }
  if (altOnly(e)) {
    if (key === 'ArrowLeft') return '\x1bb'; // word back
    if (key === 'ArrowRight') return '\x1bf'; // word forward
  }
  return null;
}

// A chord that must bubble past xterm's key encoder to the browser/Electron
// (clipboard pipeline, app menu accelerators). Ghostty's mac rule: every Cmd
// chord bubbles — Cmd+keys never encode text into the pty. This is what makes
// plain Cmd+C / Cmd+V behave natively in TUIs instead of leaking CSI-u
// sequences.
export function shouldBubbleChord(e) {
  return e.metaKey;
}

// Terminals pad each line to the grid width, so a raw selection copies with
// trailing spaces. Trim per line while preserving intentional newlines.
export function trimSelection(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n');
}

// True when a paste carries a file/image payload (screenshot, copied file) but
// no plain text. xterm's default handler emits empty bracketed-paste markers
// for these, so agents (Claude Code, Codex, opencode) never see the image.
// We instead forward literal ^V so the agent grabs it from the clipboard.
//
// Guard strictly on files.length > 0: a broader "any non-text MIME" check
// over-fires on text/html-only clipboards.
export function isNonTextPaste(e) {
  const data = e.clipboardData;
  if (!data) return false;
  if (data.getData('text/plain')) return false;
  return (data.files?.length ?? 0) > 0;
}

// Shell-escape one or more filesystem paths for insertion at a prompt. Wraps
// each in single quotes, escaping embedded single quotes as '\'' , then joins
// with spaces. (Used by the terminal drag-and-drop handler in Phase 3.)
export function shellEscape(paths) {
  return paths.map((p) => `'${String(p).replace(/'/g, "'\\''")}'`).join(' ');
}
