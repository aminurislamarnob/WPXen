import { describe, it, expect } from 'vitest';
import { snapshotBuffer } from '../electron/services/ansi.cjs';
import { shouldShowWaitingFallback } from '../src/lib/chatRows.js';

describe('snapshotBuffer', () => {
  it('strips ANSI escapes and truncates to N lines', () => {
    const buffer = 'Loading...\n\x1b[31mError!\x1b[0m\nLine 3\nLine 4\nLine 5';
    const snapshot = snapshotBuffer(buffer, 3);
    expect(snapshot).toBe(
      'Error!\nLine 3\nLine 4\nLine 5'.split('\n').slice(-3).join('\n')
    );
  });

  it('collapses \\r overwrites correctly', () => {
    const buffer = 'Progress 10%\rProgress 50%\rProgress 100%\nDone.';
    const snapshot = snapshotBuffer(buffer, 5);
    expect(snapshot).toBe('Progress 100%\nDone.');
  });

  it('strips single escapes and OSC sequences', () => {
    const buffer = 'OSC\x1b]8;;http://example.com\x07Link\x1b]8;;\x07\nSingle\x1bcEscape';
    const snapshot = snapshotBuffer(buffer, 5);
    expect(snapshot).toBe('OSCLink\nSingleEscape');
  });

  it('skips empty lines', () => {
    const buffer = 'Line 1\n\n\nLine 2';
    const snapshot = snapshotBuffer(buffer, 5);
    expect(snapshot).toBe('Line 1\nLine 2');
  });
});

describe('shouldShowWaitingFallback', () => {
  it('returns false if status is not needs-input', () => {
    expect(shouldShowWaitingFallback('running', [])).toBe(false);
    expect(shouldShowWaitingFallback('stopped', [])).toBe(false);
  });

  it('returns true if status is needs-input and no AskUserQuestion tool run is waiting', () => {
    const messages = [
      {
        role: 'tool-run',
        items: [{ tool_use: { name: 'bash' } }, { result: { content: 'done' } }],
      },
    ];
    expect(shouldShowWaitingFallback('needs-input', messages)).toBe(true);
  });

  it('returns false if AskUserQuestion tool is pending (no result)', () => {
    const messages = [
      {
        role: 'tool-run',
        items: [{ tool_use: { name: 'AskUserQuestion' } }],
      },
    ];
    expect(shouldShowWaitingFallback('needs-input', messages)).toBe(false);
  });

  it('returns true if AskUserQuestion tool is completed (has result)', () => {
    const messages = [
      {
        role: 'tool-run',
        items: [
          { tool_use: { name: 'AskUserQuestion' }, result: { content: 'user answered' } },
        ],
      },
    ];
    expect(shouldShowWaitingFallback('needs-input', messages)).toBe(true);
  });
});
