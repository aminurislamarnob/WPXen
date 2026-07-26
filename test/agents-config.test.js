import { describe, it, expect, beforeEach } from 'vitest';
import agents from '../electron/services/agents.cjs';

// effectiveRegistry() is pure over the injected config — it never probes PATH,
// so it can be tested without stubbing the shell environment. (listAgents()
// does resolve binaries, which is why these tests target the registry.)
beforeEach(() => {
  agents.setConfig({ enabled: null, commands: {}, custom: [] });
});

// Derived, not hardcoded: which providers ship built in is the launcher's
// business and changes as new CLIs appear — these tests are about what the
// user's config does to that list, whatever it currently holds.
agents.setConfig({ enabled: null, commands: {}, custom: [] });
const BUILT_IN = agents.effectiveRegistry();

describe('effectiveRegistry', () => {
  it('returns the built-in agents, unmodified, by default', () => {
    const list = agents.effectiveRegistry();
    expect(list).toHaveLength(BUILT_IN.length);
    expect(list.map((a) => a.id)).toContain('claude');
    expect(list.every((a) => a.id && a.cmd && a.name)).toBe(true);
    expect(list.some((a) => a.isCustom)).toBe(false);
  });

  it('applies a command override without changing the agent id or name', () => {
    agents.setConfig({ commands: { claude: 'claude --resume' } });
    const claude = agents.effectiveRegistry().find((a) => a.id === 'claude');
    expect(claude.cmd).toBe('claude --resume');
    expect(claude.name).toBe('Claude Code');
  });

  it('ignores a blank or whitespace-only override', () => {
    agents.setConfig({ commands: { claude: '   ' } });
    expect(agents.effectiveRegistry().find((a) => a.id === 'claude').cmd).toBe('claude');
  });

  it('appends a custom agent and marks it as such', () => {
    agents.setConfig({ custom: [{ id: 'aider', name: 'Aider', cmd: 'aider' }] });
    const aider = agents.effectiveRegistry().find((a) => a.id === 'aider');
    expect(aider).toMatchObject({
      id: 'aider',
      name: 'Aider',
      cmd: 'aider',
      isCustom: true,
    });
  });

  it('falls back to the id when a custom agent has no name', () => {
    agents.setConfig({ custom: [{ id: 'aider', cmd: 'aider' }] });
    expect(agents.effectiveRegistry().find((a) => a.id === 'aider').name).toBe('aider');
  });

  it('lets a custom entry replace a built-in of the same id', () => {
    agents.setConfig({ custom: [{ id: 'claude', name: 'Mine', cmd: 'my-claude' }] });
    const all = agents.effectiveRegistry().filter((a) => a.id === 'claude');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: 'Mine', cmd: 'my-claude', isCustom: true });
  });

  it('skips custom entries missing an id or a command', () => {
    agents.setConfig({
      custom: [{ name: 'No id', cmd: 'x' }, { id: 'no-cmd' }, null],
    });
    expect(agents.effectiveRegistry()).toHaveLength(BUILT_IN.length);
  });
});

describe('setConfig', () => {
  it('ignores malformed config rather than throwing', () => {
    agents.setConfig(undefined);
    expect(agents.effectiveRegistry()).toHaveLength(BUILT_IN.length);
    agents.setConfig({ enabled: 'nope', commands: 'nope', custom: 'nope' });
    expect(agents.effectiveRegistry()).toHaveLength(BUILT_IN.length);
  });
});
