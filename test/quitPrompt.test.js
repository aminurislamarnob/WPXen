import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  quitConfirmation,
  quitAction,
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

  describe('with keepRunningOnQuit enabled (#234)', () => {
    it('shows the 3-button dialog with Keep running as default when liveAgentCount > 0 and confirmOnQuit is on', () => {
      const res = quitConfirmation({
        confirmOnQuit: true,
        keepRunningOnQuit: true,
        liveAgentCount: 3,
        agentSiteNames: ['Theme'],
        procStatus: { nginx: live() },
      });
      expect(res).toEqual({
        kind: 'agents-keep-running',
        count: 3,
        message: '3 agents are still running.',
        detail:
          'They keep working after WPXen quits, for up to 24 hours. Your sites will be offline until you open WPXen again.',
        buttons: ['Keep running and quit', 'Stop agents and quit', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
      });
      expect(quitAction(0, res)).toBe('keep-and-quit');
      expect(quitAction(1, res)).toBe('stop-and-quit');
      expect(quitAction(2, res)).toBe('cancel');
    });

    it('uses singular grammar when liveAgentCount is 1', () => {
      const res = quitConfirmation({
        confirmOnQuit: true,
        keepRunningOnQuit: true,
        liveAgentCount: 1,
        agentSiteNames: ['Theme'],
        procStatus: {},
      });
      expect(res.message).toBe('1 agent is still running.');
    });

    it('quits silently and keeps Sessions running when confirmOnQuit is off', () => {
      const res = quitConfirmation({
        confirmOnQuit: false,
        keepRunningOnQuit: true,
        liveAgentCount: 2,
        agentSiteNames: ['Theme'],
        procStatus: { nginx: live() },
      });
      expect(res).toBeNull();
      expect(quitAction(0, res)).toBe('keep-and-quit');
    });

    it('falls back to service confirmation when keepRunningOnQuit is on but liveAgentCount is 0', () => {
      const res = quitConfirmation({
        confirmOnQuit: true,
        keepRunningOnQuit: true,
        liveAgentCount: 0,
        agentSiteNames: [],
        procStatus: { nginx: live() },
      });
      expect(res).toEqual({ kind: 'services', names: ['nginx'] });
    });
  });
});
