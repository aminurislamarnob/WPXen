import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader, Plus, Trash2 } from 'lucide-react';
import { Button, Card, SectionLabel, SettingsRow, Toggle, Tooltip } from '../../ui';
import { TextSetting } from '../controls';
import { useSettings } from '../../../lib/useSettings';
import { useSettingsContext } from '../SettingsLayout';

export default function AgentsSection() {
  const { settings, setSetting } = useSettings();
  const { visible } = useSettingsContext();
  const [agents, setAgents] = useState(null);
  const [draft, setDraft] = useState({ id: '', name: '', cmd: '' });
  const [addError, setAddError] = useState('');
  // id of the agent currently installing, its last brew output line, and the
  // outcome banner. One install at a time — brew takes a lock anyway.
  const [installing, setInstalling] = useState(null);
  const [logLine, setLogLine] = useState('');
  const [installResult, setInstallResult] = useState(null);

  const refresh = useCallback(() => {
    window.electronAPI
      .listAllAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);

  useEffect(refresh, [refresh]);

  // brew streams for minutes; keep only the newest line so the row doesn't
  // grow. The ref keeps the listener stable without re-subscribing per install.
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

  async function installAgent(agent) {
    setInstalling(agent.id);
    setLogLine('');
    setInstallResult(null);
    const result = await window.electronAPI.installAgent(agent.id);
    if (result.success && result.detected) {
      setInstallResult({ type: 'success', text: `${agent.name} installed.` });
    } else if (result.success) {
      // brew succeeded but the binary still isn't on PATH — Antigravity's cask
      // installs the IDE that carries `agy`, and a new shell may be needed for
      // anything else. Say so rather than showing a bare success.
      setInstallResult({
        type: 'info',
        text: `${agent.name} installed, but ${agent.cmd} isn’t on PATH yet — open a new terminal, or enable its CLI from the app.`,
      });
    } else {
      setInstallResult({ type: 'error', text: result.error });
    }
    setInstalling(null);
    setLogLine('');
    refresh();
  }

  const enabled = settings['agents.enabled'] || [];
  const commands = settings['agents.commands'] || {};
  const custom = settings['agents.custom']?.list || [];

  // An empty list means "all enabled". Turning the first one off therefore has
  // to materialise the full list minus that agent, or it would read as "none".
  async function toggleAgent(id, on) {
    const allIds = (agents || []).map((a) => a.id);
    const current = enabled.length ? enabled : allIds;
    const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id);
    await setSetting('agents.enabled', next);
    refresh();
  }

  async function setCommand(id, cmd) {
    const next = { ...commands };
    if (cmd.trim()) next[id] = cmd.trim();
    else delete next[id];
    await setSetting('agents.commands', next);
    refresh();
  }

  async function addCustom() {
    const id = draft.id.trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(id)) {
      setAddError('Id must be lowercase letters, numbers or hyphens.');
      return;
    }
    if ((agents || []).some((a) => a.id === id)) {
      setAddError(`An agent with the id “${id}” already exists.`);
      return;
    }
    if (!draft.cmd.trim()) {
      setAddError('A launch command is required.');
      return;
    }
    setAddError('');
    await setSetting('agents.custom', {
      list: [...custom, { id, name: draft.name.trim() || id, cmd: draft.cmd.trim() }],
    });
    setDraft({ id: '', name: '', cmd: '' });
    refresh();
  }

  async function removeCustom(id) {
    await setSetting('agents.custom', { list: custom.filter((a) => a.id !== id) });
    refresh();
  }

  if (!agents) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground px-1 py-4">
        <Loader size={14} className="animate-spin" />
        Detecting agents…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>Available Agents</SectionLabel>
        <Card>
          {agents.map((agent) => (
            <SettingsRow
              key={agent.id}
              id="agents.enabled"
              visible={visible}
              icon={
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    agent.detected ? 'bg-status-running' : 'bg-border'
                  }`}
                />
              }
              title={agent.name}
              subtitle={
                installing === agent.id
                  ? logLine || `Installing ${agent.brew?.name}…`
                  : agent.detected
                    ? `${agent.cmd} · ${agent.path}`
                    : agent.brew
                      ? `Not installed — brew install${agent.brew.cask ? ' --cask' : ''} ${agent.brew.name}`
                      : `Not installed — ${agent.install || `${agent.cmd} not found on PATH`}`
              }
            >
              {!agent.detected && agent.brew && (
                <Button
                  variant="secondary"
                  onClick={() => installAgent(agent)}
                  disabled={!!installing}
                  aria-label={`Install ${agent.name} with Homebrew`}
                >
                  {installing === agent.id ? (
                    <Loader size={13} className="animate-spin" />
                  ) : (
                    <Download size={13} />
                  )}
                  {installing === agent.id ? 'Installing…' : 'Install'}
                </Button>
              )}
              {agent.isCustom && (
                <Tooltip label="Remove agent">
                  <button
                    onClick={() => removeCustom(agent.id)}
                    aria-label={`Remove ${agent.name}`}
                    className="btn-ghost text-xs text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 size={12} />
                  </button>
                </Tooltip>
              )}
              <Toggle
                checked={agent.enabled}
                onChange={(v) => toggleAgent(agent.id, v)}
                label={`Show ${agent.name} in the launcher`}
              />
            </SettingsRow>
          ))}
        </Card>
        {installResult && (
          <p
            className={`text-[11px] mt-1.5 px-1 ${
              installResult.type === 'error'
                ? 'text-destructive'
                : installResult.type === 'success'
                  ? 'text-status-running'
                  : 'text-muted-foreground'
            }`}
          >
            {installResult.text}
          </p>
        )}
        <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
          Disabled agents stay installed — they just don’t appear in a site’s agent
          launcher. Install runs Homebrew; agents without a Homebrew package show their
          own install command instead.
        </p>
      </div>

      <div>
        <SectionLabel>Launch Commands</SectionLabel>
        <Card>
          {agents.map((agent) => (
            <SettingsRow
              key={agent.id}
              id="agents.commands"
              visible={visible}
              title={agent.name}
              subtitle="Typed into the shell when a session starts"
            >
              <TextSetting
                value={commands[agent.id] || ''}
                onCommit={(v) => setCommand(agent.id, v)}
                ariaLabel={`${agent.name} launch command`}
                className="font-mono !text-xs !w-56"
                placeholder={agent.isCustom ? agent.cmd : agent.cmd}
              />
            </SettingsRow>
          ))}
        </Card>
        <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
          Leave blank to use the default. Arguments are allowed —{' '}
          <span className="font-mono">claude --resume</span>.
        </p>
      </div>

      <div>
        <SectionLabel>Add an Agent</SectionLabel>
        <Card>
          <div className="settings-row gap-2">
            <input
              type="text"
              aria-label="New agent id"
              className="form-input font-mono !text-xs !w-28"
              placeholder="id"
              value={draft.id}
              onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
            />
            <input
              type="text"
              aria-label="New agent name"
              className="form-input !text-xs flex-1 !w-auto"
              placeholder="Display name"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
            <input
              type="text"
              aria-label="New agent command"
              className="form-input font-mono !text-xs !w-40"
              placeholder="command"
              value={draft.cmd}
              onChange={(e) => setDraft((d) => ({ ...d, cmd: e.target.value }))}
            />
            <button onClick={addCustom} className="btn-secondary text-xs">
              <Plus size={12} />
              Add
            </button>
          </div>
        </Card>
        {addError && (
          <p className="text-[11px] text-destructive mt-1.5 px-1">{addError}</p>
        )}
      </div>
    </div>
  );
}
