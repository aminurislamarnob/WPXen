// Reconnect backoff: capped exponential with full jitter. Early retries are
// quick enough to absorb a network blip; the cap keeps a dead Mac from
// spinning hot. The attempt counter resets to 0 on every success, so one
// good connection erases a long failure streak.

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 60_000;

export function backoffDelayMs(
  attempt: number,
  random: () => number = Math.random
): number {
  const capped = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.floor(random() * capped);
}
