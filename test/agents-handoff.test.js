import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  stripAnsi,
  buildPrompt,
  writeHandoffFile,
  launchTarget,
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

  it('launches the target in the source cwd with a read-this-file prompt', () => {
    vi.useFakeTimers();
    try {
      const sub = path.join(home, 'wp-content');
      fs.mkdirSync(sub, { recursive: true });
      const { sessionId: sourceId } = agents.launch({
        site: site(),
        agentId: 'fake',
        cwd: sub,
      });
      const sourcePty = ptys[0];
      sourcePty.emitData('% ');
      vi.advanceTimersByTime(200);
      sourcePty.write.mockClear();

      const res = launchTarget({
        agents,
        site: site(),
        source: agents.getSession(sourceId),
        targetAgentId: 'antigravity',
        handoffFile: '/tmp/wpxen-handoff-x.md',
      });

      expect(res.ok).toBe(true);
      const newPty = ptys[1];
      expect(newPty.spawnedWith.opts.cwd).toBe(sub);
      newPty.emitData('% ');
      vi.advanceTimersByTime(200);
      expect(newPty.write).toHaveBeenCalledWith(
        "sh --agy -i 'Read `/tmp/wpxen-handoff-x.md` and continue.'\r"
      );

      // The source keeps running, untouched.
      expect(sourcePty.write).not.toHaveBeenCalled();
      expect(sourcePty.kill).not.toHaveBeenCalled();

      const row = agents.listAllSessions().find((s) => s.sessionId === res.sessionId);
      expect(row.handoffFrom).toBe(sourceId);
      expect(row.handoffFile).toBe('/tmp/wpxen-handoff-x.md');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the prompt positionally for an Agent without a promptFlag', () => {
    vi.useFakeTimers();
    try {
      const { sessionId: sourceId } = agents.launch({ site: site(), agentId: 'fake' });
      const res = launchTarget({
        agents,
        site: site(),
        source: agents.getSession(sourceId),
        targetAgentId: 'fake',
        handoffFile: '/tmp/h.md',
      });
      const newPty = ptys.at(-1);
      newPty.emitData('% ');
      vi.advanceTimersByTime(200);
      expect(res.ok).toBe(true);
      expect(newPty.write).toHaveBeenCalledWith(
        "sh --agent 'Read `/tmp/h.md` and continue.'\r"
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
