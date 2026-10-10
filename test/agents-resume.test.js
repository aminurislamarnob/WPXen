import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agents from '../electron/services/agents.cjs';

// Resume-in-new-Session drives the real launch() through the module's own
// seam: fake pty, fake PATH with a claude binary, temp home. Assertions are
// on the typed command line and the new Session row — not on internals.

function fakePty() {
  const handlers = { data: [], exit: [] };
  return {
    onData: (cb) => handlers.data.push(cb),
    onExit: (cb) => handlers.exit.push(cb),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emitData: (d) => handlers.data.forEach((cb) => cb(d)),
  };
}

let home;
let bin;
let ptys;

const site = () => ({ id: 'site-1', path: home });

function launchClaude() {
  const res = agents.launch({ site: site(), agentId: 'claude' });
  expect(res.ok).toBe(true);
  return res.sessionId;
}

// The engine types the command after the shell settles: first output, then a
// short window. Returns everything typed into the pty at the given index.
function settleAndType(index) {
  ptys[index].emitData('% ');
  vi.advanceTimersByTime(500);
  return ptys[index].write.mock.calls.map((c) => c[0]).join('');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-resume-'));
  bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\ntrue\n');
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  ptys = [];
  agents.__setDeps({
    spawnPty: (file, args, opts) => {
      const p = fakePty();
      p.spawnedWith = { file, args, opts };
      ptys.push(p);
      return p;
    },
    shellEnv: () => ({ PATH: `${bin}:/usr/bin` }),
    userShell: () => '/bin/zsh',
    homedir: () => home,
    sitePhpBin: () => null,
  });
});

afterEach(() => {
  agents.stopAll();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('resume in new session', () => {
  it('fresh launch pins a transcript with --session-id', () => {
    vi.useFakeTimers();
    try {
      const id = launchClaude();
      const typed = settleAndType(0);
      const match = typed.match(/--session-id (\S+)/);
      expect(match).not.toBeNull();
      const row = agents.listAllSessions().find((s) => s.sessionId === id);
      expect(row.transcriptId).toBe(match[1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resume types --resume <uuid> with no --session-id', () => {
    vi.useFakeTimers();
    try {
      const oldId = launchClaude();
      settleAndType(0);
      const oldRow = agents.listAllSessions().find((s) => s.sessionId === oldId);
      const res = agents.resumeChatSession(oldId, { site: site() });
      expect(res.ok).toBe(true);
      const typed = settleAndType(1);
      expect(typed).toContain(`--resume ${oldRow.transcriptId}`);
      expect(typed).not.toContain('--session-id');
      const newRow = agents.listAllSessions().find((s) => s.sessionId === res.sessionId);
      expect(newRow.transcriptId).toBe(oldRow.transcriptId);
      expect(newRow.resumeFrom).toBe(oldId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('missing resumeFlag errors instead of launching', () => {
    const res = agents.launch({ site: site(), agentId: 'codex', resume: 'some-uuid' });
    expect(res.error).toMatch(/resum/i);
    expect(ptys).toHaveLength(0);
  });

  it('resume of an unknown session errors', () => {
    expect(agents.resumeChatSession('nope', { site: site() }).error).toMatch(
      /not found/i
    );
  });

  it('resume without a pinned transcript errors', () => {
    const floating = agents.launchFloating({ cwd: home });
    expect(agents.resumeChatSession(floating.sessionId, { site: site() }).error).toMatch(
      /transcript/i
    );
  });
});
