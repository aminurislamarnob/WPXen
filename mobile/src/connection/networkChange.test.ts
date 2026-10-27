import { describe, expect, it } from 'vitest';
import { networkChangeNudges } from './networkChange';

describe('network change nudges', () => {
  it('nudges on coming back online', () => {
    expect(networkChangeNudges({ isConnected: false, type: 'NONE' }, { isConnected: true, type: 'WIFI' })).toBe(true);
  });

  it('nudges on a Wi-Fi / cellular handoff', () => {
    expect(networkChangeNudges({ isConnected: true, type: 'WIFI' }, { isConnected: true, type: 'CELLULAR' })).toBe(
      true
    );
  });

  it('stays quiet going offline, on the first reading, and with nothing changed', () => {
    expect(networkChangeNudges({ isConnected: true, type: 'WIFI' }, { isConnected: false, type: 'NONE' })).toBe(false);
    expect(networkChangeNudges(null, { isConnected: true, type: 'WIFI' })).toBe(false);
    expect(networkChangeNudges({ isConnected: true, type: 'WIFI' }, { isConnected: true, type: 'WIFI' })).toBe(false);
  });
});
