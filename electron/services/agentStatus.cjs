'use strict';

// Session status engine — one tracker per agent Session, fed the raw pty
// output. It lives beside the pty in the main process (ADR 0001), so a Session
// whose terminal isn't mounted — every background one — is still tracked.
//
// Pure: no electron, no timers, no I/O. The session manager feeds it bytes and
// reads snapshots back, which is what makes it testable.

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
// OSC 0/2 (set window title) sequence.
function createOscParser({ onTitle }) {
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

// One tracker per Session. `now` is injected so tests control the clock.
function createTracker({ now = Date.now } = {}) {
  const snap = { title: '', changedAt: now() };

  const feed = createOscParser({
    onTitle(raw) {
      const title = cleanTitle(raw);
      if (title && title !== snap.title) snap.title = title;
    },
  });

  return {
    // Raw pty output. Returns true when the snapshot changed.
    output(chunk) {
      const before = snap.title;
      feed(chunk);
      return snap.title !== before;
    },
    snapshot() {
      return { ...snap };
    },
  };
}

module.exports = { createTracker, createOscParser, cleanTitle };
