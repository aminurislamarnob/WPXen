import { describe, it, expect } from 'vitest';
import { dnsHealthView } from '../src/lib/dnsHealth.js';

// What Settings → DNS and the Services row show for the dnsmasq status entry
// (#204): healthy only on a good lookup, and every error comes with its fix.

describe('dnsHealthView', () => {
  it('is healthy only when the lookup said so', () => {
    expect(
      dnsHealthView({
        running: true,
        mode: 'rootless',
        port: 53535,
        health: { state: 'healthy' },
        action: null,
        error: null,
      })
    ).toEqual({
      tone: 'ok',
      label: 'Resolving',
      detail: '*.test resolves to this Mac (dnsmasq on port 53535).',
      action: null,
    });

    // Running but never checked is not "healthy".
    expect(
      dnsHealthView({ running: true, health: { state: 'unknown' }, action: null })
    ).toMatchObject({ tone: 'pending', label: 'Checking…' });
  });

  it('offers Repair for a failed or wrong lookup', () => {
    expect(
      dnsHealthView({
        running: true,
        mode: 'rootless',
        health: { state: 'error', problem: 'lookup' },
        action: 'repair',
        error: ".test names don't resolve on this Mac (ENOTFOUND).",
      })
    ).toEqual({
      tone: 'error',
      label: 'Not resolving',
      detail: ".test names don't resolve on this Mac (ENOTFOUND).",
      action: { kind: 'repair', label: 'Repair' },
    });
  });

  it('offers Use a different port for a port conflict', () => {
    expect(
      dnsHealthView({
        running: false,
        mode: 'rootless',
        health: { state: 'error', problem: 'port-conflict', port: 53535 },
        action: 'change-port',
        error: 'Port 53535 is in use by another program.',
      })
    ).toEqual({
      tone: 'error',
      label: 'Port in use',
      detail: 'Port 53535 is in use by another program.',
      action: { kind: 'change-port', label: 'Use a different port' },
    });
  });

  it('falls back to Repair for a crashed dnsmasq', () => {
    expect(
      dnsHealthView({
        running: false,
        state: 'failed',
        health: { state: 'healthy' },
        action: null,
        error: 'dnsmasq exited repeatedly (last code 2).',
      })
    ).toMatchObject({ tone: 'error', action: { kind: 'repair', label: 'Repair' } });
  });

  it('asks for setup before DNS has been set up', () => {
    expect(
      dnsHealthView({ running: false, health: { state: 'unconfigured' }, action: null })
    ).toMatchObject({ tone: 'neutral', label: 'Not set up', action: null });
    expect(dnsHealthView(undefined)).toMatchObject({ tone: 'pending' });
  });
});
