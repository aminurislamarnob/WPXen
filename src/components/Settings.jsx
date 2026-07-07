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
  Lock,
  Layers,
  Trash2,
  Archive,
  Cloud,
  FolderOpen as FolderReveal,
} from 'lucide-react';
import { Card, Row, SectionLabel, Toggle, Button } from './ui';

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

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
  const [caStatus, setCaStatus] = useState(null);
  const [blueprints, setBlueprints] = useState([]);
  const [deletingBlueprint, setDeletingBlueprint] = useState(null);
  const [backupSettings, setBackupSettings] = useState(null);
  const [cloudProviders, setCloudProviders] = useState(null);
  const [cloudBusy, setCloudBusy] = useState(null); // providerId being (dis)connected
  const [cloudMessage, setCloudMessage] = useState(null);

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
    window.electronAPI
      .getCaStatus()
      .then(setCaStatus)
      .catch(() => {});
    refreshBlueprints();
    window.electronAPI
      .getBackupSettings()
      .then(setBackupSettings)
      .catch(() => {});
    refreshCloud();
  }, []);

  function refreshCloud() {
    window.electronAPI
      .getCloudStatus()
      .then((r) => setCloudProviders(r?.success ? r.providers : null))
      .catch(() => {});
  }

  async function saveBackupSettings(patch) {
    setBackupSettings((s) => ({ ...s, ...patch }));
    await window.electronAPI.setBackupSettings(patch);
  }

  async function handleCloudConnect(providerId) {
    setCloudBusy(providerId);
    setCloudMessage(null);
    const res = await window.electronAPI.cloudConnect(providerId);
    setCloudBusy(null);
    if (res?.success) {
      setCloudMessage({
        type: 'success',
        text: `Connected${res.account?.email ? ` as ${res.account.email}` : ''}.`,
      });
    } else {
      setCloudMessage({ type: 'error', text: res?.error || 'Connection failed.' });
    }
    refreshCloud();
  }

  async function handleCloudDisconnect(providerId) {
    setCloudBusy(providerId);
    setCloudMessage(null);
    await window.electronAPI.cloudDisconnect(providerId);
    setCloudBusy(null);
    refreshCloud();
  }

  function refreshBlueprints() {
    window.electronAPI
      .getBlueprints()
      .then((r) => setBlueprints(r.success ? r.blueprints : []))
      .catch(() => setBlueprints([]));
  }

  async function handleDeleteBlueprint(id) {
    setDeletingBlueprint(id);
    await window.electronAPI.deleteBlueprint(id);
    setDeletingBlueprint(null);
    refreshBlueprints();
  }

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
          <Row
            icon={
              caStatus?.trusted ? (
                <Lock size={18} className="text-wp-green flex-shrink-0" />
              ) : (
                <Lock size={18} className="text-gray-400 flex-shrink-0" />
              )
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
                  ? 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400'
                  : 'bg-gray-100 text-gray-500 dark:bg-white/10 dark:text-gray-400'
              }`}
            >
              {caStatus?.trusted ? 'Trusted' : 'Not installed'}
            </span>
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

      {/* Blueprints */}
      <div>
        <SectionLabel>Site Blueprints</SectionLabel>
        <Card>
          {blueprints.length === 0 ? (
            <div className="flex items-center gap-3 px-4 py-5 text-[13px] text-gray-500">
              <Layers size={18} className="text-gray-400 flex-shrink-0" />
              <span>
                No blueprints yet. Save one from a site’s menu (
                <span className="font-medium">Save as Blueprint…</span>) to create new
                sites from it.
              </span>
            </div>
          ) : (
            blueprints.map((bp) => (
              <Row
                key={bp.id}
                icon={<Layers size={18} className="text-wp-blue flex-shrink-0" />}
                title={bp.name}
                subtitle={`${bp.sourceSiteName ? `From ${bp.sourceSiteName} · ` : ''}PHP ${bp.phpVersion} · ${formatBytes(bp.sizeBytes)}${
                  bp.description ? ` · ${bp.description}` : ''
                }`}
              >
                <button
                  onClick={() => handleDeleteBlueprint(bp.id)}
                  disabled={deletingBlueprint === bp.id}
                  title="Delete blueprint"
                  className="btn-ghost text-xs text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                >
                  {deletingBlueprint === bp.id ? (
                    <Loader size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                </button>
              </Row>
            ))
          )}
        </Card>
        <p className="text-[11px] text-gray-400 mt-1.5 px-1">
          Blueprints are full snapshots (files + database) stored in WPHerd’s data folder.
          Create a site from one via{' '}
          <span className="font-medium">Add Site → From Blueprint</span>.
        </p>
      </div>

      {/* Backups & Cloud Sync */}
      <div>
        <SectionLabel>Backups</SectionLabel>
        <Card>
          <Row
            icon={<Archive size={18} className="text-gray-400 flex-shrink-0" />}
            title="Default Schedule"
            subtitle="Applies to every site without its own schedule"
          >
            <select
              value={backupSettings?.defaultSchedule || 'off'}
              onChange={(e) => saveBackupSettings({ defaultSchedule: e.target.value })}
              className="form-input !w-32 !py-1 text-[13px]"
            >
              <option value="off">Off</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </Row>
          <Row
            title="Keep Last"
            subtitle="Older snapshots are pruned automatically after each backup"
          >
            <input
              type="number"
              min={1}
              max={100}
              className="form-input font-mono !text-xs !w-20 text-center"
              value={backupSettings?.retainCount ?? 5}
              onChange={(e) =>
                saveBackupSettings({ retainCount: parseInt(e.target.value, 10) || 5 })
              }
            />
            <span className="text-xs text-gray-500">backups per site</span>
          </Row>
          <Row title="Disk Usage" subtitle="Total space used by all local backups">
            <span className="text-xs font-mono text-gray-700">
              {formatBytes(backupSettings?.totalBytes || 0)}
            </span>
            <button
              onClick={() => window.electronAPI.revealBackupsFolder()}
              className="btn-secondary !px-2.5 !py-1.5"
              title="Reveal backups folder"
            >
              <FolderReveal size={13} />
            </button>
          </Row>
        </Card>

        <div className="mt-4">
          <SectionLabel>Cloud Sync</SectionLabel>
          <Card>
            {cloudProviders ? (
              Object.values(cloudProviders).map((p) => (
                <Row
                  key={p.id}
                  icon={
                    <Cloud
                      size={18}
                      className={`flex-shrink-0 ${p.connected ? 'text-wp-blue' : 'text-gray-400'}`}
                    />
                  }
                  title={p.name}
                  subtitle={
                    !p.configured
                      ? 'Not available in this build'
                      : p.connected
                        ? `Connected${p.account?.email ? ` as ${p.account.email}` : ''}`
                        : 'Upload backup archives to your own account'
                  }
                >
                  {p.configured &&
                    (p.connected ? (
                      <button
                        onClick={() => handleCloudDisconnect(p.id)}
                        disabled={cloudBusy !== null}
                        className="btn-ghost text-xs text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                      >
                        {cloudBusy === p.id ? (
                          <Loader size={12} className="animate-spin" />
                        ) : null}
                        Disconnect
                      </button>
                    ) : (
                      <button
                        onClick={() => handleCloudConnect(p.id)}
                        disabled={cloudBusy !== null}
                        className="btn-secondary text-xs"
                      >
                        {cloudBusy === p.id ? (
                          <Loader size={12} className="animate-spin mr-1.5" />
                        ) : null}
                        Connect…
                      </button>
                    ))}
                </Row>
              ))
            ) : (
              <div className="px-4 py-4 text-xs text-gray-500">Loading…</div>
            )}
          </Card>
          {cloudMessage && (
            <div
              className={`flex items-start gap-2 px-3 py-2.5 rounded-lg mt-2 text-[13px] ${
                cloudMessage.type === 'error'
                  ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                  : 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400'
              }`}
            >
              <CheckCircle size={14} className="flex-shrink-0 mt-0.5" />
              {cloudMessage.text}
            </div>
          )}
          <p className="text-[11px] text-gray-400 mt-1.5 px-1">
            Connecting opens your browser to sign in. WPHerd only sees its own app folder
            and stores tokens encrypted in the macOS Keychain. Upload individual backups
            from a site&apos;s Backups tab, or enable per-site auto-upload.
          </p>
        </div>
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
