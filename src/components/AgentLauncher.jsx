import { useState, useEffect, useCallback } from 'react';
import { Terminal as TerminalIcon, Play, Square, Loader } from 'lucide-react';
import { Button, Card, Row, SectionLabel, IconTile } from './ui';
import Terminal from './Terminal';

// Agent Launcher panel (Q1/Q5/Q7). Lists the curated Agents, detected on PATH;
// launches one into a Session for this Site (one at a time — Q2). When a Session
// is running the pane becomes the embedded terminal (Q4, revised: inline).
export default function AgentLauncher({ site }) {
  const [agents, setAgents] = useState(null);
  const [status, setStatus] = useState({ running: false });
  const [busy, setBusy] = useState(null); // agentId mid-launch

  const refresh = useCallback(async () => {
    const [list, st] = await Promise.all([
      window.electronAPI.listAgents(),
      window.electronAPI.agentStatus(site.id),
    ]);
    setAgents(list);
    setStatus(st);
  }, [site.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const launch = async (agentId) => {
    setBusy(agentId);
    const res = await window.electronAPI.launchAgent(site.id, agentId);
    setBusy(null);
    if (res?.error) {
      window.alert(res.error);
      return;
    }
    refresh();
  };

  const stop = async () => {
    await window.electronAPI.terminalStop(site.id);
    refresh();
  };

  // Running Session → embedded terminal with a slim header.
  if (status.running) {
    return (
      <div className="flex flex-col h-[calc(100vh-190px)] min-h-[440px]">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <IconTile icon={TerminalIcon} color="green" size={22} />
            <div>
              <p className="text-[13px] font-medium text-gray-900">
                {status.agentName}
              </p>
              <p className="text-xs text-gray-500">Running · {site.name}</p>
            </div>
          </div>
          <Button variant="danger" onClick={stop}>
            <Square size={12} strokeWidth={2.5} fill="currentColor" />
            Stop
          </Button>
        </div>
        <div className="flex-1 min-h-0">
          <Terminal siteId={site.id} agentId={status.agentId} onExited={refresh} />
        </div>
      </div>
    );
  }

  // No Session → the launch list.
  return (
    <div>
      <SectionLabel>Agents</SectionLabel>
      <p className="px-1 mb-3 text-xs text-gray-500">
        Launch an AI coding agent in a terminal rooted at this site&rsquo;s folder.
      </p>

      <Card>
        {(agents || []).map((agent) => (
          <Row
            key={agent.id}
            icon={<IconTile icon={TerminalIcon} color={agent.detected ? 'blue' : 'gray'} />}
            title={agent.name}
            subtitle={agent.detected ? agent.cmd : `Not installed · ${agent.install}`}
          >
            <Button
              variant="secondary"
              disabled={!agent.detected || busy === agent.id}
              onClick={() => launch(agent.id)}
            >
              {busy === agent.id ? (
                <Loader size={12} strokeWidth={2.5} className="animate-spin" />
              ) : (
                <Play size={12} strokeWidth={2.5} fill="currentColor" />
              )}
              Launch
            </Button>
          </Row>
        ))}
        {agents && agents.length === 0 && <Row title="No agents configured" />}
      </Card>
    </div>
  );
}
