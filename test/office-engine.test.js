import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import engine from '../electron/services/office/engine.cjs';
import { projectSlug } from '../electron/services/office/scanner.cjs';
import { ENDED_LINGER_MS } from '../electron/services/office/types.cjs';
import { FileTailer } from '../electron/services/office/tailer.cjs';

// The Office engine: 1 s poll loop (setTimeout chain), transcript-tailer
// wiring, dispatch → reducer, broadcast-skip on same reference, ~100 ms
// snapshot coalescing, lazy single-start. Tests run against a temp CLAUDE_HOME
// with synthetic fixtures; swappable effects (onSnapshot, scan, timings) go
// through the module's own deps/__setDeps seam — vi.mock can't reach .cjs.

const until = async (fn, timeout = 4000) => {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeout) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tailer that never touches the filesystem, for dispatch-only tests.
const inertTailer = () => ({ on: () => {}, start: async () => {}, stop: () => {} });

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-office-engine-'));
  fs.mkdirSync(path.join(home, 'sessions'));
  process.env.CLAUDE_HOME = home;
});

afterEach(() => {
  engine.__reset();
  delete process.env.CLAUDE_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('engine.start', () => {
  it('lazy single start: polls once immediately, and a second start is a no-op', async () => {
    const scan = vi.fn(async (prev) => ({ events: [], snapshot: prev }));
    engine.__setDeps({ scan, pollIntervalMs: 60_000 });

    const first = engine.start();
    const second = engine.start();
    expect(second).toBe(first);
    expect(engine.isStarted()).toBe(true);

    await until(() => scan.mock.calls.length >= 1);
    await sleep(50);
    // One startup poll in total — a second start never spawns a second loop.
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('keeps polling on a setTimeout chain until stop(), then stays quiet', async () => {
    const scan = vi.fn(async (prev) => ({ events: [], snapshot: prev }));
    engine.__setDeps({ scan, pollIntervalMs: 10 });

    engine.start();
    await until(() => scan.mock.calls.length >= 3);

    engine.stop();
    expect(engine.isStarted()).toBe(false);
    const after = scan.mock.calls.length;
    await sleep(60);
    expect(scan.mock.calls.length).toBe(after);
  });

  it('start({ onSnapshot }) is the production sink — no test seam involved', async () => {
    engine.__setDeps({
      scan: async (prev) => ({ events: [], snapshot: prev }),
      scanAg: async (prev) => ({ events: [], snapshot: prev }),
      pollIntervalMs: 60_000,
      coalesceMs: 5,
      createTailer: inertTailer,
    });
    const onSnapshot = vi.fn();
    engine.start({ onSnapshot });

    engine.dispatch({
      type: 'session_appeared',
      pid: 7,
      sessionId: 's',
      cwd: '/x',
      name: 'n',
      projectKey: 'x',
      startedAt: 1,
    });
    await until(() => onSnapshot.mock.calls.length >= 1);
    expect(onSnapshot.mock.calls.at(-1)[0].sessions[7]).toBeDefined();
  });
});

describe('engine snapshots', () => {
  it('coalesces a burst of changes into one snapshot, and skips unchanged ticks', async () => {
    const onSnapshot = vi.fn();
    engine.__setDeps({ onSnapshot, coalesceMs: 10, createTailer: inertTailer });

    // A burst: a session appears and its transcript replays five prompts.
    engine.dispatch({
      type: 'session_appeared',
      pid: 4242,
      sessionId: 'aaa-bbb',
      cwd: '/projects/acme-app',
      name: 'demo',
      projectKey: 'acme-app',
      startedAt: 1_700_000_000_000,
    });
    for (let i = 0; i < 5; i++) {
      engine.dispatch({
        type: 'transcript_line',
        pid: 4242,
        line: {
          type: 'user',
          uuid: `u-${i}`,
          timestamp: new Date(1_700_000_000_000 + i).toISOString(),
          message: { content: `prompt ${i}` },
        },
      });
    }
    engine.dispatch({
      type: 'transcript_line',
      pid: 4242,
      line: {
        type: 'assistant',
        uuid: 'a-0',
        timestamp: new Date(1_700_000_000_000).toISOString(),
        message: { content: [{ type: 'tool_use', name: 'Bash' }] },
      },
    });

    await until(() => onSnapshot.mock.calls.length >= 1);
    await sleep(40);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    const office = onSnapshot.mock.calls[0][0];
    expect(office.sessions[4242].feed).toHaveLength(6);
    expect(office.sessions[4242].state).toBe('working');
    expect(office).toBe(engine.getOffice());

    // A tick that changes nothing returns the same reference — no broadcast.
    engine.dispatch({ type: 'tick', now: 1_700_000_000_100 });
    await sleep(40);
    expect(onSnapshot).toHaveBeenCalledTimes(1);

    // A tick that crosses the waiting threshold is a change — one more snapshot.
    engine.dispatch({ type: 'tick', now: 1_700_000_000_000 + 20_000 });
    await until(() => onSnapshot.mock.calls.length === 2);
    expect(onSnapshot.mock.calls[1][0].sessions[4242].state).toBe('waiting_on_user');
    expect(onSnapshot.mock.calls[1][0].waitingCount).toBe(1);
  });
});

describe('engine session end', () => {
  it('stops the tailer at once but keeps the session, ended, until the linger passes', async () => {
    const tailer = { on: () => {}, start: async () => {}, stop: vi.fn() };
    let now = 1_700_000_000_000;
    engine.__setDeps({ createTailer: () => tailer, now: () => now });

    engine.dispatch({
      type: 'session_appeared',
      pid: 4242,
      sessionId: 'aaa',
      cwd: '/projects/acme-app',
      name: 'demo',
      projectKey: 'acme-app',
      startedAt: now,
    });
    engine.dispatch({ type: 'session_ended', pid: 4242 });

    expect(tailer.stop).toHaveBeenCalledTimes(1);
    expect(engine.getOffice().sessions[4242].state).toBe('ended');

    engine.dispatch({ type: 'tick', now });
    expect(engine.getOffice().sessions[4242].state).toBe('ended');
    engine.dispatch({ type: 'tick', now: now + ENDED_LINGER_MS });
    expect(engine.getOffice().sessions[4242]).toBeUndefined();
  });
});

describe('engine subagent discovery', () => {
  // Fixtures mirror the source project's scrubbed basic/ layout: a live
  // registry entry (this test process's own pid), its transcript under
  // projects/<slug>/, and subagent files beside it in
  // projects/<slug>/<sessionId>/subagents/agent-<id>.{jsonl,meta.json}.
  const sessionId = 'abc-123';
  let cwd;
  let subagentsDir;

  function liveSession() {
    cwd = path.join(home, 'mock-project');
    fs.mkdirSync(cwd);
    const slugDir = path.join(home, 'projects', projectSlug(cwd));
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        uuid: 'u-1',
        timestamp: new Date().toISOString(),
        message: { content: 'Fan out the work' },
      }) + '\n'
    );
    subagentsDir = path.join(slugDir, sessionId, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(home, 'sessions', `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId,
        cwd,
        name: 'mock-session',
        startedAt: Date.now(),
      })
    );
  }

  function writeSubagent(id, lines, meta = {}) {
    fs.writeFileSync(
      path.join(subagentsDir, `agent-${id}.meta.json`),
      JSON.stringify({
        agentType: 'Architect',
        description: 'Designing',
        toolUseId: 't3',
        ...meta,
      })
    );
    fs.writeFileSync(
      path.join(subagentsDir, `agent-${id}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '')
    );
  }

  const toolUseLine = (tool = 'Bash') => ({
    type: 'assistant',
    uuid: `a-${Math.random()}`,
    timestamp: new Date().toISOString(),
    message: { content: [{ type: 'tool_use', name: tool }] },
  });

  const subagents = () => engine.getOffice().sessions[process.pid]?.subagents ?? {};

  it('discovers a fresh subagent within a poll cycle and tracks its own transcript', async () => {
    engine.__setDeps({ pollIntervalMs: 25, coalesceMs: 5 });
    liveSession();
    writeSubagent('xyz', [toolUseLine('Grep')]);

    engine.start();

    await until(() => subagents()['xyz']);
    expect(subagents()['xyz']).toMatchObject({
      subagentId: 'xyz',
      agentType: 'Architect',
      description: 'Designing',
      toolUseId: 't3',
    });

    // The intern's state follows its own transcript, not the parent's: its
    // tool_use line makes it working with Grep while the parent — whose own
    // transcript ends on a user prompt — is thinking.
    await until(() => subagents()['xyz'].state === 'working');
    expect(subagents()['xyz'].currentTool).toBe('Grep');
    expect(engine.getOffice().sessions[process.pid].state).toBe('thinking');

    // Lines keep flowing while the subagent runs: a later tool switch lands.
    fs.appendFileSync(
      path.join(subagentsDir, 'agent-xyz.jsonl'),
      JSON.stringify(toolUseLine('Bash')) + '\n'
    );
    await until(() => subagents()['xyz'].currentTool === 'Bash');
    expect(subagents()['xyz'].state).toBe('working');
  });

  it('ends a subagent on an assistant line with no tool_use, and never re-tails it', async () => {
    engine.__setDeps({ pollIntervalMs: 25, coalesceMs: 5 });
    liveSession();
    writeSubagent('xyz', [toolUseLine('Bash')]);

    engine.start();
    await until(() => subagents()['xyz']?.state === 'working');

    // The closing assistant message carries text only — the subagent is done.
    fs.appendFileSync(
      path.join(subagentsDir, 'agent-xyz.jsonl'),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-end',
        timestamp: new Date().toISOString(),
        message: { content: [{ type: 'text', text: 'Done' }] },
      }) + '\n'
    );
    await until(() => !subagents()['xyz']);

    // Finished subagents are remembered: later polls must not resurrect it
    // even though its files are still on disk with a fresh mtime.
    await sleep(100);
    expect(subagents()['xyz']).toBeUndefined();
  });

  it('does not rediscover the interns of a session lingering as ended', async () => {
    const tailed = [];
    engine.__setDeps({
      pollIntervalMs: 25,
      coalesceMs: 5,
      createTailer: (file) => {
        tailed.push(file);
        return new FileTailer(file);
      },
    });
    liveSession();
    writeSubagent('xyz', [toolUseLine('Bash')]);

    engine.start();
    await until(() => subagents()['xyz']);

    const before = tailed.length;
    fs.rmSync(path.join(home, 'sessions', `${process.pid}.json`));
    await until(() => engine.getOffice().sessions[process.pid]?.state === 'ended');
    expect(subagents()).toEqual({});

    // Several polls inside the linger: its interns stay gone, and no tailer is
    // opened for them again.
    await sleep(150);
    expect(engine.getOffice().sessions[process.pid]?.state).toBe('ended');
    expect(subagents()).toEqual({});
    expect(tailed.length).toBe(before);
  });

  it('treats a transcript idle past the 10 min threshold as finished — it never appears', async () => {
    engine.__setDeps({ pollIntervalMs: 25, coalesceMs: 5 });
    liveSession();
    writeSubagent('old', [toolUseLine('Bash')]);
    const stale = (Date.now() - 11 * 60_000) / 1000;
    fs.utimesSync(path.join(subagentsDir, 'agent-old.jsonl'), stale, stale);

    engine.start();
    await until(() => engine.getOffice().sessions[process.pid]);

    // Give discovery several poll cycles; the stale subagent must stay out.
    await sleep(150);
    expect(subagents()['old']).toBeUndefined();
  });
});

describe('engine with Antigravity', () => {
  let agHome;
  let wsRoot;

  beforeEach(() => {
    agHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-office-engine-agy-'));
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-office-engine-ws-'));
    process.env.ANTIGRAVITY_HOME = agHome;
  });

  afterEach(() => {
    delete process.env.ANTIGRAVITY_HOME;
    fs.rmSync(agHome, { recursive: true, force: true });
    fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  it('a conversation appears in the Antigravity room, joins its project pod from a tool-call path, and leaves when its transcript falls quiet', async () => {
    engine.__setDeps({ pollIntervalMs: 25, coalesceMs: 5 });

    // The workspace the tool call will name — a plain folder, so the project
    // key falls back to its basename.
    const workspace = path.join(wsRoot, 'acme-shop');
    fs.mkdirSync(workspace);

    const id = '9b2d41e7-55aa-4c21-8c3f-1d0e6f7a8b9c';
    const logs = path.join(
      agHome,
      'antigravity',
      'brain',
      id,
      '.system_generated',
      'logs'
    );
    fs.mkdirSync(logs, { recursive: true });
    const transcript = path.join(logs, 'transcript.jsonl');
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: new Date().toISOString(),
          content: '<USER_REQUEST>\nShip the coupon banner\n</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date().toISOString(),
          tool_calls: [
            { name: 'run_command', args: { CommandLine: 'npm test', Cwd: workspace } },
          ],
        }),
      ].join('\n') + '\n'
    );

    engine.start();

    // Appears with a synthetic negative pid in the unknown-workspace pod, then
    // the tool-call path moves it into its project's pod (session_workspace).
    await until(() => {
      const s = Object.values(engine.getOffice().sessions)[0];
      return s && s.projectKey === 'acme-shop';
    });
    const session = Object.values(engine.getOffice().sessions)[0];
    expect(session.pid).toBeLessThan(0);
    expect(session).toMatchObject({
      agent: 'antigravity',
      sessionId: id,
      name: `agy-${id.slice(0, 8)}`,
      cwd: workspace,
      title: 'Ship the coupon banner',
    });

    // 30 minutes of transcript silence → the conversation ends, shows as
    // ended for the linger, then leaves the office.
    const past = new Date(Date.now() - 31 * 60_000);
    fs.utimesSync(transcript, past, past);
    await until(() => Object.values(engine.getOffice().sessions)[0]?.endedAt);
    engine.__setDeps({ now: () => Date.now() + ENDED_LINGER_MS });
    await until(() => Object.keys(engine.getOffice().sessions).length === 0);
  });
});

describe('engine end to end (registry + transcript + tick)', () => {
  it('tails the transcript under $CLAUDE_HOME/projects/<slug>, flips a long tool call to waiting, and ends the session when its registry entry goes', async () => {
    const onSnapshot = vi.fn();
    engine.__setDeps({ onSnapshot, pollIntervalMs: 25, coalesceMs: 5 });

    const cwd = path.join(home, 'acme-app');
    fs.mkdirSync(cwd);
    const sessionId = 'aaa-bbb-ccc';

    // The transcript already holds a tool call that started 20 s ago — past
    // the 15 s waiting threshold, so the first tick flips it.
    const slugDir = path.join(home, 'projects', projectSlug(cwd));
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-1',
        timestamp: new Date(Date.now() - 20_000).toISOString(),
        message: { content: [{ type: 'tool_use', name: 'Bash' }] },
      }) + '\n'
    );

    const registryFile = path.join(home, 'sessions', `${process.pid}.json`);
    fs.writeFileSync(
      registryFile,
      JSON.stringify({
        pid: process.pid,
        sessionId,
        cwd,
        name: 'fix-login-bug',
        startedAt: Date.now() - 30_000,
      })
    );

    engine.start();

    await until(() => {
      const s = engine.getOffice().sessions[process.pid];
      return s && s.state === 'waiting_on_user';
    });
    const session = engine.getOffice().sessions[process.pid];
    expect(session).toMatchObject({
      name: 'fix-login-bug',
      projectKey: 'acme-app',
      state: 'waiting_on_user',
      currentTool: 'Bash',
    });
    expect(engine.getOffice().waitingCount).toBe(1);
    // The pushed snapshot is the same object the handler would return.
    expect(onSnapshot).toHaveBeenCalled();

    // Registry entry disappears → the session ends: shown as ended (no longer
    // waiting) for the linger, then it leaves the office.
    fs.rmSync(registryFile);
    await until(() => engine.getOffice().sessions[process.pid]?.endedAt);
    expect(engine.getOffice().sessions[process.pid].state).toBe('ended');
    expect(engine.getOffice().waitingCount).toBe(0);
    engine.__setDeps({ now: () => Date.now() + ENDED_LINGER_MS });
    await until(() => !engine.getOffice().sessions[process.pid]);
  });
});
