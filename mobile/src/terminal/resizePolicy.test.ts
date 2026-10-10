import { describe, expect, it } from 'vitest';
import { decideResize, type ResizeInput } from './resizePolicy';

const base: ResizeInput = {
  visible: true,
  covered: false,
  appState: 'active',
  keyboardTransitioning: false,
  dims: { cols: 60, rows: 20 },
  lastSentDims: { cols: 80, rows: 24 },
  reconnected: false,
  textSizeChanged: false,
};

describe('decideResize', () => {
  it('sends when the terminal is visible with new dims', () => {
    expect(decideResize(base)).toBe('send');
  });

  it('skips while covered, hidden, or backgrounded', () => {
    expect(decideResize({ ...base, covered: true })).toBe('skip');
    expect(decideResize({ ...base, visible: false })).toBe('skip');
    expect(decideResize({ ...base, appState: 'background' })).toBe('skip');
    expect(decideResize({ ...base, appState: 'inactive' })).toBe('skip');
  });

  it('defers while the keyboard is mid-transition', () => {
    // A height change mid-keystroke would reflow the pty under the user's
    // fingers; the caller retries once the keyboard settles.
    expect(decideResize({ ...base, keyboardTransitioning: true })).toBe('defer');
  });

  it('skips unchanged dims', () => {
    expect(decideResize({ ...base, dims: { cols: 80, rows: 24 } })).toBe('skip');
  });

  it('re-asserts on reconnect even when the dims look unchanged', () => {
    // The desktop may have resized the pty while the socket was down.
    expect(
      decideResize({ ...base, dims: { cols: 80, rows: 24 }, reconnected: true })
    ).toBe('send');
  });

  it('sends on rotation and text-size change', () => {
    expect(decideResize({ ...base, dims: { cols: 100, rows: 20 } })).toBe('send');
    expect(
      decideResize({ ...base, dims: { cols: 80, rows: 24 }, textSizeChanged: true })
    ).toBe('send');
  });

  it('prefers skip over defer when covered and transitioning', () => {
    expect(
      decideResize({ ...base, covered: true, keyboardTransitioning: true })
    ).toBe('skip');
  });
});
