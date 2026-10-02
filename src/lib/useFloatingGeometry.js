import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_TRIGGER,
  STORAGE_KEYS,
  clampBounds,
  defaultPanelBounds,
  maximizedBounds,
  parseBounds,
  parseTrigger,
  readStored,
  triggerToPoint,
  writeStored,
} from './floatingGeometry';

// The Floating Workspace's window state — open, maximised, the panel's bounds
// and the launcher's position — persisted per viewer in localStorage and
// re-fitted to the window as it resizes. The geometry rules themselves are the
// pure functions in floatingGeometry.js.

function useViewport() {
  const read = () => ({ width: window.innerWidth, height: window.innerHeight });
  const [viewport, setViewport] = useState(read);
  useEffect(() => {
    const onResize = () => setViewport(read());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return viewport;
}

function useStoredFlag(key) {
  const [value, setValue] = useState(() => readStored(key) === '1');
  const set = useCallback(
    (next) =>
      setValue((prev) => {
        const v = typeof next === 'function' ? next(prev) : next;
        writeStored(key, v ? '1' : '0');
        return v;
      }),
    [key]
  );
  return [value, set];
}

export function useFloatingGeometry() {
  const viewport = useViewport();
  const [open, setOpen] = useStoredFlag(STORAGE_KEYS.open);
  const [maximized, setMaximized] = useStoredFlag(STORAGE_KEYS.maximized);

  // Saved as the user left them, never as clamped — a window that launches
  // small (before it reaches its real size) must not overwrite them.
  const [savedBounds, setSavedBounds] = useState(() =>
    parseBounds(readStored(STORAGE_KEYS.panel))
  );
  const [trigger, setTriggerState] = useState(
    () => parseTrigger(readStored(STORAGE_KEYS.trigger)) || DEFAULT_TRIGGER
  );

  const saveBounds = useCallback((b) => {
    setSavedBounds(b);
    writeStored(STORAGE_KEYS.panel, JSON.stringify(b));
  }, []);

  const saveTrigger = useCallback((t) => {
    setTriggerState(t);
    writeStored(STORAGE_KEYS.trigger, JSON.stringify(t));
  }, []);

  const restoredBounds = savedBounds
    ? clampBounds(savedBounds, viewport)
    : defaultPanelBounds(viewport);

  return {
    viewport,
    open,
    setOpen,
    maximized,
    setMaximized,
    // What's drawn: maximised fills the window; otherwise the saved bounds,
    // fitted to the current window.
    bounds: maximized ? maximizedBounds(viewport) : restoredBounds,
    restoredBounds,
    saveBounds,
    trigger,
    triggerPoint: triggerToPoint(trigger, viewport),
    saveTrigger,
  };
}

// Track a pointer drag from a pointerdown: `onMove(dx, dy)` while it moves and
// `onEnd(dx, dy)` on release, both relative to where it started. The pointer
// is captured, so the drag survives crossing a terminal or a webview.
export function trackPointer(e, { onMove, onEnd }) {
  const el = e.currentTarget;
  const id = e.pointerId;
  const sx = e.clientX;
  const sy = e.clientY;
  try {
    el.setPointerCapture(id);
  } catch {
    // no active pointer to capture
  }
  const prevSelect = document.body.style.userSelect;
  document.body.style.userSelect = 'none';

  const move = (ev) => onMove?.(ev.clientX - sx, ev.clientY - sy);
  const end = (ev) => {
    try {
      el.releasePointerCapture(id);
    } catch {
      // already released
    }
    document.body.style.userSelect = prevSelect;
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
    onEnd?.(ev.clientX - sx, ev.clientY - sy);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
