import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { apply as applyTypography } from './typography';

// Optimistic settings access.
//
// There is no Save button: writing a control writes the store. `setSetting`
// updates local state immediately so the UI never lags a round-trip behind the
// pointer, then persists; if the main process rejects the value (unknown key,
// out of range, a failing side effect) the control rolls back and the reason
// surfaces on `error`.
//
// The provider also listens for 'settings-updated', so a change made anywhere
// else — the Mail page's catch toggle, the tray — lands in an open Settings
// page without a refetch.

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(null);
  const [pending, setPending] = useState(() => new Set());
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .getAllSettings()
      .then((all) => {
        if (!cancelled) setSettings(all);
      })
      .catch(() => {
        if (!cancelled) setSettings({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return window.electronAPI.on('settings-updated', (all) => {
      // Only adopt keys that aren't mid-flight locally, so a broadcast landing
      // between an optimistic write and its ack can't flicker the control back.
      setSettings((prev) => {
        if (!prev) return all;
        const merged = { ...all };
        for (const key of pending) {
          if (key in prev) merged[key] = prev[key];
        }
        return merged;
      });
    });
  }, [pending]);

  const setSetting = useCallback(async (key, value) => {
    setError(null);
    let previous;
    setSettings((prev) => {
      previous = prev?.[key];
      return { ...prev, [key]: value };
    });
    setPending((prev) => new Set(prev).add(key));

    try {
      const result = await window.electronAPI.setSettings({ [key]: value });
      if (!result?.ok) {
        const reason = result?.rejected?.find((r) => r.key === key)?.reason;
        setSettings((prev) => ({ ...prev, [key]: previous }));
        setError({ key, reason: reason || 'Could not save this setting.' });
        return false;
      }
      if (result.settings) setSettings(result.settings);
      return true;
    } catch (err) {
      setSettings((prev) => ({ ...prev, [key]: previous }));
      setError({ key, reason: err?.message || 'Could not save this setting.' });
      return false;
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  // The terminal and editor are created imperatively and can't read this
  // context, so typography is pushed into a module they subscribe to.
  useEffect(() => {
    if (settings) applyTypography(settings);
  }, [settings]);

  const value = {
    settings: settings || {},
    loaded: settings !== null,
    setSetting,
    pending,
    error,
    dismissError: () => setError(null),
  };

  return createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error('useSettings must be used inside <SettingsProvider>');
  }
  return ctx;
}
