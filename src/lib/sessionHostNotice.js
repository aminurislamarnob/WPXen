import { useEffect, useState } from 'react';

const INITIAL = { fallback: false, message: null, error: null };

export const DEFAULT_FALLBACK_NOTICE =
  'Background session host could not start — sessions won’t survive quitting WPXen.';

// Pure helper for the fallback notice banner when the Session Host fails to
// start or connect (#231). Returns the visible warning string or null.
export function hostFallbackNotice(hostStatus, keepRunningOnQuit) {
  if (!keepRunningOnQuit || !hostStatus?.fallback) return null;
  return hostStatus.message || DEFAULT_FALLBACK_NOTICE;
}

export function useAgentHostStatus() {
  const [status, setStatus] = useState(INITIAL);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .getAgentHostStatus()
      .then((s) => {
        if (!cancelled && s) setStatus(s);
      })
      .catch(() => {});
    const off = window.electronAPI.on('agent-host-status-update', (s) => {
      if (s) setStatus(s);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return status;
}
