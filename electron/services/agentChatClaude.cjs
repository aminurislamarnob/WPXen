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

// Attach results to the assistant row that made the call and re-emit that
// row. A result whose call is on a page not loaded yet becomes an orphan row
// until the call shows up.
function attachToolResults(results, record, state) {
  let out = null;
  for (const b of results) {
    const toolUseId = b.tool_use_id;
    const resultBlock = {
      type: 'tool_result',
      content: toolResultText(b.content),
      tool_use_id: toolUseId,
      is_error: !!b.is_error,
    };
    const callRow = state.calls[toolUseId] && state[state.calls[toolUseId]];
    const toolUseBlock = callRow?.blocks.find(
      (x) => x.type === 'tool_use' && x.id === toolUseId
    );
    if (toolUseBlock) {
      toolUseBlock.result = resultBlock;
      out = out || { ...callRow, record };
    } else {
      const orphanRowId = record.uuid || `orphan-${toolUseId}`;
      state.results[toolUseId] = { ...resultBlock, rowId: orphanRowId };
      out = out || {
        id: orphanRowId,
        role: 'user',
        orphan: true,
        blocks: [resultBlock],
        record,
      };
    }
  }
  return out;
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
        content: '',
        blocks: [],
      };
    }

    if (record.message?.content) {
      state[id].blocks = state[id].blocks.concat(record.message.content);
    }

    const removeIds = [];
    let combinedContent = '';

    for (const block of state[id].blocks) {
      if (block.type === 'text') {
        combinedContent += block.text + '\n';
      } else if (block.type === 'tool_use') {
        state.calls[block.id] = id;
        if (!block.result && state.results[block.id]) {
          block.result = state.results[block.id];
          removeIds.push(state.results[block.id].rowId);
        }
        combinedContent += `\`\`\`tool_use\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
      } else if (block.type === 'thinking') {
        combinedContent += `> Thinking...\n`;
      }
    }

    state[id].content = combinedContent.trim();

    const out = { ...state[id] };
    if (removeIds.length > 0) out.remove = removeIds;
    return out;
  }

  return null;
}

module.exports = {
  claudeTranscriptPath,
  decodeClaudeLine,
  toolResultText,
};
