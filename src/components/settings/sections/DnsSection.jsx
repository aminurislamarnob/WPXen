import { useEffect, useState } from 'react';
import { CheckCircle, Loader, Lock, RefreshCw } from 'lucide-react';
import { Button, Card, SectionLabel, SettingsRow, StatusPill } from '../../ui';
import { useSettingsContext } from '../SettingsLayout';
import DnsResolverRow from './DnsResolverRow';

export default function DnsSection() {
  const { visible } = useSettingsContext();
  const [caStatus, setCaStatus] = useState(null);
  const [phpTrust, setPhpTrust] = useState(null);
  const [phpTrustLoading, setPhpTrustLoading] = useState(false);
  const [phpTrustMessage, setPhpTrustMessage] = useState(null);

  useEffect(() => {
    window.electronAPI
      .getCaStatus()
      .then(setCaStatus)
      .catch(() => {});
    window.electronAPI
      .getPhpTrustStatus()
      .then(setPhpTrust)
      .catch(() => {});
  }, []);

  async function handleRepairPhpTrust() {
    setPhpTrustLoading(true);
    setPhpTrustMessage(null);
    const result = await window.electronAPI.repairPhpTrust();
    setPhpTrustLoading(false);
    if (result.success) setPhpTrust(result);
    if (!result.success || !result.trusted) {
      setPhpTrustMessage({
        type: 'error',
        text: result.error || 'PHP still does not trust the local authority.',
      });
    }
  }

  return (
    <div>
      <SectionLabel>DNS &amp; HTTPS</SectionLabel>
      <Card>
        <DnsResolverRow visible={visible} />

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
          <StatusPill tone={caStatus?.trusted ? 'ok' : 'neutral'}>
            {caStatus?.trusted ? 'Trusted' : 'Not installed'}
          </StatusPill>
        </SettingsRow>

        <SettingsRow
          id="dns.phpTrust"
          visible={visible}
          icon={
            <Lock
              size={18}
              className={`flex-shrink-0 ${
                phpTrust?.trusted ? 'text-status-running' : 'text-muted-foreground'
              }`}
            />
          }
          title="PHP trusts the local authority"
          subtitle={phpTrustSubtitle(phpTrust)}
        >
          {phpTrust?.trusted || !phpTrust?.localAuthority ? (
            <StatusPill tone={phpTrust?.trusted ? 'ok' : 'neutral'}>
              {phpTrust?.trusted ? 'Trusted' : 'Not installed'}
            </StatusPill>
          ) : (
            <Button onClick={handleRepairPhpTrust} disabled={phpTrustLoading}>
              {phpTrustLoading ? (
                <Loader size={13} className="animate-spin" />
              ) : (
                <RefreshCw size={13} />
              )}
              Repair
            </Button>
          )}
        </SettingsRow>
      </Card>

      {phpTrustMessage && (
        <div
          className={`flex items-start gap-2 px-3 py-2.5 rounded-lg mt-2 text-[13px] ${
            phpTrustMessage.type === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-status-running/10 text-status-running'
          }`}
        >
          <CheckCircle size={14} className="flex-shrink-0 mt-0.5" />
          {phpTrustMessage.text}
        </div>
      )}
    </div>
  );
}

// What the PHP-trust row says. Not trusted with a local authority present means
// the bundle is missing or stale, or a PHP version isn't pointed at it yet.
function phpTrustSubtitle(status) {
  if (!status) return 'Checking…';
  if (status.trusted) {
    return 'PHP and WordPress verify HTTPS calls to local Sites, public sites included.';
  }
  if (!status.localAuthority) {
    return 'Set up with the certificate authority when you first enable HTTPS on a site.';
  }
  if (!status.bundle)
    return 'The trust bundle is missing — HTTPS calls from PHP will fail.';
  if (!status.current) return 'The trust bundle is out of date with the local authority.';
  const missing = (status.versions || [])
    .filter((v) => !v.configured)
    .map((v) => v.version);
  return missing.length
    ? `PHP ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not using the trust bundle yet.`
    : 'No PHP version is installed yet.';
}
