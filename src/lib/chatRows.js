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

      let read = (nameCounts['read_file'] || 0) + (nameCounts['view_file'] || 0);
      let bash = (nameCounts['bash'] || 0) + (nameCounts['run_command'] || 0);
      let edit =
        (nameCounts['replace'] || 0) +
        (nameCounts['replace_file_content'] || 0) +
        (nameCounts['write_to_file'] || 0) +
        (nameCounts['multi_edit'] || 0);
      let search = (nameCounts['grep_search'] || 0) + (nameCounts['glob'] || 0);

      const parts = [];
      if (read > 0) parts.push(`Read ${read} file${read > 1 ? 's' : ''}`);
      if (bash > 0) parts.push(`Ran ${bash} command${bash > 1 ? 's' : ''}`);
      if (edit > 0) parts.push(`Edited ${edit} file${edit > 1 ? 's' : ''}`);
      if (search > 0) parts.push(`Searched ${search} time${search > 1 ? 's' : ''}`);

      const otherNames = Object.keys(nameCounts).filter(
        (n) =>
          ![
            'read_file',
            'view_file',
            'bash',
            'run_command',
            'replace',
            'replace_file_content',
            'write_to_file',
            'multi_edit',
            'grep_search',
            'glob',
          ].includes(n)
      );

      let other = 0;
      for (const n of otherNames) other += nameCounts[n];
      if (other > 0) parts.push(`Used ${other} tool${other > 1 ? 's' : ''}`);

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
