import { useEffect, useState } from 'react';
import { CheckCircle, Loader, Wifi } from 'lucide-react';
import { SettingsRow } from '../../ui';
import { dnsHealthView, runDnsAction } from '../../../lib/dnsHealth';

const TONE_TEXT = {
  ok: 'text-status-running',
  error: 'text-destructive',
  pending: 'text-muted-foreground',
  neutral: 'text-muted-foreground',
};

const TONE_PILL = {
  ok: 'bg-status-running/10 text-status-running',
  error: 'bg-destructive/10 text-destructive',
  pending: 'bg-muted text-muted-foreground',
  neutral: 'bg-muted text-muted-foreground',
};

// "*.test DNS Resolution": the real lookup's verdict, with the fix it calls
// for (Repair / Use a different port), or Set Up… before DNS exists. Each
// action is one admin prompt in the main process.
export default function DnsResolverRow({ visible }) {
  const [dns, setDns] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    // A fresh lookup when the section opens, then whatever the poller pushes.
    window.electronAPI
      .checkDns()
      .then((r) => r?.dnsmasq && setDns(r.dnsmasq))
      .catch(() => {});
    return window.electronAPI.on('service-status-update', (status) => {
      if (status?.dnsmasq) setDns(status.dnsmasq);
    });
  }, []);

  const view = dnsHealthView(dns);

  async function run(call, successText) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await call();
      if (result?.dnsmasq) setDns(result.dnsmasq);
      setMessage(
        result?.success
          ? { type: 'success', text: successText(result) }
          : { type: 'error', text: result?.error || 'Something went wrong.' }
      );
    } finally {
      setBusy(false);
    }
  }

  const handleSetup = () =>
    run(
      () => window.electronAPI.setupDnsmasq(),
      () => '*.test DNS configured! Sites will resolve to localhost.'
    );

  const handleAction = (kind) =>
    run(
      () => runDnsAction(kind),
      (r) =>
        kind === 'change-port'
          ? `DNS moved to port ${r.dnsmasq?.port}.`
          : r.dnsmasq?.health?.state === 'healthy'
            ? 'DNS repaired — *.test resolves again.'
            : 'Setup re-run, but *.test still doesn’t resolve.'
    );

  return (
    <>
      <SettingsRow
        id="dns.resolver"
        visible={visible}
        icon={<Wifi size={18} className={`flex-shrink-0 ${TONE_TEXT[view.tone]}`} />}
        title="*.test DNS Resolution"
        subtitle={
          view.tone === 'error' ? (
            <span className="text-destructive">{view.detail}</span>
          ) : (
            view.detail ||
            'Route *.test domains to localhost via dnsmasq (admin privileges required)'
          )
        }
      >
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${TONE_PILL[view.tone]}`}
        >
          {view.label}
        </span>
        {view.action ? (
          <button
            onClick={() => handleAction(view.action.kind)}
            disabled={busy}
            className="btn-secondary"
          >
            {busy ? <Loader size={13} className="animate-spin" /> : null}
            {view.action.label}
          </button>
        ) : view.tone !== 'ok' ? (
          <button onClick={handleSetup} disabled={busy} className="btn-secondary">
            {busy ? <Loader size={13} className="animate-spin" /> : null}
            Set Up…
          </button>
        ) : null}
      </SettingsRow>
      {message && (
        <div
          className={`flex items-start gap-2 px-3 py-2.5 mx-3 mb-3 rounded-lg text-[13px] ${
            message.type === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-status-running/10 text-status-running'
          }`}
        >
          <CheckCircle size={14} className="flex-shrink-0 mt-0.5" />
          {message.text}
        </div>
      )}
    </>
  );
}
