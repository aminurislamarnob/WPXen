import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sendChatAnswer,
  NATIVE_CHAT_QUESTION_STEP_MS,
} from '../electron/services/agentChatSend.cjs';
import { buildAskAnswerKeys } from '../src/lib/agentAsk.js';

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
