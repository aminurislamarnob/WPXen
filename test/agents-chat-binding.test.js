import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agents from '../electron/services/agents.cjs';
import transcripts from '../electron/services/transcripts.cjs';
import { claudeTranscriptPath } from '../electron/services/agentChatClaude.cjs';

// How a chat view finds its Session's transcript, through the engine seam:
// fake pty, temp home, real files in Claude's layout. A pinned Session has
// exactly one transcript — before the first prompt it has none yet, and a
// Resume continues the same one after the old Session ended.

function fakePty() {
  const handlers = { data: [], exit: [] };
  return {
    onData: (cb) => handlers.data.push(cb),
    onExit: (cb) => handlers.exit.push(cb),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emitData: (d) => handlers.data.forEach((cb) => cb(d)),
    emitExit: (code) => handlers.exit.forEach((cb) => cb({ exitCode: code })),
  };
}

const userLine = (uuid, text) =>
  JSON.stringify({
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
  }) + '\n';

let home;
let siteDir;
let ptys;
let pushes;
let offRows;

const site = () => ({ id: 'site-1', path: siteDir });

function transcriptFor(sessionId) {
  const row = agents.listAllSessions().find((s) => s.sessionId === sessionId);
  return claudeTranscriptPath({ home, cwd: siteDir, uuid: row.transcriptId });
}

function writeTranscript(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
}

function rowsFor(sessionId) {
  return pushes.filter((p) => p.sessionId === sessionId).flatMap((p) => p.rows);
}

beforeEach(() => {
  vi.useFakeTimers();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-chat-binding-'));
  siteDir = path.join(home, 'site.test');
  fs.mkdirSync(siteDir);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\ntrue\n');
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  ptys = [];
  pushes = [];
  agents.__setDeps({
    spawnPty: () => {
      const p = fakePty();
      ptys.push(p);
      return p;
    },
    shellEnv: () => ({ PATH: `${bin}:/usr/bin` }),
    userShell: () => '/bin/zsh',
    homedir: () => home,
    sitePhpBin: () => null,
  });
  transcripts.__setDeps({ homedir: () => home });
  offRows = agents.onChatRows((push) => pushes.push(push));
});

afterEach(() => {
  offRows();
  agents.closeAllChats();
  agents.stopAll();
  vi.useRealTimers();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('pinned transcript binding', () => {
  it("never falls back to a sibling's transcript before the first prompt", () => {
    const sibling = agents.launch({ site: site(), agentId: 'claude' }).sessionId;
    const fresh = agents.launch({ site: site(), agentId: 'claude' }).sessionId;
    // The sibling is talking; the fresh Session hasn't been prompted yet.
    writeTranscript(transcriptFor(sibling), userLine('u-sibling', 'sibling prompt'));

    const row = agents.listAllSessions().find((s) => s.sessionId === fresh);
    expect(
      transcripts.locateTranscript('claude', siteDir, row.startedAt, row.transcriptId)
    ).toBeNull();

    agents.openChat(fresh, 'viewer-1');
    expect(rowsFor(fresh)).toEqual([]);
  });

  it('binds the chat once the pinned transcript appears', () => {
    const sessionId = agents.launch({ site: site(), agentId: 'claude' }).sessionId;
    agents.openChat(sessionId, 'viewer-1');
    expect(rowsFor(sessionId)).toEqual([]);

    writeTranscript(transcriptFor(sessionId), userLine('u-1', 'first prompt'));
    vi.advanceTimersByTime(2500);

    expect(rowsFor(sessionId).map((r) => r.content)).toEqual(['first prompt']);
  });
});

describe('resume in a new Session', () => {
  it('opens the continued conversation while the old Session is still listed', () => {
    const oldId = agents.launch({ site: site(), agentId: 'claude' }).sessionId;
    const file = transcriptFor(oldId);
    writeTranscript(file, userLine('u-1', 'before the crash'));
    // The old chat is open — that's where the exit bar's Resume lives.
    agents.openChat(oldId, 'viewer-old');
    ptys[0].emitExit(0);

    const resumed = agents.resumeChatSession(oldId, { site: site() });
    expect(resumed.ok).toBe(true);
    agents.openChat(resumed.sessionId, 'viewer-new');

    expect(rowsFor(resumed.sessionId).map((r) => r.content)).toEqual([
      'before the crash',
    ]);
  });

  it('refuses while the old Session is still running', () => {
    const oldId = agents.launch({ site: site(), agentId: 'claude' }).sessionId;
    expect(agents.resumeChatSession(oldId, { site: site() }).error).toMatch(
      /still running/
    );
  });
});
