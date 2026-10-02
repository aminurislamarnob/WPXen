import { describe, it, expect } from 'vitest';
import {
  createTracker,
  cleanTitle,
  classifyTitle,
  isTerminalReply,
  createNotifier,
  NOTIFY_COOLDOWN_MS,
} from '../electron/services/agentStatus.cjs';

const osc = (text, term = '\x07') => `\x1b]0;${text}${term}`;

describe('agent status tracker — titles', () => {
  it('reads an OSC 0 title terminated by BEL', () => {
    const t = createTracker();
    expect(t.output(`hello ${osc('Fix checkout tax')} world`)).toBe(true);
    expect(t.snapshot().title).toBe('Fix checkout tax');
  });

  it('reads an OSC 2 title terminated by ST (ESC \\)', () => {
    const t = createTracker();
    t.output('\x1b]2;Add REST endpoint\x1b\\');
    expect(t.snapshot().title).toBe('Add REST endpoint');
  });

  it('assembles a title split across chunks', () => {
    const t = createTracker();
    const full = osc('Split title');
    for (const ch of full) t.output(ch);
    expect(t.snapshot().title).toBe('Split title');
  });

  it('ignores other OSC sequences (e.g. OSC 8 hyperlinks)', () => {
    const t = createTracker();
    expect(t.output('\x1b]8;;https://example.test\x07link\x1b]8;;\x07')).toBe(false);
    expect(t.snapshot().title).toBe('');
  });

  it('strips the leading status glyph; a new spinner frame is no change', () => {
    const t = createTracker();
    t.output(osc('⠂ Claude Code'));
    expect(t.snapshot().title).toBe('Claude Code');
    expect(t.output(osc('⠐ Claude Code'))).toBe(false);
  });

  it('keeps the last title when an empty one arrives', () => {
    const t = createTracker();
    t.output(osc('Real title'));
    t.output(osc(''));
    expect(t.snapshot().title).toBe('Real title');
  });
});

describe('cleanTitle', () => {
  it('strips spinner and status glyphs', () => {
    expect(cleanTitle('◐ Thinking')).toBe('Thinking');
    expect(cleanTitle('✦ Gemini')).toBe('Gemini');
    expect(cleanTitle('⠋⠙ Working')).toBe('Working');
  });

  it('keeps leading digits and punctuation that are part of the title', () => {
    expect(cleanTitle('2 files changed')).toBe('2 files changed');
    expect(cleanTitle('#123 fix')).toBe('#123 fix');
  });
});

// A fake clock the tracker reads through `now`.
function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('agent status tracker — state', () => {
  it('starts idle, and a fresh agent at rest stays idle (not done)', () => {
    const t = createTracker();
    expect(t.snapshot().state).toBe('idle');
    t.output(osc('✳ Claude Code'));
    expect(t.snapshot().state).toBe('idle');
  });

  it('goes working on a Claude braille spinner title', () => {
    const t = createTracker();
    expect(t.output(osc('⠐ Fix checkout tax'))).toBe(true);
    expect(t.snapshot().state).toBe('working');
  });

  it('goes working on a Claude quarter-circle spinner title', () => {
    const t = createTracker();
    t.output(osc('◒ Fix checkout tax'));
    expect(t.snapshot().state).toBe('working');
  });

  it('turns working → done when the title comes to rest', () => {
    const c = clock();
    const t = createTracker({ now: c.now });
    t.output(osc('⠐ Task'));
    c.advance(5000);
    t.output(osc('✳ Task'));
    expect(t.snapshot()).toMatchObject({ state: 'done', changedAt: 6000 });
  });

  it('only moves changedAt on a state change, not on spinner frames', () => {
    const c = clock();
    const t = createTracker({ now: c.now });
    t.output(osc('⠋ Task'));
    c.advance(1000);
    t.output(osc('⠙ Task'));
    expect(t.snapshot().changedAt).toBe(1000);
  });

  it('done goes back to working on new work', () => {
    const t = createTracker();
    t.output(osc('⠐ A'));
    t.output(osc('✳ A'));
    t.output(osc('⠐ B'));
    expect(t.snapshot().state).toBe('working');
  });

  it('treats a working agent losing its status glyph as done (back at the shell)', () => {
    const t = createTracker();
    t.output(osc('⠐ Task'));
    t.output(osc('user@mac: ~/Sites/shop'));
    expect(t.snapshot().state).toBe('done');
  });

  it('recognises Gemini working and idle glyphs', () => {
    const t = createTracker();
    t.output(osc('✦ Gemini'));
    expect(t.snapshot().state).toBe('working');
    t.output(osc('◇ Gemini'));
    expect(t.snapshot().state).toBe('done');
  });

  it('uses keyword fallbacks for agents but not for a plain shell', () => {
    const agent = createTracker();
    agent.output(osc('Codex: thinking'));
    expect(agent.snapshot().state).toBe('working');

    const shell = createTracker({ agent: false });
    shell.output(osc('~/projects/running-shoes'));
    expect(shell.snapshot().state).toBe('idle');
  });

  it('exit 0 is exited, non-zero is error, and both are final', () => {
    const ok = createTracker();
    expect(ok.exit(0)).toBe(true);
    expect(ok.snapshot().state).toBe('exited');
    ok.output(osc('⠐ late output'));
    expect(ok.snapshot().state).toBe('exited');

    const bad = createTracker();
    bad.exit(1);
    expect(bad.snapshot().state).toBe('error');
  });

  it('accepts normalized events from other sources', () => {
    const t = createTracker();
    expect(t.apply({ state: 'working', source: 'hook' })).toBe(true);
    expect(t.apply({ state: 'idle', source: 'hook' })).toBe(true);
    expect(t.snapshot().state).toBe('done');
  });
});

describe('classifyTitle', () => {
  it('matches keywords on word boundaries only', () => {
    expect(classifyTitle('Agent ready')).toBe('idle');
    expect(classifyTitle('already-done.txt')).toBe(null);
    expect(classifyTitle('~/src/working')).toBe(null);
  });

  it('returns null for a title with no signal', () => {
    expect(classifyTitle('Claude Code')).toBe(null);
    expect(classifyTitle('')).toBe(null);
  });
});

describe('agent status tracker — needs input', () => {
  it('a bell outside any escape sequence means needs input', () => {
    const t = createTracker();
    t.output(osc('⠐ Task'));
    expect(t.output('Allow edit to cart.php? \x07')).toBe(true);
    expect(t.snapshot().state).toBe('needs-input');
  });

  it('the BEL terminating an OSC title is not a bell', () => {
    const t = createTracker();
    t.output(osc('✳ Claude Code'));
    expect(t.snapshot().state).toBe('idle');
    expect(t.snapshot().unread).toBe(false);
  });

  it('a Gemini ✋ title means needs input', () => {
    const t = createTracker();
    t.output(osc('✋ Gemini'));
    expect(t.snapshot().state).toBe('needs-input');
  });

  it('a "permission" keyword title means needs input', () => {
    const t = createTracker();
    t.output(osc('Codex: action required'));
    expect(t.snapshot().state).toBe('needs-input');
  });

  it('resumes working when the agent picks back up', () => {
    const t = createTracker();
    t.output('\x07');
    t.output(osc('⠐ Task'));
    expect(t.snapshot().state).toBe('working');
  });

  it('typing an answer drops needs-input back to the prior resting state', () => {
    const t = createTracker();
    t.output(osc('⠐ Task'));
    t.output('\x07');
    t.typed();
    expect(t.snapshot().state).toBe('done');
  });

  it("a plain shell's bell marks unread but claims no input is needed", () => {
    const t = createTracker({ agent: false });
    t.output('\x07');
    expect(t.snapshot()).toMatchObject({ state: 'idle', unread: true });
  });
});

describe('agent status tracker — unread', () => {
  const finish = (t) => {
    t.output(osc('⠐ Task'));
    t.output(osc('✳ Task'));
  };

  it('becomes unread when it finishes off screen', () => {
    const t = createTracker();
    finish(t);
    expect(t.snapshot().unread).toBe(true);
  });

  it('stays read when it finishes on screen', () => {
    const t = createTracker();
    t.view(true);
    finish(t);
    expect(t.snapshot().unread).toBe(false);
  });

  it('becomes unread on needs-input, error exit, and bell — not on clean exit or work', () => {
    const working = createTracker();
    working.output(osc('⠐ Task'));
    expect(working.snapshot().unread).toBe(false);

    const asking = createTracker();
    asking.output('\x07');
    expect(asking.snapshot().unread).toBe(true);

    const crashed = createTracker();
    crashed.exit(2);
    expect(crashed.snapshot().unread).toBe(true);

    const clean = createTracker();
    clean.exit(0);
    expect(clean.snapshot().unread).toBe(false);
  });

  it('viewing clears unread', () => {
    const t = createTracker();
    finish(t);
    expect(t.view(true)).toBe(true);
    expect(t.snapshot().unread).toBe(false);
  });

  it('leaving the screen does not clear or set unread by itself', () => {
    const t = createTracker();
    t.view(true);
    t.view(false);
    expect(t.snapshot().unread).toBe(false);
  });

  it('typing clears unread', () => {
    const t = createTracker();
    finish(t);
    t.typed();
    expect(t.snapshot().unread).toBe(false);
  });

  it('can be marked read and unread by hand', () => {
    const t = createTracker();
    t.markUnread();
    expect(t.snapshot().unread).toBe(true);
    t.markRead();
    expect(t.snapshot().unread).toBe(false);
  });
});

describe('isTerminalReply', () => {
  it('recognises xterm auto-replies', () => {
    expect(isTerminalReply('\x1b[?1;2c')).toBe(true); // device attributes
    expect(isTerminalReply('\x1b[12;40R')).toBe(true); // cursor position
    expect(isTerminalReply('\x1b[I')).toBe(true); // focus in
    expect(isTerminalReply('\x1b]11;rgb:0000/0000/0000\x1b\\')).toBe(true);
  });

  it('does not swallow real keystrokes', () => {
    expect(isTerminalReply('\r')).toBe(false);
    expect(isTerminalReply('y')).toBe(false);
    expect(isTerminalReply('\x1b[A')).toBe(false); // arrow up
  });
});

describe('agent status tracker — alert events', () => {
  it('reports done, needs-input, bell and error, oldest first, once', () => {
    const t = createTracker();
    t.output(osc('⠐ Task'));
    t.output(osc('✳ Task'));
    t.output('\x07');
    expect(t.drainEvents()).toEqual(['done', 'needs-input', 'bell']);
    expect(t.drainEvents()).toEqual([]);
    t.exit(1);
    expect(t.drainEvents()).toEqual(['error']);
  });

  it('reports nothing for work starting or a clean exit', () => {
    const t = createTracker();
    t.output(osc('⠐ Task'));
    t.exit(0);
    expect(t.drainEvents()).toEqual([]);
  });

  it('still reports events for the session on screen (gating is the notifier’s job)', () => {
    const t = createTracker();
    t.view(true);
    t.output(osc('⠐ Task'));
    t.output(osc('✳ Task'));
    expect(t.drainEvents()).toEqual(['done']);
  });
});

describe('createNotifier', () => {
  const all = {
    enabled: true,
    onDone: true,
    onNeedsInput: true,
    onBell: true,
    suppressWhenFocused: true,
  };
  const ask = (n, over = {}) =>
    n.decide({ sessionId: 's1', kind: 'done', onScreen: false, settings: all, ...over });

  it('notifies an off-screen event', () => {
    expect(ask(createNotifier())).toBe(true);
  });

  it('suppresses the session on screen when suppress-when-focused is on', () => {
    const n = createNotifier();
    expect(ask(n, { onScreen: true })).toBe(false);
    expect(
      ask(n, { onScreen: true, settings: { ...all, suppressWhenFocused: false } })
    ).toBe(true);
  });

  it('allows one notification per session per cooldown window', () => {
    let t = 0;
    const n = createNotifier({ now: () => t });
    expect(ask(n)).toBe(true);
    t += 1000;
    expect(ask(n, { kind: 'bell' })).toBe(false);
    expect(ask(n, { sessionId: 's2' })).toBe(true); // other sessions unaffected
    t += NOTIFY_COOLDOWN_MS;
    expect(ask(n)).toBe(true);
  });

  it('honours each trigger switch, with error riding on done', () => {
    const n = () => createNotifier();
    expect(ask(n(), { settings: { ...all, onDone: false } })).toBe(false);
    expect(ask(n(), { kind: 'error', settings: { ...all, onDone: false } })).toBe(false);
    expect(
      ask(n(), { kind: 'needs-input', settings: { ...all, onNeedsInput: false } })
    ).toBe(false);
    expect(ask(n(), { kind: 'bell', settings: { ...all, onBell: false } })).toBe(false);
    expect(ask(n(), { kind: 'bell', settings: { ...all, onDone: false } })).toBe(true);
  });

  it('the master switch turns everything off', () => {
    expect(ask(createNotifier(), { settings: { ...all, enabled: false } })).toBe(false);
  });

  it('a suppressed or switched-off event does not start the cooldown', () => {
    const n = createNotifier({ now: () => 0 });
    expect(ask(n, { onScreen: true })).toBe(false);
    expect(ask(n)).toBe(true);
  });
});
