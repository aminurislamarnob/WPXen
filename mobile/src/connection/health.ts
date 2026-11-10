// What the host screen says while a Mac isn't connected, ported from Orca's
// connection-health.ts thresholds: short drops read as "Reconnecting…"; three
// failed dials in a row warn "Can't connect"; twelve, with the last good
// connection a minute or more behind (or none ever), say "Can't reach Mac".
// Before, every failed dial read the same — "Reconnecting…" or "Mac offline"
// — whether it was a blip or the tunnel had been down for an hour.

import type { ConnectionState } from './state';

export const WARNING_ATTEMPTS = 3;
export const UNREACHABLE_ATTEMPTS = 12;
export const STALE_SINCE_LAST_CONNECT_MS = 60_000;

export type ConnectionVerdict =
  | { kind: 'normal'; label: string }
  | { kind: 'warning'; label: string }
  | { kind: 'unreachable'; label: string }
  | { kind: 'final'; label: string };

export function classifyConnection(args: {
  state: ConnectionState;
  attempts: number;
  lastConnectedAt: number | null;
  now: number;
  update?: 'desktop' | 'phone' | null;
}): ConnectionVerdict {
  const { state, attempts, lastConnectedAt, now } = args;
  switch (state) {
    case 'connected':
      return { kind: 'normal', label: 'Connected' };
    case 'revoked':
      return { kind: 'final', label: 'Removed from WPXen' };
    case 'auth-failed':
      return { kind: 'final', label: 'Pairing invalid — re-pair' };
    case 'update-required':
      return {
        kind: 'final',
        label: args.update === 'desktop' ? 'Update WPXen on the Mac' : 'Update WPXen Mobile',
      };
    case 'asleep':
      return { kind: 'warning', label: 'Mac asleep' };
    default:
      break;
  }
  if (attempts >= UNREACHABLE_ATTEMPTS) {
    if (lastConnectedAt == null) return { kind: 'unreachable', label: 'Can’t reach Mac' };
    if (now - lastConnectedAt >= STALE_SINCE_LAST_CONNECT_MS) {
      const minutes = Math.max(1, Math.round((now - lastConnectedAt) / 60_000));
      return { kind: 'unreachable', label: `Can’t reach Mac (last seen ${minutes} min ago)` };
    }
  }
  if (attempts >= WARNING_ATTEMPTS) return { kind: 'warning', label: 'Can’t connect' };
  return { kind: 'normal', label: 'Reconnecting…' };
}
