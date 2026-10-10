const fs = require('fs');
const path = require('path');

function claudeTranscriptPath({ home, cwd, uuid }) {
  if (!uuid) return null;
  const realCwd = fs.realpathSync(cwd);
  const encodedCwd = realCwd.replace(/[^A-Za-z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', encodedCwd, `${uuid}.jsonl`);
}

function decodeClaudeLine(lineStr, state) {
  if (!lineStr.trim()) return null;
  let record;
  try {
    record = JSON.parse(lineStr);
  } catch {
    return null; // Ignore invalid JSON
  }

  // Skip bookkeeping records
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

  if (record.type === 'user') {
    // Check if it's an internal command
    const contentStr =
      typeof record.content === 'string'
        ? record.content
        : JSON.stringify(record.content);
    if (
      typeof record.content === 'string' &&
      (record.content.startsWith('<command-name>') ||
        record.content.startsWith('<local-command-stdout>') ||
        record.content.startsWith('<bash-input>') ||
        record.content.startsWith('<task-notification>') ||
        record.content.startsWith('<system-reminder>'))
    ) {
      return null;
    }

    // Check if it's a tool result
    if (record.toolUseResult) {
      // It's a tool result, probably skip or format?
      // "Tool results arrive as user records whose content is tool_result blocks keyed by tool_use_id. The same record has a structured toolUseResult. For example, AskUserQuestion has answers there..."
      // Let's format tool results if needed, or just skip them for now?
      // Wait, the spec says "merge assistant records by message.id...". Does it say to skip user tool results?
      // Let's just return them as tool result blocks for now.
    }

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

    // Claude writes each content block (thinking, text, tool_use) as its own record
    if (record.message?.content) {
      state[id].blocks = state[id].blocks.concat(record.message.content);
    }

    // Combine blocks into a single string for markdown rendering
    let combinedContent = '';
    for (const block of state[id].blocks) {
      if (block.type === 'text') {
        combinedContent += block.text + '\n';
      } else if (block.type === 'tool_use') {
        combinedContent += `\`\`\`tool_use\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
      } else if (block.type === 'thinking') {
        // Maybe render thinking in some way
        combinedContent += `> Thinking...\n`;
      }
    }
    state[id].content = combinedContent.trim();

    return { ...state[id] };
  }

  return null;
}

module.exports = {
  claudeTranscriptPath,
  decodeClaudeLine,
};
