import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agents from '../electron/services/agents.cjs';

// Remembered Sessions (#228): records live in the JSON store, written on
// launch, title/transcriptId change and exit. Restored at launch as ended,
// resumable for Agents with a resumeFlag and reopenable fresh in the same
// folder for others. Driven through the Session engine's own deps seam with a
// fake pty and a fake store — no Electron.

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

function fakeStore(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    get(key, def) {
      if (!key) return data;
      const val = key.split('.').reduce((o, k) => o?.[k], data);
      return val !== undefined ? structuredClone(val) : def;
    },
    set(key, val) {
      const keys = key.split('.');
      let obj = data;
      for (let i = 0; i < keys.length - 1; i++) {
        if (typeof obj[keys[i]] !== 'object' || obj[keys[i]] === null) obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = structuredClone(val);
    },
  };
}

let home;
let bin;
let ptys;
let store;
let clock;
let nextPid;
let registry; // pid -> claude session uuid

const site = (id = 'shop') => ({
  id,
  name: id,
  path: path.join(home, id),
});

function settleAndType(index) {
  ptys[index].emitData('% ');
  vi.advanceTimersByTime(500);
  return ptys[index].write.mock.calls.map((c) => c[0]).join('');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-remembered-'));
  fs.mkdirSync(path.join(home, 'shop'));
  fs.mkdirSync(path.join(home, 'shop', 'sub'));
  fs.mkdirSync(path.join(home, 'blog'));
  bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'codex', 'agy']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\ntrue\n');
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  ptys = [];
  store = fakeStore({ sites: [site('shop'), site('blog')] });
  clock = 1_000_000;
  nextPid = 1000;
  registry = new Map();

  agents.__setDeps({
    store,
    now: () => clock,
    spawnPty: (file, args, opts) => {
      const p = fakePty();
      p.spawnedWith = { file, args, opts };
      p.pid = nextPid += 10;
      ptys.push(p);
      return p;
    },
    shellEnv: () => ({ PATH: `${bin}:/usr/bin` }),
    userShell: () => '/bin/zsh',
    homedir: () => home,
    sitePhpBin: () => null,
    listProcesses: async () => ptys.map((p) => [p.pid + 1, p.pid]),
    readClaudeSessionId: (pid) => registry.get(pid) || null,
  });
});

afterEach(() => {
  agents.stopAll();
  agents.__setDeps({ store: null, now: () => Date.now() });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('remembered Sessions across quit, crash and restart (#228)', () => {
  it('lists Sessions under their Project as ended with title and Agent after a clean quit and relaunch', () => {
    const s = site('shop');
    const { sessionId } = agents.launch({ site: s, agentId: 'claude' });
    // Terminal sets an OSC title while running.
    ptys[0].emitData('\x1b]0;✳ Fix checkout totals\x07');
    clock += 5000;

    // Clean quit stops live ptys without forgetting the remembered records.
    agents.shutdownAll();
    agents.restoreSessions({ projectIds: ['shop', 'blog'] });

    const rows = agents.listAllSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId,
      siteId: 'shop',
      agentId: 'claude',
      agentName: 'Claude Code',
      title: 'Fix checkout totals',
      exited: true,
      state: 'exited',
      unread: false,
    });
  });

  it('restores Sessions as ended after an unclean kill because records are written on launch, title and transcript change', async () => {
    vi.useFakeTimers();
    try {
      const s = site('shop');
      const { sessionId } = agents.launch({ site: s, agentId: 'claude' });

      // Simulate an immediate crash right after launch: restore in a fresh start.
      const snapshotAfterLaunch = structuredClone(store.data);
      expect(snapshotAfterLaunch[agents.SESSIONS_STORE_KEY]).toHaveLength(1);

      // Update title and transcript id while running (still no exit).
      ptys[0].emitData('\x1b]0;✳ Audit REST endpoints\x07');
      registry.set(ptys[0].pid + 1, 'uuid-live-crash');
      await vi.advanceTimersByTimeAsync(1500);

      // App is killed (SIGKILL / crash) — neither emitExit nor shutdownAll runs.
      // Simulate next launch from the store as it stood mid-run.
      const crashStore = fakeStore(store.data);
      agents.__setDeps({ store: crashStore });
      agents.restoreSessions({ projectIds: ['shop'] });

      const rows = agents.listAllSessions();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sessionId,
        siteId: 'shop',
        agentId: 'claude',
        title: 'Audit REST endpoints',
        transcriptId: 'uuid-live-crash',
        exited: true,
        state: 'exited',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('records exit state when a Session exits normally or with an error', () => {
    const s = site('shop');
    const { sessionId: okId } = agents.launch({ site: s, agentId: 'codex' });
    const { sessionId: errId } = agents.launch({ site: s, agentId: 'codex' });
    clock += 2000;
    ptys[0].emitExit(0);
    ptys[1].emitExit(2);

    const crashStore = fakeStore(store.data);
    agents.__setDeps({ store: crashStore });
    agents.restoreSessions({ projectIds: ['shop'] });

    const byId = Object.fromEntries(
      agents.listAllSessions().map((r) => [r.sessionId, r])
    );
    expect(byId[okId]).toMatchObject({ exited: true, exitCode: 0, state: 'exited' });
    expect(byId[errId]).toMatchObject({ exited: true, exitCode: 2, state: 'error' });
  });

  it('resumes an ended Claude Code Session restored from disk with the same transcript id', async () => {
    vi.useFakeTimers();
    try {
      const s = site('shop');
      const subDir = path.join(s.path, 'sub');
      const { sessionId: oldId } = agents.launch({
        site: s,
        agentId: 'claude',
        cwd: subDir,
      });
      settleAndType(0);
      registry.set(ptys[0].pid + 1, 'uuid-conv-42');
      await vi.advanceTimersByTimeAsync(1500);

      // Quit and relaunch.
      agents.shutdownAll();
      agents.restoreSessions({ projectIds: ['shop'] });

      // Resume the restored ended Session.
      const res = agents.resumeChatSession(oldId, { site: s });
      expect(res.ok).toBe(true);
      const typed = settleAndType(1);
      expect(typed).toContain('--resume uuid-conv-42');
      expect(ptys[1].spawnedWith.opts.cwd).toBe(subDir);

      const newRow = agents.listAllSessions().find((r) => r.sessionId === res.sessionId);
      expect(newRow).toMatchObject({
        siteId: 'shop',
        agentId: 'claude',
        cwd: subDir,
        transcriptId: 'uuid-conv-42',
        resumeFrom: oldId,
        exited: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reopens an ended Session of an Agent without resume support fresh in the same folder, and refuses Resume', () => {
    vi.useFakeTimers();
    try {
      const s = site('shop');
      const subDir = path.join(s.path, 'sub');
      const { sessionId: oldId } = agents.launch({
        site: s,
        agentId: 'codex',
        cwd: subDir,
      });
      settleAndType(0);

      agents.shutdownAll();
      agents.restoreSessions({ projectIds: ['shop'] });

      const restored = agents.listAllSessions().find((r) => r.sessionId === oldId);
      expect(restored.resumeFlag).toBeFalsy();

      // Resume is refused for an Agent with no resume flag.
      expect(agents.resumeChatSession(oldId, { site: s }).error).toMatch(
        /not support|transcript/i
      );

      // Reopen (respawnPane) opens a fresh Session in the same working folder
      // and removes the old ended Session.
      const reopened = agents.respawnPane(oldId, { site: s });
      expect(reopened.ok).toBe(true);
      expect(ptys[1].spawnedWith.opts.cwd).toBe(subDir);
      const typed = settleAndType(1);
      expect(typed).toContain('codex');
      expect(typed).not.toContain('--resume');

      const rows = agents.listAllSessions();
      expect(rows.find((r) => r.sessionId === oldId)).toBeUndefined();
      expect(rows.find((r) => r.sessionId === reopened.sessionId)).toMatchObject({
        siteId: 'shop',
        agentId: 'codex',
        cwd: subDir,
        exited: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes a closed ended Session record so it does not return on the next launch', () => {
    const s = site('shop');
    const { sessionId: keepId } = agents.launch({ site: s, agentId: 'claude' });
    const { sessionId: closeId } = agents.launch({ site: s, agentId: 'codex' });

    agents.shutdownAll();
    agents.restoreSessions({ projectIds: ['shop'] });
    expect(agents.listAllSessions()).toHaveLength(2);

    // User closes / dismisses one ended Session.
    agents.stop(closeId);
    expect(agents.listAllSessions().map((r) => r.sessionId)).toEqual([keepId]);

    // Next launch: the closed one stays gone.
    agents.shutdownAll();
    agents.restoreSessions({ projectIds: ['shop'] });
    expect(agents.listAllSessions().map((r) => r.sessionId)).toEqual([keepId]);
  });

  it('caps ended Sessions at 50 per Project, dropping the oldest first', () => {
    const shop = site('shop');
    const blog = site('blog');
    const shopIds = [];
    for (let i = 0; i < 55; i++) {
      clock += 100;
      const { sessionId } = agents.launch({ site: shop, agentId: 'codex' });
      shopIds.push(sessionId);
      ptys.at(-1).emitExit(0);
    }
    clock += 100;
    const { sessionId: blogId } = agents.launch({ site: blog, agentId: 'codex' });
    ptys.at(-1).emitExit(0);

    agents.shutdownAll();
    agents.restoreSessions({ projectIds: ['shop', 'blog'] });

    const rows = agents.listAllSessions();
    const restoredShop = rows.filter((r) => r.siteId === 'shop').map((r) => r.sessionId);
    const restoredBlog = rows.filter((r) => r.siteId === 'blog').map((r) => r.sessionId);

    expect(restoredShop).toHaveLength(50);
    // Oldest 5 dropped, newest 50 kept in order.
    expect(restoredShop).toEqual(shopIds.slice(5));
    expect(restoredBlog).toEqual([blogId]);
    expect(
      store.get(agents.SESSIONS_STORE_KEY, []).filter((r) => r.siteId === 'shop')
    ).toHaveLength(50);
  });

  it('keeps a long-running Session when it ends after 50 others have ended', () => {
    const shop = site('shop');
    clock += 100;
    const { sessionId: longId } = agents.launch({ site: shop, agentId: 'codex' });
    const longPty = ptys.at(-1);
    for (let i = 0; i < 50; i++) {
      clock += 100;
      agents.launch({ site: shop, agentId: 'codex' });
      ptys.at(-1).emitExit(0);
    }
    clock += 100;
    longPty.emitExit(0);

    const shopRows = agents.listAllSessions().filter((r) => r.siteId === 'shop');
    expect(shopRows).toHaveLength(50);
    expect(shopRows.map((r) => r.sessionId)).toContain(longId);
    expect(
      store.get(agents.SESSIONS_STORE_KEY, []).some((r) => r.sessionId === longId)
    ).toBe(true);
  });

  it('survives a damaged store instead of failing launch and restore', () => {
    store.set(agents.SESSIONS_STORE_KEY, 'not a list');
    store.set('floatingAgentSessions', { not: 'a list' });
    expect(() => agents.restoreSessions({ projectIds: ['shop'] })).not.toThrow();
    store.set(agents.SESSIONS_STORE_KEY, { broken: true });
    const { sessionId } = agents.launch({ site: site('shop'), agentId: 'claude' });
    expect(store.get(agents.SESSIONS_STORE_KEY, []).map((r) => r.sessionId)).toEqual([
      sessionId,
    ]);
  });

  it('saves title-only changes at most once a second, not once per change', async () => {
    vi.useFakeTimers();
    try {
      const { sessionId } = agents.launch({ site: site('shop'), agentId: 'claude' });
      const set = vi.spyOn(store, 'set');
      for (let i = 0; i < 100; i++) ptys[0].emitData(`\x1b]0;Build ${i}s\x07`);
      expect(set).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1100);
      const saves = set.mock.calls.filter(([k]) => k === agents.SESSIONS_STORE_KEY);
      expect(saves).toHaveLength(1);
      expect(saves[0][1].find((r) => r.sessionId === sessionId).title).toBe('Build 99s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops records whose Project no longer exists', () => {
    const shop = site('shop');
    const blog = site('blog');
    const { sessionId: shopId } = agents.launch({ site: shop, agentId: 'claude' });
    agents.launch({ site: blog, agentId: 'claude' });

    agents.shutdownAll();
    // 'blog' was deleted before relaunch.
    agents.restoreSessions({ projectIds: ['shop'] });

    expect(agents.listAllSessions().map((r) => r.sessionId)).toEqual([shopId]);
    expect(store.get(agents.SESSIONS_STORE_KEY, []).map((r) => r.sessionId)).toEqual([
      shopId,
    ]);
  });

  it('does not remember Floating Workspace terminals', () => {
    const shop = site('shop');
    const { sessionId: siteSessionId } = agents.launch({ site: shop, agentId: 'claude' });
    agents.launchFloating({ cwd: home });

    expect(store.get(agents.SESSIONS_STORE_KEY, []).map((r) => r.sessionId)).toEqual([
      siteSessionId,
    ]);

    agents.shutdownAll();
    agents.restoreSessions({ projectIds: ['shop'] });

    expect(agents.listFloatingSessions()).toEqual([]);
    expect(agents.listAllSessions().map((r) => r.sessionId)).toEqual([siteSessionId]);
  });

  it('pushes restored Sessions on the change feed', () => {
    const s = site('shop');
    const { sessionId } = agents.launch({ site: s, agentId: 'claude' });
    agents.shutdownAll();

    const listener = vi.fn();
    const off = agents.onSessionsChanged(listener);
    agents.restoreSessions({ projectIds: ['shop'] });
    off();

    expect(listener).toHaveBeenCalled();
    expect(listener.mock.calls.at(-1)[0].map((r) => r.sessionId)).toEqual([sessionId]);
  });
});
