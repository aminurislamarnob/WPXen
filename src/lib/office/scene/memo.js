// ── Scene memo keys ──────────────────────────────────────────
// Every Office snapshot arrives over IPC as a freshly cloned object, and
// planFloor rebuilds its desks, spots and routes on every one — so nothing in
// the scene keeps its identity between snapshots. These are the value
// comparisons the scene's React.memo boundaries use instead: a component
// re-renders only when a field it actually draws changed. Pure, no React and
// no three, so they're testable without a DOM.

/** Subagent fields an intern draws: its seat order, pose, tag and laptop. */
function subagentsEqual(a = {}, b = {}) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    // Order matters: internBench seats them in insertion order.
    if (ka[i] !== kb[i]) return false;
    const x = a[ka[i]];
    const y = b[kb[i]];
    if (x === y) continue;
    if (
      x.subagentId !== y.subagentId ||
      x.state !== y.state ||
      x.currentTool !== y.currentTool ||
      x.agentType !== y.agentType
    )
      return false;
  }
  return true;
}

/**
 * Whether two snapshots of a session draw the same workstation: the fields
 * Workstation, its Character, tag and interns read. Feed, timestamps and
 * prompts change constantly and draw nothing in the scene.
 * @param {object | null | undefined} a
 * @param {object | null | undefined} b
 */
export function sessionRenderEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.pid === b.pid &&
    a.sessionId === b.sessionId &&
    a.state === b.state &&
    a.currentTool === b.currentTool &&
    a.title === b.title &&
    a.name === b.name &&
    !!a.onBreak === !!b.onBreak &&
    subagentsEqual(a.subagents, b.subagents)
  );
}

/** Same polyline, point for point. */
export function pointsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++)
    if (a[i].x !== b[i].x || a[i].z !== b[i].z) return false;
  return true;
}

/** Same break spot: id plus the geometry a commuter walks to and faces. */
export function spotEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.activity === b.activity &&
    a.x === b.x &&
    a.z === b.z &&
    a.facing === b.facing &&
    a.seat === b.seat &&
    pointsEqual(a.via, b.via)
  );
}

/**
 * The part of the page's focus that concerns one session: null when the focus
 * is on someone else, so moving focus between other agents re-renders nothing
 * here.
 * @param {{ pid: number, subagentId?: string } | null} focus
 * @param {number | undefined} pid
 */
export function focusFor(focus, pid) {
  if (!focus || pid === undefined || focus.pid !== pid) return null;
  return focus.subagentId ?? '';
}

/** React.memo comparator for Workstation. */
export function workstationPropsEqual(prev, next) {
  return (
    prev.accent === next.accent &&
    prev.deskKey === next.deskKey &&
    prev.onSelect === next.onSelect &&
    prev.origin.x === next.origin.x &&
    prev.origin.z === next.origin.z &&
    pointsEqual(prev.route, next.route) &&
    spotEqual(prev.spot, next.spot) &&
    focusFor(prev.focus, prev.session?.pid) === focusFor(next.focus, next.session?.pid) &&
    sessionRenderEqual(prev.session, next.session)
  );
}

/** Same break activity (Commuter builds a fresh object every render). */
export function activityEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.side === b.side && a.sprawl === b.sprawl;
}

/** React.memo comparator for Character: shallow, except activity by value. */
export function characterPropsEqual(prev, next) {
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(prev).length) return false;
  for (const k of keys) {
    if (k === 'activity') {
      if (!activityEqual(prev.activity, next.activity)) return false;
    } else if (prev[k] !== next[k]) return false;
  }
  return true;
}

/**
 * Everything the room shell draws from the plan: its bounds and the amenity
 * zones (whose positions follow from the bounds). Also the shell's
 * StaticBatch version.
 */
export function roomLayoutKey(plan, theme) {
  return `${theme.kind},${plan.minX},${plan.maxX + 1},${plan.minZ},${plan.maxZ},${plan.amenities.zones.map((z) => z.kind).join()}`;
}

/**
 * What moves shadows: who is in the room, at which desk, in which pose, and
 * where each one on a break is headed. The shadow map re-renders for a short
 * window after this changes and is frozen otherwise; walking commuters ask
 * for their own updates while they move.
 * @param {{ pods: Array<{ desks: Array<{ key: string, session: object | null }> }> }} plan
 * @param {Map<number, { id: string }>} breaks
 */
export function poseSignature(plan, breaks) {
  const parts = [];
  for (const pod of plan.pods)
    for (const desk of pod.desks) {
      const s = desk.session;
      if (!s) continue;
      const subs = Object.values(s.subagents ?? {})
        .map((a) => `${a.subagentId}:${a.state}`)
        .join(',');
      parts.push(
        `${desk.key}@${s.state}${s.onBreak ? '~' : ''}>${breaks.get(s.pid)?.id ?? ''}[${subs}]`
      );
    }
  return parts.join('|');
}
