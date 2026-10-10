// Context windows by model id prefix, in tokens. Longest prefix wins, so a
// dated or suffixed id (claude-haiku-4-5-20251001, claude-sonnet-5-5[1m])
// still finds its model. Add new models here.
const CONTEXT_WINDOWS = {
  'claude-fable-5-1': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5': 200_000,
};

function contextWindowFor(model) {
  let best = null;
  for (const prefix of Object.keys(CONTEXT_WINDOWS)) {
    if (model.startsWith(prefix) && (!best || prefix.length > best.length)) best = prefix;
  }
  return best ? CONTEXT_WINDOWS[best] : null;
}

// The chat header's meter: "62% of context" for a known model, otherwise
// the raw count ("48k tokens").
export function contextMeter(usage) {
  if (!usage || typeof usage.tokens !== 'number') return null;
  const limit = usage.model ? contextWindowFor(usage.model) : null;
  if (!limit)
    return { label: `${Math.round(usage.tokens / 1000)}k tokens`, percent: null };
  const percent = Math.round((usage.tokens / limit) * 100);
  return { label: `${percent}% of context`, percent };
}
