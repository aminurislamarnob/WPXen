import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agents from '../electron/services/agents.cjs';
import { claudeTranscriptPath } from '../electron/services/agentChatClaude.cjs';
import {
  locateTranscript,
  __setDeps as __setTranscriptsDeps,
} from '../electron/services/transcripts.cjs';

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

describe('Chat pin (Session transcript pinning)', () => {
  let home;
  let ptys = [];

  beforeEach(() => {
    vi.useFakeTimers();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-chat-pin-'));
    fs.mkdirSync(path.join(home, 'code.test'));

    ptys = [];
    agents.__setDeps({
      homedir: () => home,
      shellEnv: () => ({ PATH: '/bin' }),
      userShell: () => '/bin/zsh',
      spawnPty: (file, args, opts) => {
        const p = fakePty();
        p.spawnedWith = { file, args, opts };
        ptys.push(p);
        return p;
      },
    });

    __setTranscriptsDeps({
      homedir: () => home,
      existsSync: fs.existsSync,
      readdirSync: fs.readdirSync,
      readFileSync: fs.readFileSync,
      statSync: fs.statSync,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(home, { recursive: true, force: true });
    agents.stopAll();
  });

  it('generates a UUID and types --session-id <uuid> for Claude', () => {
    const cwd = path.join(home, 'code.test');

    // We launch claude. It should append --session-id <uuid>
    console.log(agents.listAgents({ all: true }).find((a) => a.id === 'claude'));
    const res = agents.launch({
      site: { id: 's1', path: cwd },
      agentId: 'claude',
      prompt: 'hello world',
      cwd,
    });

    expect(res.error).toBeUndefined();
    const sessionId = res.sessionId;

    const row = agents.listAllSessions().find((s) => s.sessionId === sessionId);
    expect(row).toBeDefined();
    expect(row.transcriptId).toBeDefined();

    // It should have written to the pty
    const pty = ptys[0];
    pty.emitData('some output'); // Trigger settle timer
    vi.advanceTimersByTime(200);

    const writeCalls = pty.write.mock.calls;
    expect(writeCalls.length).toBe(1);

    // Typed line should contain --session-id and the uuid
    const typed = writeCalls[0][0];
    expect(typed).toContain(`--session-id ${row.transcriptId}`);
    expect(typed).toContain("'hello world'");
    // Flag must be before the prompt
    expect(typed.indexOf('--session-id')).toBeLessThan(typed.indexOf("'hello world'"));
  });

  it('does not append session-id for non-Claude agents', () => {
    const cwd = path.join(home, 'code.test');

    // antigravity does not have sessionIdFlag
    const res = agents.launch({
      site: { id: 's1', path: cwd },
      agentId: 'antigravity',
      prompt: 'hello world',
      cwd,
    });

    expect(res.error).toBeUndefined();
    const sessionId = res.sessionId;

    const row = agents.listAllSessions().find((s) => s.sessionId === sessionId);
    expect(row).toBeDefined();
    expect(row.transcriptId).toBeNull();

    const pty = ptys[0];
    pty.emitData('some output');
    vi.advanceTimersByTime(200);

    const typed = pty.write.mock.calls[0][0];
    expect(typed).not.toContain('--session-id');
  });

  it('derives the correct path for a dotted cwd', () => {
    const cwd = path.join(home, 'code.test');
    const uuid = '1234-5678';
    const p = claudeTranscriptPath({ home, cwd, uuid });

    const realCwd = fs.realpathSync(cwd);
    const expectedEncoded = realCwd.replace(/[^A-Za-z0-9]/g, '-');
    const expected = path.join(
      home,
      '.claude',
      'projects',
      expectedEncoded,
      `${uuid}.jsonl`
    );

    expect(p).toEqual(expected);
  });

  it('locateTranscript uses the pinned path if transcriptId is provided and exists', () => {
    const cwd = path.join(home, 'code.test');
    const transcriptId = 'uuid-pinned';
    const pinnedPath = claudeTranscriptPath({ home, cwd, uuid: transcriptId });

    fs.mkdirSync(path.dirname(pinnedPath), { recursive: true });
    fs.writeFileSync(pinnedPath, '{"hello":"world"}');

    // Fallback unpinned path
    const encoded = fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-');
    const dir = path.join(home, '.claude', 'projects', encoded);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'other.jsonl'), '{"hello":"old"}');

    const located = locateTranscript('claude', cwd, 0, transcriptId);
    expect(located).toEqual(pinnedPath);
  });
});
