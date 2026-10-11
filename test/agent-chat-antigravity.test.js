import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeAntigravityLine } from '../electron/services/agentChatAntigravity.cjs';
import agents from '../electron/services/agents.cjs';
import {
  openChat as openWatch,
  closeAllChats as closeWatches,
  __setDeps as setAgentChatDeps,
} from '../electron/services/agentChat.cjs';
import {
  locateTranscript,
  __setDeps as setTranscriptDeps,
} from '../electron/services/transcripts.cjs';

// Fixture lines copied from a real Antigravity transcript.jsonl (paths
// scrubbed /Users/welabs → /Users/example): USER_INPUT, a thinking planner
// with 3 view_file calls, its 3 GENERIC results (one truncated), a RUNNING
// line, SYSTEM_MESSAGE, a replace_file_content planner, an assistant
// markdown planner, CHECKPOINT, ERROR_MESSAGE.
const fixturePath = path.join(__dirname, 'fixtures', 'antigravity-transcript.jsonl');
const rawLines = fs
  .readFileSync(fixturePath, 'utf8')
  .split('\n')
  .filter((l) => l.trim());

const records = rawLines.map((l) => ({ line: l, record: JSON.parse(l) }));
const byStep = (step) => records.find((r) => r.record.step_index === step);

describe('decodeAntigravityLine', () => {
  it('unwraps USER_REQUEST and drops the metadata', () => {
    const row = decodeAntigravityLine(byStep(0).line, {});
    expect(row.role).toBe('user');
    expect(row.content).toContain('Implement GitHub issue #101');
    expect(row.content).not.toContain('ADDITIONAL_METADATA');
    expect(row.content).not.toContain('USER_SETTINGS_CHANGE');
  });

  it('decodes planner thinking as reasoning', () => {
    const rows = decodeAntigravityLine(byStep(1).line, {});
    const reasoning = rows.filter((r) => r.role === 'reasoning');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].content).toContain('view_file');
  });

  it('double-parses tool args and emits one row per call', () => {
    const rows = decodeAntigravityLine(byStep(1).line, {});
    const tools = rows.filter((r) => r.role === 'tool');
    expect(tools).toHaveLength(3);
    expect(tools[0].tool_use.name).toBe('view_file');
    // Args arrive JSON-encoded inside JSON — parsed, not raw quoted strings.
    expect(tools[0].tool_use.input.AbsolutePath).toBe(
      '/Users/example/Sites/WPXen/AGENTS.md'
    );
  });

  it('pairs GENERIC results positionally with the planner calls', () => {
    const state = {};
    decodeAntigravityLine(byStep(1).line, state);
    const second = decodeAntigravityLine(byStep(2).line, state);
    const third = decodeAntigravityLine(byStep(3).line, state);
    const fourth = decodeAntigravityLine(byStep(4).line, state);

    expect(second.result.content).toContain('# AGENTS.md');
    expect(third.tool_use.input.AbsolutePath).toContain('CLAUDE.md');
    expect(third.result.content).toContain('# CLAUDE.md');
    expect(fourth.tool_use.input.AbsolutePath).toContain('implementing-a-ticket.md');
  });

  it('marks Antigravity-truncated results with a hint', () => {
    const state = {};
    decodeAntigravityLine(byStep(1).line, state);
    const third = decodeAntigravityLine(byStep(3).line, state);
    expect(third.result.content).toContain('truncated by Antigravity');
  });

  it('upserts a re-reported step_index in place', () => {
    const state = {};
    // Same schema as the real RUNNING line, re-reported DONE (the transcript
    // appends a second line with the same step_index when the tool finishes).
    const running = JSON.parse(byStep(6).line);
    const done = { ...running, status: 'DONE', content: `${running.content}\nFinished.` };
    const first = decodeAntigravityLine(JSON.stringify(running), state);
    const second = decodeAntigravityLine(JSON.stringify(done), state);
    expect(second.id).toBe(first.id);
    expect(second.result.content).toContain('Finished.');
  });

  it('skips SYSTEM_MESSAGE and CHECKPOINT', () => {
    expect(decodeAntigravityLine(byStep(9).line, {})).toBeNull();
    expect(decodeAntigravityLine(byStep(85).line, {})).toBeNull();
  });

  it('shows ERROR_MESSAGE as a notice row', () => {
    const row = decodeAntigravityLine(byStep(861).line, {});
    expect(row.role).toBe('assistant');
    expect(row.content).toContain('API error');
  });

  it('diffs replace_file_content from its args', () => {
    const state = {};
    const rows = decodeAntigravityLine(byStep(21).line, state);
    const replace = rows.find(
      (r) => r.role === 'tool' && r.tool_use.name === 'replace_file_content'
    );
    expect(replace).toBeDefined();
    expect(replace.edit.path).toContain('agents.cjs');
    expect(replace.edit.original).toContain('antigravity');
    expect(replace.edit.modified).toContain('promptFlag');
    expect(replace.edit.original).not.toBe(replace.edit.modified);
  });

  it("records the planner's token usage in the facts the renderer receives", () => {
    const state = {};
    decodeAntigravityLine(byStep(1).line, state);
    expect(state.facts.usage).toEqual({ model: null, tokens: 12322 + 0 + 423 });
  });

  it('never puts the raw record on a row', () => {
    const state = {};
    const rows = rawLines.flatMap((l) => [decodeAntigravityLine(l, state) ?? []].flat());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => 'record' in r)).toBe(false);
  });

  it('decodes an assistant markdown planner', () => {
    const rows = decodeAntigravityLine(byStep(48).line, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('assistant');
    expect(rows[0].content).toContain('successfully implemented');
  });

  it('ignores empty and unparsable lines', () => {
    expect(decodeAntigravityLine('', {})).toBeNull();
    expect(decodeAntigravityLine('not json', {})).toBeNull();
  });
});

describe('antigravity locator', () => {
  let home;

  const writeMap = (map) => {
    const dir = path.join(home, '.gemini', 'antigravity-cli', 'cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'last_conversations.json'), JSON.stringify(map));
  };

  const writeTranscript = (convId, lines) => {
    const file = path.join(
      home,
      '.gemini',
      'antigravity-cli',
      'brain',
      convId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join(''));
    return file;
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-agy-'));
    setTranscriptDeps({
      homedir: () => home,
      existsSync: fs.existsSync,
      readdirSync: fs.readdirSync,
      readFileSync: fs.readFileSync,
      statSync: fs.statSync,
    });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('maps the cwd through last_conversations.json', () => {
    writeMap({ '/my/cwd': 'conv-1' });
    const file = writeTranscript('conv-1', ['{"step_index":0}\n']);
    expect(locateTranscript('antigravity', '/my/cwd', 0)).toBe(file);
  });

  it('returns null when the cwd is unmapped or the file is missing', () => {
    writeMap({ '/other': 'conv-1' });
    expect(locateTranscript('antigravity', '/my/cwd', 0)).toBeNull();
    writeMap({ '/my/cwd': 'conv-missing' });
    expect(locateTranscript('antigravity', '/my/cwd', 0)).toBeNull();
  });

  it('re-locates when the map points at a new conversation', () => {
    writeMap({ '/my/cwd': 'conv-1' });
    const first = writeTranscript('conv-1', ['{"step_index":0}\n']);
    expect(locateTranscript('antigravity', '/my/cwd', 0)).toBe(first);

    writeMap({ '/my/cwd': 'conv-2' });
    const second = writeTranscript('conv-2', ['{"step_index":0}\n']);
    expect(locateTranscript('antigravity', '/my/cwd', 0)).toBe(second);
  });

  it('skips a transcript claimed by another session', () => {
    writeMap({ '/my/cwd': 'conv-1' });
    const file = writeTranscript('conv-1', ['{"step_index":0}\n']);
    expect(
      locateTranscript('antigravity', '/my/cwd', 0, null, new Set([file]))
    ).toBeNull();
  });
});

describe('antigravity chat binding (engine)', () => {
  let home;
  let seen;
  let unsub;

  function fakePty() {
    const handlers = { data: [], exit: [] };
    return {
      onData: (cb) => handlers.data.push(cb),
      onExit: (cb) => handlers.exit.push(cb),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-agy-bind-'));
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'agy'), '#!/bin/sh\ntrue\n');
    fs.chmodSync(path.join(bin, 'agy'), 0o755);
    seen = [];
    agents.__setDeps({
      spawnPty: () => fakePty(),
      shellEnv: () => ({ PATH: `${bin}:/usr/bin` }),
      userShell: () => '/bin/zsh',
      homedir: () => home,
      sitePhpBin: () => null,
    });
    unsub = agents.onChatRows((data) => seen.push(data));
  });

  afterEach(() => {
    unsub();
    agents.closeAllChats();
    agents.stopAll();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('tails user and assistant rows from the mapped transcript', () => {
    const res = agents.launch({
      site: { id: 'site-1', path: home },
      agentId: 'antigravity',
    });
    expect(res.ok).toBe(true);

    const user = rawLines.find((l) => l.includes('"USER_INPUT"'));
    const assistant = rawLines.find(
      (l) => l.includes('"PLANNER_RESPONSE"') && l.includes('successfully implemented')
    );
    const cacheDir = path.join(home, '.gemini', 'antigravity-cli', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'last_conversations.json'),
      JSON.stringify({ [home]: 'conv-live' })
    );
    const logsDir = path.join(
      home,
      '.gemini',
      'antigravity-cli',
      'brain',
      'conv-live',
      '.system_generated',
      'logs'
    );
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), `${user}\n${assistant}\n`);

    agents.openChat(res.sessionId, 'viewer-1');
    const rows = seen.filter((d) => d.sessionId === res.sessionId).flatMap((d) => d.rows);
    expect(rows.some((r) => r.role === 'user')).toBe(true);
    expect(
      rows.some((r) => r.role === 'assistant' && r.content.includes('successfully'))
    ).toBe(true);
  });
});

describe('relocate notice', () => {
  it('emits transcript-changed when the mapped conversation moves', () => {
    vi.useFakeTimers();
    try {
      let current = '/fake/a.jsonl';
      setAgentChatDeps({
        statSync: () => ({ size: 0, mtimeMs: 100 }),
        openSync: () => 1,
        readSync: () => 0,
        closeSync: () => {},
        readdirSync: () => [],
        setInterval,
        clearInterval,
      });
      const rows = [];
      openWatch('sess-relocate', 'viewer-1', {
        transcriptPath: '/fake/a.jsonl',
        decodeLine: () => null,
        relocate: () => current,
        onRows: (newRows) => rows.push(...newRows),
      });
      vi.advanceTimersByTime(500);
      expect(rows).not.toContainEqual({ notice: true, kind: 'transcript-changed' });

      current = '/fake/b.jsonl';
      vi.advanceTimersByTime(500);
      expect(rows).toContainEqual({ notice: true, kind: 'transcript-changed' });
    } finally {
      closeWatches();
      // Restore the real fs seam for any later consumers in this file.
      setAgentChatDeps({
        statSync: fs.statSync,
        openSync: fs.openSync,
        readSync: fs.readSync,
        closeSync: fs.closeSync,
        readdirSync: fs.readdirSync,
      });
      vi.useRealTimers();
    }
  });
});
