import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Download, Loader, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button, Card, SectionLabel, Toggle, Tooltip } from '../../ui';
import { TextSetting } from '../controls';
import { ProviderIcon } from '../../providerIcons';
import { useSettings } from '../../../lib/useSettings';
import { useSettingsContext } from '../SettingsLayout';
import { useAgentInstall } from '../../../lib/useAgentInstall';
import { installerSubtitle, installerTooltip } from '../../../lib/installerLabel';

export default function AgentsSection() {
  const { settings, setSetting } = useSettings();
  const { visible } = useSettingsContext();
  const [agents, setAgents] = useState(null);
  const [draft, setDraft] = useState({ id: '', name: '', cmd: '' });
  const [addError, setAddError] = useState('');
  // One row's command editor at a time: the field is the row's detail, not a
  // second list, and several open at once just rebuilds the stacked form this
  // replaced.
  const [open, setOpen] = useState(null);

  const refresh = useCallback(() => {
    window.electronAPI
      .listAllAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);

  useEffect(refresh, [refresh]);

  const {
    installing,
    logLine,
    result: installResult,
    install: installAgent,
  } = useAgentInstall({ onInstalled: refresh });

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

  // A search that matched only the command entry opens the editors it was
  // looking for, rather than leaving the user to expand seven rows to find it.
  const commandsSearch =
    Boolean(visible) &&
    visible.includes('agents.commands') &&
    !visible.includes('agents.enabled');

  // The launch-command editor lives inside each agent row now, so one row
  // answers to two registry entries. Settings search filters on ids, and a row
  // matching either has to survive — otherwise searching "launch command"
  // would empty the section that contains the field.
  const rows = agents
    .filter(
      () =>
        !visible ||
        visible.includes('agents.enabled') ||
        visible.includes('agents.commands')
    )
    .map((agent) => ({
      agent,
      overridden: Boolean((commands[agent.id] || '').trim()),
    }));

  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>Available Agents</SectionLabel>
        <Card>
          {rows.map(({ agent, overridden }, i) => {
            const isOpen = commandsSearch || open === agent.id;
            const isInstalling = installing === agent.id;
            return (
              <div
                key={agent.id}
                className={i > 0 ? 'border-t border-border' : undefined}
              >
                <div className="settings-row">
                  {/* The brand mark replaces the status dot: `brand` is what
                      carries detection here, exactly as in the Agents sidebar
                      — an installed agent shows its own color, a missing one
                      stays muted and can't be mistaken for active. The
                      subtitle and Install button say the rest. */}
                  <ProviderIcon
                    agentId={agent.id}
                    brand={agent.detected}
                    size={16}
                    className={`flex-shrink-0 ${
                      agent.detected ? '' : 'text-muted-foreground/50'
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] text-foreground truncate">{agent.name}</p>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {isInstalling
                        ? logLine || 'Installing…'
                        : agent.detected
                          ? `${agent.cmd} · ${agent.path}`
                          : agent.installer
                            ? installerSubtitle(agent.installer)
                            : `Not installed — ${
                                agent.install || `${agent.cmd} not found on PATH`
                              }`}
                    </p>
                  </div>

                  {!agent.detected && agent.installer && (
                    <Button
                      variant="secondary"
                      onClick={() => installAgent(agent)}
                      disabled={!!installing}
                      title={installerTooltip(agent.installer)}
                      aria-label={`Install ${agent.name} — ${installerTooltip(agent.installer)}`}
                    >
                      {isInstalling ? (
                        <Loader size={13} className="animate-spin" />
                      ) : (
                        <Download size={13} />
                      )}
                      {isInstalling ? 'Installing…' : 'Install'}
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

                  {/* Reads off while the CLI is missing, because that is what
                      the launcher actually does — an uninstalled agent never
                      appears there regardless of this setting, and a lit
                      switch would claim otherwise. The stored preference is
                      untouched, so it springs back to whatever it was once the
                      agent installs. */}
                  <Toggle
                    checked={agent.detected && agent.enabled}
                    disabled={!agent.detected}
                    onChange={(v) => toggleAgent(agent.id, v)}
                    label={`Show ${agent.name} in the launcher`}
                  />

                  {/* A dot marks an agent whose command was customised, so an
                      override is visible without opening every row — otherwise
                      collapsing the editor would hide the one thing worth
                      noticing at a glance. */}
                  <button
                    onClick={() => setOpen(isOpen ? null : agent.id)}
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Hide' : 'Show'} ${agent.name} launch command`}
                    title="Launch command"
                    className="btn-ghost flex-shrink-0 relative text-muted-foreground hover:text-foreground"
                  >
                    <ChevronDown
                      size={14}
                      className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    />
                    {overridden && !isOpen && (
                      <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-highlight" />
                    )}
                  </button>
                </div>

                {/* pl-11 lines the field and its hint up with the row's title
                    rather than the card edge: px-4 (16) + the 16px mark +
                    gap-3 (12) = 44px. Keep it in step if the row's padding,
                    icon size or gap changes. */}
                {/* Animated by grid-template-rows 0fr → 1fr rather than a
                    max-height guess: the row grows to exactly its content, so
                    a long default command that wraps can't be clipped or leave
                    the panel easing through empty space. The panel stays
                    mounted for the transition to have something to animate,
                    and `inert` keeps the collapsed field out of the tab order
                    and off screen readers. */}
                <div
                  className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
                    isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                  }`}
                >
                  <div className="overflow-hidden" {...(isOpen ? {} : { inert: '' })}>
                    <div className="pl-11 pr-4 pb-3 pt-0.5 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <TextSetting
                          value={commands[agent.id] || ''}
                          onCommit={(v) => setCommand(agent.id, v)}
                          ariaLabel={`${agent.name} launch command`}
                          className="font-mono !text-xs flex-1 !w-auto"
                          placeholder={agent.defaultCmd}
                        />
                        {overridden && (
                          <button
                            onClick={() => setCommand(agent.id, '')}
                            className="btn-ghost text-xs text-muted-foreground hover:text-foreground flex-shrink-0"
                          >
                            <RotateCcw size={12} />
                            Reset
                          </button>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Typed into the shell when a session starts. Blank uses the default{' '}
                        <span className="font-mono">{agent.defaultCmd}</span>.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {rows.length === 0 && (
            <p className="settings-row text-xs text-muted-foreground">
              No agents match your search.
            </p>
          )}
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
          A site’s agent launcher lists the agents that are both installed and enabled.
          Disabling one here leaves it installed — it just stops appearing there. An agent
          that isn’t installed can’t be toggled; install it first, and its stored
          preference applies. Expand a row to change the command it launches with.
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
