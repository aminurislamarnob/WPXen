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
} from 'lucide-react';

export default function Settings() {
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
    <div className="p-6 max-w-2xl animate-fade-in space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-0.5">Configure WPHerd preferences</p>
      </div>

      {/* General */}
      <section className="bg-white rounded-xl border border-surface-border shadow-card">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-800">General</h2>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">
              Default Sites Directory
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                className="form-input flex-1 font-mono text-xs"
                value={settings.sitesDir}
                onChange={(e) => setSettings((s) => ({ ...s, sitesDir: e.target.value }))}
                placeholder="~/Sites"
              />
              <button onClick={handleSelectSitesDir} className="btn-secondary px-3">
                <FolderOpen size={15} />
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              New WordPress sites will be created here
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">
              Default PHP Version
            </label>
            <input
              type="text"
              className="form-input font-mono text-xs"
              value={settings.defaultPhpVersion || ''}
              onChange={(e) =>
                setSettings((s) => ({ ...s, defaultPhpVersion: e.target.value }))
              }
              placeholder="8.2"
            />
          </div>

          <label className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-700">Start at Login</p>
              <p className="text-xs text-gray-400">
                Launch WPHerd when you log into macOS
              </p>
            </div>
            <div
              onClick={() =>
                setSettings((s) => ({ ...s, startAtLogin: !s.startAtLogin }))
              }
              className={`relative w-10 h-6 rounded-full cursor-pointer transition-colors ${
                settings.startAtLogin ? 'bg-wp-blue' : 'bg-gray-200'
              }`}
            >
              <span
                className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                  settings.startAtLogin ? 'translate-x-5' : 'translate-x-1'
                }`}
              />
            </div>
          </label>
        </div>
      </section>

      {/* Database */}
      <section className="bg-white rounded-xl border border-surface-border shadow-card">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-800">Database</h2>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-gray-400">
            Credentials WPHerd uses to create databases and configure WordPress. Leave the
            password blank for a passwordless root.
          </p>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">
              MySQL User
            </label>
            <input
              type="text"
              className="form-input font-mono text-xs"
              value={settings.dbUser || ''}
              onChange={(e) => setSettings((s) => ({ ...s, dbUser: e.target.value }))}
              placeholder="root"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">
              MySQL Password
            </label>
            <input
              type="password"
              className="form-input font-mono text-xs"
              value={settings.dbPassword || ''}
              onChange={(e) => setSettings((s) => ({ ...s, dbPassword: e.target.value }))}
              placeholder="(none)"
            />
          </div>
        </div>
      </section>

      {/* Permissions (sudoers) */}
      <section
        className={`rounded-xl border shadow-card ${sudoers?.configured ? 'bg-white border-surface-border' : 'bg-amber-50 border-amber-200'}`}
      >
        <div className="px-5 py-4 border-b border-black/5">
          <div className="flex items-center gap-2">
            {sudoers?.configured ? (
              <ShieldCheck size={15} className="text-wp-green" />
            ) : (
              <ShieldAlert size={15} className="text-amber-600" />
            )}
            <h2 className="text-sm font-semibold text-gray-800">Permissions</h2>
            <span
              className={`ml-auto text-xs font-medium px-2 py-0.5 rounded-full ${sudoers?.configured ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}
            >
              {sudoers?.configured ? 'Configured' : 'Not set up'}
            </span>
          </div>
        </div>
        <div className="p-5">
          <p className="text-sm text-gray-600 mb-2">
            {sudoers?.configured
              ? 'WPHerd can start and stop services silently — no password prompts.'
              : 'Without this, macOS will ask for your password every time a service starts or stops.'}
          </p>
          <p className="text-xs text-gray-400 mb-4">
            Installs{' '}
            <span className="font-mono bg-gray-100 px-1 rounded">
              /etc/sudoers.d/wpherd
            </span>{' '}
            granting passwordless{' '}
            <span className="font-mono bg-gray-100 px-1 rounded">sudo brew services</span>
            . Requires your password <strong>once</strong> to set up, then never again.
          </p>

          {sudoersMessage && (
            <div
              className={`flex items-start gap-2 px-3 py-2.5 rounded-lg mb-4 text-sm ${sudoersMessage.type === 'error' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}
            >
              <CheckCircle size={14} className="flex-shrink-0 mt-0.5" />
              {sudoersMessage.text}
            </div>
          )}

          <div className="flex gap-2">
            {!sudoers?.configured ? (
              <button
                onClick={handleInstallSudoers}
                disabled={sudoersLoading}
                className="btn-primary text-sm"
              >
                {sudoersLoading ? (
                  <Loader size={13} className="animate-spin mr-1.5" />
                ) : (
                  <ShieldCheck size={13} className="mr-1.5" />
                )}
                Setup Passwordless Services
              </button>
            ) : (
              <button
                onClick={handleUninstallSudoers}
                disabled={sudoersLoading}
                className="btn-ghost text-xs text-gray-400 hover:text-red-600"
              >
                {sudoersLoading ? (
                  <Loader size={12} className="animate-spin mr-1.5" />
                ) : (
                  <ShieldOff size={12} className="mr-1.5" />
                )}
                Remove Permissions
              </button>
            )}
          </div>
        </div>
      </section>

      {/* DNS / dnsmasq setup */}
      <section className="bg-white rounded-xl border border-surface-border shadow-card">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-800">DNS Configuration</h2>
        </div>
        <div className="p-5">
          <p className="text-sm text-gray-600 mb-4">
            Configure dnsmasq to resolve{' '}
            <span className="font-mono text-wp-blue">*.test</span> domains to localhost.
            This requires administrator privileges.
          </p>
          {dnsMessage && (
            <div
              className={`flex items-start gap-2 px-3 py-2.5 rounded-lg mb-4 text-sm ${
                dnsMessage.type === 'error'
                  ? 'bg-red-50 text-red-700'
                  : 'bg-green-50 text-green-700'
              }`}
            >
              <CheckCircle size={14} className="flex-shrink-0 mt-0.5" />
              {dnsMessage.text}
            </div>
          )}
          <button
            onClick={handleSetupDns}
            disabled={dnsSetupLoading}
            className="btn-secondary text-sm"
          >
            {dnsSetupLoading ? (
              <Loader size={13} className="animate-spin mr-1.5" />
            ) : (
              <Wifi size={13} className="mr-1.5" />
            )}
            Setup *.test DNS
          </button>
        </div>
      </section>

      {/* Dependencies */}
      <section className="bg-white rounded-xl border border-surface-border shadow-card">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-800">Dependencies</h2>
        </div>
        <div className="p-5 space-y-2">
          {deps &&
            Object.entries(deps).map(([name, installed]) => (
              <div key={name} className="flex items-center justify-between py-1.5">
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${installed ? 'bg-wp-green' : 'bg-gray-300'}`}
                  />
                  <span className="text-sm text-gray-700 capitalize font-mono text-xs">
                    {name === 'wpCli' ? 'wp-cli' : name}
                  </span>
                </div>
                <span
                  className={`text-xs font-medium ${
                    installed ? 'text-wp-green' : 'text-gray-400'
                  }`}
                >
                  {installed ? 'Installed' : 'Not found'}
                </span>
              </div>
            ))}
        </div>
        {deps && !deps.brew && (
          <div className="px-5 pb-4">
            <div className="flex items-start gap-2 bg-orange-50 rounded-lg px-3 py-2.5 text-xs text-orange-700">
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
          </div>
        )}
      </section>

      {/* System info */}
      {sysInfo && (
        <section className="bg-white rounded-xl border border-surface-border shadow-card">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-800">System Info</h2>
          </div>
          <div className="p-5 space-y-2 font-mono text-xs text-gray-500">
            {[
              ['Platform', `${sysInfo.platform} (${sysInfo.arch})`],
              ['Homebrew Prefix', sysInfo.brewPrefix || 'Not detected'],
              ['WPHerd Version', sysInfo.appVersion],
              ['Electron', sysInfo.electronVersion],
              ['Node.js', sysInfo.nodeVersion],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-gray-400">{label}</span>
                <span className="text-gray-700">{value}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Save button */}
      <div className="flex justify-end pb-4">
        <button onClick={handleSave} disabled={saving} className="btn-primary text-sm">
          {saved ? (
            <>
              <CheckCircle size={14} className="mr-1.5" />
              Saved!
            </>
          ) : saving ? (
            <>
              <Loader size={14} className="animate-spin mr-1.5" />
              Saving…
            </>
          ) : (
            <>
              <Save size={14} className="mr-1.5" />
              Save Settings
            </>
          )}
        </button>
      </div>
    </div>
  );
}
