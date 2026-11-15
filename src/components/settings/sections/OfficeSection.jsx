import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle,
  Loader,
  RefreshCw,
  Webhook,
  ZapOff,
} from 'lucide-react';
import { Button, Card, SectionLabel, SettingsRow } from '../../ui';
import { useSettings } from '../../../lib/useSettings';
import { useSettingsContext } from '../SettingsLayout';
import { ENVIRONMENTS, environmentById } from '../../../lib/office/scene/environments.js';
import cityShot from '../../../assets/office-environments/city.webp';
import spaceShot from '../../../assets/office-environments/space.webp';
import islandShot from '../../../assets/office-environments/island.webp';
import underwaterShot from '../../../assets/office-environments/underwater.webp';
import cyberpunkShot from '../../../assets/office-environments/cyberpunk.webp';
import greenShot from '../../../assets/office-environments/green.webp';

// Status is file stats on the main side, so polling it is cheap. It keeps the
// row honest when the hook is changed outside WPXen (a hand edit, another
// tool, node removed) while Settings is open.
const STATUS_POLL_MS = 5000;

const DONE_TEXT = {
  install: {
    changed: 'Hook installed. Claude Code sessions now report their state instantly.',
    unchanged: 'Already installed — nothing to change.',
  },
  uninstall: {
    changed: 'Hook removed. Agents Verse falls back to inferred waiting.',
    unchanged: 'Nothing to remove.',
  },
};

/**
 * What each environment looks like: a still of the Office in it, taken in the
 * dev sandbox (`thumb=1`, see dev/office-sandbox.jsx). Retake it when a world
 * changes how it looks.
 */
const ENV_SHOTS = {
  city: cityShot,
  space: spaceShot,
  island: islandShot,
  underwater: underwaterShot,
  cyberpunk: cyberpunkShot,
  green: greenShot,
};

// The world around the Office room (`office.environment`). A card per
// environment rather than a dropdown: the name alone doesn't say what the
// world looks like or does. Compact: the still shows the look (the blurb is
// the hover title), the line beside it says how the world reacts.
function EnvironmentPicker() {
  const { settings, setSetting } = useSettings();
  const { visible } = useSettingsContext();
  if (visible && !visible.includes('office.environment')) return null;
  const current = environmentById(settings['office.environment']).id;
  return (
    <div>
      <SectionLabel>Environment</SectionLabel>
      <div
        role="radiogroup"
        aria-label="Agents Verse environment"
        className="grid grid-cols-2 gap-2"
      >
        {ENVIRONMENTS.map((env) => {
          const selected = env.id === current;
          return (
            <button
              key={env.id}
              type="button"
              role="radio"
              aria-checked={selected}
              title={env.blurb}
              onClick={() => setSetting('office.environment', env.id)}
              className={`text-left bg-card border rounded-xl shadow-sm p-2 flex items-center gap-3 transition-colors ${
                selected
                  ? 'border-highlight ring-1 ring-highlight'
                  : 'border-border hover:bg-accent'
              }`}
            >
              <span className="relative flex-shrink-0 w-28 aspect-video rounded-md overflow-hidden bg-muted">
                <img
                  src={ENV_SHOTS[env.id]}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  className="w-full h-full object-cover"
                />
                {selected && (
                  <span className="absolute top-1 right-1 flex items-center justify-center w-4 h-4 rounded-full bg-highlight text-highlight-foreground shadow-sm">
                    <Check size={10} strokeWidth={3} />
                  </span>
                )}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-foreground truncate">
                  {env.name}
                </span>
                <span className="block text-[11px] leading-snug text-muted-foreground mt-0.5">
                  {env.reacts}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
        Click a shuttle, boat, fish school or bird out there to focus its agent, the same
        as clicking the agent itself.
      </p>
    </div>
  );
}

function subtitleFor(status) {
  if (!status?.installed)
    return 'Not installed — Agents Verse infers waiting from transcripts (up to ~15 s lag).';
  if (status.problem) return `Needs reinstall — ${status.problem.message}`;
  return 'Installed — sessions report permission prompts and tool use instantly.';
}

// Settings → Office: the Claude Code hook one-click (ticket #187). Installing
// writes the forwarder into the app's data folder and adds tagged entries to
// the user's global Claude settings, so permission prompts raise
// waiting_on_user instantly instead of after the inference threshold.
// An action row like DnsSection's sudoers flow — status lives in the Claude
// settings file, not in WPXen's store. Every write is previewed first: the
// diff is shown and nothing touches the file until the user confirms.
export default function OfficeSection() {
  const { visible } = useSettingsContext();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  // The previewed change awaiting confirmation: { command, token, diffs }.
  const [pending, setPending] = useState(null);

  const refreshStatus = useCallback(async () => {
    setStatus(await window.electronAPI.officeHooksStatus());
  }, []);

  useEffect(() => {
    refreshStatus();
    const timer = setInterval(refreshStatus, STATUS_POLL_MS);
    window.addEventListener('focus', refreshStatus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refreshStatus);
    };
  }, [refreshStatus]);

  async function apply(command, token) {
    setLoading(true);
    const result = await window.electronAPI.officeHooksApply(command, token);
    setPending(null);
    if (result.success) {
      await refreshStatus();
      setMessage({
        type: 'success',
        text: DONE_TEXT[command][result.changed ? 'changed' : 'unchanged'],
      });
    } else {
      setMessage({ type: 'error', text: result.error || 'The change failed.' });
    }
    setLoading(false);
  }

  // Install and uninstall alike: preview, then confirm before any write. A
  // preview that changes no file in the user's Claude settings applies at once
  // (install still refreshes the forwarder in WPXen's own data folder).
  async function run(command) {
    setLoading(true);
    setMessage(null);
    setPending(null);
    const preview = await window.electronAPI.officeHooksPreview(command);
    if (!preview.success) {
      setMessage({ type: 'error', text: preview.error || 'The preview failed.' });
      setLoading(false);
      return;
    }
    const diffs = [
      preview.changed && { path: preview.settingsPath, diff: preview.diff },
      ...preview.legacy.filter((l) => l.changed),
    ].filter(Boolean);
    if (diffs.length === 0) {
      await apply(command, preview.token);
      return;
    }
    setPending({ command, token: preview.token, diffs });
    setLoading(false);
  }

  const needsReinstall = status?.installed && status.problem;

  return (
    <div className="space-y-6">
      <EnvironmentPicker />
      <HookSettings
        visible={visible}
        status={status}
        loading={loading}
        pending={pending}
        setPending={setPending}
        message={message}
        needsReinstall={needsReinstall}
        run={run}
        apply={apply}
      />
    </div>
  );
}

function HookSettings({
  visible,
  status,
  loading,
  pending,
  setPending,
  message,
  needsReinstall,
  run,
  apply,
}) {
  if (visible && !visible.includes('office.hook')) return null;
  return (
    <div>
      <SectionLabel>Claude Code Hook</SectionLabel>
      <Card>
        <SettingsRow
          id="office.hook"
          visible={visible}
          icon={
            <Webhook
              size={18}
              className={`flex-shrink-0 ${
                needsReinstall
                  ? 'text-status-warning'
                  : status?.installed
                    ? 'text-status-running'
                    : 'text-muted-foreground'
              }`}
            />
          }
          title="Claude Code hook"
          subtitle={subtitleFor(status)}
        >
          {loading && <Loader size={14} className="animate-spin text-muted-foreground" />}
          {(!status?.installed || needsReinstall) && (
            <Button onClick={() => run('install')} disabled={loading || !!pending}>
              {needsReinstall ? <RefreshCw size={14} /> : <Webhook size={14} />}
              {needsReinstall ? 'Reinstall' : 'Install'}
            </Button>
          )}
          {status?.installed && (
            <Button
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => run('uninstall')}
              disabled={loading || !!pending}
            >
              <ZapOff size={14} />
              Uninstall
            </Button>
          )}
        </SettingsRow>
      </Card>

      <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
        Adds <span className="font-mono"># wpxen</span>-tagged entries to{' '}
        <span className="font-mono">~/.claude/settings.json</span> (backed up to{' '}
        <span className="font-mono">.bak</span> first) running a small forwarder with your
        system <span className="font-mono">node</span>, pinned by its full path. Hooks
        from other tools are left untouched; uninstall removes exactly ours.
      </p>

      {pending && (
        <div className="mt-2">
          <p className="text-[11px] text-muted-foreground px-1 mb-1">
            {pending.command === 'install' ? 'Installing' : 'Uninstalling'} will make
            these changes. Nothing is written until you confirm.
          </p>
          {pending.diffs.map(({ path, diff }) => (
            <pre
              key={path}
              className="sheet-well rounded-lg px-3 py-2.5 mb-2 text-[11px] font-mono overflow-x-auto whitespace-pre text-muted-foreground max-h-64"
            >
              {diff}
            </pre>
          ))}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPending(null)} disabled={loading}>
              Cancel
            </Button>
            <Button
              variant={pending.command === 'uninstall' ? 'danger' : 'primary'}
              onClick={() => apply(pending.command, pending.token)}
              disabled={loading}
            >
              {loading && <Loader size={14} className="animate-spin" />}
              {pending.command === 'install' ? 'Write changes' : 'Remove hook'}
            </Button>
          </div>
        </div>
      )}

      {message && (
        <div
          className={`flex items-start gap-2 px-3 py-2.5 rounded-lg mt-2 text-[13px] ${
            message.type === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-status-running/10 text-status-running'
          }`}
        >
          {message.type === 'error' ? (
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          ) : (
            <CheckCircle size={14} className="flex-shrink-0 mt-0.5" />
          )}
          {message.text}
        </div>
      )}
    </div>
  );
}
