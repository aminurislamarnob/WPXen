import { useState, useEffect } from 'react';
import {
  FolderOpen,
  Save,
  CheckCircle,
  Info,
  ExternalLink,
  Terminal,
  Wifi,
  Loader,
} from 'lucide-react';

export default function Settings() {
  const [settings, setSettings] = useState({
    sitesDir: '',
    defaultPhpVersion: '',
    startAtLogin: false,
    brewPrefix: '',
  });
  const [sysInfo, setSysInfo] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dnsSetupLoading, setDnsSetupLoading] = useState(false);
  const [dnsMessage, setDnsMessage] = useState(null);
  const [deps, setDeps] = useState(null);

  useEffect(() => {
    Promise.all([
      window.electronAPI.getSettings(),
      window.electronAPI.getSystemInfo(),
      window.electronAPI.checkDependencies(),
    ]).then(([s, sys, d]) => {
      setSettings(s);
      setSysInfo(sys);
      setDeps(d);
    });
  }, []);

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
        ? { type: 'success', text: '*.test DNS configured! Sites will resolve to localhost.' }
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
            <p className="text-xs text-gray-400 mt-1">New WordPress sites will be created here</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">
              Default PHP Version
            </label>
            <input
              type="text"
              className="form-input font-mono text-xs"
              value={settings.defaultPhpVersion || ''}
              onChange={(e) => setSettings((s) => ({ ...s, defaultPhpVersion: e.target.value }))}
              placeholder="8.2"
            />
          </div>

          <label className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-700">Start at Login</p>
              <p className="text-xs text-gray-400">Launch WPHerd when you log into macOS</p>
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

      {/* DNS / dnsmasq setup */}
      <section className="bg-white rounded-xl border border-surface-border shadow-card">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-800">DNS Configuration</h2>
        </div>
        <div className="p-5">
          <p className="text-sm text-gray-600 mb-4">
            Configure dnsmasq to resolve <span className="font-mono text-wp-blue">*.test</span>{' '}
            domains to localhost. This requires administrator privileges.
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
                  onClick={() =>
                    window.electronAPI.openSiteInBrowser('https://brew.sh')
                  }
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
