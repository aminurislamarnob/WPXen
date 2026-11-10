import { describe, expect, it } from 'vitest';
import { stepBackgroundGrace, type GraceEvent, type GracePhase } from './backgroundGrace';

function run(events: GraceEvent[]) {
  let phase: GracePhase = 'foreground';
  return events.map((event) => {
    const next = stepBackgroundGrace(phase, event);
    phase = next.phase;
    return next.action;
  });
}

const app = (state: string): GraceEvent => ({ type: 'app-state', state });
const expired: GraceEvent = { type: 'grace-expired' };

describe('terminal background grace', () => {
  it('unsubscribes once the grace runs out, and resubscribes on return', () => {
    expect(run([app('background'), expired, app('active')])).toEqual(['start-grace', 'unsubscribe', 'resubscribe']);
  });

  it('a quick trip away keeps the stream: the grace is cancelled', () => {
    expect(run([app('background'), app('active'), expired])).toEqual(['start-grace', 'cancel-grace', null]);
  });

  it('ignores the inactive transition and repeated states', () => {
    expect(run([app('inactive'), app('active'), app('background'), app('background')])).toEqual([
      null,
      null,
      'start-grace',
      null,
    ]);
  });
});
