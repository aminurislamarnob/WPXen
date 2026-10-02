import { describe, it, expect } from 'vitest';
import { createTracker, cleanTitle } from '../electron/services/agentStatus.cjs';

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

  it('strips the leading status glyph and reports no change for same title', () => {
    const t = createTracker();
    t.output(osc('✳ Claude Code'));
    expect(t.snapshot().title).toBe('Claude Code');
    expect(t.output(osc('⠂ Claude Code'))).toBe(false);
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
