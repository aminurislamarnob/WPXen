import { describe, expect, it } from 'vitest';
import { networkChangeNudges } from './networkChange';

describe('network change nudges', () => {
  it('nudges on every event that reports the phone connected', () => {
    expect(networkChangeNudges({ isConnected: true, type: 'WIFI' })).toBe(true);
    expect(networkChangeNudges({ isConnected: true, type: 'CELLULAR' })).toBe(true);
  });

  it('nudges when roaming keeps the same network type', () => {
    // Access point to access point reads WIFI → WIFI, and still replaces the
    // TCP path under an open socket.
    expect(networkChangeNudges({ isConnected: true, type: 'WIFI' })).toBe(true);
  });

  it('stays quiet while offline or unknown', () => {
    expect(networkChangeNudges({ isConnected: false, type: 'NONE' })).toBe(false);
    expect(networkChangeNudges({ isConnected: undefined, type: undefined })).toBe(false);
  });
});
