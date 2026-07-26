import { describe, it, expect } from 'vitest';
import agents from '../electron/services/agents.cjs';

const { resolveLaunch } = agents;
const SITE = '/Users/me/Sites/foo';

// A plain-shell launch passes an empty cmd, so the resolved command collapses
// to the args alone — or to '' , which launch() reads as "type nothing".
describe('agents.resolveLaunch — plain shell', () => {
  it('resolves to an empty command at the webroot', () => {
    expect(resolveLaunch({ cmd: '', sitePath: SITE })).toEqual({
      command: '',
      cwd: SITE,
      label: null,
    });
  });

  it('still honours a pinned directory', () => {
    const r = resolveLaunch({
      cmd: '',
      sitePath: SITE,
      target: { cwd: 'wp-content/plugins/foo', label: 'Plugin' },
    });
    expect(r).toEqual({
      command: '',
      cwd: `${SITE}/wp-content/plugins/foo`,
      label: 'Plugin',
    });
  });

  it('types just the args when a preset supplies them, with no stray space', () => {
    const r = resolveLaunch({ cmd: '', sitePath: SITE, globalArgs: 'npm run dev' });
    expect(r.command).toBe('npm run dev');
  });
});

describe('agents.resolveLaunch', () => {
  it('bare command at the webroot when nothing is configured', () => {
    expect(resolveLaunch({ cmd: 'claude', sitePath: SITE })).toEqual({
      command: 'claude',
      cwd: SITE,
      label: null,
    });
  });

  it('appends the global default flags', () => {
    const r = resolveLaunch({
      cmd: 'claude',
      sitePath: SITE,
      globalArgs: '--dangerously-skip-permissions',
    });
    expect(r.command).toBe('claude --dangerously-skip-permissions');
    expect(r.cwd).toBe(SITE);
  });

  it('trims surrounding whitespace on the global flags', () => {
    const r = resolveLaunch({ cmd: 'codex', sitePath: SITE, globalArgs: '  --yolo  ' });
    expect(r.command).toBe('codex --yolo');
  });

  it('resolves a webroot-relative target directory', () => {
    const r = resolveLaunch({
      cmd: 'claude',
      sitePath: SITE,
      target: { id: 't1', label: 'plugin', cwd: 'wp-content/plugins/foo' },
    });
    expect(r.cwd).toBe(`${SITE}/wp-content/plugins/foo`);
    expect(r.label).toBe('plugin');
  });

  it('keeps an absolute target directory (e.g. a sibling worktree)', () => {
    const r = resolveLaunch({
      cmd: 'claude',
      sitePath: SITE,
      target: { cwd: '/Users/me/worktrees/feature-x' },
    });
    expect(r.cwd).toBe('/Users/me/worktrees/feature-x');
  });

  it('resolves a ../ relative target against the webroot', () => {
    const r = resolveLaunch({
      cmd: 'claude',
      sitePath: SITE,
      target: { cwd: '../foo-feature' },
    });
    expect(r.cwd).toBe('/Users/me/Sites/foo-feature');
  });

  it('target flags override the global default', () => {
    const r = resolveLaunch({
      cmd: 'claude',
      sitePath: SITE,
      globalArgs: '--dangerously-skip-permissions',
      target: { cwd: SITE, args: '--model opus' },
    });
    expect(r.command).toBe('claude --model opus');
  });

  it('inherits the global default when target args are null', () => {
    const r = resolveLaunch({
      cmd: 'claude',
      sitePath: SITE,
      globalArgs: '--dangerously-skip-permissions',
      target: { cwd: SITE, args: null },
    });
    expect(r.command).toBe('claude --dangerously-skip-permissions');
  });

  it('an explicit empty-string target arg overrides the global to nothing', () => {
    const r = resolveLaunch({
      cmd: 'claude',
      sitePath: SITE,
      globalArgs: '--dangerously-skip-permissions',
      target: { cwd: SITE, args: '' },
    });
    expect(r.command).toBe('claude');
  });
});
