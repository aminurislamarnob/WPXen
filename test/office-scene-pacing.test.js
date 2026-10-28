import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATES,
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
  it('treats working/thinking/waiting/error as active, idle/ended as calm', () => {
    expect([...ACTIVE_STATES].sort()).toEqual([
      'error',
      'thinking',
      'waiting_on_user',
      'working',
    ]);
  });

  it('isBusy looks at sessions and their subagents', () => {
    expect(isBusy(office({}))).toBe(false);
    expect(isBusy(office({ 1: { state: 'idle' } }))).toBe(false);
    expect(isBusy(office({ 1: { state: 'ended' } }))).toBe(false);
    expect(isBusy(office({ 1: { state: 'working' } }))).toBe(true);
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
