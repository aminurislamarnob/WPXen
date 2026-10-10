import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeCodexLine } from '../electron/services/agentChatCodex.cjs';
import agents from '../electron/services/agents.cjs';
import {
  locateTranscript,
  __setDeps as setTranscriptDeps,
} from '../electron/services/transcripts.cjs';

// Fixture lines copied verbatim from a real Codex rollout
// (~/.codex/sessions/2026/10/09/rollout-2026-10-09T00-08-53-*.jsonl):
// task_started, developer, environment_context user, external-page user,
// real user, assistant, exec call + output, token_count, empty reasoning,
// second exec call + output, task_complete.
const fixturePath = path.join(__dirname, 'fixtures', 'codex-rollout.jsonl');
const rawLines = fs
  .readFileSync(fixturePath, 'utf8')
  .split('\n')
  .filter((l) => l.trim());

const byKind = {};
for (const line of rawLines) {
  const record = JSON.parse(line);
  const payload = record.payload || {};
  const key = `${record.type}/${payload.type || ''}/${payload.role || payload.name || ''}`;
  (byKind[key] = byKind[key] || []).push(line);
}

const first = (key) => byKind[key][0];

describe('decodeCodexLine', () => {
  it('skips developer messages', () => {
    expect(decodeCodexLine(first('response_item/message/developer'), {})).toBeNull();
  });

  it('skips injected user context', () => {
    const state = {};
    const users = byKind['response_item/message/user'];
    expect(users.length).toBe(3);
    expect(decodeCodexLine(users[0], state)).toBeNull(); // <environment_context>
    expect(decodeCodexLine(users[1], state)).toBeNull(); // <external_…>
  });

  it('decodes the real user message', () => {
    const row = decodeCodexLine(byKind['response_item/message/user'][2], {});
    expect(row.role).toBe('user');
    expect(row.content).toContain('My request:');
    expect(row.content).toContain('Transcript this video.');
  });

  it('decodes the assistant message', () => {
    const row = decodeCodexLine(first('response_item/message/assistant'), {});
    expect(row.role).toBe('assistant');
    expect(row.id).toBeTruthy();
    expect(row.content).toContain('transcribe the spoken audio');
  });

  it('pairs a custom tool call with its output by call_id', () => {
    const state = {};
    const callRow = decodeCodexLine(first('response_item/custom_tool_call/exec'), state);
    expect(callRow.role).toBe('tool');
    expect(callRow.tool_use.name).toBe('exec');
    expect(callRow.result).toBeUndefined();

    const outRow = decodeCodexLine(
      first('response_item/custom_tool_call_output/'),
      state
    );
    expect(outRow.id).toBe(callRow.id);
    expect(outRow.tool_use.name).toBe('exec');
    expect(JSON.stringify(outRow.result)).toContain('Script completed');
  });

  it('holds an early output as an orphan until the call arrives', () => {
    const state = {};
    const outLine = byKind['response_item/custom_tool_call_output/'][1];
    const callLine = byKind['response_item/custom_tool_call/exec'][1];
    const orphan = decodeCodexLine(outLine, state);
    expect(orphan.orphan).toBe(true);

    const callRow = decodeCodexLine(callLine, state);
    expect(callRow.result).toBeDefined();
    expect(callRow.remove).toContain(orphan.id);
  });

  it('skips reasoning with no readable summary', () => {
    expect(decodeCodexLine(first('response_item/reasoning/'), {})).toBeNull();
  });

  it('decodes reasoning text when the summary carries it', () => {
    // Same schema as the real records, with a readable summary (the observed
    // rollouts keep summaries encrypted, per Orca's summary-text fallback).
    const line = JSON.stringify({
      timestamp: '2026-10-09T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'reasoning',
        id: 'rs_test',
        summary: [{ text: 'Considering the approach.' }],
        encrypted_content: null,
      },
    });
    const row = decodeCodexLine(line, {});
    expect(row.role).toBe('reasoning');
    expect(row.content).toContain('Considering the approach.');
  });

  it('records the current context, not the session total, against the real window', () => {
    const state = {};
    expect(decodeCodexLine(first('event_msg/token_count/'), state)).toBeNull();
    expect(state.facts.usage).toEqual({ model: null, tokens: 25813, limit: 258400 });

    // A later turn: total_token_usage is cumulative across the session,
    // last_token_usage is what the latest request actually carried.
    decodeCodexLine(
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 221273,
              output_tokens: 1068,
              total_tokens: 222341,
            },
            last_token_usage: {
              input_tokens: 29657,
              output_tokens: 85,
              total_tokens: 29742,
            },
            model_context_window: 258400,
          },
        },
      }),
      state
    );
    expect(state.facts.usage.tokens).toBe(29742);
  });

  it('never puts the raw record on a row', () => {
    const state = {};
    const rows = rawLines.flatMap((l) => [decodeCodexLine(l, state) ?? []].flat());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => 'record' in r)).toBe(false);
  });

  it('ignores lifecycle and bookkeeping records', () => {
    const state = {};
    expect(decodeCodexLine(first('event_msg/task_started/'), state)).toBeNull();
    expect(decodeCodexLine(first('event_msg/task_complete/'), state)).toBeNull();
    expect(decodeCodexLine('not json at all', state)).toBeNull();
    expect(decodeCodexLine('', state)).toBeNull();
  });
});

describe('codex chat binding (engine)', () => {
  let home;
  let bin;
  let ptys;
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
      emitData: (d) => handlers.data.forEach((cb) => cb(d)),
    };
  }

  function launchCodex() {
    const res = agents.launch({ site: { id: 'site-1', path: home }, agentId: 'codex' });
    expect(res.ok).toBe(true);
    ptys[ptys.length - 1].emitData('% ');
    vi.advanceTimersByTime(500);
    return res.sessionId;
  }

  function writeRollout(name, lines) {
    const now = new Date();
    const dir = path.join(
      home,
      '.codex',
      'sessions',
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    );
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    const meta = JSON.stringify({ type: 'session_meta', payload: { cwd: home } }) + '\n';
    // Fixture lines carry no terminators (split on \n at load) — rejoin them.
    fs.writeFileSync(file, meta + lines.join('\n') + '\n');
    // Fake timers freeze Date.now while the fs clock runs real: pin mtimes
    // ahead so recency checks see the rollout as newer than the launch.
    const t = new Date(Date.now() + 60_000);
    fs.utimesSync(file, t, t);
    return file;
  }

  const fixtureUser = rawLines.find(
    (l) => l.includes('"role":"user"') && l.includes('My request:')
  );
  const fixtureAssistant = rawLines.find((l) => l.includes('"role":"assistant"'));
  // Synthesized in the observed schema: a second session's first message.
  const secondUser =
    JSON.stringify({
      timestamp: '2026-10-10T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'msg_second',
        role: 'user',
        content: [{ type: 'input_text', text: 'Second session hello' }],
      },
    }) + '\n';

  const rowsFor = (sessionId) =>
    seen.filter((d) => d.sessionId === sessionId).flatMap((d) => d.rows);

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-codex-bind-'));
    bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\ntrue\n');
    fs.chmodSync(path.join(bin, 'codex'), 0o755);
    ptys = [];
    seen = [];
    agents.__setDeps({
      spawnPty: () => {
        const p = fakePty();
        ptys.push(p);
        return p;
      },
      shellEnv: () => ({ PATH: `${bin}:/usr/bin` }),
      userShell: () => '/bin/zsh',
      homedir: () => home,
      sitePhpBin: () => null,
    });
    setTranscriptDeps({
      homedir: () => home,
      existsSync: fs.existsSync,
      readdirSync: fs.readdirSync,
      readFileSync: fs.readFileSync,
      statSync: fs.statSync,
    });
    unsub = agents.onChatRows((data) => seen.push(data));
  });

  afterEach(() => {
    unsub();
    agents.closeAllChats();
    agents.stopAll();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('binds the newest rollout and tails real rows', () => {
    vi.useFakeTimers();
    try {
      const id = launchCodex();
      writeRollout('rollout-a.jsonl', [fixtureUser, fixtureAssistant]);
      agents.openChat(id, 'viewer-1');

      const rows = rowsFor(id);
      expect(
        rows.some((r) => r.role === 'user' && r.content.includes('My request:'))
      ).toBe(true);
      expect(
        rows.some((r) => r.role === 'assistant' && r.content.includes('transcribe'))
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second session in the same cwd waits for its own rollout', () => {
    vi.useFakeTimers();
    try {
      const firstId = launchCodex();
      writeRollout('rollout-a.jsonl', [fixtureUser]);
      agents.openChat(firstId, 'viewer-1');
      expect(rowsFor(firstId).length).toBeGreaterThan(0);

      const secondId = launchCodex();
      agents.openChat(secondId, 'viewer-2');
      // Rollout A is claimed by the first session — nothing bound yet.
      expect(rowsFor(secondId)).toHaveLength(0);

      writeRollout('rollout-b.jsonl', [secondUser]);
      vi.advanceTimersByTime(2500);

      const secondRows = rowsFor(secondId);
      expect(
        secondRows.some(
          (r) => r.role === 'user' && r.content.includes('Second session hello')
        )
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('codex locator selection', () => {
  let home;

  const dayDir = () => {
    const now = new Date();
    return path.join(
      home,
      '.codex',
      'sessions',
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    );
  };

  const writeRollout = (dir, name, cwd, mtimeMs) => {
    const file = path.join(dir, name);
    fs.writeFileSync(
      file,
      JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n'
    );
    const t = new Date(mtimeMs);
    fs.utimesSync(file, t, t);
    return file;
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpxen-codex-'));
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

  it('chooses the newest rollout for the cwd after the session started', () => {
    const dir = dayDir();
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    writeRollout(dir, 'rollout-a.jsonl', '/other/cwd', now - 1000);
    writeRollout(dir, 'rollout-b.jsonl', '/my/cwd', now - 5000);
    const newest = writeRollout(dir, 'rollout-c.jsonl', '/my/cwd', now - 1000);

    expect(locateTranscript('codex', '/my/cwd', now - 8000)).toBe(newest);
  });

  it('skips rollouts claimed by another session', () => {
    const dir = dayDir();
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const claimed = writeRollout(dir, 'rollout-a.jsonl', '/my/cwd', now - 1000);
    const free = writeRollout(dir, 'rollout-b.jsonl', '/my/cwd', now - 2000);

    expect(
      locateTranscript('codex', '/my/cwd', now - 8000, null, new Set([claimed]))
    ).toBe(free);
  });
});
