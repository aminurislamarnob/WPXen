import { describe, it, expect } from 'vitest';
import {
  foldToolRuns,
  subagentSummary,
  runNeedsAttention,
  toolLabel,
  toolTarget,
  reasoningLabel,
  partitionChatRows,
  upsertRows,
  prependOlder,
} from '../src/lib/chatRows.js';

describe('foldToolRuns', () => {
  it('groups consecutive tool rows', () => {
    const rows = [
      { id: '1', role: 'user' },
      { id: '2', role: 'tool', tool_use: { name: 'replace' } },
      { id: '3', role: 'tool_result' },
      { id: '4', role: 'assistant' },
    ];

    const folded = foldToolRuns(rows);
    expect(folded.length).toBe(3);
    expect(folded[0].role).toBe('user');
    expect(folded[1].role).toBe('tool-run');
    expect(folded[1].items.length).toBe(2);
    expect(folded[2].role).toBe('assistant');
  });

  it('keeps thinking between two calls inside the run, in order', () => {
    const rows = [
      { id: 't1', role: 'tool', tool_use: { name: 'Read' } },
      { id: 'r1', role: 'reasoning', content: 'next, the test' },
      { id: 't2', role: 'tool', tool_use: { name: 'Bash' } },
      { id: 'r2', role: 'reasoning', content: 'all green' },
      { id: 'a1', role: 'assistant', content: 'Done.' },
    ];
    const folded = foldToolRuns(rows);
    expect(folded.map((r) => r.role)).toEqual(['tool-run', 'reasoning', 'assistant']);
    expect(folded[0].items.map((r) => r.id)).toEqual(['t1', 'r1', 't2']);
    expect(folded[0].summary).toBe('Read 1 file, ran 1 command');
    expect(folded[1].id).toBe('r2');
  });

  it('generates summary for tool runs', () => {
    const rows = [
      { id: '1', role: 'tool', tool_use: { name: 'read_file' } },
      { id: '2', role: 'tool', tool_use: { name: 'read_file' } },
    ];
    expect(foldToolRuns(rows)[0].summary).toBe('Read 2 files');

    const mixed = [
      { id: '1', role: 'tool', tool_use: { name: 'read_file' } },
      { id: '2', role: 'tool', tool_use: { name: 'run_command' } },
    ];
    expect(foldToolRuns(mixed)[0].summary).toBe('Read 1 file, ran 1 command');

    const editSearch = [
      { id: '1', role: 'tool', tool_use: { name: 'replace' } },
      { id: '2', role: 'tool', tool_use: { name: 'grep_search' } },
    ];
    expect(foldToolRuns(editSearch)[0].summary).toBe('Edited 1 file, searched 1 time');
  });

  it("summarises Claude Code's tool names", () => {
    const tool = (name) => ({
      id: name + Math.random(),
      role: 'tool',
      tool_use: { name },
    });
    const run = ['Read', 'Read', 'Bash', 'Edit', 'Write', 'MultiEdit', 'Grep', 'Glob'];
    expect(foldToolRuns(run.map(tool))[0].summary).toBe(
      'Read 2 files, ran 1 command, edited 3 files, searched 2 times'
    );
    expect(foldToolRuns([tool('WebFetch')])[0].summary).toBe('Used 1 tool');
  });

  it('handles empty tools gracefully', () => {
    const rows = [{ id: '1', role: 'tool' }];
    expect(foldToolRuns(rows)[0].summary).toBe('Tool interactions');
  });
});

describe('subagentSummary', () => {
  const call = (extra) => ({
    role: 'tool',
    tool_use: { id: 't1', name: 'Agent', input: { description: 'From input' } },
    subagent: { agentId: 'a', type: 'Explore', description: 'Find routes' },
    ...extra,
  });

  it('is running until the parent call has a result', () => {
    expect(subagentSummary(call())).toMatchObject({
      status: 'running',
      type: 'Explore',
      description: 'Find routes',
      count: null,
    });
  });

  it('is done or failed from the result, and counts tool calls', () => {
    expect(
      subagentSummary(call({ result: { is_error: false }, subagentCount: 12 }))
    ).toMatchObject({
      status: 'done',
      count: '12 tool calls',
    });
    expect(
      subagentSummary(call({ result: { is_error: true }, subagentCount: 1 }))
    ).toMatchObject({
      status: 'failed',
      count: '1 tool call',
    });
  });

  it('takes the main process status for a background subagent', () => {
    // A background Agent call has its `async_launched` result at once.
    const launched = { content: 'Async agent launched', meta: { asyncLaunched: true } };
    const running = call({
      result: launched,
      subagent: { agentId: 'a', status: 'running' },
    });
    expect(subagentSummary(running).status).toBe('running');
    expect(
      subagentSummary(
        call({ result: launched, subagent: { agentId: 'a', status: null } })
      ).status
    ).toBeNull();
    expect(runNeedsAttention({ role: 'tool-run', items: [running] })).toBe(true);
  });

  it("falls back to the call's own input for the description", () => {
    expect(subagentSummary(call({ subagent: { agentId: 'a' } })).description).toBe(
      'From input'
    );
  });
});

describe('runNeedsAttention', () => {
  const run = (...items) => ({ role: 'tool-run', items });
  const ask = (result) => ({
    role: 'tool',
    tool_use: { name: 'AskUserQuestion' },
    result,
  });
  const agent = (result) => ({
    role: 'tool',
    tool_use: { name: 'Agent' },
    subagent: { agentId: 'a' },
    result,
  });

  it('opens a run holding an unanswered question', () => {
    expect(
      runNeedsAttention(run({ role: 'tool', tool_use: { name: 'Read' } }, ask()))
    ).toBe(true);
    expect(runNeedsAttention(run(ask({ answers: {} })))).toBe(false);
  });

  it('opens a run holding a running subagent', () => {
    expect(runNeedsAttention(run(agent()))).toBe(true);
    expect(runNeedsAttention(run(agent({ content: 'done' })))).toBe(false);
  });

  it('leaves ordinary runs collapsed', () => {
    expect(runNeedsAttention(run({ role: 'tool', tool_use: { name: 'Bash' } }))).toBe(
      false
    );
  });
});

describe('tool rows', () => {
  it('shows MCP tools as server · tool', () => {
    expect(toolLabel('mcp__github__create_issue')).toBe('github · create_issue');
    expect(toolLabel('Read')).toBe('Read');
  });

  it("takes the target from the call's input", () => {
    expect(toolTarget({ name: 'Read', input: { file_path: '/site/a.php' } })).toBe(
      '/site/a.php'
    );
    expect(
      toolTarget({ name: 'Bash', input: { command: 'npm test\nnpm run lint' } })
    ).toBe('npm test');
    expect(toolTarget({ name: 'Grep', input: { pattern: 'add_action' } })).toBe(
      'add_action'
    );
    expect(toolTarget({ name: 'WebFetch', input: { url: 'https://x.test' } })).toBe(
      'https://x.test'
    );
    // Codex sends its arguments as a JSON string; Antigravity names keys its way.
    expect(
      toolTarget({ name: 'shell', input: JSON.stringify({ command: ['ls', '-la'] }) })
    ).toBe('ls -la');
    expect(toolTarget({ name: 'view_file', input: { AbsolutePath: '/s/b.js' } })).toBe(
      '/s/b.js'
    );
    expect(toolTarget({ name: 'TaskList', input: {} })).toBeNull();
  });
});

describe('reasoningLabel', () => {
  it('says how long the thought took when Claude timed it', () => {
    expect(reasoningLabel({ durationMs: 3200 })).toBe('Thought for 3s');
    expect(reasoningLabel({ durationMs: 200 })).toBe('Thought for 1s');
    expect(reasoningLabel({ durationMs: 95_000 })).toBe('Thought for 1m 35s');
    expect(reasoningLabel({ durationMs: null })).toBe('Thought');
  });
});

describe('applying pushes', () => {
  it('splits nested rows, resets and the stale notice out of a push', () => {
    const parts = partitionChatRows([
      { id: 'a', role: 'assistant' },
      { id: 'n1', role: 'assistant', parentId: 'toolu_A' },
      { notice: true, kind: 'transcript-changed' },
    ]);
    expect(parts.top.map((r) => r.id)).toEqual(['a']);
    expect(parts.nested.toolu_A.map((r) => r.id)).toEqual(['n1']);
    expect(parts.stale).toBe(true);
    expect(partitionChatRows([{ id: 'x' }, { reset: true }, { id: 'y' }])).toMatchObject({
      reset: true,
      top: [{ id: 'y' }],
    });
  });

  it('upserts by id and drops orphans a call has claimed', () => {
    const list = [
      { id: 'orphan-1', orphan: true },
      { id: 'u', role: 'user' },
    ];
    const next = upsertRows(list, [{ id: 'call-1', role: 'tool', remove: ['orphan-1'] }]);
    expect(next.map((r) => r.id)).toEqual(['u', 'call-1']);
    expect(upsertRows(next, [])).toBe(next);
  });

  it('prepends an older page without duplicating rows already shown', () => {
    const list = [
      { id: 'b', v: 'new' },
      { id: 'orphan-c', orphan: true },
    ];
    const next = prependOlder(list, [
      { id: 'a' },
      { id: 'b', v: 'old' },
      { id: 'c', remove: ['orphan-c'] },
    ]);
    expect(next).toEqual([
      { id: 'a' },
      { id: 'c', remove: ['orphan-c'] },
      { id: 'b', v: 'new' },
    ]);
  });

  it('keeps one copy of a row an older page carries twice, the later one', () => {
    // A Claude call row, then the same call re-emitted once its result is
    // decoded — both inside one Load older page.
    const next = prependOlder(
      [{ id: 'z' }],
      [
        { id: 'call-1', role: 'tool', tool_use: { id: 'call-1' } },
        { id: 'text-1', role: 'assistant' },
        {
          id: 'call-1',
          role: 'tool',
          tool_use: { id: 'call-1' },
          result: { content: 'ok' },
        },
      ]
    );
    expect(next.map((r) => r.id)).toEqual(['call-1', 'text-1', 'z']);
    expect(next[0].result).toEqual({ content: 'ok' });
  });
});
