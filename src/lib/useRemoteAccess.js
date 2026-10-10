import { useEffect, useState } from 'react';

// Remote Access (services/remoteAccess.cjs). Whether it is on lives in the
// `remote.enabled` setting; this file holds the copy every surface shares and
// the live server status — off, listening, or error — which settings alone
// can't tell you.

const INITIAL = { state: 'off', host: null, port: null, actualPort: null, reason: null };

// { state, host, port, actualPort, reason }, kept current by the main-process
// broadcast.
export function useRemoteAccessStatus() {
  const [status, setStatus] = useState(INITIAL);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .getRemoteAccessStatus()
      .then((s) => {
        if (!cancelled && s) setStatus(s);
      })
      .catch(() => {});
    const off = window.electronAPI.on('remote-access-status-update', setStatus);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return status;
}

// Paired devices, kept current by the main-process broadcast.
export function useRemoteAccessDevices() {
  const [devices, setDevices] = useState([]);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .listRemoteDevices()
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setDevices(list);
      })
      .catch(() => {});
    const off = window.electronAPI.on('remote-devices-update', (list) => {
      if (Array.isArray(list)) setDevices(list);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return devices;
}
