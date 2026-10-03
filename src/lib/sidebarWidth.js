// Width of the Agents sidebar (the Projects list), in pixels, dragged from
// its right edge and kept across restarts. The main-menu sidebar stays fixed.

export const AGENTS_SIDEBAR_WIDTH_KEY = 'wpxen.agentsSidebarWidth';
export const AGENTS_SIDEBAR_DEFAULT = 256;
export const AGENTS_SIDEBAR_MIN = 200;
export const AGENTS_SIDEBAR_MAX = 480;

export const clampSidebarWidth = (px) =>
  Math.round(Math.min(AGENTS_SIDEBAR_MAX, Math.max(AGENTS_SIDEBAR_MIN, px)));

// A stored value that isn't a usable number (missing, corrupted) falls back to
// the default rather than the minimum.
export function parseSidebarWidth(raw) {
  const n = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(n) && n > 0
    ? clampSidebarWidth(n)
    : AGENTS_SIDEBAR_DEFAULT;
}

export function readSidebarWidth() {
  try {
    return parseSidebarWidth(localStorage.getItem(AGENTS_SIDEBAR_WIDTH_KEY));
  } catch {
    return AGENTS_SIDEBAR_DEFAULT;
  }
}

export function saveSidebarWidth(px) {
  try {
    localStorage.setItem(AGENTS_SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(px)));
  } catch {
    // storage unavailable — the width lasts this session only
  }
}
