const fs = require('fs');
const path = require('path');

function claudeTranscriptPath({ home, cwd, uuid }) {
  if (!uuid) return null;
  const realCwd = fs.realpathSync(cwd);
  const encodedCwd = realCwd.replace(/[^A-Za-z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', encodedCwd, `${uuid}.jsonl`);
}

// User records that are the TUI talking to itself, not the user.
const USER_NOISE_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<local-command-caveat>',
  '<bash-input>',
  '<bash-stdout>',
  '<task-notification>',
  '<system-reminder>',
];

// A tool_result's content is a string or an array of text/image blocks.
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// The inline diff a file-editing tool call carries, or null.
function editFor(block) {
  if (block.name === 'replace' || block.name === 'replace_file_content') {
    return {
      path: block.input.TargetFile,
      original: block.input.TargetContent,
      modified: block.input.ReplacementContent,
    };
  }
  if (block.name === 'write_to_file') {
    return {
      path: block.input.TargetFile,
      original: '',
      modified: block.input.CodeContent,
    };
  }
  return null;
}

// Attach results to their calls and re-emit each call's tool row. A result
// whose call is on a page not loaded yet becomes an orphan row until the call
// shows up.
function attachToolResults(results, record, state) {
  const out = [];
  for (const b of results) {
    const toolUseId = b.tool_use_id;
    const resultBlock = {
      type: 'tool_result',
      content: toolResultText(b.content),
      tool_use_id: toolUseId,
      is_error: !!b.is_error,
    };
    const callRowId = state.calls[toolUseId];
    const callRow = callRowId && state[callRowId];
    const blockIndex = callRow
      ? callRow.blocks.findIndex((x) => x.type === 'tool_use' && x.id === toolUseId)
      : -1;
    if (blockIndex !== -1) {
      const toolBlock = callRow.blocks[blockIndex];
      toolBlock.result = resultBlock;
      out.push({
        id: `${callRowId}-${blockIndex}`,
        role: 'tool',
        tool_use: toolBlock,
        result: resultBlock,
        edit: editFor(toolBlock),
        record,
      });
    } else {
      const orphanRowId = record.uuid || `orphan-${toolUseId}`;
      state.results[toolUseId] = { ...resultBlock, rowId: orphanRowId };
      out.push({
        id: orphanRowId,
        role: 'user',
        orphan: true,
        blocks: [resultBlock],
        record,
      });
    }
  }
  if (out.length === 0) return null;
  return out.length === 1 ? out[0] : out;
}

function decodeClaudeLine(lineStr, state) {
  if (!lineStr.trim()) return null;
  let record;
  try {
    record = JSON.parse(lineStr);
  } catch {
    return null;
  }

  const skipTypes = [
    'attachment',
    'file-history-snapshot',
    'file-history-delta',
    'last-prompt',
    'mode',
    'permission-mode',
    'queue-operation',
    'system',
  ];
  if (skipTypes.includes(record.type)) return null;
  if (record.isMeta || record.isSynthetic || record.isCompactSummary) return null;

  state.calls = state.calls || {};
  state.results = state.results || {};

  if (record.type === 'user') {
    // The turn lives under message.content: a string, or an array of blocks.
    const content = record.message?.content;
    const blocks =
      typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    if (!Array.isArray(blocks)) return null;

    // Tool results arrive as user records of tool_result blocks, keyed by
    // tool_use_id. They attach to their call, never show as a user message.
    const results = blocks.filter((b) => b.type === 'tool_result');
    if (results.length > 0) return attachToolResults(results, record, state);

    const contentStr = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!contentStr) return null;
    if (USER_NOISE_PREFIXES.some((p) => contentStr.startsWith(p))) return null;

    return {
      id: record.uuid,
      role: 'user',
      content: contentStr,
      record,
    };
  }

  if (record.type === 'assistant') {
    const id = record.message?.id || record.uuid || Math.random().toString();
    if (!state[id]) {
      state[id] = {
        id,
        role: 'assistant',
        blocks: [],
      };
    }

    if (record.message?.content) {
      state[id].blocks = state[id].blocks.concat(record.message.content);
    }

    const removeIds = [];
    const rows = [];

    let blockIndex = 0;
    for (const block of state[id].blocks) {
      const blockId = `${id}-${blockIndex}`;
      blockIndex++;

      if (block.type === 'text') {
        if (block.text && block.text.includes('<ai-title>')) {
          const match = block.text.match(/<ai-title>(.*?)<\/ai-title>/);
          if (match) {
            rows.push({
              isHeader: true,
              title: match[1],
            });
            const cleaned = block.text.replace(/<ai-title>.*?<\/ai-title>/, '').trim();
            if (cleaned) {
              rows.push({ id: blockId, role: 'assistant', content: cleaned });
            }
            continue;
          }
        }

        if (block.text) {
          rows.push({ id: blockId, role: 'assistant', content: block.text });
        }
      } else if (block.type === 'tool_use') {
        state.calls[block.id] = id;
        if (!block.result && state.results[block.id]) {
          block.result = state.results[block.id];
          removeIds.push(state.results[block.id].rowId);
        }

        rows.push({
          id: blockId,
          role: 'tool',
          tool_use: block,
          result: block.result,
          edit: editFor(block),
        });
      } else if (block.type === 'thinking') {
        rows.push({
          id: blockId,
          role: 'reasoning',
          content: block.thinking,
        });
      }
    }

    if (removeIds.length > 0 && rows.length > 0) {
      rows[0].remove = removeIds;
    }

    return rows;
  }

  return null;
}

module.exports = {
  claudeTranscriptPath,
  decodeClaudeLine,
  toolResultText,
};
