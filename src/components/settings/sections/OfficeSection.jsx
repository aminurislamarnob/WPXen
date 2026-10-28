import { useEffect, useState } from 'react';
import { CheckCircle, Loader, Webhook, ZapOff } from 'lucide-react';
import { Card, SectionLabel, SettingsRow } from '../../ui';
import { useSettingsContext } from '../SettingsLayout';

// Settings → Office: the Claude Code hook one-click (ticket #187). Installing
// writes the forwarder into the app's data folder and adds tagged entries to
// the user's global Claude settings, so permission prompts raise
// waiting_on_user instantly instead of after the inference threshold.
// An action row like DnsSection's sudoers flow — status lives in the Claude
// settings file, not in WPXen's store.
export default function OfficeSection() {
  const { visible } = useSettingsContext();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [diff, setDiff] = useState(null);

  useEffect(() => {
    window.electronAPI.officeHooksStatus().then(setStatus);
  }, []);

  async function handleInstall() {
    setLoading(true);
    setMessage(null);
    setDiff(null);
    const result = await window.electronAPI.officeHooksInstall();
    if (result.success) {
      setStatus(await window.electronAPI.officeHooksStatus());
      setMessage({
        type: 'success',
        text: result.changed
          ? 'Hook installed. Claude Code sessions now report their state instantly.'
          : 'Already installed — nothing to change.',
      });
      setDiff(result.diff || null);
    } else {
      setMessage({ type: 'error', text: result.error || 'Install failed.' });
    }
    setLoading(false);
  }

  async function handleUninstall() {
    setLoading(true);
    setMessage(null);
    setDiff(null);
    const result = await window.electronAPI.officeHooksUninstall();
    if (result.success) {
      setStatus(await window.electronAPI.officeHooksStatus());
      setMessage({
        type: 'success',
        text: result.changed
          ? 'Hook removed. The Office falls back to inferred waiting.'
          : 'Nothing to remove.',
      });
      setDiff(result.diff || null);
    } else {
      setMessage({ type: 'error', text: result.error || 'Uninstall failed.' });
    }
    setLoading(false);
  }

  return (
    <div>
      <SectionLabel>Office</SectionLabel>
      <Card>
        <SettingsRow
          id="office.hook"
          visible={visible}
          icon={
            <Webhook
              size={18}
              className={`flex-shrink-0 ${
                status?.installed ? 'text-status-running' : 'text-muted-foreground'
              }`}
            />
          }
          title="Claude Code hook"
          subtitle={
            status?.installed
              ? 'Installed — sessions report permission prompts and tool use instantly.'
              : 'Not installed — the Office infers waiting from transcripts (up to ~15 s lag).'
          }
        >
          {!status?.installed ? (
            <button
              onClick={handleInstall}
              disabled={loading}
              className="btn-secondary text-xs"
            >
              {loading ? (
                <Loader size={12} className="animate-spin" />
              ) : (
                <Webhook size={12} />
              )}
              Install
            </button>
          ) : (
            <button
              onClick={handleUninstall}
              disabled={loading}
              className="btn-ghost text-xs text-muted-foreground hover:text-destructive"
            >
              {loading ? (
                <Loader size={12} className="animate-spin" />
              ) : (
                <ZapOff size={12} />
              )}
              Uninstall
            </button>
          )}
        </SettingsRow>
      </Card>

      <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
        Adds <span className="font-mono"># wpxen</span>-tagged entries to{' '}
        <span className="font-mono">~/.claude/settings.json</span> (backed up to{' '}
        <span className="font-mono">.bak</span> first) running a small forwarder via your
        system <span className="font-mono">node</span>. Hooks from other tools are left
        untouched; uninstall removes exactly ours.
      </p>

      {message && (
        <div
          className={`flex items-start gap-2 px-3 py-2.5 rounded-lg mt-2 text-[13px] ${
            message.type === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-status-running/10 text-status-running'
          }`}
        >
          <CheckCircle size={14} className="flex-shrink-0 mt-0.5" />
          {message.text}
        </div>
      )}

      {diff && (
        <div className="mt-2">
          <p className="text-[11px] text-muted-foreground px-1 mb-1">
            Changes written to the settings file:
          </p>
          <pre className="sheet-well rounded-lg px-3 py-2.5 text-[11px] font-mono overflow-x-auto whitespace-pre text-muted-foreground max-h-64">
            {diff}
          </pre>
        </div>
      )}
    </div>
  );
}
