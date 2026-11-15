'use strict';

// Decides whether quitting needs a confirmation, and what it names. Pure, so
// main.cjs's before-quit handler stays a thin shell around it.
//
// Services are read from procman's registry, not the status poller: the
// poller's `running` flags are probes that also see programs WPXen didn't
// start (another app's nginx, any dnsmasq on the machine), and can be a poll
// behind. Quitting only stops procman's children, so only they are worth
// asking about.

// Dashboard order and labels. PHP-FPM is one slot per version (php@8.3, …).
const SERVICE_LABELS = [
  ['nginx', 'nginx'],
  ['php', 'PHP-FPM'],
  ['mysql', 'MySQL'],
  ['dnsmasq', 'dnsmasq'],
  ['mailpit', 'Mailpit'],
];

function serviceKey(slot) {
  return slot.startsWith('php@') ? 'php' : slot;
}

// A slot with a live process that hasn't failed or been stopped. A slot
// waiting out a crash backoff has no process, so there's nothing to stop.
function isLive(st) {
  return !!st && st.pid != null && (st.state === 'running' || st.state === 'starting');
}

// Labels of the services quitting would stop, given procman.statusAll().
function servicesQuitStops(procStatus) {
  const keys = new Set(
    Object.entries(procStatus || {})
      .filter(([, st]) => isLive(st))
      .map(([slot]) => serviceKey(slot))
  );
  const known = SERVICE_LABELS.filter(([key]) => keys.has(key)).map(([, label]) => label);
  const unknown = [...keys].filter((key) => !SERVICE_LABELS.some(([k]) => k === key));
  return [...known, ...unknown];
}

// Which confirmation a quit needs: { kind: 'agents' | 'services', names }, or
// null to quit straight away.
function quitConfirmation({ confirmOnQuit, agentSiteNames, procStatus }) {
  if (agentSiteNames && agentSiteNames.length > 0) {
    return { kind: 'agents', names: agentSiteNames };
  }
  if (confirmOnQuit === false) return null;
  const names = servicesQuitStops(procStatus);
  return names.length > 0 ? { kind: 'services', names } : null;
}

module.exports = { servicesQuitStops, quitConfirmation };
