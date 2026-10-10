import { describe, it, expect } from 'vitest';
import { foldToolRuns, subagentSummary, runNeedsAttention } from '../src/lib/chatRows.js';

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
    expect(foldToolRuns(mixed)[0].summary).toBe('Read 1 file, Ran 1 command');

    const editSearch = [
      { id: '1', role: 'tool', tool_use: { name: 'replace' } },
      { id: '2', role: 'tool', tool_use: { name: 'grep_search' } },
    ];
    expect(foldToolRuns(editSearch)[0].summary).toBe('Edited 1 file, Searched 1 time');
  });

  it("summarises Claude Code's tool names", () => {
    const tool = (name) => ({
      id: name + Math.random(),
      role: 'tool',
      tool_use: { name },
    });
    const run = ['Read', 'Read', 'Bash', 'Edit', 'Write', 'MultiEdit', 'Grep', 'Glob'];
    expect(foldToolRuns(run.map(tool))[0].summary).toBe(
      'Read 2 files, Ran 1 command, Edited 3 files, Searched 2 times'
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
