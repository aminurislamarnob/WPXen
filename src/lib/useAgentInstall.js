import { useCallback, useEffect, useRef, useState } from 'react';

// Shared one-click Homebrew install for agent CLIs, used by both surfaces that
// offer it: Settings → Agents (full row with a progress line) and the Agents
// sidebar (icon button). Keeping it here means the progress subscription and
// the "installed but not on PATH" reporting have one implementation, not two
// that drift.
//
// One install at a time — brew takes its own lock, and two concurrent casks
// would interleave their output into a single progress channel anyway.
export function useAgentInstall({ onInstalled } = {}) {
  const [installing, setInstalling] = useState(null);
  const [logLine, setLogLine] = useState('');
  const [result, setResult] = useState(null);

  // brew streams for minutes; the ref keeps the listener stable so we subscribe
  // once rather than re-subscribing on every state change.
  const installingRef = useRef(null);
  useEffect(() => {
    installingRef.current = installing;
  }, [installing]);

  useEffect(() => {
    const handleProgress = (data) => {
      if (data && data.agentId === installingRef.current) setLogLine(data.line);
    };
    window.electronAPI.on('agent-install-progress', handleProgress);
    return () => window.electronAPI.off('agent-install-progress');
  }, []);

  const install = useCallback(
    async (agent) => {
      if (installingRef.current) return;
      setInstalling(agent.id);
      setLogLine('');
      setResult(null);

      const outcome = await window.electronAPI.installAgent(agent.id);

      if (outcome.success && outcome.detected) {
        setResult({
          type: 'success',
          agentId: agent.id,
          text: `${agent.name} installed.`,
        });
      } else if (outcome.success) {
        // brew exited 0 but the binary still isn't on PATH. Antigravity's cask
        // installs the IDE that carries `agy`, so this is an expected outcome
        // for it rather than a failure — say what happened instead of showing
        // a success the launcher will immediately contradict.
        setResult({
          type: 'info',
          agentId: agent.id,
          text: `${agent.name} installed, but ${agent.cmd} isn’t on PATH yet — open a new terminal, or enable its CLI from the app.`,
        });
      } else {
        setResult({ type: 'error', agentId: agent.id, text: outcome.error });
      }

      setInstalling(null);
      setLogLine('');
      onInstalled?.();
    },
    [onInstalled]
  );

  const clearResult = useCallback(() => setResult(null), []);

  return { installing, logLine, result, install, clearResult };
}
