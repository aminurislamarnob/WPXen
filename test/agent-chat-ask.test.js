import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sendChatAnswer,
  NATIVE_CHAT_QUESTION_STEP_MS,
} from '../electron/services/agentChatSend.cjs';
import {
  buildAskAnswerKeys,
  askAnswerStatus,
  formatAskAnswer,
} from '../src/lib/agentAsk.js';

describe('AskUserQuestion keys', () => {
  it('buildAskAnswerKeys generates digits for single-select', () => {
    const prompt = { questions: [{ options: [{}, {}, {}] }] };
    const selections = [{ indices: [1] }];
    const keys = buildAskAnswerKeys(prompt, selections, 'claude-digits');
    expect(keys).toEqual([{ raw: '2' }]); // 0-based index 1 -> '2'
  });

  it('buildAskAnswerKeys generates toggles and tab for multi-select', () => {
    const prompt = { questions: [{ multiSelect: true, options: [{}, {}, {}] }] };
    const selections = [{ indices: [0, 2] }];
    const keys = buildAskAnswerKeys(prompt, selections, 'claude-digits');
    expect(keys).toEqual([{ raw: '1' }, { raw: '3' }, { raw: '\x1b[C' }, { raw: '\r' }]);
  });

  it('buildAskAnswerKeys handles Other free-text', () => {
    const prompt = { questions: [{ options: [{}, {}] }] };
    const selections = [{ indices: [], other: 'my custom answer' }];
    const keys = buildAskAnswerKeys(prompt, selections, 'claude-digits');
    expect(keys).toEqual([
      { raw: '3' }, // options.length + 1
      { text: 'my custom answer' },
      { raw: '\r' },
    ]);
  });
});

describe('sendChatAnswer serialiser', () => {
  let session;

  beforeEach(() => {
    vi.useFakeTimers();
    session = {
      sessionId: 'test-session',
      pty: { write: vi.fn() },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes each group spaced apart', async () => {
    const groups = [{ raw: '1' }, { raw: '3' }, { raw: '\x1b[C' }];

    const promise = sendChatAnswer(session, groups);

    // Allow initial promise to resolve and execute first write
    await Promise.resolve();
    await Promise.resolve();

    expect(session.pty.write).toHaveBeenCalledWith('1');
    expect(session.pty.write).toHaveBeenCalledTimes(1);

    // Second group
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_QUESTION_STEP_MS);
    expect(session.pty.write).toHaveBeenCalledWith('3');
    expect(session.pty.write).toHaveBeenCalledTimes(2);

    // Third group
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_QUESTION_STEP_MS);
    expect(session.pty.write).toHaveBeenCalledWith('\x1b[C');
    expect(session.pty.write).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_QUESTION_STEP_MS);
    await promise;
  });
});

describe('askAnswerStatus', () => {
  const prompt = {
    questions: [
      {
        question: 'Which route?',
        multiSelect: false,
        options: [{ label: '/health' }, { label: '/status' }],
      },
      {
        question: 'Which checks?',
        multiSelect: true,
        options: [{ label: 'db' }, { label: 'cache' }, { label: 'queue' }],
      },
    ],
  };

  it('reports nothing before an answer is recorded', () => {
    expect(askAnswerStatus(prompt, null, null)).toBeNull();
  });

  it('shows the recorded answer, matching what was sent', () => {
    const sent = [
      { indices: [0], other: '' },
      { indices: [0, 2], other: '' },
    ];
    const recorded = { 'Which route?': '/health', 'Which checks?': 'db, queue' };
    expect(askAnswerStatus(prompt, recorded, sent)).toEqual([
      { answer: '/health', mismatch: false },
      { answer: 'db, queue', mismatch: false },
    ]);
  });

  it('flags a recorded answer that differs from what was clicked', () => {
    const sent = [
      { indices: [0], other: '' },
      { indices: [1], other: '' },
    ];
    const recorded = { 'Which route?': '/status', 'Which checks?': 'cache' };
    expect(askAnswerStatus(prompt, recorded, sent)[0]).toEqual({
      answer: '/status',
      mismatch: true,
      sent: '/health',
    });
  });

  it('never flags a mismatch for an answer given in the terminal', () => {
    const recorded = { 'Which route?': '/status', 'Which checks?': 'db' };
    expect(askAnswerStatus(prompt, recorded, null).every((q) => !q.mismatch)).toBe(true);
  });
});

// A card with two questions (Claude Code shows one tab per question, then a
// Submit tab): the shape AskUserQuestion records for it.
describe('a two-question card', () => {
  const prompt = {
    questions: [
      {
        question: 'Which route path should the health check use?',
        header: 'Route',
        multiSelect: false,
        options: [{ label: '/health' }, { label: '/status' }],
      },
      {
        question: 'Which checks should it run?',
        header: 'Checks',
        multiSelect: true,
        options: [{ label: 'Database' }, { label: 'Cache' }, { label: 'Queue' }],
      },
    ],
  };
  const selections = [{ indices: [1] }, { indices: [0, 2] }];

  it('answers each tab in turn and submits once at the end', () => {
    expect(buildAskAnswerKeys(prompt, selections, 'claude-digits')).toEqual([
      { raw: '2' }, // picks /status, which moves to the next tab
      { raw: '1' },
      { raw: '3' },
      { raw: '\x1b[C' }, // leaves the multi-select tab for Submit
      { raw: '\r' },
    ]);
  });

  it('skips a question left blank with a tab step', () => {
    expect(
      buildAskAnswerKeys(prompt, [{ indices: [] }, { indices: [1] }], 'claude-digits')
    ).toEqual([{ raw: '\x1b[C' }, { raw: '2' }, { raw: '\x1b[C' }, { raw: '\r' }]);
  });

  it('formats and checks the answer per question', () => {
    expect(formatAskAnswer(prompt, selections)).toBe('/status\nDatabase, Queue');
    const recorded = {
      'Which route path should the health check use?': '/status',
      'Which checks should it run?': 'Database, Cache',
    };
    expect(askAnswerStatus(prompt, recorded, selections)).toEqual([
      { answer: '/status', mismatch: false },
      { answer: 'Database, Cache', mismatch: true, sent: 'Database, Queue' },
    ]);
  });
});
