// The host list: paired Macs. Pure transforms only — persistence (secure
// store) and the live socket live elsewhere, so these run under vitest with
// no React Native. Secrets never appear here: the device keypair per host
// stays in the secure store under its own key.

export interface HostRecord {
  id: string;
  // Shown in the list; renamed on the Mac it follows the next sync.
  name: string;
  // wss:// URL this host was paired on.
  url: string;
  hostId: string;
  hostPublicKey: string;
  lastSeen: number | null;
}

// Add or replace by id: re-pairing a Mac replaces its row rather than
// doubling it.
export function addHost(list: HostRecord[], host: HostRecord): HostRecord[] {
  const index = list.findIndex((h) => h.id === host.id);
  if (index < 0) return [...list, host];
  return list.map((h, i) => (i === index ? host : h));
}

export function removeHost(list: HostRecord[], id: string): HostRecord[] {
  return list.filter((h) => h.id !== id);
}

export function touchHost(list: HostRecord[], id: string, now: number): HostRecord[] {
  return list.map((h) => (h.id === id ? { ...h, lastSeen: now } : h));
}

export function findHost(list: HostRecord[], id: string): HostRecord | null {
  return list.find((h) => h.id === id) ?? null;
}
