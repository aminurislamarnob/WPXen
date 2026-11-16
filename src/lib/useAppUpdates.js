import { useEffect, useState } from 'react';

// The daily WPXen update check's state (electron/services/appUpdates.cjs):
// { current, latest, available, notice, checkedAt, checking, error }.
// Fetched once, then kept current by the 'app-updates' push, so the Dashboard
// notice and Settings → About agree without polling.
export function useAppUpdates() {
  const [state, setState] = useState(null);
  useEffect(() => {
    let live = true;
    window.electronAPI
      .getAppUpdates?.()
      .then((s) => live && setState(s))
      .catch(() => {});
    const off = window.electronAPI.on('app-updates', setState);
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

// The Updates row's subtitle. Pure.
export function appUpdateStatusText(state) {
  if (!state) return '';
  if (state.checking) return 'Checking for updates…';
  if (state.available)
    return `WPXen ${state.latest.version} is available. You have ${state.current}.`;
  if (state.error) return state.error;
  if (state.checkedAt) return `WPXen ${state.current} is the latest version.`;
  return `You have WPXen ${state.current}.`;
}
