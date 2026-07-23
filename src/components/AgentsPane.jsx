import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Terminal as TerminalIcon, Square } from 'lucide-react';
import { Button } from './ui';
import Terminal from './Terminal';

// Main pane for the Agents section. With no selection it shows an empty state;
// with /agents/<siteId>/<agentId> it launches (idempotently) and hosts the
// embedded terminal for that Session.
export default function AgentsPane() {
  const { siteId, agentId } = useParams();
  const navigate = useNavigate();
  const [meta, setMeta] = useState({ siteName: siteId, agentName: agentId });
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!siteId || !agentId) return;
    let cancelled = false;
    setError(null);

    (async () => {
      const [sites, agents] = await Promise.all([
        window.electronAPI.getSites(),
        window.electronAPI.listAgents(),
      ]);
      const site = (sites || []).find((s) => s.id === siteId);
      const agent = (agents || []).find((a) => a.id === agentId);
      if (cancelled) return;
      setMeta({ siteName: site?.name || siteId, agentName: agent?.name || agentId });

      // One Session per Site (Q2). If a different Agent is already running for
      // this Site, offer to switch rather than silently ignore or kill (Q10).
      const st = await window.electronAPI.agentStatus(siteId);
      if (cancelled) return;
      if (st.running && st.agentId !== agentId) {
        const ok = window.confirm(
          `${st.agentName} is already running for ${site?.name || siteId}. ` +
            `Stop it and start ${agent?.name || agentId}?`
        );
        if (!ok) {
          navigate(`/agents/${encodeURIComponent(siteId)}/${st.agentId}`);
          return;
        }
        await window.electronAPI.terminalStop(siteId);
      }

      const res = await window.electronAPI.launchAgent(siteId, agentId);
      if (!cancelled && res?.error) setError(res.error);
    })();

    return () => {
      cancelled = true;
    };
  }, [siteId, agentId, navigate]);

  const stop = async () => {
    await window.electronAPI.terminalStop(siteId);
    navigate('/agents');
  };

  if (!siteId || !agentId) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <div className="icon-tile w-12 h-12 bg-[#af52de] mb-4">
          <TerminalIcon size={24} strokeWidth={2} />
        </div>
        <p className="text-[15px] font-semibold text-gray-900">Agents</p>
        <p className="mt-1 max-w-sm text-[13px] text-gray-500">
          Pick a site in the sidebar, expand it, and choose an AI agent to open it
          in that site&rsquo;s directory.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <p className="text-[13px] text-red-600 dark:text-red-400">{error}</p>
        <Button className="mt-3" onClick={() => navigate('/agents')}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span className="icon-tile w-[26px] h-[26px] bg-[#28c840]">
            <TerminalIcon size={15} strokeWidth={2.2} />
          </span>
          <div>
            <p className="text-[13px] font-medium text-gray-900">{meta.agentName}</p>
            <p className="text-xs text-gray-500">{meta.siteName}</p>
          </div>
        </div>
        <Button variant="danger" onClick={stop}>
          <Square size={12} strokeWidth={2.5} fill="currentColor" />
          Stop
        </Button>
      </div>
      <div className="flex-1 min-h-0">
        <Terminal
          key={`${siteId}:${agentId}`}
          siteId={siteId}
          agentId={agentId}
          onExited={() => navigate('/agents')}
        />
      </div>
    </div>
  );
}
