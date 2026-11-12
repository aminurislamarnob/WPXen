// What the UI shows for the dnsmasq status entry (see dnsmasqStatus() in
// electron/ipc.cjs): `health` is the last real lookup of a .test name,
// `action` the one-click fix the main process says it calls for. Pure, so the
// rules are testable without a DOM.

const ACTIONS = {
  repair: { kind: 'repair', label: 'Repair' },
  'change-port': { kind: 'change-port', label: 'Use a different port' },
};

// → { tone: 'ok' | 'error' | 'pending' | 'neutral', label, detail, action }
export function dnsHealthView(dns) {
  if (!dns) return { tone: 'pending', label: 'Checking…', detail: null, action: null };
  const state = dns.health?.state;

  if (dns.error) {
    return {
      tone: 'error',
      label: dns.action === 'change-port' ? 'Port in use' : 'Not resolving',
      detail: dns.error,
      // A crashed dnsmasq (procman error, no lookup verdict yet) is fixed the
      // same way a failed lookup is: redo setup and restart.
      action: ACTIONS[dns.action] || ACTIONS.repair,
    };
  }
  if (state === 'healthy') {
    return {
      tone: 'ok',
      label: 'Resolving',
      detail:
        dns.mode === 'rootless' && dns.port
          ? `*.test resolves to this Mac (dnsmasq on port ${dns.port}).`
          : '*.test resolves to this Mac.',
      action: null,
    };
  }
  if (state === 'unconfigured') {
    return { tone: 'neutral', label: 'Not set up', detail: null, action: null };
  }
  return { tone: 'pending', label: 'Checking…', detail: null, action: null };
}

// Calls the main-process fix for an action kind; resolves with its
// { success, error?, dnsmasq } result.
export function runDnsAction(kind) {
  if (kind === 'change-port') return window.electronAPI.useDifferentDnsPort();
  return window.electronAPI.repairDns();
}
