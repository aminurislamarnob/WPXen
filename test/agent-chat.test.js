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
import {
  sendChat,
  chatStop,
  chatCommand,
  formatBody,
} from '../electron/services/agentChatSend.cjs';

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

  it('leaves no half-open watch when the first read fails', () => {
    const content = Buffer.from('line1\n');
    let failRead = true;
    __setDeps({
      statSync: () => ({ size: content.length, mtimeMs: 100 }),
      openSync: () => 1,
      readSync: (fd, buf, offset, length, position) => {
        if (failRead) throw new Error('EIO');
        const slice = content.slice(position, position + length);
        slice.copy(buf);
        return slice.length;
      },
      closeSync: () => {},
      setInterval,
      clearInterval,
    });
    const opts = (rows) => ({
      transcriptPath: '/fake/path.jsonl',
      decodeLine: (line) => ({ decoded: line }),
      onRows: (newRows) => rows.push(...newRows),
    });
    expect(() => openChat('sess-io', 'viewer-1', opts([]))).toThrow('EIO');

    // The retry opens a real watch, rather than joining a dead one.
    failRead = false;
    const rows = [];
    openChat('sess-io', 'viewer-1', opts(rows));
    expect(rows).toEqual([{ decoded: 'line1' }]);
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
    // 400 lines of ~500 bytes (~195 KB) read in 64 KB chunks. A page stops
    // on the line that reaches MAX_PAGE_ROWS, not at the end of the chunk it
    // sits in, so the first page is exactly 200 rows and Load older reads
    // the other 200.
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

    expect(rows.length).toBe(200);
    expect(rows[0].id).toBe('msg-201');

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

    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    expect(row.blocks[0].truncated).toBe(true);
    expect(row.blocks[0].content.length).toBe(TRUNCATE_THRESHOLD);

    // fetchFull
    const full = chatFetchFull('sess-3', 'tool-1');
    expect(full).toBe(largeStr);
  });

  // A project folder of transcripts: name -> { content, mtimeMs }. Each open
  // gets its own fd so reads hit the right file.
  function fakeFolder(files) {
    const fds = new Map();
    __setDeps({
      statSync: (p) => {
        const f = files[path.basename(p)];
        return { size: Buffer.byteLength(f.content), mtimeMs: f.mtimeMs };
      },
      readdirSync: () => Object.keys(files),
      openSync: (p) => {
        const fd = fds.size + 10;
        fds.set(fd, path.basename(p));
        return fd;
      },
      readSync: (fd, buf, offset, length, position) => {
        const slice = Buffer.from(files[fds.get(fd)].content).slice(
          position,
          position + length
        );
        slice.copy(buf, offset);
        return slice.length;
      },
      closeSync: () => {},
      setInterval,
      clearInterval,
    });
  }

  const CLEAR_HEAD =
    JSON.stringify(
      userRecord(
        'c-1',
        '<command-name>/clear</command-name>\n<command-args></command-args>'
      )
    ) + '\n';

  function watchOld(extra = {}) {
    const rows = [];
    openChat('sess-4', 'viewer-1', {
      transcriptPath: '/fake/old.jsonl',
      transcriptId: 'old',
      startedAt: new Date(150).toISOString(),
      decodeLine: (line) => ({ decoded: line }),
      onRows: (newRows) => rows.push(...newRows),
      ...extra,
    });
    vi.advanceTimersByTime(500);
    return rows;
  }

  it('detects stale transcript after /clear', () => {
    fakeFolder({
      'old.jsonl': { content: '', mtimeMs: 100 },
      'newer.jsonl': { content: CLEAR_HEAD, mtimeMs: 200 },
    });
    expect(watchOld()).toContainEqual({ notice: true, kind: 'transcript-changed' });
  });

  it("ignores another session's newer transcript in the same folder", () => {
    fakeFolder({
      'old.jsonl': { content: '', mtimeMs: 100 },
      'other.jsonl': {
        content: JSON.stringify(userRecord('o-1', 'unrelated work')) + '\n',
        mtimeMs: 200,
      },
    });
    expect(watchOld()).not.toContainEqual({ notice: true, kind: 'transcript-changed' });
  });

  it('ignores a /clear transcript another live Session has pinned', () => {
    fakeFolder({
      'old.jsonl': { content: '', mtimeMs: 100 },
      'pinned.jsonl': { content: CLEAR_HEAD, mtimeMs: 200 },
    });
    const rows = watchOld({ isPinnedElsewhere: (uuid) => uuid === 'pinned' });
    expect(rows).not.toContainEqual({ notice: true, kind: 'transcript-changed' });
  });

  it('attaches a result on a newer page to its call once Load older brings it in', () => {
    // The call, then ~250 KB of later turns, then the call's result: the
    // result lands on the first page as an orphan, the call on an older one.
    const call = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-call',
        content: [{ type: 'tool_use', id: 'toolu_X', name: 'Bash', input: {} }],
      },
    });
    const filler = Array.from({ length: 500 }, (_, i) =>
      JSON.stringify(userRecord(`f-${i}`, `later ${i} ${'x'.repeat(450)}`))
    );
    const result = JSON.stringify(toolResultRecord('r-1', 'toolu_X', 'done'));
    fakeFolder({
      'long.jsonl': {
        content: [call, ...filler, result].join('\n') + '\n',
        mtimeMs: 100,
      },
    });

    const rows = [];
    openChat('sess-6', 'viewer-1', {
      transcriptPath: '/fake/long.jsonl',
      decodeLine: decodeClaudeLine,
      onRows: (newRows) => rows.push(...newRows),
    });
    expect(rows.find((r) => r.orphan)?.id).toBe('r-1');

    const older = [];
    for (let page = loadOlder('sess-6'); ; page = loadOlder('sess-6')) {
      older.push(...page.rows);
      if (page.atStart) break;
    }
    const callRow = older.find((r) => r.id === 'toolu_X');
    expect(callRow.result.content).toBe('done');
    expect(callRow.remove).toEqual(['r-1']);
  });

  it('holds a partial last line until it completes, then decodes it once', () => {
    const first = JSON.stringify(userRecord('p-1', 'first')) + '\n';
    const second = JSON.stringify(userRecord('p-2', 'second'));
    const files = { 'live.jsonl': { content: first, mtimeMs: 100 } };
    fakeFolder(files);

    const rows = [];
    openChat('sess-5', 'viewer-1', {
      transcriptPath: '/fake/live.jsonl',
      decodeLine: decodeClaudeLine,
      onRows: (newRows) => rows.push(...newRows),
    });

    // Claude flushes half a record, then the rest.
    files['live.jsonl'].content = first + second.slice(0, 20);
    vi.advanceTimersByTime(500);
    files['live.jsonl'].content = first + second + '\n';
    vi.advanceTimersByTime(500);

    expect(rows.map((r) => r.content)).toEqual(['first', 'second']);
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
      const out = decodeClaudeLine(line, state);
      for (const row of [out ?? []].flat()) rows.set(row.id, row);
    }
    return [...rows.values()];
  }

  it('decodes user prompts from message.content, string or text blocks', () => {
    const users = decodeFixture().filter((r) => r.role === 'user');
    expect(users).toEqual([
      expect.objectContaining({ id: 'u-0003', content: 'Add a health check endpoint' }),
      expect.objectContaining({ id: 'u-0005', content: 'Thanks, now add a test' }),
      expect.objectContaining({
        id: 'u-0105',
        content: '[Image #1] what is wrong on this page?',
      }),
    ]);
  });

  it('never shows tool results, meta records or slash commands as user messages', () => {
    const contents = decodeFixture()
      .filter((r) => r.role === 'user')
      .map((r) => r.content);
    expect(contents.join('\n')).not.toMatch(/register_rest_route|<command-name>|caveat/i);
  });

  it("takes the header title from Claude's ai-title record", () => {
    const state = {};
    const lines = fs
      .readFileSync(path.join(__dirname, 'fixtures/claude-transcript.jsonl'), 'utf8')
      .split('\n');
    const headers = lines
      .flatMap((l) => [decodeClaudeLine(l, state) ?? []].flat())
      .filter((r) => r.isHeader);
    expect(headers).toEqual([{ isHeader: true, title: 'Health check endpoint' }]);
  });

  it('renders Edit, Write and MultiEdit calls as inline diffs', () => {
    const P = '/Users/dev/Sites/shop.test/wp-content/plugins/shop/';
    const edits = Object.fromEntries(
      decodeFixture()
        .filter((r) => r.role === 'tool' && r.edit)
        .map((r) => [r.tool_use.name, r.edit])
    );
    expect(edits.Edit).toEqual({
      path: P + 'rest.php',
      original: "register_rest_route('shop/v1', '/orders'",
      modified: "register_rest_route('shop/v1', '/health'",
    });
    expect(edits.Write).toEqual({
      path: P + 'tests/test-health.php',
      original: '',
      modified: '<?php\nclass Test_Health extends WP_UnitTestCase {}\n',
    });
    expect(edits.MultiEdit).toEqual({
      path: P + 'shop.php',
      original: 'Version: 1.0\n\n// routes',
      modified: 'Version: 1.1\n\n// routes: orders, health',
    });
  });

  it('attaches each edit result to its call', () => {
    const tools = decodeFixture().filter((r) => r.role === 'tool');
    expect(tools.every((t) => t.result)).toBe(true);
  });

  it('keeps row ids stable when a message straddles a page boundary', () => {
    // Claude writes each block of a message as its own record; Load older
    // decodes each page with its own state.
    const thinking = JSON.stringify({
      type: 'assistant',
      uuid: 'a-think',
      message: { id: 'msg-split', content: [{ type: 'thinking', thinking: 'hm' }] },
    });
    const call = JSON.stringify({
      type: 'assistant',
      uuid: 'a-call',
      message: {
        id: 'msg-split',
        content: [{ type: 'tool_use', id: 'toolu_Split', name: 'Agent', input: {} }],
      },
    });
    const olderPage = [decodeClaudeLine(thinking, {})].flat();
    const newerPage = [decodeClaudeLine(call, {})].flat();
    const ids = [...olderPage, ...newerPage].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(newerPage[0].id).toBe('toolu_Split');
  });

  it('splits assistant messages into one row per block record', () => {
    const rows = decodeFixture();
    expect(rows.filter((r) => r.role === 'assistant').map((r) => r.id)).toEqual([
      'a-0002-0',
      'a-0004-0',
    ]);
    expect(rows.find((r) => r.id === 'a-0001-0')).toMatchObject({
      role: 'reasoning',
      content: 'The routes live in the plugin bootstrap.',
    });
  });

  it('accumulates assistant blocks', () => {
    const state = {};
    const msgId = 'msg-2';

    // First block
    let res = decodeClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: { id: msgId, content: [{ type: 'thinking', thinking: 'hmmm' }] },
      }),
      state
    );

    expect(res).toBeInstanceOf(Array);
    expect(res[0].role).toBe('reasoning');
    expect(res[0].content).toBe('hmmm');

    // Second block
    res = decodeClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: { id: msgId, content: [{ type: 'text', text: 'I am claude' }] },
      }),
      state
    );

    expect(res).toBeInstanceOf(Array);
    expect(res.length).toBe(2);
    expect(res[1].role).toBe('assistant');
    expect(res[1].content).toBe('I am claude');

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

    expect(callRes).toBeInstanceOf(Array);
    expect(callRes[0].remove).toEqual(['orphan-1']);
    expect(callRes[0].result.content).toBe('result content');
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
    expect(resultRes.id).toBe('tool-y');
    expect(resultRes.orphan).toBeUndefined();
    expect(resultRes.result.content).toBe('result content');
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

describe('chatStop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('writes exactly one Esc and nothing else', async () => {
    const written = [];
    const session = {
      sessionId: 'stop-exact',
      pty: { write: (data) => written.push(data) },
    };

    await chatStop(session);

    expect(written).toEqual(['\x1b']);
  });

  it('cancels a pending delayed Enter from an earlier send', async () => {
    const written = [];
    const session = {
      sessionId: 'stop-cancel',
      pty: { write: (data) => written.push(data) },
    };

    const send = sendChat(session, 'hello');
    // Let the send start: its body writes on a microtask and the delayed
    // Enter becomes pending. A real Stop always arrives over IPC after that.
    await Promise.resolve();
    await chatStop(session);
    await vi.advanceTimersByTimeAsync(2000);
    await send;

    expect(written).toEqual(['\x15', 'hello', '\x1b']);
    expect(written).not.toContain('\r');
  });
});

describe('chatCommand (/model)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('writes the command with a delayed Enter and no line clear', async () => {
    const written = [];
    const session = {
      sessionId: 'model-plain',
      pty: { write: (data) => written.push(data) },
    };

    const done = chatCommand(session, '/model sonnet');
    await vi.advanceTimersByTimeAsync(2000);
    await done;

    expect(written).toEqual(['/model sonnet', '\r']);
  });

  it('waits for an in-flight send Enter and never interleaves', async () => {
    const written = [];
    const session = {
      sessionId: 'model-queue',
      pty: { write: (data) => written.push(data) },
    };

    const first = sendChat(session, 'hello');
    const second = chatCommand(session, '/model sonnet');
    await vi.advanceTimersByTimeAsync(4000);
    await Promise.all([first, second]);

    expect(written).toEqual(['\x15', 'hello', '\r', '/model sonnet', '\r']);
  });
});

describe('subagents in agentChat', () => {
  const {
    __setDeps,
    openChat,
    closeAllChats,
    chatExpandSubagent,
    loadOlder,
  } = require('../electron/services/agentChat.cjs');
  const { decodeClaudeLine } = require('../electron/services/agentChatClaude.cjs');
  const os = require('node:os');

  // Claude's real layout: <project>/<uuid>.jsonl, and the Session's subagents
  // in <project>/<uuid>/subagents/agent-<id>.jsonl + .meta.json.
  const UUID = '5f0c2a8e-1b7d-4c3e-9a61-2d8e4f7b9c10';
  let proj;

  const line = (r) => JSON.stringify(r) + '\n';
  const agentCall = line({
    type: 'assistant',
    uuid: 'a-1',
    message: {
      id: 'msg-1',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_Agent1',
          name: 'Agent',
          input: {
            description: 'Find REST routes',
            subagent_type: 'Explore',
            prompt: 'p',
          },
        },
      ],
    },
  });
  const agentResult = line(toolResultRecord('u-2', 'toolu_Agent1', 'Found 2 routes.'));
  const subLines =
    line({
      isSidechain: true,
      agentId: 'abc123',
      type: 'user',
      uuid: 's-1',
      message: { role: 'user', content: 'Find REST routes' },
    }) +
    line({
      isSidechain: true,
      agentId: 'abc123',
      type: 'assistant',
      uuid: 's-2',
      message: {
        id: 'msg-sub-1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_S1', name: 'Grep', input: { pattern: 'route' } },
        ],
      },
    });

  function writeSession({ parent, sub = subLines }) {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-sub-'));
    fs.writeFileSync(path.join(proj, `${UUID}.jsonl`), parent);
    const dir = path.join(proj, UUID, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'agent-abc123.meta.json'),
      JSON.stringify({
        agentType: 'Explore',
        description: 'Find REST routes',
        toolUseId: 'toolu_Agent1',
      })
    );
    fs.writeFileSync(path.join(dir, 'agent-abc123.jsonl'), sub);
  }

  function watch() {
    const rows = [];
    openChat('sess-sub', 'viewer-1', {
      transcriptPath: path.join(proj, `${UUID}.jsonl`),
      transcriptId: UUID,
      decodeLine: decodeClaudeLine,
      onRows: (newRows) => rows.push(...newRows),
    });
    vi.advanceTimersByTime(500);
    return rows;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // Production fs, except readFileSync: whatever the module ships with.
    __setDeps({
      statSync: fs.statSync,
      openSync: fs.openSync,
      readSync: fs.readSync,
      closeSync: fs.closeSync,
      readdirSync: fs.readdirSync,
      setInterval,
      clearInterval,
    });
  });

  afterEach(() => {
    closeAllChats();
    vi.useRealTimers();
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it("finds subagents in the Session's own folder and labels the parent call", () => {
    writeSession({ parent: agentCall + agentResult });
    const rows = watch();
    const call = rows.filter((r) => r.tool_use?.id === 'toolu_Agent1').at(-1);
    expect(call.subagent).toEqual({
      agentId: 'abc123',
      type: 'Explore',
      description: 'Find REST routes',
      status: 'done',
    });
  });

  it('does not tail a finished, collapsed subagent', () => {
    writeSession({ parent: agentCall + agentResult });
    const rows = watch();
    expect(rows.some((r) => r.parentId)).toBe(false);
  });

  it('tails a finished subagent once expanded by its tool_use id', () => {
    writeSession({ parent: agentCall + agentResult });
    const rows = watch();
    chatExpandSubagent('sess-sub', 'toolu_Agent1', true);
    vi.advanceTimersByTime(500);
    const nested = rows.filter((r) => r.parentId === 'toolu_Agent1');
    expect(nested.map((r) => r.role)).toEqual(['user', 'tool']);
  });

  it('labels a subagent call that arrives through Load older', () => {
    // Push the Agent call off the first page with ~250 KB of later rows.
    const filler = Array.from({ length: 500 }, (_, i) =>
      line(userRecord(`f-${i}`, `later prompt ${i} ${'x'.repeat(450)}`))
    ).join('');
    writeSession({ parent: agentCall + agentResult + filler });
    const rows = watch();
    expect(rows.some((r) => r.tool_use?.id === 'toolu_Agent1')).toBe(false);

    const older = [];
    for (let page = loadOlder('sess-sub'); ; page = loadOlder('sess-sub')) {
      older.push(...page.rows);
      if (page.atStart) break;
    }
    const call = older.filter((r) => r.tool_use?.id === 'toolu_Agent1').at(-1);
    expect(call.subagent).toMatchObject({ agentId: 'abc123', type: 'Explore' });
  });

  it('tails a running subagent without being expanded', () => {
    writeSession({ parent: agentCall });
    const rows = watch();
    vi.advanceTimersByTime(500);
    expect(rows.some((r) => r.parentId === 'toolu_Agent1')).toBe(true);
  });
});

describe('session facts and images (#115)', () => {
  function decodeAll() {
    const state = {};
    const rows = new Map();
    const lines = fs
      .readFileSync(path.join(__dirname, 'fixtures/claude-transcript.jsonl'), 'utf8')
      .split('\n');
    for (const line of lines) {
      for (const row of [decodeClaudeLine(line, state) ?? []].flat()) {
        if (row.id) rows.set(row.id, row);
      }
    }
    return { state, rows: [...rows.values()] };
  }

  it('tracks background Bash and Monitor tasks through notifications and TaskStop', () => {
    const { state } = decodeAll();
    expect(state.facts.tasks).toEqual({
      b77r50xr0: { id: 'b77r50xr0', command: 'npm run dev', status: 'completed' },
      bya76lu8s: { id: 'bya76lu8s', command: 'errors in dev log', status: 'stopped' },
    });
  });

  it("marks each task's tool row with its task id", () => {
    const { rows } = decodeAll();
    expect(rows.find((r) => r.id === 'toolu_04Bg').taskId).toBe('b77r50xr0');
    expect(rows.find((r) => r.id === 'toolu_05Mon').taskId).toBe('bya76lu8s');
  });

  it('keeps the latest TodoWrite list', () => {
    expect(decodeAll().state.facts.todos).toEqual([
      { content: 'Add /health route', status: 'completed' },
      { content: 'Write the health test', status: 'in_progress' },
    ]);
  });

  it('records the latest usage and model', () => {
    expect(decodeAll().state.facts.usage).toEqual({
      model: 'claude-opus-5-5',
      contextModel: null,
      tokens: 2 + 1000 + 50000 + 50,
    });
  });

  it("carries AskUserQuestion's recorded answers on its result", () => {
    const { rows } = decodeAll();
    expect(rows.find((r) => r.id === 'toolu_09Ask').result.answers).toEqual({
      'Which route path should the health check use?': '/status',
    });
  });

  it('references images by record and position, never carrying base64', () => {
    const { rows } = decodeAll();
    const pasted = rows.find((r) => r.id === 'u-0105');
    expect(pasted).toMatchObject({
      role: 'user',
      content: '[Image #1] what is wrong on this page?',
      images: [{ uuid: 'u-0105', path: [1] }],
    });
    expect(rows.find((r) => r.id === 'toolu_07Read').result.images).toEqual([
      { uuid: 'u-0106', path: [0, 0] },
    ]);
    expect(JSON.stringify(rows)).not.toContain('iVBORw0KGgo');
  });
});

describe('chatImage (#115)', () => {
  const chat = require('../electron/services/agentChat.cjs');
  const os = require('node:os');
  const fixture = fs.readFileSync(
    path.join(__dirname, 'fixtures/claude-transcript.jsonl'),
    'utf8'
  );
  let dir;

  function open(content = fixture) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-img-'));
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, content);
    chat.openChat('sess-img', 'viewer-1', {
      transcriptPath: file,
      decodeLine: decodeClaudeLine,
      onRows: () => {},
    });
  }

  beforeEach(() => {
    chat.__setDeps({
      statSync: fs.statSync,
      openSync: fs.openSync,
      readSync: fs.readSync,
      closeSync: fs.closeSync,
      readdirSync: fs.readdirSync,
      setInterval,
      clearInterval,
    });
  });

  afterEach(() => {
    chat.closeAllChats();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves a pasted image from the session's own transcript", async () => {
    open();
    const url = await chat.chatImage('sess-img', { uuid: 'u-0105', path: [1] });
    expect(url).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
  });

  it('serves an image inside a tool result', async () => {
    open();
    const url = await chat.chatImage('sess-img', { uuid: 'u-0106', path: [0, 0] });
    expect(url).toMatch(/^data:image\/png;base64,/);
  });

  it('refuses file paths, unknown records and non-image blocks', async () => {
    open();
    for (const ref of [
      { path: '/etc/passwd' },
      { uuid: 'u-0105', path: '/Users/dev/.claude/.credentials.json' },
      { uuid: 'nope', path: [1] },
      { uuid: 'u-0105', path: [0] }, // the text block
      { uuid: '"', path: [1] },
      null,
    ]) {
      expect(await chat.chatImage('sess-img', ref)).toBeNull();
    }
    expect(
      await chat.chatImage('no-such-session', { uuid: 'u-0105', path: [1] })
    ).toBeNull();
  });

  it('refuses media types a page could script, and caps size', async () => {
    const rec = (uuid, mediaType, data) =>
      JSON.stringify({
        type: 'user',
        uuid,
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          ],
        },
      });
    const big = 'A'.repeat(Math.ceil((chat.IMAGE_MAX_BYTES * 4) / 3) + 8);
    open(
      [rec('svg', 'image/svg+xml', 'PHN2Zz4='), rec('big', 'image/png', big)].join('\n') +
        '\n'
    );
    expect(await chat.chatImage('sess-img', { uuid: 'svg', path: [0] })).toBeNull();
    expect(await chat.chatImage('sess-img', { uuid: 'big', path: [0] })).toEqual({
      tooLarge: true,
    });
  });
});

// Current Claude Code (2.1.x) records, in the shapes real transcripts carry:
// TaskCreate/TaskUpdate to-dos, a background task completed through a queued
// <task-notification> attachment, Stop's interrupt notice, thinking timing.
describe('Claude Code 2.1 transcripts', () => {
  function decodeAll() {
    const state = {};
    const rows = new Map();
    const lines = fs
      .readFileSync(path.join(__dirname, 'fixtures/claude-2.1-transcript.jsonl'), 'utf8')
      .split('\n');
    for (const line of lines) {
      for (const row of [decodeClaudeLine(line, state) ?? []].flat()) {
        if (row.id) rows.set(row.id, row);
      }
    }
    return { state, rows: [...rows.values()] };
  }

  it('folds TaskCreate and TaskUpdate into the to-do checklist', () => {
    expect(decodeAll().state.facts.todos).toEqual([
      { content: 'Reproduce the checkout bug', status: 'in_progress' },
    ]);
  });

  it('completes a background task from a queued task-notification attachment', () => {
    expect(decodeAll().state.facts.tasks.bk7q2m9xa).toMatchObject({
      command: 'npm test -- checkout',
      status: 'completed',
    });
  });

  it("shows Stop's interrupt notice as a status row, not a user message", () => {
    const { rows } = decodeAll();
    expect(rows.find((r) => r.id === 'u-7')).toEqual({
      id: 'u-7',
      role: 'status',
      content: 'Interrupted',
    });
    const users = rows.filter((r) => r.role === 'user' && !r.orphan);
    expect(users.map((r) => r.content)).toEqual([
      'Plan the checkout fix',
      'Carry on with the test',
    ]);
  });

  it('times a thinking block from the record that started the request', () => {
    const reasoning = decodeAll().rows.find((r) => r.role === 'reasoning');
    // Prompt at :16.000, thinking record written at :19.200.
    expect(reasoning.durationMs).toBe(3200);
  });
});

// A paired call carries its result on `result` (and Claude's call block on
// `tool_use.result`): both used to cross IPC whole.
describe('tool results over the cap (#112)', () => {
  const agentChat = require('../electron/services/agentChat.cjs');
  const claude = require('../electron/services/agentChatClaude.cjs');
  const codex = require('../electron/services/agentChatCodex.cjs');
  const antigravity = require('../electron/services/agentChatAntigravity.cjs');
  const os = require('node:os');
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-cap-'));
    agentChat.__setDeps({
      statSync: fs.statSync,
      openSync: fs.openSync,
      readSync: fs.readSync,
      closeSync: fs.closeSync,
      readdirSync: fs.readdirSync,
      setInterval: () => 0,
      clearInterval: () => {},
    });
  });
  afterEach(() => {
    agentChat.closeAllChats();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function open(sessionId, file, decoder, decodeLine) {
    const rows = [];
    agentChat.openChat(sessionId, 'v', {
      transcriptPath: file,
      decodeLine,
      findToolResult: decoder.findToolResult,
      toolResultNeedle: decoder.toolResultNeedle,
      onRows: (r) => rows.push(...r),
    });
    return rows;
  }

  function expectCapped(row, full) {
    expect(row.result.truncated).toBe(true);
    expect(row.result.content).toBe(full.slice(0, agentChat.TRUNCATE_THRESHOLD));
    expect(row.result.fullBytes).toBe(Buffer.byteLength(full));
    expect(row.tool_use.result).toBeUndefined();
    expect(JSON.stringify(row).length).toBeLessThan(2 * agentChat.TRUNCATE_THRESHOLD);
  }

  it('Claude: a ~50 KB Bash result is capped once and fetched in full', () => {
    const file = path.join(__dirname, 'fixtures', 'claude-large-result.jsonl');
    const records = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const full = records[1].message.content[0].content;
    expect(full.length).toBeGreaterThan(40 * 1024);

    const rows = open('cap-claude', file, claude, claude.decodeClaudeLine);
    const call = rows.filter((r) => r.role === 'tool').at(-1);
    expectCapped(call, full);
    // The call's first row was emitted before its result was decoded; the
    // decoder pairing it later must not reach a row already handed over.
    expect(rows.every((r) => !r.tool_use?.result)).toBe(true);
    expect(agentChat.chatFetchFull('cap-claude', call.tool_use.id)).toBe(full);
  });

  it('Codex: a large function_call_output is capped and fetched in full', () => {
    const full = 'row of output\n'.repeat(4000);
    const lines = fs
      .readFileSync(path.join(__dirname, 'fixtures', 'codex-rollout-0.100.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const r = JSON.parse(l);
        if (r.payload?.type === 'function_call_output') r.payload.output = full;
        return JSON.stringify(r);
      });
    const file = path.join(dir, 'rollout-cap.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const rows = open('cap-codex', file, codex, codex.decodeCodexLine);
    const call = rows.filter((r) => r.role === 'tool').at(-1);
    expectCapped(call, full);
    expect(agentChat.chatFetchFull('cap-codex', call.tool_use.id)).toBe(full);
  });

  it('Antigravity: a large result step is capped and fetched in full', () => {
    const full = 'listing line\n'.repeat(4000);
    const recs = [
      {
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-10-24T05:43:04Z',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"ls -R"' } }],
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-10-24T05:43:05Z',
        content: full,
      },
    ];
    const file = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const rows = open('cap-agy', file, antigravity, antigravity.decodeAntigravityLine);
    const call = rows.filter((r) => r.role === 'tool').at(-1);
    expectCapped(call, full);
    expect(agentChat.chatFetchFull('cap-agy', call.tool_use.id)).toBe(full);
  });
});

// Claude Code 2.1 background subagents (test/fixtures/claude-async-subagent,
// real shapes): the Agent call's result is `async_launched` at once, and a
// <task-notification> user turn whose <task-id> is the agentId settles it.
describe('async subagents (#114)', () => {
  const agentChat = require('../electron/services/agentChat.cjs');
  const claude = require('../electron/services/agentChatClaude.cjs');
  const os = require('node:os');
  const fixture = fs
    .readFileSync(path.join(__dirname, 'fixtures', 'claude-async-subagent.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean);
  const notifyAt = fixture.findIndex((l) =>
    l.includes('"turnOrigin":"task_notification"')
  );
  const launch = fixture.slice(0, notifyAt).join('\n') + '\n';
  const settle = fixture.slice(notifyAt).join('\n') + '\n';
  const UUID = '7c1e9a40-2b5d-4f8e-9c3a-000000000001';
  const AGENT = 'a1b2c3d4e5f60718';
  const TOOLU = 'toolu_01InventedAsyncAgent0001';
  let proj;
  let rows;

  function writeSession(parent, { subMtime } = {}) {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-async-'));
    const file = path.join(proj, `${UUID}.jsonl`);
    fs.writeFileSync(file, parent);
    const dir = path.join(proj, UUID, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `agent-${AGENT}.meta.json`),
      JSON.stringify({
        agentType: 'Explore',
        description: 'Audit theme templates',
        toolUseId: TOOLU,
      })
    );
    const sub = path.join(dir, `agent-${AGENT}.jsonl`);
    fs.writeFileSync(
      sub,
      JSON.stringify({
        isSidechain: true,
        agentId: AGENT,
        type: 'user',
        uuid: 's-1',
        message: { role: 'user', content: 'List every template in the theme.' },
      }) + '\n'
    );
    if (subMtime) fs.utimesSync(sub, subMtime, subMtime);
    return file;
  }

  function open(file) {
    rows = [];
    agentChat.openChat('async', 'v', {
      transcriptPath: file,
      transcriptId: UUID,
      decodeLine: claude.decodeClaudeLine,
      onRows: (r) => rows.push(...r),
    });
    vi.advanceTimersByTime(500);
  }
  const parent = () => rows.filter((r) => r.tool_use?.id === TOOLU).at(-1);

  beforeEach(() => {
    vi.useFakeTimers();
    agentChat.__setDeps({
      statSync: fs.statSync,
      openSync: fs.openSync,
      readSync: fs.readSync,
      closeSync: fs.closeSync,
      readdirSync: fs.readdirSync,
      readFileSync: fs.readFileSync,
      setInterval,
      clearInterval,
      now: () => Date.now(),
    });
  });
  afterEach(() => {
    agentChat.closeAllChats();
    vi.useRealTimers();
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it('is running after async_launched, though the call already has a result', () => {
    open(writeSession(launch));
    expect(parent().result).toBeDefined();
    expect(parent().subagent.status).toBe('running');
    // ...and its transcript is tailed while it runs.
    expect(rows.some((r) => r.parentId === TOOLU)).toBe(true);
  });

  it('settles from the task-notification whose task-id is its agentId', () => {
    const file = writeSession(launch);
    open(file);
    fs.appendFileSync(file, settle);
    vi.advanceTimersByTime(500);
    // The notification renders no row, yet the parent row is pushed again.
    expect(parent().subagent.status).toBe('done');
  });

  it('with no report, counts as running only while its transcript is fresh', () => {
    const stale = new Date(Date.now() - 10 * 60_000);
    open(writeSession(launch, { subMtime: stale }));
    expect(parent().subagent.status).toBeNull();
    expect(rows.some((r) => r.parentId === TOOLU)).toBe(false);
  });

  it('reads the status before <summary>: a result can quote its own tag', () => {
    const text = JSON.parse(fixture[notifyAt]).message.content;
    expect(text).toContain('<status>failed</status>');
    expect(claude.readTaskNotification(text)).toEqual({
      taskId: AGENT,
      status: 'completed',
    });
  });
});

// A line bigger than the page budget used to stop the page mid-line:
// `pageStart` never moved and every Load older re-read the same bytes.
describe('oversized transcript lines (#112)', () => {
  const agentChat = require('../electron/services/agentChat.cjs');
  const os = require('node:os');
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-big-'));
    agentChat.__setDeps({
      statSync: fs.statSync,
      openSync: fs.openSync,
      readSync: fs.readSync,
      closeSync: fs.closeSync,
      readdirSync: fs.readdirSync,
      setInterval: () => 0,
      clearInterval: () => {},
    });
  });
  afterEach(() => {
    agentChat.closeAllChats();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const record = (uuid, text) => JSON.stringify(userRecord(uuid, text)) + '\n';

  function pageAll(file) {
    const rows = [];
    agentChat.openChat('big', 'v', {
      transcriptPath: file,
      decodeLine: decodeClaudeLine,
      onRows: (r) => rows.push(...r),
    });
    let pages = 0;
    for (let page = agentChat.loadOlder('big'); ; page = agentChat.loadOlder('big')) {
      rows.unshift(...page.rows);
      if (page.atStart || ++pages > 20) break;
    }
    return { rows, pages };
  }

  it('Load older moves past a line larger than the page budget', () => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(
      file,
      record('before', 'the first prompt') +
        record('huge', 'x'.repeat(agentChat.MAX_PAGE_BYTES + 100_000)) +
        record('after', 'the last prompt')
    );
    const { rows, pages } = pageAll(file);
    expect(pages).toBeLessThan(5);
    expect(rows.map((r) => r.id)).toEqual(['before', 'huge', 'after']);
    // Under MAX_LINE_BYTES it is still decoded: its row is small.
    expect(rows[1].content.length).toBeGreaterThan(agentChat.MAX_PAGE_BYTES);
  });

  it('shows a placeholder for a line over MAX_LINE_BYTES and keeps going', () => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(
      file,
      record('before', 'the first prompt') +
        record('huge', 'x'.repeat(agentChat.MAX_LINE_BYTES + 1000)) +
        record('after', 'the last prompt')
    );
    const { rows, pages } = pageAll(file);
    expect(pages).toBeLessThan(10);
    expect(rows.map((r) => r.role)).toEqual(['user', 'status', 'user']);
    expect(rows[1]).toMatchObject({
      tooLarge: true,
      content: expect.stringMatching(/too large/),
    });
    expect(rows[1].id).toMatch(/:\d{16}$/);
  });
});

// Background-task state that moves without a row (#115): a notification or
// a task_status attachment renders nothing, and the task may have started
// above the newest page.
describe('session facts without rows (#115)', () => {
  const agentChat = require('../electron/services/agentChat.cjs');
  const claude = require('../electron/services/agentChatClaude.cjs');
  const os = require('node:os');
  const fixture = fs
    .readFileSync(path.join(__dirname, 'fixtures', 'claude-2.1-transcript.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean);
  // The background Bash call (run_in_background) and its result.
  const bgCall = fixture.find((l) => l.includes('"run_in_background":true'));
  const bgResult = fixture.find((l) => l.includes('"backgroundTaskId":"bk7q2m9xa"'));
  const notification = (status) =>
    JSON.stringify({
      parentUuid: 'a-9',
      isSidechain: false,
      type: 'user',
      message: {
        role: 'user',
        content: `<task-notification>\n<task-id>bk7q2m9xa</task-id>\n<status>${status}</status>\n<summary>Background command completed</summary>\n</task-notification>`,
      },
      uuid: 'u-note',
      timestamp: '2026-10-20T08:10:00.000Z',
      origin: { kind: 'task-notification' },
    });
  // Claude Code 2.1's task_status attachment, as seen on real transcripts.
  const taskStatus = (taskId, status) =>
    JSON.stringify({
      parentUuid: 'a-1',
      isSidechain: false,
      attachment: {
        type: 'task_status',
        taskId,
        taskType: 'local_bash',
        description: 'Run the dev server',
        status,
        deltaSummary: null,
        outputFilePath: `/tmp/tasks/${taskId}.output`,
        shell: 'zsh',
      },
      type: 'attachment',
      uuid: `att-${taskId}`,
      timestamp: '2026-10-20T08:00:00.000Z',
    });
  const filler = (n) =>
    Array.from({ length: n }, (_, i) =>
      JSON.stringify(userRecord(`fill-${i}`, `later prompt ${i}`))
    ).join('\n');

  let dir;
  let pushes;
  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-facts-'));
    agentChat.__setDeps({
      statSync: fs.statSync,
      openSync: fs.openSync,
      readSync: fs.readSync,
      closeSync: fs.closeSync,
      readdirSync: fs.readdirSync,
      setInterval,
      clearInterval,
    });
  });
  afterEach(() => {
    agentChat.closeAllChats();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function open(content) {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, content + '\n');
    pushes = [];
    agentChat.openChat('facts', 'v', {
      transcriptPath: file,
      decodeLine: claude.decodeClaudeLine,
      factScan: { markers: claude.FACT_MARKERS, noteFacts: claude.noteFacts },
      onRows: (rows, state) => pushes.push({ rows, facts: state?.facts }),
    });
    return file;
  }
  const lastFacts = () => pushes.filter((p) => p.facts).at(-1).facts;

  it('pushes a task finishing even though its notification renders no row', () => {
    const file = open([bgCall, bgResult].join('\n'));
    expect(lastFacts().tasks.bk7q2m9xa.status).toBe('running');
    fs.appendFileSync(file, notification('completed') + '\n');
    vi.advanceTimersByTime(500);
    const last = pushes.at(-1);
    expect(last.rows).toEqual([]);
    expect(last.facts.tasks.bk7q2m9xa.status).toBe('completed');
  });

  it('takes a task it never saw start from its task_status attachment', () => {
    open(
      [userRecord('u-1', 'start the server'), taskStatus('b1dev', 'running')]
        .map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))
        .join('\n')
    );
    expect(lastFacts().tasks.b1dev).toMatchObject({ status: 'running' });
  });

  it('folds task state recorded above the newest page', () => {
    // The task's status sits under 300 later prompts, off the first page.
    open([taskStatus('b2old', 'running'), filler(300)].join('\n'));
    expect(pushes[0].rows.some((r) => r.id === 'att-b2old')).toBe(false);
    expect(lastFacts().tasks.b2old).toMatchObject({ status: 'running' });
  });
});

// Claude Code's assistant records name the bare model; the context window
// is only in the session's `model` attachment (#115).
describe('Claude context window from the model attachment (#115)', () => {
  const agentChat = require('../electron/services/agentChat.cjs');
  const claude = require('../electron/services/agentChatClaude.cjs');
  const { contextMeter } = require('../src/lib/contextMeter.js');
  const os = require('node:os');
  // Real shape (Claude Code 2.1), text as Claude writes it.
  const modelAttachment = (modelId) =>
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      attachment: {
        type: 'model',
        identity: {
          modelId,
          marketingName: 'Opus 5.5 (1M context)',
          knowledgeCutoff: 'June 2026',
        },
        text: `You are powered by the model named Opus 5.5 (1M context). The exact model ID is ${modelId}.`,
      },
      type: 'attachment',
      uuid: 'att-model',
      timestamp: '2026-10-20T08:00:00.000Z',
    });
  const assistant = (uuid, tokens) =>
    JSON.stringify({
      type: 'assistant',
      uuid,
      message: {
        model: 'claude-opus-5-5',
        id: `msg-${uuid}`,
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: tokens,
          output_tokens: 0,
        },
      },
    });

  it('shows a percentage once the attachment names a [1m] window', () => {
    const state = {};
    claude.decodeClaudeLine(modelAttachment('claude-opus-5-5[1m]'), state);
    claude.decodeClaudeLine(assistant('a1', 249_998), state);
    expect(state.facts.usage.contextModel).toBe('claude-opus-5-5[1m]');
    expect(contextMeter(state.facts.usage)).toEqual({
      label: '25% of context',
      percent: 25,
    });
  });

  it('finds an attachment written far above the newest page', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-model-'));
    try {
      agentChat.__setDeps({
        statSync: fs.statSync,
        openSync: fs.openSync,
        readSync: fs.readSync,
        closeSync: fs.closeSync,
        readdirSync: fs.readdirSync,
        setInterval: () => 0,
        clearInterval: () => {},
      });
      const file = path.join(dir, 't.jsonl');
      const later = Array.from({ length: 300 }, (_, i) => assistant(`a${i}`, 500_000));
      fs.writeFileSync(
        file,
        [modelAttachment('claude-opus-5-5[1m]'), ...later].join('\n') + '\n'
      );
      let facts = null;
      agentChat.openChat('model', 'v', {
        transcriptPath: file,
        decodeLine: claude.decodeClaudeLine,
        factScan: { markers: claude.FACT_MARKERS, noteFacts: claude.noteFacts },
        onRows: (_rows, state) => (facts = state?.facts ?? facts),
      });
      expect(contextMeter(facts.usage).percent).toBe(50);
    } finally {
      agentChat.closeAllChats();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a raw count when the attachment names no window', () => {
    const state = {};
    claude.decodeClaudeLine(modelAttachment('claude-opus-5-5'), state);
    claude.decodeClaudeLine(assistant('a1', 100_000), state);
    expect(contextMeter(state.facts.usage)).toEqual({
      label: '100k tokens',
      percent: null,
    });
  });
});
