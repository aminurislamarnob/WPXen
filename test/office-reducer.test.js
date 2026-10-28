import { describe, it, expect } from 'vitest';
import { reduce, emptyOffice } from '../electron/services/office/reducer.cjs';
import {
  WAITING_THRESHOLD_MS,
  BREAK_THRESHOLD_MS,
  FEED_CAP,
} from '../electron/services/office/types.cjs';

// One-time faithful port of the claude-agent-verse core reducer suite
// (packages/core/src/reducer.test.ts). All fixture data is synthetic —
// invented paths, names and content only.

// ── Fixture helpers ──────────────────────────────────────────

function appeared(overrides = {}) {
  return {
    type: 'session_appeared',
    pid: 1001,
    sessionId: 'aaa-bbb-ccc',
    cwd: '/projects/acme-app',
    name: 'fix-login-bug',
    projectKey: 'acme-app',
    startedAt: 1700000000000,
    ...overrides,
  };
}

function officeWith(...events) {
  return events.reduce(reduce, emptyOffice());
}

// ── Tests ────────────────────────────────────────────────────

describe('reducer', () => {
  it('starts with an empty office', () => {
    const office = emptyOffice();
    expect(office.sessions).toEqual({});
  });

  describe('constants', () => {
    it('match the source product values', () => {
      expect(WAITING_THRESHOLD_MS).toBe(15000);
      expect(BREAK_THRESHOLD_MS).toBe(300000);
      expect(FEED_CAP).toBe(20);
      const office = emptyOffice();
      expect(office.waitingThresholdMs).toBe(WAITING_THRESHOLD_MS);
      expect(office.breakThresholdMs).toBe(BREAK_THRESHOLD_MS);
    });
  });

  describe('session_appeared', () => {
    it('adds a session to the office', () => {
      const office = officeWith(appeared());
      expect(Object.keys(office.sessions)).toHaveLength(1);
      const s = office.sessions[1001];
      expect(s.pid).toBe(1001);
      expect(s.sessionId).toBe('aaa-bbb-ccc');
      expect(s.cwd).toBe('/projects/acme-app');
      expect(s.name).toBe('fix-login-bug');
      expect(s.state).toBe('idle');
      expect(s.projectKey).toBe('acme-app');
      expect(s.startedAt).toBe(1700000000000);
      expect(s.feed).toEqual([]);
    });
  });

  describe('transcript_line', () => {
    it('processes ai-title', () => {
      const office = officeWith(appeared(), {
        type: 'transcript_line',
        pid: 1001,
        line: { type: 'ai-title', aiTitle: 'Fix login flow' },
      });
      expect(office.sessions[1001].title).toBe('Fix login flow');
    });

    it('processes gitBranch and last-prompt', () => {
      const office = officeWith(
        appeared(),
        {
          type: 'transcript_line',
          pid: 1001,
          line: { gitBranch: 'feature/login-bug' },
        },
        {
          type: 'transcript_line',
          pid: 1001,
          line: { type: 'last-prompt', lastPrompt: 'Can you fix the login?' },
        }
      );
      expect(office.sessions[1001].gitBranch).toBe('feature/login-bug');
      expect(office.sessions[1001].lastPrompt).toBe('Can you fix the login?');
    });

    it('transitions to working when tool is used', () => {
      const office = officeWith(appeared(), {
        type: 'transcript_line',
        pid: 1001,
        line: {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'I will use Bash' },
              { type: 'tool_use', name: 'Bash', id: 'tool_1' },
            ],
          },
        },
      });
      const s = office.sessions[1001];
      expect(s.state).toBe('working');
      expect(s.currentTool).toBe('Bash');
      expect(s.feed.length).toBe(1);
      expect(s.feed[0].type).toBe('tool_use');
    });

    it('transitions to error when tool result is error', () => {
      const office = officeWith(appeared(), {
        type: 'transcript_line',
        pid: 1001,
        line: {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_1',
                is_error: true,
                content: 'Command failed',
              },
            ],
          },
        },
      });
      const s = office.sessions[1001];
      expect(s.state).toBe('error');
      expect(s.currentTool).toBeUndefined();
    });

    it('transitions to thinking when user provides successful tool result', () => {
      const office = officeWith(appeared(), {
        type: 'transcript_line',
        pid: 1001,
        line: {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_1',
                is_error: false,
                content: 'Success',
              },
            ],
          },
        },
      });
      const s = office.sessions[1001];
      expect(s.state).toBe('thinking');
    });

    it('transitions to thinking when user provides text', () => {
      const office = officeWith(appeared(), {
        type: 'transcript_line',
        pid: 1001,
        line: {
          type: 'user',
          message: {
            content: [{ type: 'text', text: 'Please continue' }],
          },
        },
      });
      const s = office.sessions[1001];
      expect(s.state).toBe('thinking');
    });

    it('transitions to idle when assistant responds with text without tools', () => {
      const office = officeWith(appeared(), {
        type: 'transcript_line',
        pid: 1001,
        line: {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'I am done.' }],
          },
        },
      });
      const s = office.sessions[1001];
      expect(s.state).toBe('idle');
    });
  });

  describe('session_ended', () => {
    it('removes the session from the office', () => {
      const office = officeWith(appeared(), { type: 'session_ended', pid: 1001 });
      expect(Object.keys(office.sessions)).toHaveLength(0);
    });
  });

  describe('subagent lifecycle', () => {
    it('can spawn and run a subagent', () => {
      let office = emptyOffice();
      office = reduce(office, appeared());

      // Spawn
      office = reduce(office, {
        type: 'subagent_appeared',
        pid: 1001,
        subagentId: 'agent-123',
        agentType: 'Researcher',
        description: 'Find files',
        toolUseId: 'toolu_xyz',
      });

      expect(office.sessions[1001].subagents['agent-123']).toBeDefined();
      expect(office.sessions[1001].subagents['agent-123'].state).toBe('idle');

      // Work
      office = reduce(office, {
        type: 'subagent_transcript_line',
        pid: 1001,
        subagentId: 'agent-123',
        line: {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Grep' }] },
        },
      });
      expect(office.sessions[1001].subagents['agent-123'].state).toBe('working');
      expect(office.sessions[1001].subagents['agent-123'].currentTool).toBe('Grep');

      // End
      office = reduce(office, {
        type: 'subagent_ended',
        pid: 1001,
        subagentId: 'agent-123',
      });
      expect(office.sessions[1001].subagents['agent-123']).toBeUndefined();
    });
  });

  describe('catch-up', () => {
    it('yields the same Office as continuous observation', () => {
      // Continuous observation
      let office = emptyOffice();
      office = reduce(office, appeared());
      office = reduce(office, {
        type: 'transcript_line',
        pid: 1001,
        line: { type: 'ai-title', aiTitle: 'Fix login bug' },
      });
      office = reduce(office, {
        type: 'transcript_line',
        pid: 1001,
        line: { gitBranch: 'feature/login' },
      });
      office = reduce(office, {
        type: 'transcript_line',
        pid: 1001,
        line: {
          uuid: 'u1',
          timestamp: '2024-01-01T00:00:00Z',
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Bash', id: 't1' }],
          },
        },
      });
      office = reduce(office, {
        type: 'subagent_appeared',
        pid: 1001,
        subagentId: 'agent-999',
        agentType: 'Coder',
        description: 'Write tests',
        toolUseId: 't1',
      });
      office = reduce(office, {
        type: 'subagent_transcript_line',
        pid: 1001,
        subagentId: 'agent-999',
        line: {
          uuid: 's1',
          timestamp: '2024-01-01T00:00:01Z',
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Editor' }] },
        },
      });
      const continuousOffice = office;

      // Catch-up (all at once)
      const catchUpOffice = officeWith(
        appeared(),
        {
          type: 'transcript_line',
          pid: 1001,
          line: { type: 'ai-title', aiTitle: 'Fix login bug' },
        },
        {
          type: 'transcript_line',
          pid: 1001,
          line: { gitBranch: 'feature/login' },
        },
        {
          type: 'transcript_line',
          pid: 1001,
          line: {
            uuid: 'u1',
            timestamp: '2024-01-01T00:00:00Z',
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', name: 'Bash', id: 't1' }],
            },
          },
        },
        {
          type: 'subagent_appeared',
          pid: 1001,
          subagentId: 'agent-999',
          agentType: 'Coder',
          description: 'Write tests',
          toolUseId: 't1',
        },
        {
          type: 'subagent_transcript_line',
          pid: 1001,
          subagentId: 'agent-999',
          line: {
            uuid: 's1',
            timestamp: '2024-01-01T00:00:01Z',
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name: 'Editor' }] },
          },
        }
      );

      expect(catchUpOffice).toEqual(continuousOffice);
      expect(catchUpOffice.sessions[1001].state).toBe('working');
      expect(catchUpOffice.sessions[1001].currentTool).toBe('Bash');
      expect(catchUpOffice.sessions[1001].title).toBe('Fix login bug');
      expect(catchUpOffice.sessions[1001].gitBranch).toBe('feature/login');
      expect(catchUpOffice.sessions[1001].subagents['agent-999'].state).toBe('working');
    });
  });

  describe('waiting_on_user inference', () => {
    it('transitions to waiting_on_user after threshold', () => {
      let office = emptyOffice();
      office = reduce(office, appeared());

      // Start working at T=1000
      office = reduce(office, {
        type: 'transcript_line',
        pid: 1001,
        line: {
          timestamp: new Date(1000).toISOString(),
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Bash', id: 'tool_1' }],
          },
        },
      });

      expect(office.sessions[1001].state).toBe('working');
      expect(office.waitingCount).toBe(0);

      // Tick before threshold (T=2000)
      office = reduce(office, { type: 'tick', now: 2000 });
      expect(office.sessions[1001].state).toBe('working');
      expect(office.waitingCount).toBe(0);

      // Tick after threshold (T=17000)
      office = reduce(office, { type: 'tick', now: 17000 });
      expect(office.sessions[1001].state).toBe('waiting_on_user');
      expect(office.waitingCount).toBe(1);
    });

    it('clears waiting state when result arrives', () => {
      let office = emptyOffice();
      office = reduce(office, appeared());

      // Start working at T=1000
      office = reduce(office, {
        type: 'transcript_line',
        pid: 1001,
        line: {
          timestamp: new Date(1000).toISOString(),
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Bash', id: 'tool_1' }],
          },
        },
      });

      // Tick after threshold
      office = reduce(office, { type: 'tick', now: 17000 });
      expect(office.sessions[1001].state).toBe('waiting_on_user');

      // Result arrives
      office = reduce(office, {
        type: 'transcript_line',
        pid: 1001,
        line: {
          timestamp: new Date(18000).toISOString(),
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_1',
                is_error: false,
                content: 'Done',
              },
            ],
          },
        },
      });

      expect(office.sessions[1001].state).toBe('thinking');
      expect(office.waitingCount).toBe(0);
    });

    it('applies to subagents as well', () => {
      let office = emptyOffice();
      office = reduce(office, appeared());
      office = reduce(office, {
        type: 'subagent_appeared',
        pid: 1001,
        subagentId: 'sub-1',
        agentType: 'Coder',
        description: '',
        toolUseId: 't1',
      });

      // Subagent works
      office = reduce(office, {
        type: 'subagent_transcript_line',
        pid: 1001,
        subagentId: 'sub-1',
        line: {
          timestamp: new Date(1000).toISOString(),
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Bash', id: 't2' }],
          },
        },
      });

      // Tick past threshold
      office = reduce(office, { type: 'tick', now: 20000 });

      expect(office.sessions[1001].subagents['sub-1'].state).toBe('waiting_on_user');
      expect(office.waitingCount).toBe(1);
    });
  });

  describe('hook events', () => {
    it('Notification gives exact waiting_on_user overriding passive inference', () => {
      let office = emptyOffice();
      office = reduce(office, appeared());

      office = reduce(office, {
        type: 'hook_event',
        pid: 1001,
        hookData: { type: 'Notification' },
      });

      expect(office.sessions[1001].state).toBe('waiting_on_user');
      expect(office.sessions[1001].hookWaiting).toBe(true);
      expect(office.waitingCount).toBe(1);
    });

    it('Hook-before-transcript ordering correctly preserves waiting state', () => {
      let office = emptyOffice();
      office = reduce(office, appeared());

      // Hook arrives first
      office = reduce(office, {
        type: 'hook_event',
        pid: 1001,
        hookData: { type: 'PermissionRequest' },
      });
      expect(office.sessions[1001].state).toBe('waiting_on_user');

      // Then transcript line arrives (normally would set state to "working")
      office = reduce(office, {
        type: 'transcript_line',
        pid: 1001,
        line: {
          timestamp: new Date(1000).toISOString(),
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Bash', id: 'tool_1' }],
          },
        },
      });

      // State should remain waiting_on_user
      expect(office.sessions[1001].state).toBe('waiting_on_user');
      expect(office.sessions[1001].hookWaiting).toBe(true);
    });

    it('User transcript line clears hook waiting state', () => {
      let office = emptyOffice();
      office = reduce(office, appeared());

      office = reduce(office, {
        type: 'hook_event',
        pid: 1001,
        hookData: { type: 'PermissionRequest' },
      });

      office = reduce(office, {
        type: 'transcript_line',
        pid: 1001,
        line: {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_1',
                is_error: false,
                content: 'Done',
              },
            ],
          },
        },
      });

      expect(office.sessions[1001].state).toBe('thinking');
      expect(office.sessions[1001].hookWaiting).toBe(false);
    });
  });

  describe('break', () => {
    const T0 = Date.parse('2026-01-01T10:00:00Z');
    const MIN = 60_000;
    const reply = (at) => ({
      type: 'transcript_line',
      pid: 1001,
      line: {
        type: 'assistant',
        timestamp: new Date(at).toISOString(),
        message: { content: [{ type: 'text', text: 'Done.' }] },
      },
    });
    const prompt = (at) => ({
      type: 'transcript_line',
      pid: 1001,
      line: {
        type: 'user',
        timestamp: new Date(at).toISOString(),
        message: { content: 'Next task' },
      },
    });
    const tick = (now) => ({ type: 'tick', now });

    it('sends a session on break after five idle minutes', () => {
      const office = officeWith(appeared(), reply(T0), tick(T0 + 5 * MIN));
      expect(office.sessions[1001].state).toBe('idle');
      expect(office.sessions[1001].onBreak).toBe(true);
    });

    it('keeps a recently idle session at its desk', () => {
      const office = officeWith(appeared(), reply(T0), tick(T0 + 4 * MIN));
      expect(office.sessions[1001].onBreak).toBeFalsy();
    });

    it('ends the break as soon as a new task arrives, without waiting for a tick', () => {
      const office = officeWith(
        appeared(),
        reply(T0),
        tick(T0 + 6 * MIN),
        prompt(T0 + 7 * MIN)
      );
      expect(office.sessions[1001].state).toBe('thinking');
      expect(office.sessions[1001].onBreak).toBe(false);
    });

    it('never breaks a session that is busy', () => {
      const office = officeWith(appeared(), prompt(T0), tick(T0 + 30 * MIN));
      expect(office.sessions[1001].onBreak).toBeFalsy();
    });

    it('counts idle time from session start when there is no activity yet', () => {
      const office = officeWith(appeared({ startedAt: T0 }), tick(T0 + 5 * MIN));
      expect(office.sessions[1001].onBreak).toBe(true);
    });
  });

  describe('registry status', () => {
    const T0 = Date.parse('2026-01-01T10:00:00Z');
    const MIN = 60_000;
    const status = (value, at, sessionId = 'aaa-bbb-ccc') => ({
      type: 'session_status',
      pid: 1001,
      status: value,
      at,
      sessionId,
    });
    const userLine = (at) => ({
      type: 'transcript_line',
      pid: 1001,
      line: {
        type: 'user',
        timestamp: new Date(at).toISOString(),
        message: { content: 'Do the thing' },
      },
    });
    const toolLine = (at, name) => ({
      type: 'transcript_line',
      pid: 1001,
      line: {
        type: 'assistant',
        timestamp: new Date(at).toISOString(),
        message: { content: [{ type: 'tool_use', name }] },
      },
    });
    const tick = (now) => ({ type: 'tick', now });

    it('trusts an idle registry over a stale transcript', () => {
      const office = officeWith(appeared(), status('idle', T0), userLine(T0 - MIN));
      expect(office.sessions[1001].state).toBe('idle');
    });

    it('shows a busy session as thinking until the transcript names a tool', () => {
      let office = officeWith(appeared(), status('busy', T0));
      expect(office.sessions[1001].state).toBe('thinking');
      office = reduce(office, toolLine(T0 + 1000, 'Bash'));
      expect(office.sessions[1001].state).toBe('working');
      expect(office.sessions[1001].currentTool).toBe('Bash');
    });

    it('counts break time from when the registry went idle', () => {
      const office = officeWith(
        appeared(),
        userLine(T0),
        status('idle', T0 + 3 * MIN),
        tick(T0 + 6 * MIN)
      );
      expect(office.sessions[1001].onBreak).toBeFalsy();
      expect(reduce(office, tick(T0 + 8 * MIN)).sessions[1001].onBreak).toBe(true);
    });

    it('ends a break the moment the registry says busy', () => {
      const office = officeWith(
        appeared(),
        status('idle', T0),
        tick(T0 + 6 * MIN),
        status('busy', T0 + 7 * MIN)
      );
      expect(office.sessions[1001].state).toBe('thinking');
      expect(office.sessions[1001].onBreak).toBe(false);
    });

    it('keeps a permission prompt visible whatever the registry says', () => {
      const office = officeWith(
        appeared(),
        { type: 'hook_event', pid: 1001, hookData: { type: 'PermissionRequest' } },
        status('idle', T0)
      );
      expect(office.sessions[1001].state).toBe('waiting_on_user');
    });

    it('falls back to the transcript for a status it does not know', () => {
      const office = officeWith(appeared(), status('shell', T0), userLine(T0));
      expect(office.sessions[1001].state).toBe('thinking');
    });

    it('starts a fresh conversation when the process gets a new session id', () => {
      const office = officeWith(
        appeared(),
        {
          type: 'transcript_line',
          pid: 1001,
          line: { type: 'ai-title', aiTitle: 'Old work' },
        },
        userLine(T0),
        status('idle', T0 + MIN, 'ddd-eee-fff')
      );
      const s = office.sessions[1001];
      expect(s.sessionId).toBe('ddd-eee-fff');
      expect(s.title).toBeUndefined();
      expect(s.feed).toEqual([]);
    });
  });

  describe('antigravity sessions', () => {
    const T0 = Date.parse('2026-01-01T10:00:00Z');
    const SEC = 1000;
    const MIN = 60_000;
    const PID = -1;
    const agy = (overrides = {}) =>
      appeared({
        pid: PID,
        sessionId: '0f0e0d0c-0000-4000-8000-000000000001',
        cwd: '',
        name: 'agy-0f0e0d0c',
        projectKey: 'antigravity',
        startedAt: T0,
        agent: 'antigravity',
        ...overrides,
      });
    let stepIndex = 0;
    const step = (at, fields) => ({
      type: 'transcript_line',
      pid: PID,
      line: {
        step_index: stepIndex++,
        created_at: new Date(at).toISOString(),
        status: 'DONE',
        ...fields,
      },
    });
    const userInput = (at, content) =>
      step(at, { type: 'USER_INPUT', source: 'USER_EXPLICIT', content });
    const toolCall = (at, name, args = {}) =>
      step(at, {
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        tool_calls: [{ name, args }],
      });
    const toolResult = (at) =>
      step(at, { type: 'GENERIC', source: 'SYSTEM', content: 'exit code 0' });
    const reply = (at, content, status = 'DONE') =>
      step(at, { type: 'PLANNER_RESPONSE', source: 'MODEL', content, status });
    const tick = (now) => ({ type: 'tick', now });

    it('puts sessions in the Claude room unless the adapter says otherwise', () => {
      const office = officeWith(appeared(), agy());
      expect(office.sessions[1001].agent).toBe('claude');
      expect(office.sessions[PID].agent).toBe('antigravity');
    });

    it('follows a turn from the prompt through a tool call to the final answer', () => {
      let office = officeWith(agy(), userInput(T0, 'Fix the flaky checkout test'));
      expect(office.sessions[PID].state).toBe('thinking');

      office = reduce(
        office,
        toolCall(T0 + SEC, 'run_command', { CommandLine: 'pnpm test' })
      );
      expect(office.sessions[PID].state).toBe('working');
      expect(office.sessions[PID].currentTool).toBe('run_command');

      office = reduce(office, toolResult(T0 + 2 * SEC));
      expect(office.sessions[PID].state).toBe('thinking');
      expect(office.sessions[PID].currentTool).toBeUndefined();

      office = reduce(office, reply(T0 + 3 * SEC, 'The test is fixed.'));
      const s = office.sessions[PID];
      expect(s.state).toBe('idle');
      expect(s.lastPrompt).toBe('Fix the flaky checkout test');
      expect(s.title).toBe('Fix the flaky checkout test');
      expect(s.feed.map((e) => [e.type, e.excerpt])).toEqual([
        ['text', 'Fix the flaky checkout test'],
        ['tool_use', 'Used tool: run_command'],
        ['tool_result', 'Tool finished: run_command'],
        ['text', 'The test is fixed.'],
      ]);
    });

    it('keeps the first prompt as the title and the latest as the last prompt', () => {
      const office = officeWith(
        agy(),
        userInput(T0, 'Add dark mode'),
        reply(T0 + SEC, 'Done.'),
        userInput(T0 + 2 * SEC, 'Now the settings page')
      );
      expect(office.sessions[PID].title).toBe('Add dark mode');
      expect(office.sessions[PID].lastPrompt).toBe('Now the settings page');
    });

    it('reads the request out of a tagged prompt', () => {
      const office = officeWith(
        agy(),
        userInput(
          T0,
          '<USER_REQUEST>\nRename the module\n</USER_REQUEST>\n<ADDITIONAL_METADATA>cursor 3:1</ADDITIONAL_METADATA>'
        )
      );
      expect(office.sessions[PID].lastPrompt).toBe('Rename the module');
    });

    it('shows a response that is still streaming as thinking', () => {
      const office = officeWith(
        agy(),
        userInput(T0, 'Explain the cache'),
        reply(T0 + SEC, 'The cache', 'RUNNING')
      );
      expect(office.sessions[PID].state).toBe('thinking');
    });

    it("replaces a step's feed entry when the step is written again", () => {
      const running = reply(T0 + SEC, 'The cache', 'RUNNING');
      const done = {
        ...running,
        line: { ...running.line, status: 'DONE', content: 'The cache is warm.' },
      };
      const office = officeWith(agy(), userInput(T0, 'Explain the cache'), running, done);
      expect(office.sessions[PID].state).toBe('idle');
      expect(office.sessions[PID].feed.map((e) => e.excerpt)).toEqual([
        'Explain the cache',
        'The cache is warm.',
      ]);
    });

    it('shows an error step as the error state', () => {
      const office = officeWith(
        agy(),
        toolCall(T0, 'view_file'),
        step(T0 + SEC, {
          type: 'ERROR_MESSAGE',
          source: 'SYSTEM',
          content: 'Model quota exceeded',
        })
      );
      expect(office.sessions[PID].state).toBe('error');
      expect(office.sessions[PID].currentTool).toBeUndefined();
      expect(office.sessions[PID].feed.at(-1)).toMatchObject({
        type: 'error',
        excerpt: 'Model quota exceeded',
      });
    });

    it('skips steps it does not recognise', () => {
      const before = officeWith(agy(), toolCall(T0, 'view_file'));
      const after = [
        step(T0 + SEC, { type: 'SYSTEM_MESSAGE', source: 'SYSTEM' }),
        step(T0 + SEC, { type: 'CHECKPOINT' }),
        step(T0 + SEC, { type: 'SOMETHING_NEW', content: 42 }),
        step(T0 + SEC, {
          type: 'PLANNER_RESPONSE',
          tool_calls: 'not a list',
          content: { nested: true },
        }),
        { type: 'transcript_line', pid: PID, line: null },
        { type: 'transcript_line', pid: PID, line: 'not json' },
      ].reduce(reduce, before);
      expect(after.sessions[PID].state).toBe('working');
      expect(after.sessions[PID].currentTool).toBe('view_file');
    });

    it('infers waiting on you when a tool call runs past the threshold', () => {
      const office = officeWith(agy(), toolCall(T0, 'run_command'), tick(T0 + 20 * SEC));
      expect(office.sessions[PID].state).toBe('waiting_on_user');
      expect(office.waitingCount).toBe(1);
    });

    it('goes on break after the idle threshold and comes back for the next prompt', () => {
      let office = officeWith(
        agy(),
        userInput(T0, 'Ship it'),
        reply(T0 + SEC, 'Shipped.'),
        tick(T0 + 6 * MIN)
      );
      expect(office.sessions[PID].onBreak).toBe(true);
      office = reduce(office, userInput(T0 + 7 * MIN, 'One more thing'));
      expect(office.sessions[PID].onBreak).toBe(false);
    });

    it('moves to its project pod once the workspace is known', () => {
      const office = officeWith(agy(), {
        type: 'session_workspace',
        pid: PID,
        cwd: '/projects/acme-app/web',
        projectKey: 'acme-app',
      });
      expect(office.sessions[PID].projectKey).toBe('acme-app');
      expect(office.sessions[PID].cwd).toBe('/projects/acme-app/web');
    });

    it('leaves Claude transcripts to the Claude parser', () => {
      const office = officeWith(appeared(), {
        type: 'transcript_line',
        pid: 1001,
        line: { type: 'USER_INPUT', content: 'hi' },
      });
      expect(office.sessions[1001].lastPrompt).toBeUndefined();
    });
  });

  describe('tick', () => {
    it('returns the same office when nothing changed, so the engine can skip the broadcast', () => {
      const office = officeWith(appeared(), { type: 'tick', now: 1700000001000 });
      expect(reduce(office, { type: 'tick', now: 1700000002000 })).toBe(office);
    });
  });

  describe('unknown event types', () => {
    it('are silently skipped', () => {
      const office = officeWith(appeared());
      const after = reduce(office, { type: 'some_future_event' });
      expect(after).toEqual(office);
    });
  });
});
