import { describe, it, expect, vi, beforeEach } from 'vitest';
import tools from '../electron/services/externalTools.cjs';

// The module probes the machine with execFileSync (`command -v`, mdfind) and
// launches with execFile. Both are swapped through the module's own seam —
// these .cjs services load via Node's CJS loader, so vi.mock on a builtin
// never reaches them — letting the tests describe resolution logic rather than
// whatever happens to be installed on the runner.
const execFileSync = vi.fn();
const execFile = vi.fn();

beforeEach(() => {
  execFileSync.mockReset();
  execFile.mockReset();
  tools.__setDeps({ execFileSync, execFile });
  tools.clearCache();
});

// `command -v <bin>` succeeds for the listed bins; everything else throws the
// way a real non-zero exit would.
function withBins(...available) {
  execFileSync.mockImplementation((cmd, args) => {
    if (cmd === '/bin/sh') {
      const found = available.find((b) => args[1].includes(JSON.stringify(b)));
      if (found) return `/usr/local/bin/${found}\n`;
      throw new Error('not found');
    }
    throw new Error('not found'); // mdfind: no app bundles
  });
}

describe('openInEditor', () => {
  it('launches the editor CLI shim when it resolves', () => {
    withBins('code');
    const fallback = vi.fn();
    const result = tools.openInEditor(
      '/site/wp-config.php',
      { editor: 'vscode' },
      fallback
    );
    expect(result).toMatchObject({ ok: true, via: 'code' });
    expect(execFile).toHaveBeenCalledWith(
      '/usr/local/bin/code',
      ['/site/wp-config.php'],
      expect.anything(),
      expect.any(Function)
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to the system opener when the editor is missing', () => {
    withBins(); // nothing installed
    const fallback = vi.fn();
    const result = tools.openInEditor('/site/x.php', { editor: 'phpstorm' }, fallback);
    expect(result.via).toBe('system');
    expect(result.reason).toMatch(/PhpStorm/);
    expect(fallback).toHaveBeenCalledWith('/site/x.php');
  });

  it("falls back for 'system', the pre-settings behaviour", () => {
    withBins('code');
    const fallback = vi.fn();
    expect(tools.openInEditor('/a.php', { editor: 'system' }, fallback).via).toBe(
      'system'
    );
    expect(fallback).toHaveBeenCalledWith('/a.php');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('runs a custom command with the path as the final argument', () => {
    withBins('mate');
    const result = tools.openInEditor(
      '/site/a b.php',
      { editor: 'custom', customCommand: 'mate -w' },
      vi.fn()
    );
    expect(result).toMatchObject({ ok: true, via: 'custom' });
    // argv, never a shell string — a path with a space stays one argument.
    expect(execFile).toHaveBeenCalledWith(
      '/usr/local/bin/mate',
      ['-w', '/site/a b.php'],
      expect.anything(),
      expect.any(Function)
    );
  });

  it('falls back when a custom command is blank or unresolvable', () => {
    withBins();
    const fallback = vi.fn();
    expect(
      tools.openInEditor('/a.php', { editor: 'custom', customCommand: '   ' }, fallback)
        .via
    ).toBe('system');
    expect(
      tools.openInEditor('/a.php', { editor: 'custom', customCommand: 'nope' }, fallback)
        .via
    ).toBe('system');
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('falls back for an unknown editor id', () => {
    withBins('code');
    const fallback = vi.fn();
    expect(tools.openInEditor('/a.php', { editor: 'notepad' }, fallback).via).toBe(
      'system'
    );
    expect(fallback).toHaveBeenCalled();
  });

  it('tolerates a missing fallback', () => {
    withBins();
    expect(() => tools.openInEditor('/a.php', { editor: 'vscode' })).not.toThrow();
  });
});

describe('openInTerminal', () => {
  it('falls back when the terminal app is not installed', () => {
    withBins();
    const fallback = vi.fn();
    const result = tools.openInTerminal('/site', { terminalApp: 'iterm' }, fallback);
    expect(result.via).toBe('system');
    expect(fallback).toHaveBeenCalledWith('/site');
  });

  it("falls back for 'system'", () => {
    withBins();
    const fallback = vi.fn();
    expect(tools.openInTerminal('/site', { terminalApp: 'system' }, fallback).via).toBe(
      'system'
    );
  });
});

describe('resolveBin caching', () => {
  it('probes each binary once', () => {
    withBins('code');
    tools.resolveBin('code');
    tools.resolveBin('code');
    const shellProbes = execFileSync.mock.calls.filter((c) => c[0] === '/bin/sh');
    expect(shellProbes).toHaveLength(1);
  });

  it('re-probes after clearCache', () => {
    withBins('code');
    tools.resolveBin('code');
    tools.clearCache();
    tools.resolveBin('code');
    const shellProbes = execFileSync.mock.calls.filter((c) => c[0] === '/bin/sh');
    expect(shellProbes).toHaveLength(2);
  });
});

describe('listTools', () => {
  it('reports which editors and terminals were detected', () => {
    withBins('code', 'subl');
    const { editors, terminals } = tools.listTools();
    expect(editors.find((e) => e.id === 'vscode').detected).toBe(true);
    expect(editors.find((e) => e.id === 'zed').detected).toBe(false);
    expect(terminals.every((t) => t.detected === false)).toBe(true);
  });
});
