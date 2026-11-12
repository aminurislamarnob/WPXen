import { useEffect, useState } from 'react';
import { CheckCircle, Loader, Lock, Wifi } from 'lucide-react';
import { Card, SectionLabel, SettingsRow } from '../../ui';
import { useSettingsContext } from '../SettingsLayout';

export default function DnsSection() {
  const { visible } = useSettingsContext();
  const [dnsLoading, setDnsLoading] = useState(false);
  const [dnsMessage, setDnsMessage] = useState(null);
  const [caStatus, setCaStatus] = useState(null);

  useEffect(() => {
    window.electronAPI
      .getCaStatus()
      .then(setCaStatus)
      .catch(() => {});
  }, []);

  async function handleSetupDns() {
    setDnsLoading(true);
    setDnsMessage(null);
    const result = await window.electronAPI.setupDnsmasq();
    setDnsLoading(false);
    setDnsMessage(
      result.success
        ? {
            type: 'success',
            text: '*.test DNS configured! Sites will resolve to localhost.',
          }
        : { type: 'error', text: result.error }
    );
  }

  return (
    <div>
      <SectionLabel>DNS &amp; HTTPS</SectionLabel>
      <Card>
        <SettingsRow
          id="dns.resolver"
          visible={visible}
          icon={<Wifi size={18} className="text-muted-foreground flex-shrink-0" />}
          title="*.test DNS Resolution"
          subtitle="Route *.test domains to localhost via dnsmasq (admin privileges required)"
        >
          <button
            onClick={handleSetupDns}
            disabled={dnsLoading}
            className="btn-secondary text-xs"
          >
            {dnsLoading ? <Loader size={12} className="animate-spin" /> : null}
            Set Up…
          </button>
        </SettingsRow>

        <SettingsRow
          id="dns.ca"
          visible={visible}
          icon={
            <Lock
              size={18}
              className={`flex-shrink-0 ${
                caStatus?.trusted ? 'text-status-running' : 'text-muted-foreground'
              }`}
            />
          }
          title="Local HTTPS Certificate Authority"
          subtitle={
            caStatus?.trusted
              ? 'Trusted — sites you switch to HTTPS get browser-trusted certificates.'
              : 'Not installed yet. Enabling HTTPS on any site sets it up automatically.'
          }
        >
          <span
            className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
              caStatus?.trusted
                ? 'bg-status-running/10 text-status-running'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {caStatus?.trusted ? 'Trusted' : 'Not installed'}
          </span>
        </SettingsRow>
      </Card>

      {[dnsMessage].filter(Boolean).map((m, i) => (
        <div
          key={i}
          className={`flex items-start gap-2 px-3 py-2.5 rounded-lg mt-2 text-[13px] ${
            m.type === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-status-running/10 text-status-running'
          }`}
        >
          <CheckCircle size={14} className="flex-shrink-0 mt-0.5" />
          {m.text}
        </div>
      ))}
    </div>
  );
}
