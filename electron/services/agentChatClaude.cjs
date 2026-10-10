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

// Images stay in the transcript: rows carry where to find one (the record's
// uuid and the block's position inside message.content), and the main
// process serves it from there. No base64 and no file path crosses IPC.
function imageRefs(blocks, uuid, prefix = []) {
  if (!Array.isArray(blocks) || !uuid) return [];
  const refs = [];
  blocks.forEach((b, i) => {
    if (b?.type === 'image') refs.push({ uuid, path: [...prefix, i] });
  });
  return refs;
}

// Background work a tool call started or stopped, from its result. A task
// starts running; a <task-notification> or TaskStop later moves it on.
function noteTask(toolBlock, result, facts) {
  const meta = result.meta || {};
  const input = toolBlock.input || {};
  let started = null;
  if (toolBlock.name === 'Bash' && input.run_in_background && meta.backgroundTaskId) {
    started = { id: meta.backgroundTaskId, command: input.command ?? '' };
  } else if (toolBlock.name === 'Monitor' && meta.taskId) {
    started = { id: meta.taskId, command: input.description || input.command || '' };
  }
  if (started) {
    toolBlock.taskId = started.id;
    facts.tasks[started.id] = facts.tasks[started.id] || {
      ...started,
      status: 'running',
    };
  }
  if (toolBlock.name === 'TaskStop') {
    const task = facts.tasks[meta.task_id || input.task_id];
    if (task) task.status = 'stopped';
  }
}

// <task-notification><task-id>…</task-id>…<status>completed</status>…
function noteTaskNotification(text, facts) {
  const id = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1];
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1];
  if (id && status && facts.tasks[id]) facts.tasks[id].status = status;
}

// The inline diff a file-editing tool call carries, or null. Claude Code's
// Edit / Write / MultiEdit inputs; MultiEdit's hunks are shown as one diff.
function editFor(block) {
  const input = block.input || {};
  if (typeof input.file_path !== 'string') return null;
  if (block.name === 'Edit') {
    return {
      path: input.file_path,
      original: input.old_string ?? '',
      modified: input.new_string ?? '',
    };
  }
  if (block.name === 'Write') {
    return { path: input.file_path, original: '', modified: input.content ?? '' };
  }
  if (block.name === 'MultiEdit' && Array.isArray(input.edits)) {
    return {
      path: input.file_path,
      original: input.edits.map((e) => e.old_string ?? '').join('\n\n'),
      modified: input.edits.map((e) => e.new_string ?? '').join('\n\n'),
    };
  }
  return null;
}

// Attach results to their calls and re-emit each call's tool row. A result
// whose call is on a page not loaded yet becomes an orphan row until the call
// shows up.
function attachToolResults(results, record, state) {
  const out = [];
  const tur = record.toolUseResult || {};
  for (const [b, index] of results) {
    const toolUseId = b.tool_use_id;
    const resultBlock = {
      type: 'tool_result',
      content: toolResultText(b.content),
      tool_use_id: toolUseId,
      is_error: !!b.is_error,
      images: imageRefs(b.content, record.uuid, [index]),
      // AskUserQuestion records the chosen labels, keyed by question text.
      answers:
        tur.answers && typeof tur.answers === 'object' && !Array.isArray(tur.answers)
          ? tur.answers
          : undefined,
      // Only the ids background work is tracked by, not the whole result.
      meta: {
        backgroundTaskId: tur.backgroundTaskId,
        taskId: tur.taskId,
        task_id: tur.task_id,
      },
    };
    const callRowId = state.calls[toolUseId];
    const callRow = callRowId && state[callRowId];
    const toolBlock = callRow?.blocks.find(
      (x) => x.type === 'tool_use' && x.id === toolUseId
    );
    if (toolBlock) {
      toolBlock.result = resultBlock;
      noteTask(toolBlock, resultBlock, state.facts);
      out.push({
        id: toolBlock.rowId,
        role: 'tool',
        tool_use: toolBlock,
        result: resultBlock,
        edit: editFor(toolBlock),
        taskId: toolBlock.taskId,
      });
    } else {
      const orphanRowId = record.uuid || `orphan-${toolUseId}`;
      state.results[toolUseId] = { ...resultBlock, rowId: orphanRowId };
      out.push({
        id: orphanRowId,
        role: 'user',
        orphan: true,
        blocks: [resultBlock],
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
  // What the chat shows beside the rows; the only state sent to the renderer.
  state.facts = state.facts || { tasks: {}, todos: null, usage: null };

  // Claude names the conversation in its own record, and renames it later.
  if (record.type === 'ai-title') {
    return typeof record.aiTitle === 'string' && record.aiTitle.trim()
      ? { isHeader: true, title: record.aiTitle.trim() }
      : null;
  }

  if (record.type === 'user') {
    // The turn lives under message.content: a string, or an array of blocks.
    const content = record.message?.content;
    const blocks =
      typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    if (!Array.isArray(blocks)) return null;

    // Tool results arrive as user records of tool_result blocks, keyed by
    // tool_use_id. They attach to their call, never show as a user message.
    const results = blocks
      .map((b, i) => [b, i])
      .filter(([b]) => b.type === 'tool_result');
    if (results.length > 0) return attachToolResults(results, record, state);

    const contentStr = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (contentStr.startsWith('<task-notification>')) {
      noteTaskNotification(contentStr, state.facts);
      return null;
    }
    if (USER_NOISE_PREFIXES.some((p) => contentStr.startsWith(p))) return null;
    const images = imageRefs(blocks, record.uuid);
    if (!contentStr && images.length === 0) return null;

    return {
      id: record.uuid,
      role: 'user',
      content: contentStr,
      images,
    };
  }

  if (record.type === 'assistant') {
    // Context in use = everything the last request read plus what it wrote.
    const u = record.message?.usage;
    if (u && record.message.model && record.message.model !== '<synthetic>') {
      state.facts.usage = {
        model: record.message.model,
        tokens:
          (u.input_tokens || 0) +
          (u.cache_creation_input_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.output_tokens || 0),
      };
    }
    const id = record.message?.id || record.uuid || Math.random().toString();

    if (!state[id]) {
      state[id] = {
        id,
        role: 'assistant',
        blocks: [],
      };
    }

    // Row ids must survive Load older, which decodes each page with fresh
    // state and so may see only part of a message: a tool call is keyed by
    // its tool_use id, any other block by the record that carries it.
    if (record.message?.content) {
      for (const block of record.message.content) {
        if (block.type !== 'tool_use') continue;
        state.toolUseCount = (state.toolUseCount || 0) + 1;
        if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
          state.facts.todos = block.input.todos.map((t) => ({
            content: t.content,
            status: t.status,
          }));
        }
      }
      const tagged = record.message.content.map((b, i) => ({
        ...b,
        rowId: b.type === 'tool_use' ? b.id : `${record.uuid || id}-${i}`,
      }));
      state[id].blocks = state[id].blocks.concat(tagged);
    }

    const removeIds = [];
    const rows = [];

    for (const block of state[id].blocks) {
      const blockId = block.rowId;

      if (block.type === 'text') {
        if (block.text) {
          rows.push({ id: blockId, role: 'assistant', content: block.text });
        }
      } else if (block.type === 'tool_use') {
        state.calls[block.id] = id;
        if (!block.result && state.results[block.id]) {
          block.result = state.results[block.id];
          removeIds.push(state.results[block.id].rowId);
          noteTask(block, block.result, state.facts);
        }

        rows.push({
          id: blockId,
          role: 'tool',
          tool_use: block,
          result: block.result,
          edit: editFor(block),
          taskId: block.taskId,
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
