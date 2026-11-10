import { describe, expect, it } from 'vitest';
import { INITIAL_LIST_SYNC, reduceListSync, type ListSyncEvent, type ListSyncState } from './listSync';

function run(events: ListSyncEvent[]) {
  let state: ListSyncState = INITIAL_LIST_SYNC;
  const refetches: number[] = [];
  const stale: boolean[] = [];
  events.forEach((event, i) => {
    const next = reduceListSync(state, event);
    state = next.state;
    if (next.refetch) refetches.push(i);
    stale.push(state.stale);
  });
  return { state, refetches, stale };
}

const connected: ListSyncEvent = { type: 'connection', state: 'connected' };
const offline: ListSyncEvent = { type: 'connection', state: 'offline' };
const reconnecting: ListSyncEvent = { type: 'connection', state: 'reconnecting' };
const loaded: ListSyncEvent = { type: 'loaded' };

describe('host list sync', () => {
  it('fetches on first connect, not on heartbeat re-emits', () => {
    const { refetches } = run([connected, loaded, connected, connected]);
    expect(refetches).toEqual([0]);
  });

  it('refetches on every reconnect, not just the first', () => {
    const { refetches } = run([connected, loaded, offline, reconnecting, connected, loaded]);
    expect(refetches).toEqual([0, 4]);
  });

  it('marks the kept list stale from the drop until the refetch lands', () => {
    const { stale } = run([connected, loaded, offline, connected, loaded]);
    // connected, loaded → fresh; offline → stale; reconnected but not
    // refetched yet → still stale; refetch landed → fresh.
    expect(stale).toEqual([false, false, true, true, false]);
  });

  it('has nothing to mark stale before the first list', () => {
    const { stale } = run([reconnecting, offline, connected]);
    expect(stale).toEqual([false, false, false]);
  });
});
