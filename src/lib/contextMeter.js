// Context windows the model id itself names, by suffix. A bare name says
// nothing: the same model runs 1M first-party and 200k through a gateway, so
// guessing would show a confidently wrong percentage (after Orca's
// claudeContextWindowHint). Add a suffix here only when it fixes the window.
const CONTEXT_WINDOW_SUFFIXES = {
  '[1m]': 1_000_000,
};

function contextWindowFor(model) {
  const id = String(model).trim().toLowerCase();
  for (const [suffix, window] of Object.entries(CONTEXT_WINDOW_SUFFIXES)) {
    if (id.endsWith(suffix)) return window;
  }
  return null;
}

// The chat header's meter: "62% of context" when the window is known (the
// Agent reports it, like Codex, or the model id names it), otherwise the raw
// count ("48k tokens").
export function contextMeter(usage) {
  if (!usage || typeof usage.tokens !== 'number') return null;
  const limit = usage.limit || (usage.model ? contextWindowFor(usage.model) : null);
  if (!limit)
    return { label: `${Math.round(usage.tokens / 1000)}k tokens`, percent: null };
  const percent = Math.round((usage.tokens / limit) * 100);
  return { label: `${percent}% of context`, percent };
}
