// Pure logic behind the Agents-screen activity bar (see Layout.jsx), kept out
// of the component so it's testable without a DOM.

// Width of the activity bar, in px. Layout sizes the strip from this and
// derives how far the Agents pane must inset past the floating window
// controls when the Sites tree is collapsed.
export const ACTIVITY_BAR_WIDTH = 48;

// The window-control cluster (sidebar toggle + back/forward) ends this far from
// the window's left edge.
export const WINDOW_CONTROLS_END = 190;

// Services a .test site can't load without. Mailpit is deliberately absent:
// it's optional, and it being off breaks nothing.
const CORE_SERVICES = [
  ['nginx', 'nginx'],
  ['php', 'PHP-FPM'],
  ['mysql', 'MySQL'],
  ['dnsmasq', 'dnsmasq'],
];

// The core services that are down, by display name — stopped, or crashed per
// the supervisor. Empty when all is well (or before the first status arrives,
// so the badge doesn't flash at launch).
export function downCoreServices(status) {
  if (!status) return [];
  return CORE_SERVICES.filter(([key]) => {
    const s = status[key];
    return s && (!s.running || !!s.error);
  }).map(([key, label]) => status[key]?.name || label);
}

// Tooltip for the Services icon: plain label, or the culprits appended.
export function servicesLabel(down) {
  if (!down.length) return 'Services';
  return `Services — ${down.join(', ')} ${down.length === 1 ? 'is' : 'are'} down`;
}

// localStorage key holding the last Site viewed on the Agents screen.
export const LAST_AGENTS_SITE_KEY = 'wpxen.lastAgentsSite';

// Which Site a bare /agents should reopen: the remembered one, if it still
// exists. Null means show the empty "pick a site" state.
export function resolveLastSite(lastId, sites) {
  if (!lastId) return null;
  return (sites || []).some((s) => s.id === lastId) ? lastId : null;
}
