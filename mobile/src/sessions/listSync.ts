// When the host screen refetches its lists, and whether what it shows is
// stale. After Orca's host-connect-refetch-gate.ts: refetch on every
// transition into connected — not only the first — because Sessions start,
// exit and change state on the Mac while the socket is down, and a
// sessions.changed push that fired then was never delivered.
//
// Last-known rows stay on screen across a drop (better than an empty list),
// marked stale from the moment the connection is lost until a fresh list
// lands. Reconnecting alone doesn't clear the mark: until the refetch (or a
// full sessions.changed push) arrives, the rows are still the old ones.

import type { ConnectionState } from '../connection/state';

export interface ListSyncState {
  connected: boolean;
  // A list has been received at least once on this screen.
  loaded: boolean;
  stale: boolean;
}

export type ListSyncEvent =
  | { type: 'connection'; state: ConnectionState }
  // A full list arrived: the refetch, or a sessions.changed push.
  | { type: 'loaded' };

export const INITIAL_LIST_SYNC: ListSyncState = { connected: false, loaded: false, stale: false };

export function reduceListSync(
  state: ListSyncState,
  event: ListSyncEvent
): { state: ListSyncState; refetch: boolean } {
  if (event.type === 'loaded') {
    return { state: { ...state, loaded: true, stale: false }, refetch: false };
  }
  const connected = event.state === 'connected';
  // Heartbeats re-emit connected; only the crossing refetches.
  const refetch = connected && !state.connected;
  const lostOrRejoined = refetch || !connected;
  return {
    state: { ...state, connected, stale: lostOrRejoined ? state.loaded : state.stale },
    refetch,
  };
}
