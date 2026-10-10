import { describe, it, expect } from 'vitest';
import { foldToolRuns } from '../src/lib/chatRows.js';

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

  it('handles empty tools gracefully', () => {
    const rows = [{ id: '1', role: 'tool' }];
    expect(foldToolRuns(rows)[0].summary).toBe('Tool interactions');
  });
});
