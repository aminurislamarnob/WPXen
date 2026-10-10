import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openChat, closeAllChats, __setDeps } from '../electron/services/agentChat.cjs';
import { decodeClaudeLine } from '../electron/services/agentChatClaude.cjs';

describe('agent-chat watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    closeAllChats();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('polls a file and emits rows', () => {
    let mockSize = 0;
    let mockContent = Buffer.from('');

    __setDeps({
      statSync: () => ({ size: mockSize }),
      openSync: () => 1,
      readSync: (fd, buf, offset, length, position) => {
        const slice = mockContent.slice(position, position + length);
        slice.copy(buf);
        return slice.length;
      },
      closeSync: () => {},
      setInterval,
      clearInterval,
    });

    const rows = [];
    openChat('sess-1', 'viewer-1', {
      transcriptPath: '/fake/path.jsonl',
      decodeLine: (line) => ({ decoded: line }),
      onRows: (newRows) => rows.push(...newRows),
    });

    // File grows
    mockContent = Buffer.from('line1\nline2\n');
    mockSize = mockContent.length;
    vi.advanceTimersByTime(500);

    expect(rows).toEqual([{ decoded: 'line1' }, { decoded: 'line2' }]);

    // File grows more
    mockContent = Buffer.from('line1\nline2\nline3\n');
    mockSize = mockContent.length;
    vi.advanceTimersByTime(500);

    expect(rows).toEqual([
      { decoded: 'line1' },
      { decoded: 'line2' },
      { decoded: 'line3' },
    ]);
  });

  it('resets when file truncates', () => {
    let mockSize = 10;
    let mockContent = Buffer.from('line1\n');

    __setDeps({
      statSync: () => ({ size: mockSize }),
      openSync: () => 1,
      readSync: (fd, buf, offset, length, position) => {
        const slice = mockContent.slice(position, position + length);
        slice.copy(buf);
        return slice.length;
      },
      closeSync: () => {},
      setInterval,
      clearInterval,
    });

    const rows = [];
    openChat('sess-1', 'viewer-1', {
      transcriptPath: '/fake/path.jsonl',
      decodeLine: (line) => ({ decoded: line }),
      onRows: (newRows) => rows.push(...newRows),
    });

    vi.advanceTimersByTime(500);

    // Truncate
    mockSize = 0;
    mockContent = Buffer.alloc(0);
    vi.advanceTimersByTime(500);

    expect(rows).toContainEqual({ reset: true });
  });
});

describe('decodeClaudeLine', () => {
  it('skips bookkeeping records', () => {
    const state = {};
    expect(decodeClaudeLine('{"type":"mode"}', state)).toBeNull();
    expect(decodeClaudeLine('{"type":"file-history-snapshot"}', state)).toBeNull();
  });

  it('parses user commands', () => {
    const state = {};
    const res = decodeClaudeLine(
      JSON.stringify({
        uuid: 'msg-1',
        type: 'user',
        content: 'hello claude',
      }),
      state
    );

    expect(res).toMatchObject({
      id: 'msg-1',
      role: 'user',
      content: 'hello claude',
    });
  });

  it('accumulates assistant blocks', () => {
    const state = {};
    const msgId = 'msg-2';

    // First block
    let res = decodeClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: { id: msgId, content: [{ type: 'thinking', text: 'hmmm' }] },
      }),
      state
    );

    expect(res.content).toContain('> Thinking...');

    // Second block
    res = decodeClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: { id: msgId, content: [{ type: 'text', text: 'I am claude' }] },
      }),
      state
    );

    expect(res.content).toContain('I am claude');

    // State should have combined both
    expect(state[msgId].blocks.length).toBe(2);
  });
});

import { sendChat, formatBody } from '../electron/services/agentChatSend.cjs';

describe('agentChatSend', () => {
  it('formats body with bracketed paste for multiline', () => {
    expect(formatBody('hello\nworld')).toBe('\x1b[200~hello\rworld\x1b[201~');
    expect(formatBody('single line')).toBe('single line');
  });

  it('sends to pty correctly', async () => {
    const written = [];
    const session = {
      sessionId: 'sess-1',
      pty: {
        write: (data) => written.push(data),
      },
    };

    await sendChat(session, 'test');

    expect(written).toEqual(['\x15', 'test', '\r']);
  });
});
