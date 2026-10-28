import { internBench } from './scene/layout.js';

// ── Click-to-focus ───────────────────────────────────────────
// A Focus is `{ pid, subagentId? } | null`: the session (or one of its interns)
// the camera is on and the inspector shows. Pure, so the page and the camera
// rig agree on it and it's testable without WebGL.

/**
 * Keeps a focus valid against the latest snapshot. The same reference comes
 * back while nothing it points at has gone, so a caller can compare and skip
 * the state update. A focused session leaving the office clears focus — once
 * it is removed, not while it lingers as `ended`, so you see it end; a
 * focused intern finishing hands focus back to its parent.
 *
 * @param {{ sessions: Record<number, object> }} office
 * @param {{ pid: number, subagentId?: string } | null} focus
 */
export function reconcileFocus(office, focus) {
  if (!focus) return null;
  const session = office.sessions[focus.pid];
  if (!session) return null;
  if (focus.subagentId && !session.subagents?.[focus.subagentId])
    return { pid: focus.pid };
  return focus;
}

/**
 * Where the camera aims for a focus, in world units: the desk, the break spot
 * a session is taking its break at, or an intern's stool. Interns stay at the
 * desk while their parent is away. An intern past the stools (the "+n"
 * overflow) has no seat of its own, so it's framed at the desk.
 *
 * @returns {{ x: number, y: number, z: number } | null}
 */
export function focusTarget(plan, focus, breaks) {
  if (!focus) return null;
  const spot = !focus.subagentId && breaks.get(focus.pid);
  if (spot) return { x: spot.x, y: 1, z: spot.z };
  for (const pod of plan.pods)
    for (const desk of pod.desks) {
      if (desk.session?.pid !== focus.pid) continue;
      if (focus.subagentId) {
        const seat = internBench(desk.session.subagents).seated.find(
          (s) => s.sub.subagentId === focus.subagentId
        );
        if (seat) return { x: desk.x + seat.x, y: 0.8, z: desk.z + seat.z };
      }
      return { x: desk.x, y: 1, z: desk.z };
    }
  return null;
}

/**
 * Changes exactly when the camera must re-aim for focus: a different session
 * or intern, or the focused session leaving for (or returning from) a break.
 */
export function focusKey(focus, breaks) {
  if (!focus) return '';
  return `${focus.pid}:${focus.subagentId ?? ''}:${breaks.get(focus.pid)?.id ?? ''}`;
}
