// Tool name -> summary kind. Claude Code's names, then Antigravity's.
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
  replace: 'edit',
  replace_file_content: 'edit',
  write_to_file: 'edit',
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

export function foldToolRuns(rows) {
  const folded = [];
  let currentRun = null;

  for (const row of rows) {
    if (
      row.role === 'tool' ||
      row.role === 'tool_result' ||
      (row.role === 'user' && row.orphan)
    ) {
      if (!currentRun) {
        currentRun = {
          id: `run-${row.id}`,
          role: 'tool-run',
          items: [],
          summary: '',
          success: true,
        };
        folded.push(currentRun);
      }
      currentRun.items.push(row);
    } else {
      currentRun = null;
      folded.push(row);
    }
  }

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

      const parts = [];
      for (const [kind, one, many] of SUMMARY_PARTS) {
        const n = counts[kind];
        if (n > 0) parts.push((n === 1 ? one : many).replace('#', n));
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
