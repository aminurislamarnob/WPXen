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

// Which confirmation a quit needs:
//   - { kind: 'agents-keep-running', count, message, detail, buttons, defaultId, cancelId }
//   - { kind: 'agents' | 'services', names }
//   - null to quit straight away.
//
// `liveAgentCount` is the Sessions a Session Host holds, the only ones that
// can keep running. `agentSiteNames` names the Sites whose Sessions quitting
// stops regardless (in-app ones, or every one with the setting off). Those
// are always confirmed, even with confirm-on-quit off: an Agent may be
// mid-edit.
function quitConfirmation({
  confirmOnQuit,
  agentSiteNames,
  procStatus,
  keepRunningOnQuit = false,
  liveAgentCount = 0,
}) {
  const stopping = agentSiteNames || [];
  if (keepRunningOnQuit && liveAgentCount > 0) {
    if (confirmOnQuit === false && stopping.length === 0) return null;
    const stopNote =
      stopping.length > 0
        ? ` Agents in ${stopping.join(', ')} started before “Keep agents running when WPXen quits” was on, so they stop.`
        : '';
    return {
      kind: 'agents-keep-running',
      count: liveAgentCount,
      message:
        liveAgentCount === 1
          ? '1 agent is still running.'
          : `${liveAgentCount} agents are still running.`,
      detail: `They keep working after WPXen quits, for up to 24 hours. Your sites will be offline until you open WPXen again.${stopNote}`,
      buttons: ['Keep running and quit', 'Stop agents and quit', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    };
  }
  if (stopping.length > 0) {
    return { kind: 'agents', names: stopping };
  }
  if (confirmOnQuit === false) return null;
  const names = servicesQuitStops(procStatus);
  return names.length > 0 ? { kind: 'services', names } : null;
}

// Map the user's dialog button choice (or null confirmation) to a quit action.
//   'keep-and-quit' — Sessions a host holds keep running; the rest stop.
//   'stop-and-quit' — every Session stops.
//   'cancel'
// Only the keep-running dialog offers stopping host Sessions. "Quit" on the
// services dialog and "Quit Anyway" on the agents one (which only names
// Sessions that stop anyway) keep host-held ones, Floating terminals included.
function quitAction(choice, confirmation) {
  if (!confirmation) return 'keep-and-quit';
  if (confirmation.kind === 'agents-keep-running') {
    if (choice === 0) return 'keep-and-quit';
    if (choice === 1) return 'stop-and-quit';
    return 'cancel';
  }
  return choice === 0 ? 'keep-and-quit' : 'cancel';
}

module.exports = { servicesQuitStops, quitConfirmation, quitAction };
