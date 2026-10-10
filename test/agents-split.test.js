import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agents from '../electron/services/agents.cjs';

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
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-split-'));
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

describe('agents split layout', () => {
  const site = () => ({ id: 'shop', name: 'Shop', path: path.join(home, 'code') });

  it('splitting a root creates a shell Session with paneOf and the right cwd', () => {
    const s = site();
    const { sessionId: rootId } = agents.launch({ site: s, agentId: agents.SHELL_ID });

    // Change cwd of root somehow? It launches in site.path.
    // For test purposes, we will just pass site which has path.
    const res = agents.splitPane(rootId, 'right', s);
    expect(res.ok).toBe(true);
    const childId = res.sessionId;

    expect(ptys).toHaveLength(2);
    expect(ptys[1].spawnedWith.opts.cwd).toBe(s.path);

    const rows = agents.listAllSessions();
    const childRow = rows.find((r) => r.sessionId === childId);
    expect(childRow.paneOf).toBe(rootId);
    expect(childRow.layout).toBeNull();

    const rootRow = rows.find((r) => r.sessionId === rootId);
    expect(rootRow.layout).toEqual({
      dir: 'right',
      ratio: 50,
      a: { leaf: rootId },
      b: { leaf: childId },
    });
  });

  it('nested splits create a layout tree right → down → right', () => {
    const s = site();
    const { sessionId: rootId } = agents.launch({ site: s, agentId: agents.SHELL_ID });

    // Split right
    const { sessionId: c1 } = agents.splitPane(rootId, 'right', s);

    // Split down on c1
    const { sessionId: c2 } = agents.splitPane(c1, 'down', s);

    // Split right on c2
    const { sessionId: c3 } = agents.splitPane(c2, 'right', s);

    const rootRow = agents.listAllSessions().find((r) => r.sessionId === rootId);
    expect(rootRow.layout).toEqual({
      dir: 'right',
      ratio: 50,
      a: { leaf: rootId },
      b: {
        dir: 'down',
        ratio: 50,
        a: { leaf: c1 },
        b: {
          dir: 'right',
          ratio: 50,
          a: { leaf: c2 },
          b: { leaf: c3 },
        },
      },
    });
  });

  it('setPaneRatio updates the tree', () => {
    const s = site();
    const { sessionId: rootId } = agents.launch({ site: s, agentId: agents.SHELL_ID });
    const { sessionId: c1 } = agents.splitPane(rootId, 'right', s);
    agents.splitPane(c1, 'down', s);

    agents.setPaneRatio(rootId, '', 30); // root split
    agents.setPaneRatio(rootId, 'b', 60); // child split

    const rootRow = agents.listAllSessions().find((r) => r.sessionId === rootId);
    expect(rootRow.layout.ratio).toBe(30);
    expect(rootRow.layout.b.ratio).toBe(60);
  });
});

describe('pane lifecycle', () => {
  const site = () => ({ id: 'shop', name: 'Shop', path: path.join(home, 'code') });

  it('collapse at depth 1', () => {
    const s = site();
    const { sessionId: rootId } = agents.launch({ site: s, agentId: agents.SHELL_ID });
    const { sessionId: childId } = agents.splitPane(rootId, 'right', s);

    agents.stop(childId);

    const rows = agents.listAllSessions();
    const rootRow = rows.find((r) => r.sessionId === rootId);
    expect(rootRow.layout).toEqual({ leaf: rootId });
    expect(rows.find((r) => r.sessionId === childId)).toBeUndefined();
  });

  it('collapse at depth 3', () => {
    const s = site();
    const { sessionId: rootId } = agents.launch({ site: s, agentId: agents.SHELL_ID });
    const { sessionId: c1 } = agents.splitPane(rootId, 'right', s);
    const { sessionId: c2 } = agents.splitPane(c1, 'down', s);

    agents.stop(c1);

    const rootRow = agents.listAllSessions().find((r) => r.sessionId === rootId);
    expect(rootRow.layout).toEqual({
      dir: 'right',
      ratio: 50,
      a: { leaf: rootId },
      b: { leaf: c2 },
    });
  });

  it('promoting the root rewrites paneOf and moves layout', () => {
    const s = site();
    const { sessionId: rootId } = agents.launch({ site: s, agentId: agents.SHELL_ID });
    const { sessionId: c1 } = agents.splitPane(rootId, 'right', s);
    const { sessionId: c2 } = agents.splitPane(c1, 'down', s);

    agents.stop(rootId);

    const rows = agents.listAllSessions();
    expect(rows.find((r) => r.sessionId === rootId)).toBeUndefined();

    const newRootRow = rows.find((r) => r.sessionId === c1);
    expect(newRootRow.paneOf).toBeNull();
    expect(newRootRow.layout).toEqual({
      dir: 'down',
      ratio: 50,
      a: { leaf: c1 },
      b: { leaf: c2 },
    });

    const c2Row = rows.find((r) => r.sessionId === c2);
    expect(c2Row.paneOf).toBe(c1);
  });

  it('an exited pane stays a leaf', () => {
    const s = site();
    const { sessionId: rootId } = agents.launch({ site: s, agentId: agents.SHELL_ID });
    const { sessionId: c1 } = agents.splitPane(rootId, 'right', s);

    ptys[1].emitExit(1); // child exited

    const rows = agents.listAllSessions();
    const childRow = rows.find((r) => r.sessionId === c1);
    expect(childRow).toBeDefined();
    expect(childRow.exited).toBe(true);
    expect(rows.find((r) => r.sessionId === rootId).layout.b.leaf).toBe(c1);
  });

  it('closing the tab stops every pane', () => {
    const s = site();
    const { sessionId: rootId } = agents.launch({ site: s, agentId: agents.SHELL_ID });
    const { sessionId: c1 } = agents.splitPane(rootId, 'right', s);

    // UI would call destroyTab on all panes in the tree:
    agents.stop(c1);
    agents.stop(rootId);

    expect(ptys[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(ptys[1].kill).toHaveBeenCalledWith('SIGTERM');

    const rows = agents.listAllSessions();
    expect(rows.length).toBe(0);
  });
});
