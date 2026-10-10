// Decoder for Antigravity CLI transcripts
// (~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl).
// Lines are { step_index, source, type, status, created_at, content, … }.
// WPXen's own format mapping (Orca has no Antigravity decoder): rows shaped
// like the Claude decoder's so the chat view renders both identically.

// Tool results follow their planner response in step_index order and carry
// no call id — pair them positionally with that response's tool_calls.
const TRUNCATED_HINT = '\n\n*(truncated by Antigravity)*';

function unwrapUserRequest(content) {
  const match = String(content || '').match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  return match ? match[1].trim() : String(content || '').trim();
}

// Arg values arrive JSON-encoded inside JSON — parse the second layer,
// keeping the raw string when it is not JSON.
function decodeArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (typeof value === 'string') {
      try {
        out[key] = JSON.parse(value);
        continue;
      } catch {
        // keep the raw string
      }
    }
    out[key] = value;
  }
  return out;
}

function editForCall(name, input) {
  if (name === 'replace_file_content' && input.TargetFile) {
    return {
      path: input.TargetFile,
      original: input.TargetContent || '',
      modified: input.ReplacementContent || '',
    };
  }
  if (name === 'write_to_file' && input.TargetFile) {
    return { path: input.TargetFile, original: '', modified: input.CodeContent || '' };
  }
  return null;
}

function resultContent(record) {
  let content = typeof record.content === 'string' ? record.content : '';
  if (
    Array.isArray(record.truncated_fields) &&
    record.truncated_fields.includes('content')
  ) {
    content += TRUNCATED_HINT;
  }
  return content;
}

function decodeAntigravityLine(lineStr, state) {
  if (!lineStr || !lineStr.trim()) return null;
  let record;
  try {
    record = JSON.parse(lineStr);
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object') return null;
  const step = record.step_index;

  state.agyPending = state.agyPending || null;
  state.usage = state.usage || null;

  if (record.type === 'USER_INPUT') {
    const text = unwrapUserRequest(record.content);
    if (!text) return null;
    return { id: `agy-${step}-user`, role: 'user', content: text, record };
  }

  if (record.type === 'PLANNER_RESPONSE') {
    if (
      record.input_tokens != null ||
      record.cache_read_tokens != null ||
      record.output_tokens != null
    ) {
      state.usage = {
        totalTokens:
          (record.input_tokens || 0) +
          (record.cache_read_tokens || 0) +
          (record.output_tokens || 0),
        model: 'unknown',
      };
    }

    const rows = [];
    const thinking = typeof record.thinking === 'string' ? record.thinking.trim() : '';
    if (thinking) {
      rows.push({
        id: `agy-${step}-thinking`,
        role: 'reasoning',
        content: thinking,
        record,
      });
    }

    const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    const pending = [];
    calls.forEach((call, index) => {
      const name = (call && call.name) || 'tool';
      const input = decodeArgs(call && call.args);
      const id = `agy-${step}-${index}`;
      const edit = editForCall(name, input);
      pending.push({ id, name, input, edit });
      rows.push({ id, role: 'tool', tool_use: { id, name, input }, edit, record });
    });
    if (pending.length > 0) state.agyPending = { step, calls: pending };

    const content = typeof record.content === 'string' ? record.content.trim() : '';
    if (content) {
      rows.push({ id: `agy-${step}-msg`, role: 'assistant', content, record });
    }
    return rows;
  }

  if (record.type === 'GENERIC') {
    const resultBlock = {
      type: 'tool_result',
      content: resultContent(record),
      tool_use_id: null,
    };
    if (record.status === 'ERROR' || record.status === 'INVALID') {
      resultBlock.is_error = true;
    }

    // A re-reported step updates the same row in place.
    const pending = state.agyPending;
    if (
      pending &&
      typeof step === 'number' &&
      step > pending.step &&
      step - pending.step - 1 < pending.calls.length
    ) {
      const call = pending.calls[step - pending.step - 1];
      resultBlock.tool_use_id = call.id;
      return {
        id: call.id,
        role: 'tool',
        tool_use: { id: call.id, name: call.name, input: call.input },
        result: resultBlock,
        edit: call.edit,
        record,
      };
    }

    return {
      id: `agy-${step}-result`,
      role: 'tool',
      tool_use: { id: `agy-${step}-result`, name: 'tool', input: null },
      result: resultBlock,
      record,
    };
  }

  if (record.type === 'ERROR_MESSAGE') {
    if (!record.error) return null;
    return {
      id: `agy-${step}-error`,
      role: 'assistant',
      content: `⚠ ${record.error}`,
      record,
    };
  }

  return null;
}

module.exports = {
  decodeAntigravityLine,
};
