import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettings } from './useSettings';

// One decision point for "where does this site link open?", driven by
// Settings → General → Open links in.
//
// 'system' (the default) hands the URL to the default browser through the main
// process, which is the only place allowed to call shell.openExternal.
// 'app' routes it to a browser tab on that site's Agents screen — the browser
// only exists there, so a link with no site to attach to falls back to the
// system browser rather than navigating somewhere arbitrary.
export function useOpenLink() {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const inApp = settings['app.openLinksIn'] === 'app';

  return useCallback(
    (url, siteId) => {
      if (!url) return;
      if (inApp && siteId) {
        // `nonce` makes location.key change even when the route and URL are
        // identical, so opening the same link twice really opens two tabs —
        // the same trick the sidebar uses to spawn repeat agent sessions.
        navigate(`/agents/${encodeURIComponent(siteId)}`, {
          state: { openBrowser: url, nonce: Date.now() },
        });
        return;
      }
      window.electronAPI.openSiteInBrowser(url);
    },
    [inApp, navigate]
  );
}
