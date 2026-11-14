import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  quitConfirmation,
  servicesQuitStops,
} = require('../electron/services/quitPrompt.cjs');

const live = (pid = 100) => ({ state: 'running', pid });
const stopped = { state: 'stopped', pid: null };

describe('servicesQuitStops', () => {
  it('names the services WPXen is running, in Dashboard order', () => {
    expect(
      servicesQuitStops({
        mailpit: live(),
        mysql: live(),
        'php@8.3': live(),
        nginx: live(),
      })
    ).toEqual(['nginx', 'PHP-FPM', 'MySQL', 'Mailpit']);
  });

  it('lists PHP-FPM once however many versions run', () => {
    expect(servicesQuitStops({ 'php@8.3': live(1), 'php@8.5': live(2) })).toEqual([
      'PHP-FPM',
    ]);
  });

  it('ignores stopped and failed services', () => {
    expect(
      servicesQuitStops({
        nginx: stopped,
        mysql: { state: 'failed', pid: null },
        mailpit: stopped,
      })
    ).toEqual([]);
  });

  it('ignores a service waiting to restart, which has no process', () => {
    expect(servicesQuitStops({ nginx: { state: 'starting', pid: null } })).toEqual([]);
  });

  it('counts a service that is starting with a process', () => {
    expect(servicesQuitStops({ mysql: { state: 'starting', pid: 7 } })).toEqual([
      'MySQL',
    ]);
  });

  it('keeps an unknown service under its own name', () => {
    expect(servicesQuitStops({ redis: live() })).toEqual(['redis']);
  });

  it('is empty with no services', () => {
    expect(servicesQuitStops({})).toEqual([]);
    expect(servicesQuitStops(undefined)).toEqual([]);
  });
});

describe('quitConfirmation', () => {
  const base = {
    confirmOnQuit: true,
    agentSiteNames: [],
    procStatus: {},
  };

  it('asks about running services', () => {
    expect(quitConfirmation({ ...base, procStatus: { nginx: live() } })).toEqual({
      kind: 'services',
      names: ['nginx'],
    });
  });

  it("doesn't ask when WPXen runs nothing", () => {
    // Another program's nginx or dnsmasq never reaches procStatus: only
    // what WPXen started does.
    expect(quitConfirmation({ ...base, procStatus: { nginx: stopped } })).toBeNull();
  });

  it("doesn't ask about services when the setting is off", () => {
    expect(
      quitConfirmation({ ...base, confirmOnQuit: false, procStatus: { nginx: live() } })
    ).toBeNull();
  });

  it('asks about live agents even with the setting off', () => {
    expect(
      quitConfirmation({ ...base, confirmOnQuit: false, agentSiteNames: ['Theme'] })
    ).toEqual({ kind: 'agents', names: ['Theme'] });
  });

  it('asks about agents before services', () => {
    expect(
      quitConfirmation({
        ...base,
        agentSiteNames: ['Theme'],
        procStatus: { nginx: live() },
      })
    ).toEqual({ kind: 'agents', names: ['Theme'] });
  });
});
