// Decoder for Codex rollout transcripts
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). Records are
// { type, payload }; response_item payloads carry the conversation.
// Behaviour ported from Orca's transcript-line-decoders-codex.ts: same skip
// rules and the same call-input passthrough, shaped into WPXen rows like the
// Claude decoder so the chat view renders both identically.

// A user message that is injected context rather than the user's prompt.
// <environment_context> and <user_instructions> are named in the spec;
// <external_*> (open-page snapshots) and <skill> expansions (Orca's rule)
// ride the same channel.
const INJECTED_USER_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '<external_',
  '<skill>',
];

function isInjectedUserText(text) {
  const trimmed = String(text).trimStart().toLowerCase();
  return INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
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

function decodeCodexLine(lineStr, state) {
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

  state.codexCalls = state.codexCalls || {};
  state.codexResults = state.codexResults || {};
  // What the chat shows beside the rows; the only state sent to the renderer.
  state.facts = state.facts || { tasks: {}, todos: null, usage: null };

  if (record.type === 'response_item') {
    if (payload.type === 'message') {
      if (payload.role !== 'user' && payload.role !== 'assistant') return null;
      const text = messageText(payload.content);
      if (!text) return null;
      if (payload.role === 'user' && isInjectedUserText(text)) return null;
      return {
        id: payload.id || record.id,
        role: payload.role,
        content: text,
      };
    }

    if (payload.type === 'reasoning') {
      const text =
        (typeof payload.text === 'string' && payload.text) ||
        summaryText(payload.summary);
      if (!text) return null;
      return {
        id: payload.id || record.id,
        role: 'reasoning',
        content: text,
      };
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
      if (!payload.message) return null;
      return { id: record.id, role: 'user', content: payload.message };
    }
    if (payload.type === 'agent_message' && typeof payload.message === 'string') {
      if (!payload.message) return null;
      return { id: record.id, role: 'assistant', content: payload.message };
    }
    return null;
  }

  return null;
}

module.exports = {
  decodeCodexLine,
};
