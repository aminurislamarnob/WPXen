import { useState, useEffect } from 'react';
import {
  FolderOpen,
  Save,
  CheckCircle,
  Info,
  Wifi,
  Loader,
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  Wand2,
} from 'lucide-react';
import { Card, Row, SectionLabel, Toggle, Button } from './ui';

export default function Settings({ onOpenWizard }) {
  const [settings, setSettings] = useState({
    sitesDir: '',
    defaultPhpVersion: '',
    startAtLogin: false,
    dbUser: 'root',
    dbPassword: '',
    brewPrefix: '',
  });
  const [sysInfo, setSysInfo] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dnsSetupLoading, setDnsSetupLoading] = useState(false);
  const [dnsMessage, setDnsMessage] = useState(null);
  const [deps, setDeps] = useState(null);
  const [sudoers, setSudoers] = useState(null);
  const [sudoersLoading, setSudoersLoading] = useState(false);
  const [sudoersMessage, setSudoersMessage] = useState(null);

  useEffect(() => {
    Promise.all([
      window.electronAPI.getSettings(),
      window.electronAPI.getSystemInfo(),
      window.electronAPI.checkDependencies(),
      window.electronAPI.checkSudoers(),
    ]).then(([s, sys, d, sud]) => {
      setSettings(s);
      setSysInfo(sys);
      setDeps(d);
      setSudoers(sud);
    });
  }, []);

  // Main process re-checks dependencies whenever the app regains focus (e.g.
  // after installing something via Homebrew), so the list stays current
  // without a manual refresh.
  useEffect(() => {
    window.electronAPI.on('dependencies-update', (fresh) => setDeps(fresh));
    return () => window.electronAPI.off('dependencies-update');
  }, []);

  async function handleInstallSudoers() {
    setSudoersLoading(true);
    setSudoersMessage(null);
    const result = await window.electronAPI.installSudoers();
    if (result.success) {
      const sud = await window.electronAPI.checkSudoers();
      setSudoers(sud);
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

  async function handleSave() {
    setSaving(true);
    await window.electronAPI.saveSettings(settings);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  async function handleSelectSitesDir() {
    const folder = await window.electronAPI.selectFolder();
    if (folder) setSettings((s) => ({ ...s, sitesDir: folder }));
  }

  async function handleSetupDns() {
    setDnsSetupLoading(true);
    setDnsMessage(null);
    const result = await window.electronAPI.setupDnsmasq();
    setDnsSetupLoading(false);
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
    <div className="px-6 pb-6 max-w-[735px] mx-auto animate-fade-in space-y-6">
      {/* General */}
      <div>
        <SectionLabel>General</SectionLabel>
        <Card>
          <Row
            title="Default Sites Directory"
            subtitle="New WordPress sites will be created here"
          >
            <input
              type="text"
              className="form-input font-mono !text-xs !w-56"
              value={settings.sitesDir}
              onChange={(e) => setSettings((s) => ({ ...s, sitesDir: e.target.value }))}
              placeholder="~/Sites"
            />
            <button
              onClick={handleSelectSitesDir}
              className="btn-secondary !px-2.5 !py-1.5"
            >
              <FolderOpen size={13} />
            </button>
          </Row>
          <Row title="Default PHP Version">
            <input
              type="text"
              className="form-input font-mono !text-xs !w-24 text-center"
              value={settings.defaultPhpVersion || ''}
              onChange={(e) =>
                setSettings((s) => ({ ...s, defaultPhpVersion: e.target.value }))
              }
              placeholder="8.2"
            />
          </Row>
          <Row title="Start at Login" subtitle="Launch WPHerd when you log into macOS">
            <Toggle
              checked={!!settings.startAtLogin}
              onChange={(v) => setSettings((s) => ({ ...s, startAtLogin: v }))}
              label="Start at Login"
            />
          </Row>
        </Card>
      </div>

      {/* Database */}
      <div>
        <SectionLabel>Database</SectionLabel>
        <Card>
          <Row
            title="MySQL User"
            subtitle="Used to create databases and configure WordPress"
          >
            <input
              type="text"
              className="form-input font-mono !text-xs !w-40"
              value={settings.dbUser || ''}
              onChange={(e) => setSettings((s) => ({ ...s, dbUser: e.target.value }))}
              placeholder="root"
            />
          </Row>
          <Row title="MySQL Password" subtitle="Leave blank for a passwordless root">
            <input
              type="password"
              className="form-input font-mono !text-xs !w-40"
              value={settings.dbPassword || ''}
              onChange={(e) => setSettings((s) => ({ ...s, dbPassword: e.target.value }))}
              placeholder="(none)"
            />
          </Row>
        </Card>
      </div>

      {/* Permissions (sudoers) + DNS */}
      <div>
        <SectionLabel>DNS &amp; Permissions</SectionLabel>
        <Card>
          <Row
            icon={
              sudoers?.configured ? (
                <ShieldCheck size={18} className="text-wp-green flex-shrink-0" />
              ) : (
                <ShieldAlert
                  size={18}
                  className="text-amber-600 dark:text-amber-400 flex-shrink-0"
                />
              )
            }
            title="Passwordless DNS Control"
            subtitle={
              sudoers?.configured
                ? 'WPHerd manages the dnsmasq resolver silently — no password prompts.'
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
                  <Loader size={12} className="animate-spin mr-1.5" />
                ) : (
                  <ShieldCheck size={12} className="mr-1.5" />
                )}
                Set Up…
              </button>
            ) : (
              <button
                onClick={handleUninstallSudoers}
                disabled={sudoersLoading}
                className="btn-ghost text-xs text-gray-400 hover:text-red-600 dark:hover:text-red-400"
              >
                {sudoersLoading ? (
                  <Loader size={12} className="animate-spin mr-1.5" />
                ) : (
                  <ShieldOff size={12} className="mr-1.5" />
                )}
                Remove
              </button>
            )}
          </Row>
          <Row
            icon={<Wifi size={18} className="text-gray-400 flex-shrink-0" />}
            title="*.test DNS Resolution"
            subtitle="Route *.test domains to localhost via dnsmasq (admin privileges required)"
          >
            <button
              onClick={handleSetupDns}
              disabled={dnsSetupLoading}
              className="btn-secondary text-xs"
            >
              {dnsSetupLoading ? (
                <Loader size={12} className="animate-spin mr-1.5" />
              ) : null}
              Set Up…
            </button>
          </Row>
        </Card>
        <p className="text-[11px] text-gray-400 mt-1.5 px-1">
          Installs <span className="font-mono">/etc/sudoers.d/wpherd</span> granting
          passwordless <span className="font-mono">sudo brew services</span>, used only
          for dnsmasq — the other services run inside WPHerd and need no privileges.
        </p>
        {(sudoersMessage || dnsMessage) &&
          [sudoersMessage, dnsMessage].filter(Boolean).map((m, i) => (
            <div
              key={i}
              className={`flex items-start gap-2 px-3 py-2.5 rounded-lg mt-2 text-[13px] ${
                m.type === 'error'
                  ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                  : 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400'
              }`}
            >
              <CheckCircle size={14} className="flex-shrink-0 mt-0.5" />
              {m.text}
            </div>
          ))}
      </div>

      {/* Dependencies */}
      <div>
        <SectionLabel
          right={
            onOpenWizard && (
              <Button variant="secondary" onClick={onOpenWizard}>
                <Wand2 size={12} strokeWidth={2.5} />
                Run setup wizard
              </Button>
            )
          }
        >
          Dependencies
        </SectionLabel>
        <Card>
          {deps &&
            Object.entries(deps).map(([name, installed]) => (
              <Row
                key={name}
                icon={
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${installed ? 'bg-wp-green' : 'bg-gray-300'}`}
                  />
                }
                title={
                  <span className="font-mono text-xs">
                    {name === 'wpCli' ? 'wp-cli' : name}
                  </span>
                }
              >
                <span
                  className={`text-xs font-medium ${
                    installed ? 'text-wp-green' : 'text-gray-400'
                  }`}
                >
                  {installed ? 'Installed' : 'Not found'}
                </span>
              </Row>
            ))}
        </Card>
        {deps && !deps.brew && (
          <div className="flex items-start gap-2 bg-orange-50 dark:bg-orange-500/10 rounded-lg px-3 py-2.5 mt-2 text-xs text-orange-700 dark:text-orange-300">
            <Info size={13} className="flex-shrink-0 mt-0.5" />
            <span>
              Install Homebrew first:{' '}
              <button
                onClick={() => window.electronAPI.openSiteInBrowser('https://brew.sh')}
                className="underline"
              >
                brew.sh
              </button>
            </span>
          </div>
        )}
      </div>

      {/* System info */}
      {sysInfo && (
        <div>
          <SectionLabel>About</SectionLabel>
          <Card>
            {[
              ['Platform', `${sysInfo.platform} (${sysInfo.arch})`],
              ['Homebrew Prefix', sysInfo.brewPrefix || 'Not detected'],
              ['WPHerd Version', sysInfo.appVersion],
              ['Electron', sysInfo.electronVersion],
              ['Node.js', sysInfo.nodeVersion],
            ].map(([label, value]) => (
              <Row key={label} title={<span className="text-gray-500">{label}</span>}>
                <span className="font-mono text-xs text-gray-700">{value}</span>
              </Row>
            ))}
          </Card>
        </div>
      )}

      {/* Save button */}
      <div className="flex justify-end">
        <button onClick={handleSave} disabled={saving} className="btn-primary">
          {saved ? (
            <>
              <CheckCircle size={12} strokeWidth={2.5} />
              Saved!
            </>
          ) : saving ? (
            <>
              <Loader size={12} className="animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <Save size={12} strokeWidth={2.5} />
              Save
            </>
          )}
        </button>
      </div>
    </div>
  );
}
