import { useEffect, useState } from 'react';
import {
  CheckCircle,
  Loader,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Wifi,
} from 'lucide-react';
import { Button, Card, SectionLabel, SettingsRow } from '../../ui';
import { useSettingsContext } from '../SettingsLayout';

export default function DnsSection() {
  const { visible } = useSettingsContext();
  const [sudoers, setSudoers] = useState(null);
  const [sudoersLoading, setSudoersLoading] = useState(false);
  const [sudoersMessage, setSudoersMessage] = useState(null);
  const [dnsLoading, setDnsLoading] = useState(false);
  const [dnsMessage, setDnsMessage] = useState(null);
  const [caStatus, setCaStatus] = useState(null);
  const [phpTrust, setPhpTrust] = useState(null);
  const [phpTrustLoading, setPhpTrustLoading] = useState(false);
  const [phpTrustMessage, setPhpTrustMessage] = useState(null);

  useEffect(() => {
    window.electronAPI.checkSudoers().then(setSudoers);
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

  async function handleInstallSudoers() {
    setSudoersLoading(true);
    setSudoersMessage(null);
    const result = await window.electronAPI.installSudoers();
    if (result.success) {
      setSudoers(await window.electronAPI.checkSudoers());
      setSudoersMessage({
        type: 'success',
        text: 'Permissions configured. Services now start silently.',
      });
    } else {
      setSudoersMessage({
        type: 'error',
        text: result.error || 'Setup failed or was cancelled.',
      });
    }
    setSudoersLoading(false);
  }

  async function handleUninstallSudoers() {
    setSudoersLoading(true);
    setSudoersMessage(null);
    const result = await window.electronAPI.uninstallSudoers();
    if (result.success) {
      setSudoers({ configured: false });
      setSudoersMessage({
        type: 'success',
        text: 'Permissions removed. Services will require your password again.',
      });
    } else {
      setSudoersMessage({ type: 'error', text: result.error });
    }
    setSudoersLoading(false);
  }

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
          id="dns.sudoers"
          visible={visible}
          icon={
            sudoers?.configured ? (
              <ShieldCheck size={18} className="text-status-running flex-shrink-0" />
            ) : (
              <ShieldAlert size={18} className="text-status-warning flex-shrink-0" />
            )
          }
          title="Passwordless DNS Control"
          subtitle={
            sudoers?.configured
              ? 'WPXen manages the dnsmasq resolver silently — no password prompts.'
              : 'Without this, macOS asks for your password when dnsmasq starts or stops.'
          }
        >
          {!sudoers?.configured ? (
            <button
              onClick={handleInstallSudoers}
              disabled={sudoersLoading}
              className="btn-secondary text-xs"
            >
              {sudoersLoading ? (
                <Loader size={12} className="animate-spin" />
              ) : (
                <ShieldCheck size={12} />
              )}
              Set Up…
            </button>
          ) : (
            <button
              onClick={handleUninstallSudoers}
              disabled={sudoersLoading}
              className="btn-ghost text-xs text-muted-foreground hover:text-destructive"
            >
              {sudoersLoading ? (
                <Loader size={12} className="animate-spin" />
              ) : (
                <ShieldOff size={12} />
              )}
              Remove
            </button>
          )}
        </SettingsRow>

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
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
                phpTrust?.trusted
                  ? 'bg-status-running/10 text-status-running'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {phpTrust?.trusted ? 'Trusted' : 'Not installed'}
            </span>
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

      <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
        Installs <span className="font-mono">/etc/sudoers.d/wpxen</span> granting
        passwordless <span className="font-mono">sudo brew services</span>, used only for
        dnsmasq — the other services run inside WPXen and need no privileges.
      </p>

      {[sudoersMessage, dnsMessage, phpTrustMessage].filter(Boolean).map((m, i) => (
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
