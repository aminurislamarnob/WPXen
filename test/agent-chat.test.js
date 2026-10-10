import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  openChat,
  closeAllChats,
  loadOlder,
  chatFetchFull,
  __setDeps,
  TRUNCATE_THRESHOLD,
} from '../electron/services/agentChat.cjs';
import { decodeClaudeLine } from '../electron/services/agentChatClaude.cjs';
import { sendChat, formatBody } from '../electron/services/agentChatSend.cjs';

// Real Claude record shapes: the turn sits under message.content, and a tool
// result is a user record of tool_result blocks keyed by tool_use_id.
function userRecord(uuid, text) {
  return { type: 'user', uuid, message: { role: 'user', content: text } };
}
function toolResultRecord(uuid, toolUseId, content) {
  return {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [
        { tool_use_id: toolUseId, type: 'tool_result', content, is_error: false },
      ],
    },
    toolUseResult: { stdout: content, stderr: '', interrupted: false },
  };
}

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
      statSync: () => ({ size: mockSize, mtimeMs: 100 }),
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

  it('handles chunk-based tail reading and loadOlder', () => {
    // Generate lines of ~500 bytes each.
    // 400 lines * 500 bytes = ~200,000 bytes (~195 KB)
    // PAGE_CHUNK is 64KB.
    // Chunk 1 (64KB) -> ~131 lines. Total lines = 131 (< 200). Continues.
    // Chunk 2 (64KB) -> ~131 lines. Total lines = 262 (> 200). Stops.
    // Remaining bytes ~ 69KB. loadOlder will read the rest.
    const padding = 'A'.repeat(480);
    const lines = Array.from(
      { length: 400 },
      (_, i) => `${JSON.stringify(userRecord(`msg-${i + 1}`, padding))}\n`
    );
    const mockContent = Buffer.from(lines.join(''));
    let mockSize = mockContent.length;

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
    openChat('sess-2', 'viewer-1', {
      transcriptPath: '/fake/path2.jsonl',
      decodeLine: decodeClaudeLine,
      onRows: (newRows) => rows.push(...newRows),
    });

    // We should get ~262 lines (it's exactly 262 depending on boundaries)
    // Let's just assert it's > 200 and < 400
    expect(rows.length).toBeGreaterThan(200);
    expect(rows.length).toBeLessThan(400);

    const loadedRows = rows.length;

    // now loadOlder
    const oldRows = loadOlder('sess-2');
    expect(oldRows.rows.length).toBe(400 - loadedRows);
    expect(oldRows.atStart).toBe(true);
  });

  it('truncates large tool results and can fetch full', () => {
    // Generate a huge tool result
    const largeStr = 'A'.repeat(TRUNCATE_THRESHOLD + 100);
    const mockJson = JSON.stringify(toolResultRecord('result-1', 'tool-1', largeStr));
    const mockContent = Buffer.from(mockJson + '\n');

    __setDeps({
      statSync: () => ({ size: mockContent.length }),
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
    openChat('sess-3', 'viewer-1', {
      transcriptPath: '/fake/path3.jsonl',
      decodeLine: decodeClaudeLine,
      onRows: (newRows) => rows.push(...newRows),
    });

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.blocks[0].truncated).toBe(true);
    expect(row.blocks[0].content.length).toBe(TRUNCATE_THRESHOLD);

    // fetchFull
    const full = chatFetchFull('sess-3', 'tool-1');
    expect(full).toBe(largeStr);
  });

  it('detects stale transcript', () => {
    __setDeps({
      statSync: (p) => {
        if (p.endsWith('newer.jsonl')) return { mtimeMs: 200, size: 10 };
        return { size: 0, mtimeMs: 100 };
      },
      readdirSync: () => ['old.jsonl', 'newer.jsonl'],
      openSync: () => 1,
      readSync: () => 0,
      closeSync: () => {},
      setInterval,
      clearInterval,
    });

    const rows = [];
    openChat('sess-4', 'viewer-1', {
      transcriptPath: '/fake/old.jsonl',
      transcriptId: 'old',
      startedAt: new Date(150).toISOString(),
      decodeLine: (line) => ({ decoded: line }),
      onRows: (newRows) => rows.push(...newRows),
    });

    vi.advanceTimersByTime(500);

    expect(rows).toContainEqual({ notice: true, kind: 'transcript-changed' });
  });
});

describe('decodeClaudeLine', () => {
  it('skips bookkeeping records', () => {
    const state = {};
    expect(decodeClaudeLine('{"type":"mode"}', state)).toBeNull();
    expect(decodeClaudeLine('{"type":"file-history-snapshot"}', state)).toBeNull();
  });

  // Real Claude records keep the turn under `message.content`, as a string or
  // an array of blocks; tool results arrive as user records of tool_result
  // blocks. The fixture follows that shape.
  function decodeFixture() {
    const lines = fs
      .readFileSync(path.join(__dirname, 'fixtures/claude-transcript.jsonl'), 'utf8')
      .split('\n');
    const state = {};
    const rows = new Map();
    for (const line of lines) {
      const row = decodeClaudeLine(line, state);
      if (row) rows.set(row.id, row);
    }
    return [...rows.values()];
  }

  it('decodes user prompts from message.content, string or text blocks', () => {
    const users = decodeFixture().filter((r) => r.role === 'user');
    expect(users).toEqual([
      expect.objectContaining({ id: 'u-0003', content: 'Add a health check endpoint' }),
      expect.objectContaining({ id: 'u-0005', content: 'Thanks, now add a test' }),
    ]);
  });

  it('never shows tool results, meta records or slash commands as user messages', () => {
    const contents = decodeFixture()
      .filter((r) => r.role === 'user')
      .map((r) => r.content);
    expect(contents.join('\n')).not.toMatch(/register_rest_route|<command-name>|caveat/i);
  });

  it('merges assistant records by message id', () => {
    const assistants = decodeFixture().filter((r) => r.role === 'assistant');
    expect(assistants.map((r) => r.id)).toEqual(['msg_01HealthA', 'msg_02HealthB']);
    expect(assistants[0].content).toContain("I'll look at the routes first.");
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

  it('handles cross-page tool pairing (orphan result then call)', () => {
    const state = {};

    // 1. Result arrives before call (due to loadOlder tail logic where we scan backwards but process forwards)
    const resultRes = decodeClaudeLine(
      JSON.stringify(toolResultRecord('orphan-1', 'tool-x', 'result content')),
      state
    );

    expect(resultRes.orphan).toBe(true);
    expect(resultRes.id).toBe('orphan-1');
    expect(state.results['tool-x']).toBeDefined();

    // 2. Later (or when paging up), the call is processed
    const callRes = decodeClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-1',
          content: [{ type: 'tool_use', id: 'tool-x', name: 'my_tool', input: {} }],
        },
      }),
      state
    );

    expect(callRes.remove).toEqual(['orphan-1']);
    expect(callRes.blocks[0].result.content).toBe('result content');
  });

  it('handles cross-page tool pairing (call then result via polling)', () => {
    const state = {};

    // 1. Call arrives
    decodeClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-1',
          content: [{ type: 'tool_use', id: 'tool-y', name: 'my_tool', input: {} }],
        },
      }),
      state
    );
    expect(state.calls['tool-y']).toBe('msg-1');

    // 2. Result arrives
    const resultRes = decodeClaudeLine(
      JSON.stringify(toolResultRecord('result-1', 'tool-y', 'result content')),
      state
    );

    // It should re-emit the modified call row instead of an orphan
    expect(resultRes.id).toBe('msg-1');
    expect(resultRes.orphan).toBeUndefined();
    expect(resultRes.blocks[0].result.content).toBe('result content');
  });
});

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
