import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import agents from '../electron/services/agents.cjs';

// installAgent() shells out — to Homebrew or to a vendor script — so it goes
// through the module's own `deps` seam rather than vi.mock: electron CJS
// modules load through Node's loader, out of vi.mock's reach (CLAUDE.md).
let brewCalls;
let scriptCalls;

const CLEAN_CONFIG = { enabled: null, commands: {}, custom: [] };

beforeEach(() => {
  agents.setConfig(CLEAN_CONFIG);
  brewCalls = [];
  scriptCalls = [];
  agents.__setDeps({
    isBrewInstalled: () => true,
    runBrewStreaming: (args, onProgress) => {
      brewCalls.push(args);
      onProgress?.('==> Downloading');
      return Promise.resolve();
    },
    runScriptStreaming: (url, onProgress) => {
      scriptCalls.push(url);
      onProgress?.('Installing mimocode');
      return Promise.resolve();
    },
  });
});

afterEach(() => agents.setConfig(CLEAN_CONFIG));

// Derived from the registry, not hardcoded — which agents ship which installer
// changes as CLIs appear, and a test that pinned names would just be a second
// copy of the registry to keep in sync.
const registry = () => agents.effectiveRegistry();
const byKind = (kind) => registry().filter((a) => a.installer?.kind === kind);
const firstBrew = () => byKind('brew')[0];
const firstScript = () => byKind('script')[0];

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

describe('installScriptUrl', () => {
  it('accepts an https URL', () => {
    expect(agents.installScriptUrl({ url: 'https://example.test/install' })).toBe(
      'https://example.test/install'
    );
  });

  // This is the one place the app runs code it did not ship. Plain http would
  // let anyone on the network path choose what executes.
  it('refuses anything but https', () => {
    for (const url of ['http://example.test/i', 'file:///etc/passwd', 'ftp://x/i']) {
      expect(() => agents.installScriptUrl({ url })).toThrow(/https/);
    }
  });

  it('refuses embedded credentials', () => {
    expect(() => agents.installScriptUrl({ url: 'https://u:p@example.test/i' })).toThrow(
      /must not carry credentials/
    );
  });

  it('refuses a missing or unparseable URL', () => {
    expect(() => agents.installScriptUrl(null)).toThrow(/No install script/);
    expect(() => agents.installScriptUrl({ url: 'nonsense' })).toThrow(
      /Invalid install script/
    );
  });
});

describe('assertShellScript', () => {
  it('accepts something with a shebang', () => {
    expect(agents.assertShellScript('#!/usr/bin/env bash\nset -e\n')).toBe(true);
  });

  // A CDN that answers 200 with an error page must not get executed.
  it('refuses a response that is not a script', () => {
    expect(() => agents.assertShellScript('<html>404</html>')).toThrow(
      /not a shell script/
    );
  });

  it('refuses an empty or truncated body', () => {
    expect(() => agents.assertShellScript('')).toThrow(/empty/);
    expect(() => agents.assertShellScript('   \n ')).toThrow(/empty/);
    expect(() => agents.assertShellScript(null)).toThrow(/empty/);
  });
});

describe('registry installers', () => {
  it('offers at least one of each kind', () => {
    expect(byKind('brew').length).toBeGreaterThan(0);
    expect(byKind('script').length).toBeGreaterThan(0);
  });

  it('every declared installer is well-formed for its kind', () => {
    for (const agent of byKind('brew')) {
      expect(() => agents.brewInstallArgs(agent.installer), agent.id).not.toThrow();
    }
    for (const agent of byKind('script')) {
      expect(() => agents.installScriptUrl(agent.installer), agent.id).not.toThrow();
    }
  });

  it('has no installer of an unrecognised kind', () => {
    for (const agent of registry()) {
      if (!agent.installer) continue;
      expect(['brew', 'script'], agent.id).toContain(agent.installer.kind);
    }
  });

  it('exposes the installer through listAgents so the UI can offer a button', () => {
    const listed = agents.listAgents({ all: true, shell: false });
    for (const agent of registry()) {
      const row = listed.find((a) => a.id === agent.id);
      // null, not undefined — the renderer branches on it.
      expect(row.installer ?? null).toEqual(agent.installer ?? null);
    }
  });

  it('never offers an installer for the plain shell', () => {
    expect(agents.listAgents().find((a) => a.isShell).installer).toBeNull();
  });
});

describe('installAgent', () => {
  it('runs brew install for a brew-kind agent', async () => {
    const target = firstBrew();
    await agents.installAgent(target.id);
    expect(brewCalls).toEqual([agents.brewInstallArgs(target.installer)]);
    expect(scriptCalls).toEqual([]);
  });

  it('runs the vendor script for a script-kind agent', async () => {
    const target = firstScript();
    await agents.installAgent(target.id);
    expect(scriptCalls).toEqual([target.installer.url]);
    expect(brewCalls).toEqual([]);
  });

  // The two paths are independent: conflating them would make a script-kind
  // agent uninstallable on a machine without Homebrew, for no reason.
  it('does not require Homebrew for a script-kind agent', async () => {
    agents.__setDeps({ isBrewInstalled: () => false });
    const target = firstScript();
    await agents.installAgent(target.id);
    expect(scriptCalls).toEqual([target.installer.url]);
  });

  it('streams installer output to the progress callback, both kinds', async () => {
    const onBrew = vi.fn();
    await agents.installAgent(firstBrew().id, onBrew);
    expect(onBrew).toHaveBeenCalledWith('==> Downloading');

    const onScript = vi.fn();
    await agents.installAgent(firstScript().id, onScript);
    expect(onScript).toHaveBeenCalledWith('Installing mimocode');
  });

  it('rejects an unknown agent id', async () => {
    await expect(agents.installAgent('nope')).rejects.toThrow(/Unknown agent/);
    expect(brewCalls).toEqual([]);
    expect(scriptCalls).toEqual([]);
  });

  it('rejects an agent with no installer, quoting its install hint', async () => {
    const textOnly = registry().find((a) => !a.installer && a.install);
    if (!textOnly) return;
    await expect(agents.installAgent(textOnly.id)).rejects.toThrow(
      new RegExp(textOnly.install.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
    expect(brewCalls).toEqual([]);
    expect(scriptCalls).toEqual([]);
  });

  it('rejects a user-defined agent — custom entries carry no vetted installer', async () => {
    agents.setConfig({
      ...CLEAN_CONFIG,
      custom: [{ id: 'mine', name: 'Mine', cmd: 'mine' }],
    });
    await expect(agents.installAgent('mine')).rejects.toThrow(/no one-click install/i);
    expect(brewCalls).toEqual([]);
    expect(scriptCalls).toEqual([]);
  });

  it('fails clearly when Homebrew is absent for a brew-kind agent', async () => {
    agents.__setDeps({ isBrewInstalled: () => false });
    await expect(agents.installAgent(firstBrew().id)).rejects.toThrow(
      /Homebrew is not installed/
    );
    expect(brewCalls).toEqual([]);
  });

  it('propagates a brew failure instead of reporting success', async () => {
    agents.__setDeps({
      runBrewStreaming: () => Promise.reject(new Error('Error: No available formula')),
    });
    await expect(agents.installAgent(firstBrew().id)).rejects.toThrow(
      /No available formula/
    );
  });

  it('propagates a script failure instead of reporting success', async () => {
    agents.__setDeps({
      runScriptStreaming: () =>
        Promise.reject(new Error('Install script failed (exit 1)')),
    });
    await expect(agents.installAgent(firstScript().id)).rejects.toThrow(
      /Install script failed/
    );
  });
});

// Guards the seam itself: if __setDeps ever stopped being honoured, every test
// above would start shelling out for real and quietly pass.
describe('deps seam', () => {
  it('routes through the injected runners, not the real ones', async () => {
    let usedBrew = false;
    let usedScript = false;
    agents.__setDeps({
      runBrewStreaming: () => ((usedBrew = true), Promise.resolve()),
      runScriptStreaming: () => ((usedScript = true), Promise.resolve()),
    });
    await agents.installAgent(firstBrew().id);
    await agents.installAgent(firstScript().id);
    expect(usedBrew).toBe(true);
    expect(usedScript).toBe(true);
  });
});
