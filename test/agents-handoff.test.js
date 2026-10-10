import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  stripAnsi,
  buildPrompt,
  writeHandoffFile,
} from '../electron/services/handoff.cjs';
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-handoff-'));
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
  fs.rmSync(home, { recursive: true, force: true });
});

describe('handoff transcript preparation', () => {
  it('strips ANSI escape sequences and lone carriage returns', () => {
    const raw = '\x1b[31mError\x1b[0m \x1b]0;Title\x07\nLine\r\n';
    expect(stripAnsi(raw)).toBe('Error \nLine\n');
  });

  it('caps the transcript to 800 lines', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `Line ${i}`);
    const capture = lines.join('\n');
    const prompt = buildPrompt({ agentName: 'A', title: 'T', cwd: '/', capture });

    expect(prompt).not.toContain('Line 0');
    expect(prompt).not.toContain('Line 199');
    expect(prompt).toContain('Line 200');
    expect(prompt).toContain('Line 999');
  });

  it('adjusts markdown fences to wrap any inner fences safely', () => {
    const capture = 'Here is a block:\n```\ncode\n```\nand another:\n`````\nmore\n`````';
    const prompt = buildPrompt({ agentName: 'A', title: 'T', cwd: '/', capture });
    expect(prompt).toContain('``````\nHere is a block');
  });

  it('writes the handoff file to a temporary location', () => {
    const content = 'Mock handoff prompt';
    const filePath = writeHandoffFile(content);
    expect(filePath.startsWith(os.tmpdir())).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
  });
});

describe('launching a handoff Session', () => {
  const site = () => ({ id: 'shop', name: 'Shop', path: home });

  beforeEach(() => {
    agents.setConfig({
      custom: [{ id: 'fake', name: 'Fake', cmd: 'sh --agent' }],
      commands: { antigravity: 'sh --agy' },
    });
  });

  afterEach(() => {
    agents.setConfig({});
    agents.listAllSessions().forEach((s) => agents.stop(s.sessionId));
  });

  it('spawns a new session, writes handoff prompt with -i, and protects the source pty', () => {
    vi.useFakeTimers();
    try {
      // 1. Launch source session
      const { sessionId: sourceId } = agents.launchFloating({ cwd: home });
      const sourcePty = ptys[0];
      sourcePty.emitData('% '); // shell ready

      // 2. Launch handoff session targetting Antigravity
      const res = agents.launch({
        site: site(),
        agentId: 'antigravity',
        cwd: home,
        handoffFrom: sourceId,
        handoffFile: '/tmp/fake-handoff.md',
      });

      expect(res.ok).toBe(true);
      expect(ptys).toHaveLength(2);

      const newPty = ptys[1];
      newPty.emitData('% '); // new shell ready
      vi.advanceTimersByTime(200);

      // The handoff writes to the new pty
      expect(newPty.write).toHaveBeenCalledWith("sh --agy -i '/tmp/fake-handoff.md'\r");

      // The source pty was NOT written to by the handoff launch
      expect(sourcePty.write).not.toHaveBeenCalled();

      // Metadata is attached
      const newSession = agents
        .listAllSessions()
        .find((s) => s.sessionId === res.sessionId);
      expect(newSession.handoffFrom).toBe(sourceId);
      expect(newSession.handoffFile).toBe('/tmp/fake-handoff.md');
    } finally {
      vi.useRealTimers();
    }
  });
});
