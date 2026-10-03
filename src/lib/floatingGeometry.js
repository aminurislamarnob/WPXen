// Floating Workspace geometry — where the panel and its launcher sit, as pure
// functions of a viewport { width, height }. Constants are Orca's
// (floating-terminal-panel-bounds.ts / floating-terminal-trigger-position.ts).
//
// Saved positions are kept as the user left them and clamped only when drawn,
// so a small viewport at launch (before the window reaches its real size)
// can't shrink what was saved.

export const TRIGGER_SIZE = 36;
export const DEFAULT_TRIGGER = Object.freeze({ corner: 'br', dx: 24, dy: 72 });
export const DRAG_THRESHOLD = 4;

export const DEFAULT_PANEL = Object.freeze({
  width: 920,
  height: 560,
  right: 24,
  bottom: 84,
});
export const MIN_PANEL = Object.freeze({ width: 420, height: 280 });
export const MAXIMIZED_MARGIN = 12;
// Keep clear of the window-controls drag strip, so the panel can never slide
// under the traffic lights.
export const TOP_INSET = 36;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// A pointer that moved less than this between down and up was a click.
export function isDrag(dx, dy) {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD;
}

// ── Panel ────────────────────────────────────────────────────────────────────
// Bounds are { x, y, width, height } in viewport pixels.

export function defaultPanelBounds(viewport) {
  return clampBounds(
    {
      x: viewport.width - DEFAULT_PANEL.right - DEFAULT_PANEL.width,
      y: viewport.height - DEFAULT_PANEL.bottom - DEFAULT_PANEL.height,
      width: DEFAULT_PANEL.width,
      height: DEFAULT_PANEL.height,
    },
    viewport
  );
}

// Fit bounds inside the viewport and below the drag strip, never below the
// minimum size unless the viewport itself is smaller. Size is fitted first,
// then position, so an oversized panel shrinks rather than hanging off-screen.
export function clampBounds(bounds, viewport) {
  const maxW = viewport.width;
  const maxH = viewport.height - TOP_INSET;
  const width = Math.min(Math.max(bounds.width, MIN_PANEL.width), maxW);
  const height = Math.min(Math.max(bounds.height, MIN_PANEL.height), maxH);
  return {
    x: clamp(bounds.x, 0, viewport.width - width),
    y: clamp(bounds.y, TOP_INSET, viewport.height - height),
    width,
    height,
  };
}

export function moveBounds(start, dx, dy, viewport) {
  return clampBounds({ ...start, x: start.x + dx, y: start.y + dy }, viewport);
}

// Resize from an edge or corner — 'n', 's', 'e', 'w' or a pair like 'se'. The
// dragged edges move; the opposite ones stay put, including when the minimum
// size or the viewport stops the drag.
export function resizeBounds(start, edge, dx, dy, viewport) {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (edge.includes('w')) left = clamp(left + dx, 0, right - MIN_PANEL.width);
  if (edge.includes('e'))
    right = clamp(right + dx, left + MIN_PANEL.width, viewport.width);
  if (edge.includes('n')) top = clamp(top + dy, TOP_INSET, bottom - MIN_PANEL.height);
  if (edge.includes('s')) {
    bottom = clamp(bottom + dy, top + MIN_PANEL.height, viewport.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function maximizedBounds(viewport) {
  const y = Math.max(MAXIMIZED_MARGIN, TOP_INSET);
  return {
    x: MAXIMIZED_MARGIN,
    y,
    width: Math.max(0, viewport.width - MAXIMIZED_MARGIN * 2),
    height: Math.max(0, viewport.height - y - MAXIMIZED_MARGIN),
  };
}

// ── Launcher ─────────────────────────────────────────────────────────────────
// Stored relative to its nearest window corner — { corner, dx, dy }, with dx/dy
// measured inward from that corner — so it stays in place as the window
// resizes, the way a dock icon pinned to a corner would.

export function triggerToPoint(pos, viewport) {
  const { corner, dx, dy } = pos || DEFAULT_TRIGGER;
  const x = corner[1] === 'r' ? viewport.width - dx - TRIGGER_SIZE : dx;
  const y = corner[0] === 'b' ? viewport.height - dy - TRIGGER_SIZE : dy;
  return {
    x: clamp(x, 0, viewport.width - TRIGGER_SIZE),
    y: clamp(y, TOP_INSET, viewport.height - TRIGGER_SIZE),
  };
}

export function pointToTrigger(point, viewport) {
  const x = clamp(point.x, 0, viewport.width - TRIGGER_SIZE);
  const y = clamp(point.y, TOP_INSET, viewport.height - TRIGGER_SIZE);
  const cx = x + TRIGGER_SIZE / 2;
  const cy = y + TRIGGER_SIZE / 2;
  const right = cx > viewport.width / 2;
  const bottom = cy > viewport.height / 2;
  return {
    corner: `${bottom ? 'b' : 't'}${right ? 'r' : 'l'}`,
    dx: right ? viewport.width - x - TRIGGER_SIZE : x,
    dy: bottom ? viewport.height - y - TRIGGER_SIZE : y,
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────
// Per-viewer UI state, so localStorage. Every access is guarded: storage can be
// unavailable, and a stored value can be stale or hand-edited.

export const STORAGE_KEYS = Object.freeze({
  panel: 'wpxen.floatingWorkspace.panel',
  trigger: 'wpxen.floatingWorkspace.trigger',
  open: 'wpxen.floatingWorkspace.open',
  maximized: 'wpxen.floatingWorkspace.maximized',
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function parseBounds(raw) {
  try {
    const b = JSON.parse(raw);
    if (b && isNum(b.x) && isNum(b.y) && isNum(b.width) && isNum(b.height)) {
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }
  } catch {
    // malformed — fall back to the default
  }
  return null;
}

export function parseTrigger(raw) {
  try {
    const t = JSON.parse(raw);
    if (t && ['tl', 'tr', 'bl', 'br'].includes(t.corner) && isNum(t.dx) && isNum(t.dy)) {
      return { corner: t.corner, dx: t.dx, dy: t.dy };
    }
  } catch {
    // malformed — fall back to the default
  }
  return null;
}

export function readStored(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable — keep it for this session only
  }
}
