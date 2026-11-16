import { useEffect, useState } from 'react';

// The daily PHP update check's state (electron/services/phpUpdates.cjs):
// { updates, notice, checkedAt, checking, error }. Fetched once, then kept
// current by the 'php-updates' push, so the sidebar dot, the Dashboard notice
// and the PHP page agree without polling.
export function usePhpUpdates() {
  const [state, setState] = useState(null);
  useEffect(() => {
    let live = true;
    window.electronAPI
      .getPhpUpdates?.()
      .then((s) => live && setState(s))
      .catch(() => {});
    const off = window.electronAPI.on('php-updates', setState);
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

// "PHP 8.4.15", or "PHP 8.3.30 and 8.4.15". Pure, for the notice title.
export function phpUpdatesLabel(updates) {
  const names = (updates || []).map((u) => u.latest || u.version);
  if (names.length <= 1) return `PHP ${names[0] || ''}`.trim();
  return `PHP ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
