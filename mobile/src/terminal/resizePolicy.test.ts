import { describe, expect, it } from 'vitest';
import {
  INITIAL_FRAME_REFIT,
  clearsRefitFlags,
  decideResize,
  keyboardEvents,
  reduceFrameRefit,
  type FrameRefitEvent,
  type ResizeInput,
} from './resizePolicy';

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

describe('frame refit while the keyboard is up', () => {
  function run(events: FrameRefitEvent[]) {
    let state = INITIAL_FRAME_REFIT;
    return events.map((event) => {
      const next = reduceFrameRefit(state, event);
      state = next.state;
      return next.shouldRefit;
    });
  }

  it('refits a frame change with the keyboard closed', () => {
    expect(run([{ type: 'frame', width: 390, height: 600 }, { type: 'frame', width: 390, height: 600 }])).toEqual([true, false]);
  });

  it('holds frame changes while the keyboard is visible and flushes once on close', () => {
    expect(
      run([
        { type: 'frame', width: 390, height: 600 },
        { type: 'keyboard-visibility', visible: true },
        { type: 'frame', width: 390, height: 320 },
        { type: 'frame', width: 390, height: 300 },
        { type: 'keyboard-visibility', visible: false },
        { type: 'frame', width: 390, height: 300 },
      ])
    ).toEqual([true, false, false, false, true, false]);
  });

  it('a refit deferred with the keyboard up lands when it closes', () => {
    expect(
      run([
        { type: 'keyboard-visibility', visible: true },
        { type: 'refit-deferred' },
        { type: 'keyboard-visibility', visible: false },
      ])
    ).toEqual([false, false, true]);
  });

  it('refits a width-only change (rotation, split view)', () => {
    expect(
      run([
        { type: 'frame', width: 390, height: 600 },
        { type: 'frame', width: 700, height: 600 },
      ])
    ).toEqual([true, true]);
  });

  it('closing a keyboard with nothing held refits nothing', () => {
    expect(
      run([
        { type: 'keyboard-visibility', visible: true },
        { type: 'keyboard-visibility', visible: false },
      ])
    ).toEqual([false, false]);
  });
});

describe('refit flags and keyboard events', () => {
  it('keeps the reconnect flag through a deferred or skipped refit', () => {
    expect(clearsRefitFlags('defer')).toBe(false);
    expect(clearsRefitFlags('skip')).toBe(false);
    expect(clearsRefitFlags('send')).toBe(true);
  });

  it('listens to Will events on iOS and Did events on Android', () => {
    expect(keyboardEvents('ios')).toEqual({ show: 'keyboardWillShow', hide: 'keyboardWillHide' });
    expect(keyboardEvents('android')).toEqual({ show: 'keyboardDidShow', hide: 'keyboardDidHide' });
  });
});
