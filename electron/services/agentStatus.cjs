'use strict';

// Session status engine — one tracker per agent Session, fed the raw pty
// output. It lives beside the pty in the main process (ADR 0001), so a Session
// whose terminal isn't mounted — every background one — is still tracked.
//
// Pure: no electron, no timers, no I/O. The session manager feeds it bytes and
// reads snapshots back, which is what makes it testable.
//
// States:
//   idle     — at rest and never seen working (a fresh agent, a plain shell)
//   working  — the agent's title shows it busy
//   done     — it was working and has come to rest: there's output to review
//   exited   — the session's shell exited cleanly
//   error    — the session's shell exited non-zero
//
// Evidence arrives as normalized `{ state, source }` events. Today the sources
// are the terminal title and process exit; agent hooks can be added later as
// another source without touching anything downstream.

// Title glyph sets, adapted from Orca (stablyai/orca, agent-title-core.ts).
// Data, not logic: Claude Code has changed its spinner between releases
// (braille → quarter circles in 2.1.228), so extend these rather than the
// classifier.
const TITLE_GLYPHS = {
  working: [
    /^[\u2800-\u28ff]/, // braille spinner (Claude Code, many CLIs)
    /^[\u25d0-\u25d3]/, // ◐◑◒◓ quarter-circle spinner (Claude Code ≥ 2.1.228)
    /^[\u2726\u23f2]/, // ✦ ⏲ Gemini busy
    /^\. /, // ASCII fallback
  ],
  idle: [
    /^\u2733/, // ✳ Claude Code at rest
    /^\u25c7/, // ◇ Gemini at rest
    /^\* /, // ASCII fallback
  ],
  permission: [/^\u270b/], // ✋ Gemini awaiting approval
};

// Keyword fallbacks for agents that spell their state out. Only consulted for
// agent sessions — a plain shell's title is a path, and "~/done" is not done.
const B = (words) => new RegExp(`(?<![\\w./\\\\-])(?:${words})(?![\\w-])`, 'i');
const TITLE_KEYWORDS = [
  ['permission', B('action required|permission|waiting')],
  ['working', B('working|thinking|running')],
  ['idle', B('ready|idle|done')],
];

// Raw terminal title → 'working' | 'idle' | 'permission' | null (no signal).
function classifyTitle(raw, { keywords = true } = {}) {
  const t = String(raw || '').trim();
  if (!t) return null;
  for (const kind of ['working', 'idle', 'permission']) {
    if (TITLE_GLYPHS[kind].some((re) => re.test(t))) return kind;
  }
  if (keywords) {
    for (const [kind, re] of TITLE_KEYWORDS) if (re.test(t)) return kind;
  }
  return null;
}

// Terminal titles are capped well above anything an agent sets; a runaway OSC
// (a binary dumped to the terminal) must not grow the accumulator unbounded.
const MAX_OSC = 4096;

const ESC = '\x1b';
const BEL = '\x07';

// Strip the leading status glyph(s) an agent prefixes its title with (Claude's
// ✳ / spinner, Gemini's ✦), so what's left reads as the session's subject.
// Pictographs and "other symbols" (So) only — \p{Emoji} would also eat a
// leading digit, `#` or `*`, which are part of real titles.
function cleanTitle(t) {
  return String(t || '')
    .trim()
    .replace(/^(?:[\p{Extended_Pictographic}\p{So}️]\s*)+/u, '')
    .trim();
}

// Incremental OSC parser. Escape sequences routinely straddle pty chunks, so
// parser state survives between `feed` calls. Calls `onTitle(text)` for every
// OSC 0/2 (set window title) sequence, and `onBell()` for a BEL that is a real
// bell — not the BEL that terminates an OSC.
function createOscParser({ onTitle, onBell = () => {} }) {
  let state = 'normal'; // normal | esc | osc | oscEsc
  let buf = '';

  const finish = () => {
    const semi = buf.indexOf(';');
    const ps = semi === -1 ? buf : buf.slice(0, semi);
    if (semi !== -1 && (ps === '0' || ps === '2')) onTitle(buf.slice(semi + 1));
    buf = '';
    state = 'normal';
  };

  return function feed(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      switch (state) {
        case 'normal':
          if (ch === ESC) state = 'esc';
          else if (ch === BEL) onBell();
          break;
        case 'esc':
          if (ch === ']') {
            state = 'osc';
            buf = '';
          } else state = ch === ESC ? 'esc' : 'normal';
          break;
        case 'osc':
          if (ch === BEL) finish();
          else if (ch === ESC) state = 'oscEsc';
          else if (buf.length < MAX_OSC) buf += ch;
          break;
        case 'oscEsc':
          // ESC \ is the string terminator; any other ESC aborts the OSC and
          // starts a new sequence.
          if (ch === '\\') finish();
          else {
            buf = '';
            state = ch === ']' ? 'osc' : 'normal';
          }
          break;
      }
    }
  };
}

// Input xterm sends on its own — device attributes, status and cursor
// position reports, focus in/out, colour query answers. It travels the same
// path as keystrokes, so `typed()` callers filter it out with this.
const TERMINAL_REPLY =
  // eslint-disable-next-line no-control-regex -- matching escape sequences is the point
  /^(?:\x1b\[[?>=]?[\d;]*[cnRIOt]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;

function isTerminalReply(data) {
  return TERMINAL_REPLY.test(String(data || ''));
}

const ENDED = new Set(['exited', 'error']);
// States that mean "there's something here for you" — entering one while the
// session isn't on screen marks it unread.
const ATTENTION = new Set(['done', 'needs-input', 'error']);

// One tracker per Session. `now` is injected so tests control the clock.
// `agent: false` for a plain shell session: no keyword title rules (a shell's
// title is a path), and its bell — a failed tab completion, usually — marks
// the row unread but doesn't claim anything needs input.
function createTracker({ now = Date.now, agent = true } = {}) {
  const snap = { state: 'idle', title: '', changedAt: now(), unread: false };
  let dirty = false;
  let onScreen = false; // selected in the Agents pane AND the window focused
  let beforeInput = 'idle'; // the state needs-input interrupted

  const touch = () => {
    dirty = true;
  };
  const setUnread = (v) => {
    if (snap.unread !== v) {
      snap.unread = v;
      touch();
    }
  };
  const attention = () => {
    if (!onScreen) setUnread(true);
  };

  const setState = (state) => {
    if (state === snap.state) return;
    if (state === 'needs-input')
      beforeInput = snap.state === 'working' ? 'done' : snap.state;
    snap.state = state;
    snap.changedAt = now();
    touch();
    if (ATTENTION.has(state)) attention();
  };

  // The one entry point every source goes through.
  const apply = ({ state }) => {
    // An exited session is final; late output can't revive it.
    if (ENDED.has(snap.state)) return;
    if (state === 'working' || state === 'needs-input' || ENDED.has(state)) {
      return setState(state);
    }
    if (state === 'idle') {
      // Coming to rest after work (or after a prompt) is what "done" means; at
      // rest from the start is just idle, and a reviewed "done" stays done
      // until new work.
      if (snap.state === 'working' || snap.state === 'needs-input') setState('done');
    }
  };

  const feed = createOscParser({
    onTitle(raw) {
      const kind = classifyTitle(raw, { keywords: agent });
      if (kind === 'permission') apply({ state: 'needs-input', source: 'title' });
      else if (kind) apply({ state: kind, source: 'title' });
      // A busy agent whose title loses its status glyph has gone back to the
      // shell prompt (the agent CLI exited) — treat it as at rest.
      else if (snap.state === 'working') apply({ state: 'idle', source: 'title' });
      const title = cleanTitle(raw);
      if (title && title !== snap.title) {
        snap.title = title;
        touch();
      }
    },
    onBell() {
      if (ENDED.has(snap.state)) return;
      if (agent) apply({ state: 'needs-input', source: 'bell' });
      attention();
    },
  });

  const flush = () => {
    const changed = dirty;
    dirty = false;
    return changed;
  };

  return {
    // Raw pty output. Returns true when the snapshot changed.
    output(chunk) {
      feed(chunk);
      return flush();
    },
    // The session's shell exited.
    exit(code) {
      apply({ state: code === 0 ? 'exited' : 'error', source: 'exit' });
      return flush();
    },
    // A normalized event from any other source (e.g. agent hooks, later).
    apply(event) {
      apply(event);
      return flush();
    },
    // Whether the session is on screen (selected + window focused). Coming on
    // screen is "viewing" it, which reads it.
    view(visible) {
      onScreen = !!visible;
      if (onScreen) setUnread(false);
      return flush();
    },
    // The user typed into the session: they've seen it, and if it was waiting
    // on them, they've answered — back to where it was until the agent says
    // otherwise.
    typed() {
      setUnread(false);
      if (snap.state === 'needs-input') {
        snap.state = beforeInput;
        snap.changedAt = now();
        touch();
      }
      return flush();
    },
    markRead() {
      setUnread(false);
      return flush();
    },
    markUnread() {
      setUnread(true);
      return flush();
    },
    snapshot() {
      return { ...snap };
    },
  };
}

module.exports = {
  createTracker,
  createOscParser,
  cleanTitle,
  classifyTitle,
  isTerminalReply,
  TITLE_GLYPHS,
};
