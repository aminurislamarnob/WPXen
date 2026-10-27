import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agentChat from '../electron/services/agentChat.cjs';
import claude from '../electron/services/agentChatClaude.cjs';
import codex from '../electron/services/agentChatCodex.cjs';
import antigravity from '../electron/services/agentChatAntigravity.cjs';
import { partitionChatRows, prependOlder, upsertRows } from '../src/lib/chatRows';

// Opt-in: runs every decoder through the real watch engine (first page, then
// Load older to the top) over the transcripts on this machine, and checks
// invariants rather than snapshots. Fixtures copy record shapes someone
// observed once; this catches the shapes drifting since.
//
//   WPXEN_REAL_TRANSCRIPTS=1 npx vitest run test/real-transcripts.test.js
//
// It reads ~/.claude/projects, ~/.codex/sessions and
// ~/.gemini/antigravity-cli/brain read-only and prints counts only — never a
// row's content or a file path.
const enabled = process.env.WPXEN_REAL_TRANSCRIPTS === '1';
const home = os.homedir();

// Calls left without a result once every page is loaded: interrupted turns
// and a still-running last call account for a few; a decoder that can't pair
// a record shape shows up as far more.
const MAX_UNPAIRED_SHARE = 0.05;
// Results still waiting for their call after the whole file is loaded.
const MAX_ORPHAN_SHARE = 0.01;
// Consecutive empty Load older pages before a file counts as stalled.
const STALL_PAGES = 50;

function walk(dir, keep, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, keep, out);
    else if (keep(full)) out.push(full);
  }
  return out;
}

const AGENTS = {
  claude: {
    decoder: claude,
    decodeLine: claude.decodeClaudeLine,
    files: () =>
      walk(path.join(home, '.claude', 'projects'), (f) => f.endsWith('.jsonl')),
  },
  codex: {
    decoder: codex,
    decodeLine: codex.decodeCodexLine,
    files: () =>
      walk(path.join(home, '.codex', 'sessions'), (f) =>
        /rollout-.*\.jsonl$/.test(path.basename(f))
      ),
  },
  antigravity: {
    decoder: antigravity,
    decodeLine: antigravity.decodeAntigravityLine,
    files: () =>
      walk(
        path.join(home, '.gemini', 'antigravity-cli', 'brain'),
        (f) => path.basename(f) === 'transcript.jsonl'
      ),
  },
};

const TOOL_RESULT_CAP = agentChat.TRUNCATE_THRESHOLD;

function resultsOf(row) {
  const out = [];
  if (row.result) out.push(row.result);
  if (row.tool_use?.result) out.push(row.tool_use.result);
  for (const b of row.blocks || []) if (b?.type === 'tool_result') out.push(b);
  return out;
}

// Every row that would cross IPC, checked as it is pushed.
function checkPushed(row, counts) {
  counts.pushed++;
  if (!row.id) counts.missingId++;
  const bytes = JSON.stringify(row).length;
  if (bytes > counts.maxRowBytes) counts.maxRowBytes = bytes;
  for (const r of resultsOf(row)) {
    if (typeof r.content === 'string' && r.content.length > TOOL_RESULT_CAP)
      counts.overCap++;
  }
  if (row.role === 'user' && !row.orphan && resultsOf(row).length > 0)
    counts.resultAsUser++;
}

function readWhole(agent, file, n) {
  const sessionId = `real-${n}`;
  let list = [];
  const counts = {
    pushed: 0,
    missingId: 0,
    overCap: 0,
    resultAsUser: 0,
    maxRowBytes: 0,
    stalled: 0,
  };
  // What agents.cjs forwards: a title record becomes the header, never a row.
  const visible = (rows) => (rows || []).filter((r) => r && !r.isHeader);
  const apply = (rows) => {
    const { reset, top } = partitionChatRows(visible(rows));
    for (const r of top) checkPushed(r, counts);
    list = upsertRows(reset ? [] : list, top);
  };
  agentChat.openChat(sessionId, 'viewer', {
    transcriptPath: file,
    decodeLine: agent.decodeLine,
    findToolResult: agent.decoder.findToolResult,
    onRows: (rows) => apply(rows),
  });
  // A page with no rows is fine (bookkeeping records); a long run of them
  // means Load older stopped moving — the reader would click forever.
  let empty = 0;
  for (;;) {
    const page = agentChat.loadOlder(sessionId);
    const { top } = partitionChatRows(visible(page.rows));
    for (const r of top) checkPushed(r, counts);
    list = prependOlder(list, top);
    if (page.atStart) break;
    empty = page.rows?.length ? 0 : empty + 1;
    if (empty >= STALL_PAGES) {
      counts.stalled = 1;
      break;
    }
  }
  agentChat.closeChat(sessionId, 'viewer');
  return { list, counts };
}

describe.skipIf(!enabled)('real transcripts on this machine', () => {
  beforeAll(() => {
    // No poll: each file is read once, first page then every older page.
    agentChat.__setDeps({ setInterval: () => 0, clearInterval: () => {} });
  });
  afterAll(() => {
    agentChat.closeAllChats();
    agentChat.__setDeps({ setInterval, clearInterval });
  });

  for (const [name, agent] of Object.entries(AGENTS)) {
    it(`${name}: every row has a unique id, results pair, nothing over the cap`, () => {
      const files = agent.files();
      const total = {
        files: files.length,
        unreadable: 0,
        rows: 0,
        tools: 0,
        unpaired: 0,
        orphans: 0,
        duplicateIds: 0,
        tooLarge: 0,
        pushed: 0,
        missingId: 0,
        overCap: 0,
        resultAsUser: 0,
        maxRowBytes: 0,
        stalled: 0,
      };
      files.forEach((file, i) => {
        let result;
        try {
          result = readWhole(agent, file, i);
        } catch {
          total.unreadable++;
          return;
        }
        const { list, counts } = result;
        total.rows += list.length;
        const ids = new Set();
        for (const row of list) {
          if (ids.has(row.id)) total.duplicateIds++;
          ids.add(row.id);
          if (row.role === 'tool') {
            total.tools++;
            if (!row.result) total.unpaired++;
          }
          if (row.orphan) total.orphans++;
          if (row.tooLarge) total.tooLarge++;
        }
        for (const k of ['pushed', 'missingId', 'overCap', 'resultAsUser', 'stalled'])
          total[k] += counts[k];
        total.maxRowBytes = Math.max(total.maxRowBytes, counts.maxRowBytes);
      });
      // Counts only: no content, no paths.
      console.log(`[real-transcripts] ${name}`, JSON.stringify(total));

      if (files.length === 0) return;
      expect(total.rows).toBeGreaterThan(0);
      expect(total.missingId).toBe(0);
      expect(total.duplicateIds).toBe(0);
      expect(total.resultAsUser).toBe(0);
      expect(total.overCap).toBe(0);
      expect(total.stalled).toBe(0);
      if (total.tools > 0) {
        expect(total.unpaired / total.tools).toBeLessThan(MAX_UNPAIRED_SHARE);
        expect(total.orphans / total.tools).toBeLessThan(MAX_ORPHAN_SHARE);
      }
    }, 600_000);
  }
});
