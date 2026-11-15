// ── Render pacing policy ─────────────────────────────────────
// Pure decisions behind the scene's perf machinery (OfficeScene renders on a
// demand frameloop and only invalidates when something can move). Extracted
// from the source scene so they are testable without a DOM/WebGL environment.

/**
 * Agent States whose characters move fast enough to need brisk frames: typing,
 * the thought bubble, the error head-shake. Waiting on you is deliberately not
 * one of them — its wave and ring pulse read fine at the calm rate, and an
 * agent can sit waiting for hours, which would otherwise hold the canvas at
 * 30 fps the whole time.
 */
export const BRISK_STATES = new Set(['working', 'thinking', 'error']);

/** Whether any session (or any of its subagents) is in a brisk state. */
export function isBusy(office) {
  return Object.values(office.sessions).some(
    (s) =>
      BRISK_STATES.has(s.state) ||
      Object.values(s.subagents ?? {}).some((a) => BRISK_STATES.has(a.state))
  );
}

/**
 * Ticks per second for the FrameDriver: 0 when the window is hidden (the
 * frameloop is fully paused), brisk while agents move or a ping-pong rally
 * needs smooth frames, slow when the office is calm.
 */
export function frameRate({ visible, busy, rally = false }) {
  return !visible ? 0 : busy || rally ? 30 : 10;
}

/** Orthographic zoom below which in-world text stops being legible. */
export const FAR_ZOOM = 72;

/** Label mode: `far` swaps in crisp HTML pod labels when zoomed out. */
export function isFarZoom(zoom) {
  return zoom < FAR_ZOOM;
}
