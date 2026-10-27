// Decoder for Codex rollout transcripts
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). Records are
// { type, payload }; response_item payloads carry the conversation.
// Behaviour ported from Orca's transcript-line-decoders-codex.ts: same skip
// rules and the same call-input passthrough, shaped into WPXen rows like the
// Claude decoder so the chat view renders both identically.

// A user message that is injected context rather than the user's prompt.
// <environment_context> and <user_instructions> are named in the spec;
// <external_*> (open-page snapshots) and <skill> expansions (Orca's rule)
// ride the same channel. Real 0.100 / 0.130 rollouts also inject the
// AGENTS.md instructions and <system_instruction> blocks as user turns —
// the latter even as an event_msg user_message, so the check runs there too.
const INJECTED_USER_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '<system_instruction>',
  '# agents.md instructions for',
  '<external_',
  '<skill>',
];

function isInjectedUserText(text) {
  const trimmed = String(text).trimStart().toLowerCase();
  return INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

// Every turn is written twice: once as the event_msg the TUI shows
// (user_message / agent_message, or item_completed in paginated rollouts) and
// once as the response_item copy sent to the model, whose blocks are
// input_text / output_text. Rendering both doubles every turn, so — Orca's
// rule (transcript-line-decoders-codex.ts:61-174, via claudeContentBlocks) —
// the model copies are dropped and only plain `text` blocks count there.

function responseMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && (b.type === 'text' || b.type === 'Text'))
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

// Join the text parts of message content blocks (input_text, output_text,
// text, Text) — the shapes observed in real rollouts.
function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (
      block.type === 'input_text' ||
      block.type === 'output_text' ||
      block.type === 'text' ||
      block.type === 'Text'
    ) {
      if (typeof block.text === 'string' && block.text) parts.push(block.text);
    }
  }
  return parts.join('\n');
}

// Reasoning summaries are encrypted on this machine (empty arrays); when a
// rollout carries readable summary text, join it the way Orca does.
function summaryText(summary) {
  if (!Array.isArray(summary)) return null;
  const parts = [];
  for (const item of summary) {
    const text =
      item && typeof item === 'object'
        ? typeof item.text === 'string'
          ? item.text
          : null
        : typeof item === 'string'
          ? item
          : null;
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

// Codex keeps its plan with update_plan: { plan: [{ step, status }] }, the
// arguments arriving as a JSON string. It is the to-do checklist Claude's
// TodoWrite is, so it folds into the same snapshot (after Orca's
// normalizeNativeChatTaskList).
function planTodos(input) {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || !Array.isArray(value.plan)) return null;
  const todos = [];
  for (const item of value.plan) {
    const content = item && typeof item.step === 'string' ? item.step.trim() : '';
    if (!content) continue;
    const status =
      item.status === 'in_progress' || item.status === 'inProgress'
        ? 'in_progress'
        : item.status === 'completed'
          ? 'completed'
          : 'pending';
    todos.push({ content, status });
  }
  return value.plan.length > 0 && todos.length === 0 ? null : todos;
}

// `fallbackId` is the line's byte-offset id from the engine: real rollouts
// (0.100, 0.130) write no payload.id, and a row without an id is dropped by
// the renderer's upsert.
// Paginated rollouts record the visible turn as an item_completed event
// whose item is a UserMessage / AgentMessage (Orca's codexCompletedTurnItem).
function completedItem(item, fallbackId) {
  if (!item || typeof item !== 'object') return null;
  const text = messageText(item.content);
  if (!text) return null;
  const id = item.id || fallbackId;
  if (item.type === 'UserMessage' || item.type === 'user_message') {
    return isInjectedUserText(text) ? null : { id, role: 'user', content: text };
  }
  if (item.type === 'AgentMessage' || item.type === 'agent_message') {
    return { id, role: 'assistant', content: text };
  }
  return null;
}

function decodeCodexLine(lineStr, state, { fallbackId } = {}) {
  if (!lineStr || !lineStr.trim()) return null;
  let record;
  try {
    record = JSON.parse(lineStr);
  } catch {
    return null;
  }
  const payload =
    record.payload && typeof record.payload === 'object' ? record.payload : null;
  if (!payload) return null;
  const id = payload.id || record.id || fallbackId;

  state.codexCalls = state.codexCalls || {};
  state.codexResults = state.codexResults || {};
  // What the chat shows beside the rows; the only state sent to the renderer.
  state.facts = state.facts || { tasks: {}, todos: null, usage: null };

  if (record.type === 'response_item') {
    if (payload.type === 'message') {
      if (payload.role !== 'user' && payload.role !== 'assistant') return null;
      const text = responseMessageText(payload.content);
      if (!text) return null;
      if (payload.role === 'user' && isInjectedUserText(text)) return null;
      return { id, role: payload.role, content: text };
    }

    if (payload.type === 'reasoning') {
      const text =
        (typeof payload.text === 'string' && payload.text) ||
        summaryText(payload.summary);
      if (!text) return null;
      return { id, role: 'reasoning', content: text };
    }

    if (
      payload.type === 'function_call' ||
      payload.type === 'local_shell_call' ||
      payload.type === 'custom_tool_call'
    ) {
      const callId = payload.call_id || payload.id;
      if (!callId) return null;
      // The argument payload passes through exactly as it arrived — decoding
      // it here would change the shape every consumer sees.
      const input =
        payload.arguments !== undefined
          ? payload.arguments
          : (payload.input ?? payload.action ?? null);
      const toolUse = { id: callId, name: payload.name || 'tool', input };
      state.codexCalls[callId] = toolUse;
      if (toolUse.name === 'update_plan') {
        const todos = planTodos(input);
        if (todos) state.facts.todos = todos;
      }
      const row = { id: callId, role: 'tool', tool_use: toolUse };
      const pending = state.codexResults[callId];
      if (pending) {
        row.result = pending.result;
        row.remove = [pending.rowId];
        delete state.codexResults[callId];
      }
      return row;
    }

    if (
      payload.type === 'function_call_output' ||
      payload.type === 'custom_tool_call_output'
    ) {
      const callId = payload.call_id;
      if (!callId) return null;
      const resultBlock = {
        type: 'tool_result',
        content: messageText(payload.output ?? payload.content),
        tool_use_id: callId,
      };
      const toolUse = state.codexCalls[callId];
      if (toolUse) {
        return {
          id: callId,
          role: 'tool',
          tool_use: toolUse,
          result: resultBlock,
        };
      }
      const orphanRowId = `orphan-${callId}`;
      state.codexResults[callId] = { result: resultBlock, rowId: orphanRowId };
      return {
        id: orphanRowId,
        role: 'user',
        orphan: true,
        blocks: [resultBlock],
      };
    }

    return null;
  }

  if (record.type === 'event_msg') {
    if (payload.type === 'token_count') {
      const info = payload.info || {};
      // total_token_usage is the session's cumulative spend; what's in the
      // context now is the latest request's, last_token_usage. Rollouts carry
      // no model name, but they do carry the real context window.
      const last = info.last_token_usage || info.total_token_usage || {};
      state.facts.usage = {
        model: null,
        tokens: last.total_tokens || 0,
        limit: info.model_context_window || null,
      };
      return null;
    }
    if (payload.type === 'user_message' && typeof payload.message === 'string') {
      if (!payload.message || isInjectedUserText(payload.message)) return null;
      return { id, role: 'user', content: payload.message };
    }
    if (payload.type === 'agent_message' && typeof payload.message === 'string') {
      if (!payload.message) return null;
      return { id, role: 'assistant', content: payload.message };
    }
    if (payload.type === 'item_completed') return completedItem(payload.item, id);
    return null;
  }

  return null;
}

// The full text of one call's output, for "Show full output".
function findToolResult(record, callId) {
  const payload = record?.type === 'response_item' ? record.payload : null;
  if (
    !payload ||
    (payload.type !== 'function_call_output' &&
      payload.type !== 'custom_tool_call_output') ||
    payload.call_id !== callId
  ) {
    return null;
  }
  return messageText(payload.output ?? payload.content);
}

module.exports = {
  decodeCodexLine,
  findToolResult,
};
