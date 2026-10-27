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

// A value that may still be JSON one layer down (ReplacementChunks arrives
// as an array, or on some steps as a JSON string of one).
function parsed(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// The inline diff a file-editing call carries, or null — every edit tool
// observed in real transcripts: replace_file_content / write_to_file, and
// multi_replace_file_content (hunks shown as one diff, like Claude's
// MultiEdit), edit_file and write_file.
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
  if (name === 'multi_replace_file_content' && input.TargetFile) {
    const chunks = parsed(input.ReplacementChunks);
    if (!Array.isArray(chunks)) return null;
    return {
      path: input.TargetFile,
      original: chunks.map((c) => c?.TargetContent ?? '').join('\n\n'),
      modified: chunks.map((c) => c?.ReplacementContent ?? '').join('\n\n'),
    };
  }
  if (name === 'edit_file' && input.Path) {
    return {
      path: input.Path,
      original: input.Target || '',
      modified: input.Replacement || '',
    };
  }
  if (name === 'write_file' && input.Path) {
    return { path: input.Path, original: '', modified: input.Content || '' };
  }
  return null;
}

// A tool's result step. GENERIC is the catch-all; many tools write a typed
// record instead (RUN_COMMAND, CODE_ACTION, VIEW_FILE, GREP_SEARCH,
// LIST_DIRECTORY, SEARCH_WEB, READ_URL_CONTENT, GENERATE_IMAGE,
// ASK_QUESTION …). Every one is source MODEL; the planner's own records are
// PLANNER_RESPONSE. On this machine's 54 transcripts that rule pairs every
// result step with a call, where GENERIC alone left ~19% of calls unpaired.
function isResultStep(record) {
  return record.source === 'MODEL' && record.type !== 'PLANNER_RESPONSE';
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
  // What the chat shows beside the rows; the only state sent to the renderer.
  state.facts = state.facts || { tasks: {}, todos: null, usage: null };

  if (record.type === 'USER_INPUT') {
    const text = unwrapUserRequest(record.content);
    if (!text) return null;
    return { id: `agy-${step}-user`, role: 'user', content: text };
  }

  if (record.type === 'PLANNER_RESPONSE') {
    if (
      record.input_tokens != null ||
      record.cache_read_tokens != null ||
      record.output_tokens != null
    ) {
      // Per request, so it is the context in use now. No model name is
      // recorded, so the meter shows a raw count.
      state.facts.usage = {
        model: null,
        tokens:
          (record.input_tokens || 0) +
          (record.cache_read_tokens || 0) +
          (record.output_tokens || 0),
      };
    }

    const rows = [];
    const thinking = typeof record.thinking === 'string' ? record.thinking.trim() : '';
    if (thinking) {
      rows.push({
        id: `agy-${step}-thinking`,
        role: 'reasoning',
        content: thinking,
      });
    }

    const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    const pending = [];
    // A result step a newer page already showed unpaired (its call is on
    // this older page) is claimed here, and its row removed.
    const early = state.results || {};
    const claimed = [];
    calls.forEach((call, index) => {
      const name = (call && call.name) || 'tool';
      const input = decodeArgs(call && call.args);
      const id = `agy-${step}-${index}`;
      const edit = editForCall(name, input);
      pending.push({ id, name, input, edit });
      const row = { id, role: 'tool', tool_use: { id, name, input }, edit };
      const orphan = typeof step === 'number' ? early[step + 1 + index] : null;
      if (orphan) {
        row.result = { ...orphan.result, tool_use_id: id };
        claimed.push(orphan.rowId);
        delete early[step + 1 + index];
      }
      rows.push(row);
    });
    if (claimed.length > 0) rows[0].remove = claimed;
    if (pending.length > 0) state.agyPending = { step, calls: pending };

    const content = typeof record.content === 'string' ? record.content.trim() : '';
    if (content) {
      rows.push({ id: `agy-${step}-msg`, role: 'assistant', content });
    }
    return rows;
  }

  if (record.type === 'ERROR_MESSAGE') {
    const text = record.error || record.content;
    if (typeof text !== 'string' || !text.trim()) return null;
    // A notice from Antigravity itself (quota, API errors), not the model.
    return {
      id: `agy-${step}-error`,
      role: 'status',
      tone: 'error',
      content: text.trim(),
    };
  }

  if (isResultStep(record)) {
    const resultBlock = {
      type: 'tool_result',
      content: resultContent(record),
      tool_use_id: null,
    };
    if (
      record.status === 'ERROR' ||
      record.status === 'INVALID' ||
      (typeof record.exit_code === 'number' && record.exit_code !== 0)
    ) {
      resultBlock.is_error = true;
    }

    // Results follow their planner response one step per call.
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
      };
    }

    // Its call is on a page not loaded yet: show it on its own until Load
    // older brings the call in.
    resultBlock.tool_use_id = `agy-${step}-result`;
    if (typeof step === 'number') {
      state.results = state.results || {};
      state.results[step] = { result: resultBlock, rowId: `agy-${step}-result` };
    }
    return {
      id: `agy-${step}-result`,
      role: 'tool',
      tool_use: { id: `agy-${step}-result`, name: 'tool', input: null },
      result: resultBlock,
    };
  }

  return null;
}

// Antigravity results carry no call id: a call `agy-<step>-<i>` is answered
// by step <step> + 1 + i, an unpaired result `agy-<step>-result` is its own
// step. The step a result id points at, or null.
function resultStep(toolUseId) {
  const call = /^agy-(\d+)-(\d+)$/.exec(String(toolUseId));
  if (call) return Number(call[1]) + 1 + Number(call[2]);
  const own = /^agy-(\d+)-result$/.exec(String(toolUseId));
  return own ? Number(own[1]) : null;
}

// The full text of one result step, for "Show full output".
function findToolResult(record, toolUseId) {
  const step = resultStep(toolUseId);
  if (step === null || record?.step_index !== step) return null;
  if (!isResultStep(record) || typeof record.content !== 'string') return null;
  return resultContent(record);
}

// Lines worth parsing (a prefilter; findToolResult checks the step exactly):
// the transcript writes records compactly.
function toolResultNeedle(toolUseId) {
  const step = resultStep(toolUseId);
  return step === null ? null : `"step_index":${step}`;
}

module.exports = {
  decodeAntigravityLine,
  findToolResult,
  toolResultNeedle,
};
