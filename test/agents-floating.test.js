import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agents from '../electron/services/agents.cjs';

// Floating Workspace terminals ride the Session engine with no owning Site.
// The pty is swapped through the module's own seam (.cjs loads out of
// vi.mock's reach), so these tests describe what a floating launch does and
// where its Session shows up — not how the engine stores it.

function fakePty() {
  const handlers = { data: [], exit: [] };
  return {
    spawnedWith: null,
    onData: (cb) => handlers.data.push(cb),
    onExit: (cb) => handlers.exit.push(cb),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emitData: (d) => handlers.data.forEach((cb) => cb(d)),
    emitExit: (code) => handlers.exit.forEach((cb) => cb({ exitCode: code })),
  };
}

let home;
let ptys;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-floating-'));
  fs.mkdirSync(path.join(home, 'code'));
  ptys = [];
  agents.__setDeps({
    spawnPty: (file, args, opts) => {
      const p = fakePty();
      p.spawnedWith = { file, args, opts };
      ptys.push(p);
      return p;
    },
    shellEnv: () => ({ PATH: '/usr/bin' }),
    userShell: () => '/bin/zsh',
    homedir: () => home,
  });
});

afterEach(() => {
  agents.stopAll();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agents.launchFloating', () => {
  it('types a given one-line command once the shell settles', () => {
    vi.useFakeTimers();
    try {
      agents.launchFloating({ cwd: home, command: '  gh auth login --web ' });
      ptys[0].emitData('% ');
      vi.advanceTimersByTime(200);
      expect(ptys[0].write).toHaveBeenCalledWith('gh auth login --web\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a multi-line command — it would be typed, not exec’d', () => {
    expect(agents.launchFloating({ cwd: home, command: 'ls\nrm -rf x' }).error).toMatch(
      /single line/
    );
    expect(ptys).toHaveLength(0);
  });

  it('starts a login shell in the given directory, with no Site', () => {
    const res = agents.launchFloating({ cwd: path.join(home, 'code') });
    expect(res.ok).toBe(true);
    expect(ptys).toHaveLength(1);
    expect(ptys[0].spawnedWith.file).toBe('/bin/zsh');
    expect(ptys[0].spawnedWith.args).toEqual(['-il']);
    expect(ptys[0].spawnedWith.opts.cwd).toBe(path.join(home, 'code'));
    // A plain shell: nothing is typed into it.
    expect(ptys[0].write).not.toHaveBeenCalled();
  });

  it('expands ~ and ~/ against the home directory', () => {
    agents.launchFloating({ cwd: '~' });
    agents.launchFloating({ cwd: '~/code' });
    expect(ptys.map((p) => p.spawnedWith.opts.cwd)).toEqual([
      home,
      path.join(home, 'code'),
    ]);
  });

  it('defaults to the home directory when no cwd is given', () => {
    agents.launchFloating();
    expect(ptys[0].spawnedWith.opts.cwd).toBe(home);
  });

  it('refuses a directory that does not exist, without spawning', () => {
    const res = agents.launchFloating({ cwd: path.join(home, 'gone') });
    expect(res.error).toMatch(/Directory not found/);
    expect(ptys).toHaveLength(0);
  });

  it('refuses a relative path', () => {
    const res = agents.launchFloating({ cwd: 'code' });
    expect(res.error).toMatch(/Directory not found/);
    expect(ptys).toHaveLength(0);
  });

  it('refuses a file as the directory', () => {
    const file = path.join(home, 'notes.txt');
    fs.writeFileSync(file, '');
    expect(agents.launchFloating({ cwd: file }).error).toMatch(/Directory not found/);
  });
});

describe('floating Sessions are kept apart from Site Sessions', () => {
  it('lists them on the floating feed, never in the Site list', () => {
    const { sessionId } = agents.launchFloating({ cwd: home });

    expect(agents.listAllSessions().some((s) => s.sessionId === sessionId)).toBe(false);
    const floating = agents.listFloatingSessions();
    expect(floating).toHaveLength(1);
    expect(floating[0]).toMatchObject({
      sessionId,
      siteId: null,
      cwd: home,
      exited: false,
    });
  });

  it('notifies floating listeners, not Site listeners', () => {
    const site = vi.fn();
    const floating = vi.fn();
    const offSite = agents.onSessionsChanged(site);
    const offFloating = agents.onFloatingSessionsChanged(floating);

    const { sessionId } = agents.launchFloating({ cwd: home });

    expect(floating).toHaveBeenCalled();
    expect(floating.mock.calls.at(-1)[0].map((s) => s.sessionId)).toEqual([sessionId]);
    for (const [list] of site.mock.calls) {
      expect(list.some((s) => s.sessionId === sessionId)).toBe(false);
    }
    offSite();
    offFloating();
  });

  it('does not hold up quitting', () => {
    agents.launchFloating({ cwd: home });
    expect(agents.hasActiveSessions()).toBe(false);
    expect(agents.activeSiteIds()).toEqual([]);
  });

  it('never raises a native alert, even on a bell', () => {
    const alert = vi.fn();
    const off = agents.onAlert(alert);
    agents.launchFloating({ cwd: home });
    ptys[0].emitData('\x07');
    ptys[0].emitExit(1);
    expect(alert).not.toHaveBeenCalled();
    off();
  });

  it('marks the Session exited when its shell exits', () => {
    const { sessionId } = agents.launchFloating({ cwd: home });
    ptys[0].emitExit(0);
    expect(
      agents.listFloatingSessions().find((s) => s.sessionId === sessionId)
    ).toMatchObject({ exited: true, exitCode: 0 });
  });

  it('drops the Session from the floating list once stopped', () => {
    const { sessionId } = agents.launchFloating({ cwd: home });
    agents.stop(sessionId);
    expect(agents.listFloatingSessions()).toEqual([]);
  });
});

describe('agents.launch for Start →', () => {
  const site = () => ({ id: 'shop', name: 'Shop', path: home });
  beforeEach(() => {
    // `sh` is on every PATH, so this custom agent is always "installed".
    agents.setConfig({ custom: [{ id: 'fake', name: 'Fake', cmd: 'sh --agent' }] });
  });
  afterEach(() => agents.setConfig({}));

  it('runs at the given cwd, with the prompt quoted onto the command line', () => {
    vi.useFakeTimers();
    try {
      const res = agents.launch({
        site: site(),
        agentId: 'fake',
        cwd: path.join(home, 'code'),
        prompt: "Complete it's\nhttps://x/1",
      });
      expect(res.ok).toBe(true);
      expect(ptys[0].spawnedWith.opts.cwd).toBe(path.join(home, 'code'));
      ptys[0].emitData('% ');
      vi.advanceTimersByTime(200);
      expect(ptys[0].write).toHaveBeenCalledWith(
        "sh --agent 'Complete it'\\''s https://x/1'\r"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs Claude with a prompt positionally (unchanged)', () => {
    vi.useFakeTimers();
    try {
      agents.setConfig({ commands: { claude: 'sh --claude' } });
      const res = agents.launch({ site: site(), agentId: 'claude', prompt: 'Fix it' });
      expect(res.ok).toBe(true);
      ptys[0].emitData('% ');
      vi.advanceTimersByTime(200);
      expect(ptys[0].write).toHaveBeenCalledWith("sh --claude 'Fix it'\r");
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs Antigravity with a prompt using its promptFlag', () => {
    vi.useFakeTimers();
    try {
      agents.setConfig({ commands: { antigravity: 'sh --agy' } });
      const res = agents.launch({
        site: site(),
        agentId: 'antigravity',
        prompt: 'Fix it',
      });
      expect(res.ok).toBe(true);
      ptys[0].emitData('% ');
      vi.advanceTimersByTime(200);
      expect(ptys[0].write).toHaveBeenCalledWith("sh --agy -i 'Fix it'\r");
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs Antigravity without a prompt, omitting the flag', () => {
    vi.useFakeTimers();
    try {
      agents.setConfig({ commands: { antigravity: 'sh --agy' } });
      const res = agents.launch({ site: site(), agentId: 'antigravity' });
      expect(res.ok).toBe(true);
      ptys[0].emitData('% ');
      vi.advanceTimersByTime(200);
      expect(ptys[0].write).toHaveBeenCalledWith('sh --agy\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies promptFlag even if Antigravity command is overridden in Settings', () => {
    vi.useFakeTimers();
    try {
      agents.setConfig({ commands: { antigravity: 'sh --agy-override' } });
      const res = agents.launch({
        site: site(),
        agentId: 'antigravity',
        prompt: 'Fix it',
      });
      expect(res.ok).toBe(true);
      ptys[0].emitData('% ');
      vi.advanceTimersByTime(200);
      expect(ptys[0].write).toHaveBeenCalledWith("sh --agy-override -i 'Fix it'\r");
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the issue on the Session row', () => {
    const { sessionId } = agents.launch({
      site: site(),
      agentId: 'fake',
      issue: {
        repo: 'acme/shop',
        number: '7',
        url: 'u',
        title: 'T',
        kind: 'bogus',
        extra: 1,
      },
    });
    const row = agents.listAllSessions().find((s) => s.sessionId === sessionId);
    expect(row.issue).toEqual({
      repo: 'acme/shop',
      number: 7,
      url: 'u',
      title: 'T',
      kind: 'issue',
    });
  });

  it('links a PR the same way', () => {
    const { sessionId } = agents.launch({
      site: site(),
      agentId: 'fake',
      issue: { repo: 'acme/shop', number: 9, url: 'u', title: 'Fix', kind: 'pr' },
    });
    expect(
      agents.listAllSessions().find((s) => s.sessionId === sessionId).issue
    ).toMatchObject({ number: 9, kind: 'pr' });
  });

  it('leaves an ordinary launch unlinked', () => {
    const { sessionId } = agents.launch({ site: site(), agentId: 'fake' });
    expect(
      agents.listAllSessions().find((s) => s.sessionId === sessionId).issue
    ).toBeNull();
  });
});
