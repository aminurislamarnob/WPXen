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
// home directory scrubbed to /Users/example): USER_INPUT, a thinking planner
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

// test/fixtures/antigravity-typed-results: real record shapes, invented
// content — a planner response, then one typed result step per call.
const typed = fs
  .readFileSync(
    path.join(__dirname, 'fixtures', 'antigravity-typed-results.jsonl'),
    'utf8'
  )
  .split('\n')
  .filter((l) => l.trim());

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

  // Real transcripts never repeat a step_index (none of this machine's 54
  // do); each call's result is the step after it, typed or GENERIC.
  it('pairs each call with the step that follows it, typed records included', () => {
    const state = {};
    const rows = typed.flatMap((l) => [decodeAntigravityLine(l, state) ?? []].flat());
    const latest = new Map(rows.map((r) => [r.id, r]));
    const calls = [...latest.values()].filter((r) => r.role === 'tool');
    expect(calls.map((c) => c.tool_use.name)).toEqual([
      'view_file',
      'run_command',
      'multi_replace_file_content',
      'edit_file',
      'write_file',
      'grep_search',
      'list_dir',
    ]);
    expect(calls.every((c) => c.result)).toBe(true);
    const byName = Object.fromEntries(calls.map((c) => [c.tool_use.name, c]));
    expect(byName.view_file.result.content).toContain('header.php');
    expect(byName.run_command.result.content).toContain('No syntax errors');
    expect(byName.run_command.result.is_error).toBeFalsy();
    expect(byName.multi_replace_file_content.result.content).toContain('2 chunks');
    expect(byName.list_dir.result.content).toContain('notes.txt');
  });

  it('pairs a result shown unpaired once Load older brings its call in', () => {
    // The newest page starts at the result steps; its planner response is
    // on the older page, decoded later with fresh state plus the orphans.
    const newer = {};
    const orphanView = decodeAntigravityLine(typed[3], newer);
    const orphanRun = decodeAntigravityLine(typed[4], newer);
    expect(orphanView.id).toBe('agy-3-result');

    const older = decodeAntigravityLine(typed[2], { results: newer.results });
    const calls = older.filter((r) => r.role === 'tool');
    expect(calls.map((c) => c.result?.content.slice(0, 9))).toEqual([
      'File Path',
      'No syntax',
    ]);
    expect(calls[0].result.tool_use_id).toBe(calls[0].id);
    expect(older[0].remove).toEqual([orphanView.id, orphanRun.id]);
  });

  it('marks a command with a non-zero exit code as failed', () => {
    const state = {};
    decodeAntigravityLine(typed[2], state);
    const run = JSON.parse(typed[4]);
    const row = decodeAntigravityLine(JSON.stringify({ ...run, exit_code: 2 }), state);
    expect(row.result.is_error).toBe(true);
  });

  it('shows multi_replace_file_content, edit_file and write_file as diffs', () => {
    const rows = [decodeAntigravityLine(typed[5], {})].flat();
    const edit = (name) => rows.find((r) => r.tool_use?.name === name).edit;
    expect(edit('multi_replace_file_content')).toEqual({
      path: '/tmp/example-site/header.php',
      original: '<div class="hdr">\n\n</div>',
      modified: '<header class="hdr">\n\n</header>',
    });
    expect(edit('edit_file')).toEqual({
      path: '/tmp/example-site/footer.php',
      original: 'old footer',
      modified: 'new footer',
    });
    expect(edit('write_file')).toEqual({
      path: '/tmp/example-site/notes.txt',
      original: '',
      modified: 'invented notes\n',
    });
  });

  it('skips SYSTEM_MESSAGE and CHECKPOINT', () => {
    expect(decodeAntigravityLine(byStep(9).line, {})).toBeNull();
    expect(decodeAntigravityLine(byStep(85).line, {})).toBeNull();
  });

  it('shows ERROR_MESSAGE as a notice row, not as the model speaking', () => {
    const row = decodeAntigravityLine(byStep(861).line, {});
    expect(row.role).toBe('status');
    expect(row.tone).toBe('error');
    expect(row.content).toContain('API error');
    const last = decodeAntigravityLine(typed.at(-1), {});
    expect(last).toMatchObject({ role: 'status', tone: 'error' });
    expect(last.content).toContain('quota exhausted');
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

  const user = rawLines.find((l) => l.includes('"USER_INPUT"'));
  const assistant = rawLines.find(
    (l) => l.includes('"PLANNER_RESPONSE"') && l.includes('successfully implemented')
  );
  // The fixture's lines, as written by a conversation that began at `at`.
  const at = (line, ms) =>
    line.replace(/"created_at":"[^"]+"/, `"created_at":"${new Date(ms).toISOString()}"`);

  function mapFolder(convId) {
    const cacheDir = path.join(home, '.gemini', 'antigravity-cli', 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'last_conversations.json'),
      JSON.stringify({ [home]: convId })
    );
  }
  function writeConversation(convId, lines) {
    const logsDir = path.join(
      home,
      '.gemini',
      'antigravity-cli',
      'brain',
      convId,
      '.system_generated',
      'logs'
    );
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), lines.join('\n') + '\n');
  }
  const rowsFor = (sessionId) =>
    seen.filter((d) => d.sessionId === sessionId).flatMap((d) => d.rows);

  function launchAgy() {
    const res = agents.launch({
      site: { id: 'site-1', path: home },
      agentId: 'antigravity',
    });
    expect(res.ok).toBe(true);
    return res.sessionId;
  }

  it('tails user and assistant rows from the mapped transcript', () => {
    const id = launchAgy();
    const now = Date.now();
    mapFolder('conv-live');
    writeConversation('conv-live', [at(user, now + 1000), at(assistant, now + 2000)]);

    agents.openChat(id, 'viewer-1');
    const rows = rowsFor(id);
    expect(rows.some((r) => r.role === 'user')).toBe(true);
    expect(
      rows.some((r) => r.role === 'assistant' && r.content.includes('successfully'))
    ).toBe(true);
  });

  it("never binds the folder's earlier conversation; waits for the Session's own", () => {
    vi.useFakeTimers();
    try {
      const id = launchAgy();
      const now = Date.now();
      // The folder still maps to yesterday's conversation.
      mapFolder('conv-old');
      writeConversation('conv-old', [at(user, now - 86_400_000)]);
      agents.openChat(id, 'viewer-1');
      vi.advanceTimersByTime(2500);
      expect(rowsFor(id)).toHaveLength(0);

      // The Session's first prompt starts a new conversation.
      writeConversation('conv-new', [at(user, now + 1000), at(assistant, now + 2000)]);
      mapFolder('conv-new');
      vi.advanceTimersByTime(2500);
      expect(rowsFor(id).some((r) => r.role === 'assistant')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
