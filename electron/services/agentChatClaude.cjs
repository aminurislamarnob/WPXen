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
    // The turn lives under message.content: a string, or an array of blocks.
    const content = record.message?.content;
    const blocks =
      typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    if (!Array.isArray(blocks)) return null;

    // Tool results arrive as user records of tool_result blocks. They belong
    // to their call, never to the user.
    if (blocks.some((b) => b.type === 'tool_result')) return null;

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
