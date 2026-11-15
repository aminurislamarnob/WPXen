import { describe, expect, it } from 'vitest';
import {
  BRISK_STATES,
  FAR_ZOOM,
  frameRate,
  isBusy,
  isFarZoom,
} from '../src/lib/office/scene/pacing.js';

// The demand-frameloop policy: what counts as busy, how fast the FrameDriver
// ticks, and when labels flip to their zoomed-out form. The machinery that
// consumes these (FrameDriver, ZoomWatcher) is verified via the dev Preview.

function office(sessions) {
  return { sessions, waitingCount: 0 };
}

describe('render pacing', () => {
  it('treats working/thinking/error as brisk; waiting, idle and ended are calm', () => {
    expect([...BRISK_STATES].sort()).toEqual(['error', 'thinking', 'working']);
  });

  it('isBusy looks at sessions and their subagents', () => {
    expect(isBusy(office({}))).toBe(false);
    expect(isBusy(office({ 1: { state: 'idle' } }))).toBe(false);
    expect(isBusy(office({ 1: { state: 'ended' } }))).toBe(false);
    expect(isBusy(office({ 1: { state: 'working' } }))).toBe(true);
    // An agent can wait on you for hours; that must not hold 30 fps.
    expect(isBusy(office({ 1: { state: 'waiting_on_user' } }))).toBe(false);
    expect(
      isBusy(
        office({ 1: { state: 'idle', subagents: { a: { state: 'waiting_on_user' } } } })
      )
    ).toBe(false);
    expect(
      isBusy(office({ 1: { state: 'idle', subagents: { a: { state: 'thinking' } } } }))
    ).toBe(true);
  });

  it('frameRate: hidden pauses, busy or a rally is brisk, calm is slow', () => {
    expect(frameRate({ visible: false, busy: true })).toBe(0);
    expect(frameRate({ visible: true, busy: true })).toBe(30);
    expect(frameRate({ visible: true, busy: false, rally: true })).toBe(30);
    expect(frameRate({ visible: true, busy: false })).toBe(10);
  });

  it('labels flip to far mode below the zoom threshold', () => {
    expect(isFarZoom(FAR_ZOOM - 1)).toBe(true);
    expect(isFarZoom(FAR_ZOOM)).toBe(false);
    expect(isFarZoom(200)).toBe(false);
  });
});
