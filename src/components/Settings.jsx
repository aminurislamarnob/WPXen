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
} from 'lucide-react';
import { Button, Card, Row, SectionLabel, Toggle, Tooltip } from './ui';

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
  }, []);

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
                <ShieldCheck size={18} className="text-status-running flex-shrink-0" />
              ) : (
                <ShieldAlert size={18} className="text-status-warning flex-shrink-0" />
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
                className="btn-ghost text-xs text-muted-foreground hover:text-destructive"
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
            icon={<Wifi size={18} className="text-muted-foreground flex-shrink-0" />}
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
                <Lock size={18} className="text-status-running flex-shrink-0" />
              ) : (
                <Lock size={18} className="text-muted-foreground flex-shrink-0" />
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
                  ? 'bg-status-running/10 text-status-running'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {caStatus?.trusted ? 'Trusted' : 'Not installed'}
            </span>
          </Row>
        </Card>
        <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
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
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-status-running/10 text-status-running'
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
            <div className="flex items-center gap-3 px-4 py-5 text-[13px] text-muted-foreground">
              <Layers size={18} className="text-muted-foreground flex-shrink-0" />
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
                icon={<Layers size={18} className="text-highlight flex-shrink-0" />}
                title={bp.name}
                subtitle={`${bp.sourceSiteName ? `From ${bp.sourceSiteName} · ` : ''}PHP ${bp.phpVersion} · ${formatBytes(bp.sizeBytes)}${
                  bp.description ? ` · ${bp.description}` : ''
                }`}
              >
                <Tooltip label="Delete blueprint">
                  <button
                    onClick={() => handleDeleteBlueprint(bp.id)}
                    disabled={deletingBlueprint === bp.id}
                    aria-label="Delete blueprint"
                    className="btn-ghost text-xs text-muted-foreground hover:text-destructive"
                  >
                    {deletingBlueprint === bp.id ? (
                      <Loader size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={12} />
                    )}
                  </button>
                </Tooltip>
              </Row>
            ))
          )}
        </Card>
        <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
          Blueprints are full snapshots (files + database) stored in WPHerd’s data folder.
          Create a site from one via{' '}
          <span className="font-medium">Add Site → From Blueprint</span>.
        </p>
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
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${installed ? 'bg-status-running' : 'bg-border'}`}
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
                    installed ? 'text-status-running' : 'text-muted-foreground'
                  }`}
                >
                  {installed ? 'Installed' : 'Not found'}
                </span>
              </Row>
            ))}
        </Card>
        {deps && !deps.brew && (
          <div className="flex items-start gap-2 bg-status-warning/10 rounded-lg px-3 py-2.5 mt-2 text-xs text-status-warning">
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
              <Row
                key={label}
                title={<span className="text-muted-foreground">{label}</span>}
              >
                <span className="font-mono text-xs text-foreground">{value}</span>
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
