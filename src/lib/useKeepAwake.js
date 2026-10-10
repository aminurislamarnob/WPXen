import { useEffect, useState } from 'react';

// Keep computer awake (services/keepAwake.cjs). The mode is the
// `agents.keepAwake` setting; this file holds the copy every surface shares
// and the live status — whether a sleep assertion is actually held — which
// settings alone can't tell you.

export const KEEP_AWAKE_MODES = [
  { value: 'on', label: 'On', description: 'Keep this computer awake continuously' },
  { value: 'agent', label: 'Agent', description: 'Stay awake while an agent is working' },
  { value: 'off', label: 'Off', description: 'Allow normal system sleep behavior' },
];

export function keepAwakeMode(value) {
  return KEEP_AWAKE_MODES.find((m) => m.value === value) || KEEP_AWAKE_MODES[2];
}

const INITIAL = { mode: 'off', active: false, workingCount: 0, reasons: [] };

// { mode, active, workingCount, reasons }, kept current by the main-process broadcast.
export function useKeepAwakeStatus() {
  const [status, setStatus] = useState(INITIAL);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .getKeepAwakeStatus()
      .then((s) => {
        if (!cancelled && s) setStatus(s);
      })
      .catch(() => {});
    const off = window.electronAPI.on('keep-awake-status-update', setStatus);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return status;
}
