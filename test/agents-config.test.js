import { describe, it, expect, beforeEach } from 'vitest';
import agents from '../electron/services/agents.cjs';

// effectiveRegistry() is pure over the injected config — it never probes PATH,
// so it can be tested without stubbing the shell environment. (listAgents()
// does resolve binaries, which is why these tests target the registry.)
beforeEach(() => {
  agents.setConfig({ enabled: null, commands: {}, custom: [] });
});

describe('effectiveRegistry', () => {
  it('returns the built-in agents by default', () => {
    const ids = agents.effectiveRegistry().map((a) => a.id);
    expect(ids).toEqual(['claude', 'codex', 'gemini', 'opencode']);
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
    expect(agents.effectiveRegistry()).toHaveLength(4);
  });
});

describe('setConfig', () => {
  it('ignores malformed config rather than throwing', () => {
    agents.setConfig(undefined);
    expect(agents.effectiveRegistry()).toHaveLength(4);
    agents.setConfig({ enabled: 'nope', commands: 'nope', custom: 'nope' });
    expect(agents.effectiveRegistry()).toHaveLength(4);
  });
});
