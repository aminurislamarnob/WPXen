import { describe, expect, it } from 'vitest';
import { deriveConnectionState } from './state';

describe('deriveConnectionState', () => {
  it('is connected on an open, healthy socket', () => {
    expect(
      deriveConnectionState({ socket: 'open', closeStatus: null, lastSeenAt: 1, heartbeatLost: false })
    ).toBe('connected');
  });

  it('is reconnecting before the first contact', () => {
    expect(
      deriveConnectionState({ socket: 'connecting', closeStatus: null, lastSeenAt: null, heartbeatLost: false })
    ).toBe('reconnecting');
    expect(
      deriveConnectionState({ socket: 'closed', closeStatus: 'closed', lastSeenAt: null, heartbeatLost: false })
    ).toBe('reconnecting');
  });

  it('is offline once seen, while retrying', () => {
    expect(
      deriveConnectionState({ socket: 'closed', closeStatus: 'closed', lastSeenAt: 123, heartbeatLost: false })
    ).toBe('offline');
  });

  it('reads a lost heartbeat as asleep, open socket or not', () => {
    expect(
      deriveConnectionState({ socket: 'open', closeStatus: null, lastSeenAt: 1, heartbeatLost: true })
    ).toBe('asleep');
    expect(
      deriveConnectionState({ socket: 'closed', closeStatus: 'closed', lastSeenAt: 1, heartbeatLost: true })
    ).toBe('asleep');
  });

  it('sticks on revoked whatever else happened', () => {
    expect(
      deriveConnectionState({ socket: 'open', closeStatus: 'revoked', lastSeenAt: 1, heartbeatLost: false })
    ).toBe('revoked');
    expect(
      deriveConnectionState({ socket: 'closed', closeStatus: 'revoked', lastSeenAt: null, heartbeatLost: false })
    ).toBe('revoked');
  });
});
