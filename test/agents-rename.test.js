import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agents from '../electron/services/agents.cjs';
import { TAB_COLORS } from '../src/lib/tabColors.js';

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-rename-'));
  agents.__setDeps({
    spawnPty: () => ({
      onData() {},
      onExit() {},
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    }),
    shellEnv: () => ({ PATH: '/usr/bin' }),
    userShell: () => '/bin/zsh',
    homedir: () => home,
  });
});

afterEach(() => {
  agents.stopAll();
  fs.rmSync(home, { recursive: true, force: true });
});

const row = (id) => agents.listAllSessions().find((s) => s.sessionId === id);

describe('renameSession', () => {
  it('stores a cleaned name on the Session row, and clears it when empty', () => {
    const site = { id: 'shop', name: 'Shop', path: home };
    const { sessionId } = agents.launch({ site, agentId: agents.SHELL_ID });
    expect(row(sessionId).customTitle).toBeNull();
    expect(row(sessionId).cwd).toBe(home);

    expect(agents.renameSession(sessionId, '  Fix \n checkout  ')).toEqual({ ok: true });
    expect(row(sessionId).customTitle).toBe('Fix checkout');

    expect(agents.renameSession(sessionId, 'x'.repeat(500)).ok).toBe(true);
    expect(row(sessionId).customTitle).toHaveLength(120);

    agents.renameSession(sessionId, '   ');
    expect(row(sessionId).customTitle).toBeNull();
  });

  it('refuses an unknown Session', () => {
    expect(agents.renameSession('nope', 'x')).toEqual({ error: 'session not found' });
  });
});

describe('setSessionPinned', () => {
  it('marks the Session row pinned and unpinned', () => {
    const site = { id: 'shop', name: 'Shop', path: home };
    const { sessionId } = agents.launch({ site, agentId: agents.SHELL_ID });
    expect(row(sessionId).pinned).toBe(false);
    expect(agents.setSessionPinned(sessionId, true)).toEqual({ ok: true });
    expect(row(sessionId).pinned).toBe(true);
    agents.setSessionPinned(sessionId, false);
    expect(row(sessionId).pinned).toBe(false);
    expect(agents.setSessionPinned('nope', true)).toEqual({ error: 'session not found' });
  });
});

describe('setSessionColor', () => {
  it('accepts exactly the renderer palette', () => {
    expect(agents.TAB_COLOR_VALUES).toEqual(
      TAB_COLORS.filter((c) => c.value).map((c) => c.value)
    );
  });

  it('colors the Session row, clears it, and refuses anything else', () => {
    const site = { id: 'shop', name: 'Shop', path: home };
    const { sessionId } = agents.launch({ site, agentId: agents.SHELL_ID });
    expect(row(sessionId).color).toBeNull();
    expect(agents.setSessionColor(sessionId, '#3B82F6')).toEqual({ ok: true });
    expect(row(sessionId).color).toBe('#3b82f6');
    expect(agents.setSessionColor(sessionId, 'red; background: url(x)')).toEqual({
      error: 'unknown tab color',
    });
    expect(row(sessionId).color).toBe('#3b82f6');
    agents.setSessionColor(sessionId, null);
    expect(row(sessionId).color).toBeNull();
  });
});
