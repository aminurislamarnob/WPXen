import { describe, it, expect } from 'vitest';
import {
  createTracker,
  cleanTitle,
  classifyTitle,
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

    const shell = createTracker({ keywords: false });
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
