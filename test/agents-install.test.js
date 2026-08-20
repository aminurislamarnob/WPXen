import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import agents from '../electron/services/agents.cjs';

// installAgent() shells out to Homebrew, so it goes through the module's own
// `deps` seam rather than vi.mock — electron/**/*.cjs load through Node's CJS
// loader, out of vi.mock's reach (see CLAUDE.md → Testing).
let calls;

beforeEach(() => {
  agents.setConfig({ enabled: null, commands: {}, custom: [] });
  calls = [];
  agents.__setDeps({
    isBrewInstalled: () => true,
    runBrewStreaming: (args, onProgress) => {
      calls.push(args);
      onProgress?.('==> Downloading');
      return Promise.resolve();
    },
  });
});

afterEach(() => {
  agents.setConfig({ enabled: null, commands: {}, custom: [] });
});

describe('brewInstallArgs', () => {
  it('installs a formula without --cask', () => {
    expect(agents.brewInstallArgs({ name: 'gemini-cli' })).toEqual([
      'install',
      'gemini-cli',
    ]);
  });

  it('installs a cask with --cask', () => {
    expect(agents.brewInstallArgs({ name: 'claude-code', cask: true })).toEqual([
      'install',
      '--cask',
      'claude-code',
    ]);
  });

  it('refuses a missing or empty package', () => {
    expect(() => agents.brewInstallArgs(null)).toThrow(/No Homebrew package/);
    expect(() => agents.brewInstallArgs({ name: '   ' })).toThrow(/No Homebrew package/);
  });

  // The name is ours, but it lands in an argv — a registry typo should fail
  // loudly rather than becoming brew arguments.
  it('refuses anything that is not a plain package token', () => {
    for (const name of ['bad name', 'foo; whoami', '--force', '$(id)', '-x']) {
      expect(() => agents.brewInstallArgs({ name })).toThrow(
        /Invalid Homebrew package name/
      );
    }
  });
});

describe('registry brew targets', () => {
  // Derived, not hardcoded — which agents ship a Homebrew package changes as
  // CLIs appear. What must hold is the shape, so a malformed entry can't reach
  // an argv.
  const withBrew = agents.effectiveRegistry().filter((a) => a.brew);

  it('has at least one agent installable via Homebrew', () => {
    expect(withBrew.length).toBeGreaterThan(0);
  });

  it('every brew target is a well-formed package name', () => {
    for (const agent of withBrew) {
      expect(typeof agent.brew.name, `${agent.id}`).toBe('string');
      expect(() => agents.brewInstallArgs(agent.brew)).not.toThrow();
    }
  });

  it('exposes the target through listAgents so the UI can offer a button', () => {
    const listed = agents.listAgents({ all: true, shell: false });
    for (const agent of withBrew) {
      const row = listed.find((a) => a.id === agent.id);
      expect(row.brew).toEqual(agent.brew);
    }
    // Agents without a package must report null, not undefined — the renderer
    // branches on it.
    for (const row of listed) {
      if (!withBrew.some((a) => a.id === row.id)) expect(row.brew).toBeNull();
    }
  });

  it('never offers a package for the plain shell', () => {
    const shell = agents.listAgents().find((a) => a.isShell);
    expect(shell.brew).toBeNull();
  });
});

describe('installAgent', () => {
  it('runs brew install for an agent that has a package', async () => {
    const target = agents.effectiveRegistry().find((a) => a.brew);
    await agents.installAgent(target.id);
    expect(calls).toEqual([agents.brewInstallArgs(target.brew)]);
  });

  it('streams brew output to the progress callback', async () => {
    const target = agents.effectiveRegistry().find((a) => a.brew);
    const onProgress = vi.fn();
    await agents.installAgent(target.id, onProgress);
    expect(onProgress).toHaveBeenCalledWith('==> Downloading');
  });

  it('rejects an unknown agent id', async () => {
    await expect(agents.installAgent('nope')).rejects.toThrow(/Unknown agent/);
    expect(calls).toEqual([]);
  });

  // The npm-hint agents must not silently do nothing — the error carries the
  // command the user should run instead.
  it('rejects an agent with no Homebrew package, quoting its install hint', async () => {
    const textOnly = agents.effectiveRegistry().find((a) => !a.brew && a.install);
    if (!textOnly) return;
    await expect(agents.installAgent(textOnly.id)).rejects.toThrow(
      new RegExp(textOnly.install.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
    expect(calls).toEqual([]);
  });

  it('rejects a user-defined agent — custom entries carry no vetted package', async () => {
    agents.setConfig({
      enabled: null,
      commands: {},
      custom: [{ id: 'mine', name: 'Mine', cmd: 'mine' }],
    });
    await expect(agents.installAgent('mine')).rejects.toThrow(/no Homebrew package/i);
    expect(calls).toEqual([]);
  });

  it('fails clearly when Homebrew is absent', async () => {
    agents.__setDeps({ isBrewInstalled: () => false });
    const target = agents.effectiveRegistry().find((a) => a.brew);
    await expect(agents.installAgent(target.id)).rejects.toThrow(
      /Homebrew is not installed/
    );
    expect(calls).toEqual([]);
  });

  it('propagates a brew failure instead of reporting success', async () => {
    agents.__setDeps({
      runBrewStreaming: () => Promise.reject(new Error('Error: No available formula')),
    });
    const target = agents.effectiveRegistry().find((a) => a.brew);
    await expect(agents.installAgent(target.id)).rejects.toThrow(/No available formula/);
  });
});

// Guards the seam itself: if __setDeps ever stopped being honoured, every test
// above would start shelling out to real brew and quietly pass.
describe('deps seam', () => {
  it('routes through the injected runBrewStreaming, not the real one', async () => {
    let used = false;
    agents.__setDeps({ runBrewStreaming: () => ((used = true), Promise.resolve()) });
    const target = agents.effectiveRegistry().find((a) => a.brew);
    await agents.installAgent(target.id);
    expect(used).toBe(true);
  });
});
