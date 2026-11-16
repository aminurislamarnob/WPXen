import { useEffect, useState } from 'react';

const INITIAL = {
  keepRunningOnQuit: false,
  connectedHostCount: 0,
  totalRunning: 0,
  olderVersionCount: 0,
  olderVersions: [],
  currentVersion: null,
};

// Pure helper for the Settings → Agents "Background sessions" row label (#236).
export function backgroundSessionsLabel({
  totalRunning = 0,
  olderVersionCount = 0,
  olderVersions = [],
} = {}) {
  if (!totalRunning) {
    return 'Background sessions: none running';
  }
  if (olderVersionCount > 0) {
    if (olderVersions.length === 1) {
      return `Background sessions: ${totalRunning} running (${olderVersionCount} from version ${olderVersions[0]})`;
    }
    if (olderVersions.length > 1) {
      return `Background sessions: ${totalRunning} running (${olderVersionCount} from older versions ${olderVersions.join(', ')})`;
    }
    return `Background sessions: ${totalRunning} running (${olderVersionCount} from older versions)`;
  }
  return `Background sessions: ${totalRunning} running`;
}

export function shouldShowBackgroundSessionsRow({
  keepRunningOnQuit = false,
  connectedHostCount = 0,
  totalRunning = 0,
} = {}) {
  return Boolean(keepRunningOnQuit || connectedHostCount > 0 || totalRunning > 0);
}

export function useBackgroundSessionsSummary() {
  const [summary, setSummary] = useState(INITIAL);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .getAgentHostSummary()
      .then((s) => {
        if (!cancelled && s) setSummary(s);
      })
      .catch(() => {});
    const off = window.electronAPI.on('agent-host-summary-update', (s) => {
      if (s) setSummary(s);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return summary;
}
