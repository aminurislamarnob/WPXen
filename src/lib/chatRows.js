// Tool name -> summary kind. Claude Code's names, then Antigravity's and
// Codex's.
const TOOL_KINDS = {
  Read: 'read',
  NotebookRead: 'read',
  Bash: 'bash',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  Glob: 'search',
  read_file: 'read',
  view_file: 'read',
  bash: 'bash',
  run_command: 'bash',
  // Codex
  shell: 'bash',
  local_shell: 'bash',
  exec_command: 'bash',
  apply_patch: 'edit',
  replace: 'edit',
  replace_file_content: 'edit',
  write_to_file: 'edit',
  multi_replace_file_content: 'edit',
  edit_file: 'edit',
  write_file: 'edit',
  multi_edit: 'edit',
  grep_search: 'search',
  glob: 'search',
};

// [kind, singular, plural] in summary order; '#' is the count.
const SUMMARY_PARTS = [
  ['read', 'Read # file', 'Read # files'],
  ['bash', 'Ran # command', 'Ran # commands'],
  ['edit', 'Edited # file', 'Edited # files'],
  ['search', 'Searched # time', 'Searched # times'],
  ['other', 'Used # tool', 'Used # tools'],
];

const isToolRow = (row) =>
  row.role === 'tool' ||
  row.role === 'tool_result' ||
  (row.role === 'user' && row.orphan);

// Consecutive tool calls fold into one run. Thinking between two calls
// stays inside the run (shown in order when it opens) rather than splitting
// it in two; thinking after the last call, before the answer, stays out.
export function foldToolRuns(rows) {
  const folded = [];
  let currentRun = null;
  let heldReasoning = [];
  const release = () => {
    folded.push(...heldReasoning);
    heldReasoning = [];
  };

  for (const row of rows) {
    if (row.parentId) continue; // Nested rows are handled separately

    if (isToolRow(row)) {
      if (!currentRun) {
        release();
        currentRun = {
          id: `run-${row.id}`,
          role: 'tool-run',
          items: [],
          summary: '',
          success: true,
        };
        folded.push(currentRun);
      }
      currentRun.items.push(...heldReasoning, row);
      heldReasoning = [];
    } else if (row.role === 'reasoning' && currentRun) {
      heldReasoning.push(row);
    } else {
      release();
      currentRun = null;
      folded.push(row);
    }
  }
  release();

  for (const run of folded) {
    if (run.role === 'tool-run') {
      const nameCounts = {};

      for (const item of run.items) {
        if (item.tool_use && item.tool_use.name) {
          nameCounts[item.tool_use.name] = (nameCounts[item.tool_use.name] || 0) + 1;
        }
      }

      const counts = { read: 0, bash: 0, edit: 0, search: 0, other: 0 };
      for (const [name, n] of Object.entries(nameCounts)) {
        counts[TOOL_KINDS[name] || 'other'] += n;
      }

      // One sentence: "Read 3 files, ran 2 commands".
      const parts = [];
      for (const [kind, one, many] of SUMMARY_PARTS) {
        const n = counts[kind];
        if (n === 0) continue;
        const part = (n === 1 ? one : many).replace('#', n);
        parts.push(parts.length ? part[0].toLowerCase() + part.slice(1) : part);
      }

      if (parts.length === 0) {
        run.summary = 'Tool interactions';
      } else {
        run.summary = parts.join(', ');
      }

      run.success = !run.items.some(
        (item) => item.result && (item.result.is_error || item.result.isError)
      );
    }
  }

  return folded;
}

// A subagent's state from its parent Agent / Task call: the main process
// works it out (a background subagent's call returns at once and settles
// from a later notification) and sends it as `subagent.status` — running,
// done, failed, stopped, or null when nothing says. Without one: running
// until the call has its result, then done or failed from that result.
function subagentStatus(item) {
  const meta = item.subagent || {};
  if ('status' in meta) return meta.status ?? null;
  return !item.result ? 'running' : item.result.is_error ? 'failed' : 'done';
}

// What a subagent row's header shows.
export function subagentSummary(item) {
  const meta = item.subagent || {};
  const n = item.subagentCount;
  return {
    status: subagentStatus(item),
    type: meta.type || item.tool_use?.input?.subagent_type || 'Subagent',
    description: meta.description || item.tool_use?.input?.description || 'Task',
    count: n ? `${n} tool call${n === 1 ? '' : 's'}` : null,
  };
}

// A folded tool run opens by default while it holds something live: an
// unanswered question card, or a subagent still running. Collapsed, they'd
// sit behind a "Used 1 tool" summary.
export function runNeedsAttention(run) {
  return run.items.some(
    (item) =>
      (!item.result && item.tool_use?.name === 'AskUserQuestion') ||
      (!!item.subagent && subagentStatus(item) === 'running')
  );
}

// "Waiting in terminal": the TUI wants input the transcript can't show.
// Suppressed only while the latest row is an open question card the chat can
// answer itself — an older open question, or one this Agent has no card for
// (`cards`: its registry entry defines no key map), doesn't count.
export function shouldShowWaitingFallback(status, foldedMessages, { cards = true } = {}) {
  if (status !== 'needs-input') return false;
  const last = foldedMessages[foldedMessages.length - 1];
  const lastRow = last?.role === 'tool-run' ? last.items[last.items.length - 1] : last;
  const openCard =
    cards && lastRow?.tool_use?.name === 'AskUserQuestion' && !lastRow.result;
  return !openCard;
}

// ── Tool rows ─────────────────────────────────────────────────────────────
// MCP tools are named `mcp__<server>__<tool>`; the chat shows `server · tool`.
export function toolLabel(name) {
  const text = String(name || 'tool');
  const mcp = /^mcp__(.+?)__(.+)$/.exec(text);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : text;
}

const TARGET_MAX = 160;

// What a call acted on: the file, command, pattern or URL from its input —
// Claude Code's keys first, then Antigravity's and Codex's. Codex passes its
// arguments as a JSON string, decoded here only to read the target.
export function toolTarget(toolUse) {
  let input = toolUse?.input;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!input || typeof input !== 'object') return null;
  const keys = [
    'file_path',
    'notebook_path',
    'command',
    'cmd',
    'pattern',
    'url',
    'AbsolutePath',
    'TargetFile',
    'CommandLine',
    'path',
  ];
  for (const key of keys) {
    let value = input[key];
    if (Array.isArray(value))
      value = value.filter((v) => typeof v === 'string').join(' ');
    if (typeof value === 'string' && value.trim()) {
      const line = value.trim().split('\n')[0];
      return line.length > TARGET_MAX ? `${line.slice(0, TARGET_MAX)}…` : line;
    }
  }
  return null;
}

// "Thought for 12s" once Claude's timing says how long; plain "Thought"
// for redacted or untimed reasoning.
export function reasoningLabel(row) {
  const ms = row?.durationMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'Thought';
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `Thought for ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `Thought for ${minutes}m${rest ? ` ${rest}s` : ''}`;
}

// ── Applying pushes ───────────────────────────────────────────────────────
// One `agent-chat-rows` push, split into what it does: reset the list, flag
// a stale transcript, change top-level rows, change a subagent's nested rows.
export function partitionChatRows(rows) {
  const out = { reset: false, stale: false, top: [], nested: {} };
  for (const row of rows || []) {
    if (!row) continue;
    if (row.parentId) {
      (out.nested[row.parentId] = out.nested[row.parentId] || []).push(row);
      continue;
    }
    if (row.reset) {
      out.reset = true;
      out.top = [];
      out.stale = false;
      continue;
    }
    if (row.notice) {
      if (row.kind === 'transcript-changed') out.stale = true;
      continue;
    }
    out.top.push(row);
  }
  return out;
}

// Upsert rows by id, honouring each row's `remove` list (an orphan result its
// call has now claimed). Returns the same array when nothing changed.
export function upsertRows(list, rows) {
  let next = list;
  const copy = () => {
    if (next === list) next = [...list];
  };
  for (const row of rows) {
    if (row.remove?.length) {
      const before = next.length;
      const kept = next.filter((m) => !row.remove.includes(m.id));
      if (kept.length !== before) next = kept;
    }
    if (!row.id) continue;
    const idx = next.findIndex((m) => m.id === row.id);
    copy();
    if (idx >= 0) next[idx] = row;
    else next.push(row);
  }
  return next;
}

// An older page goes in front. A row already on screen keeps its newer copy,
// and a call that arrives with its orphan result's id removes that orphan.
// The page itself can hold one row twice — a call, then the call again once
// its result lands — so it is collapsed the way a live push is: the later
// copy replaces the earlier one in place.
export function prependOlder(list, older) {
  const seen = new Set(list.map((m) => m.id));
  const fresh = upsertRows([], older).filter((r) => !seen.has(r.id));
  const removed = new Set(older.flatMap((r) => r.remove || []));
  const rest = removed.size ? list.filter((m) => !removed.has(m.id)) : list;
  return fresh.length || rest !== list ? [...fresh, ...rest] : list;
}
