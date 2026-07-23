import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  ExternalLink,
  Settings,
  LayoutDashboard,
  Wrench,
  Code2,
  Server,
  Globe,
  Database,
  Folder,
  FileText,
  Terminal,
  HardDrive,
  Share2,
  Loader,
  Copy,
  Check,
  X,
  KeyRound,
  Pencil,
} from 'lucide-react';
import { Toggle } from './ui';
import ChangeUrlModal from './ChangeUrlModal';
import WpConfigManager from './WpConfigManager';
import SitePhpSettings from './SitePhpSettings';
import WpOverview from './WpOverview';
import WpPlugins from './WpPlugins';
import WpThemes from './WpThemes';
import SiteLogs from './SiteLogs';
import AgentLauncher from './AgentLauncher';
import { WordPressIcon } from './icons';

const NAV = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  {
    label: 'Configurations',
    icon: Wrench,
    group: true,
    children: [
      { id: 'wpconfig', label: 'WP Config' },
      { id: 'php', label: 'PHP' },
    ],
  },
  {
    label: 'WordPress',
    icon: Globe,
    group: true,
    children: [
      { id: 'wp-overview', label: 'Overview' },
      { id: 'wp-plugins', label: 'Plugins' },
      { id: 'wp-themes', label: 'Themes' },
    ],
  },
  { id: 'agents', label: 'Agents', icon: Terminal },
  { id: 'logs', label: 'Logs', icon: FileText },
];

function Overview({ site, onSaved }) {
  const [pmaBusy, setPmaBusy] = useState(false);
  const [tunnel, setTunnel] = useState(null);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState(null);

  // One-click admin (magic login)
  const oca = site.oneClickAdmin || {};
  const [ocaBusy, setOcaBusy] = useState(false);
  const [ocaError, setOcaError] = useState(null);
  const [changingUrl, setChangingUrl] = useState(false);
  const [adminUsers, setAdminUsers] = useState(null);
  const [selectedUser, setSelectedUser] = useState(oca.userId || '');

  // Load the admin-user list lazily the first time the panel needs it (when
  // enabled, or when the user flips the toggle on).
  async function loadAdminUsers() {
    if (adminUsers) return adminUsers;
    const res = await window.electronAPI.listAdminUsers(site.id);
    if (!res?.success) {
      setOcaError(res?.error || 'Could not load admin users.');
      return null;
    }
    setAdminUsers(res.users);
    if (!selectedUser && res.users[0]) setSelectedUser(res.users[0].id);
    return res.users;
  }

  useEffect(() => {
    if (oca.enabled) loadAdminUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id]);

  async function persistOneClick(enabled, userId) {
    setOcaBusy(true);
    setOcaError(null);
    const res = await window.electronAPI.setOneClickAdmin(site.id, { enabled, userId });
    setOcaBusy(false);
    if (!res?.success) {
      setOcaError(res?.error || 'Failed to update one-click admin.');
      return false;
    }
    onSaved?.();
    return true;
  }

  async function handleToggleOneClick(next) {
    if (next) {
      const users = await loadAdminUsers();
      if (!users || users.length === 0) {
        setOcaError('This site has no administrator accounts.');
        return;
      }
      const uid = selectedUser || users[0].id;
      setSelectedUser(uid);
      await persistOneClick(true, uid);
    } else {
      await persistOneClick(false);
    }
  }

  async function handleChangeUser(uid) {
    setSelectedUser(uid);
    if (oca.enabled) await persistOneClick(true, uid);
  }

  // Pick up any tunnel already running for this site and follow its state.
  useEffect(() => {
    window.electronAPI
      .getTunnels()
      .then((list) => setTunnel((list || []).find((t) => t.siteId === site.id) || null))
      .catch(() => {});

    const onTunnel = (t) => {
      if (!t || t.siteId !== site.id) return;
      setTunnel(t.status === 'stopped' ? null : t);
    };
    window.electronAPI.on('tunnel-update', onTunnel);
    return () => window.electronAPI.off('tunnel-update');
  }, [site.id]);

  async function handlePhpMyAdmin() {
    setPmaBusy(true);
    setActionError(null);
    const result = await window.electronAPI.openPhpMyAdmin(site.dbName);
    if (!result?.success) setActionError(result?.error || 'Failed to open phpMyAdmin.');
    setPmaBusy(false);
  }

  async function handleExpose() {
    if (tunnel) return; // already starting/running — panel below has the controls
    setActionError(null);
    setTunnel({ siteId: site.id, status: 'starting' });
    const result = await window.electronAPI.startTunnel(site.id);
    if (!result.success) {
      setTunnel(null);
      setActionError(result.error);
    }
  }

  async function handleStopTunnel() {
    await window.electronAPI.stopTunnel(site.id);
    setTunnel(null);
  }

  function copyTunnelUrl() {
    if (!tunnel?.url) return;
    navigator.clipboard.writeText(tunnel.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const tunnelActive =
    tunnel && (tunnel.status === 'starting' || tunnel.status === 'running');

  const actions = [
    {
      icon: ExternalLink,
      label: 'Open',
      onClick: () => window.electronAPI.openSiteInBrowser(site.url),
    },
    {
      icon: WordPressIcon,
      label: 'wp-admin',
      onClick: () => window.electronAPI.openWpAdmin(site.id),
    },
    {
      icon: pmaBusy ? Loader : HardDrive,
      label: 'phpMyAdmin',
      onClick: handlePhpMyAdmin,
      spinning: pmaBusy,
      disabled: pmaBusy,
    },
    {
      icon: Folder,
      label: 'Finder',
      onClick: () => window.electronAPI.openSiteInFinder(site.path),
    },
    {
      icon: Terminal,
      label: 'Terminal',
      onClick: () => window.electronAPI.openSiteInTerminal(site.path),
    },
    {
      icon: tunnel?.status === 'starting' ? Loader : Share2,
      label: 'Expose',
      onClick: handleExpose,
      spinning: tunnel?.status === 'starting',
      active: tunnelActive,
    },
  ];

  const rows = [
    { icon: Globe, label: 'Domain', value: site.domain },
    { icon: ExternalLink, label: 'URL', value: site.url },
    { icon: Folder, label: 'Path', value: site.path },
    { icon: Database, label: 'Database', value: site.dbName },
    { icon: Code2, label: 'PHP version', value: site.phpVersion },
    { icon: Server, label: 'WordPress', value: site.wpVersion || 'unknown' },
  ];

  return (
    <div>
      <h2 className="text-[15px] font-bold text-gray-900 mb-4">Overview</h2>

      {/* Quick actions */}
      <div className="settings-card p-3 mb-4">
        <div className="grid grid-cols-3 gap-1.5">
          {actions.map(({ icon: Icon, label, onClick, spinning, disabled, active }) => (
            <button
              key={label}
              onClick={onClick}
              disabled={disabled}
              title={label}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors font-medium disabled:opacity-50 justify-start ${
                active
                  ? 'bg-wp-blue/10 text-wp-blue hover:bg-wp-blue/15'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              }`}
            >
              <Icon size={12} className={spinning ? 'animate-spin' : ''} />
              {label}
            </button>
          ))}
        </div>

        {/* Live tunnel state */}
        {tunnel?.status === 'running' && (
          <div className="mt-2 px-2.5 py-2 bg-gray-50 rounded-lg flex items-center gap-1.5 animate-fade-in">
            <button
              onClick={() => window.electronAPI.openSiteInBrowser(tunnel.url)}
              className="flex-1 min-w-0 text-left text-xs text-wp-blue font-mono truncate hover:underline"
              title={tunnel.url}
            >
              {tunnel.url}
            </button>
            <button
              onClick={copyTunnelUrl}
              title="Copy URL"
              className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-200"
            >
              {copied ? (
                <Check size={13} className="text-wp-green" />
              ) : (
                <Copy size={13} />
              )}
            </button>
            <button
              onClick={handleStopTunnel}
              title="Stop sharing"
              className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10"
            >
              <X size={13} />
            </button>
          </div>
        )}
        {tunnel?.status === 'error' && (
          <p className="mt-2 px-2.5 text-xs text-red-600 dark:text-red-400">
            {tunnel.error || 'Failed to start the tunnel.'}
          </p>
        )}
        {actionError && (
          <p className="mt-2 px-2.5 text-xs text-red-600 dark:text-red-400">
            {actionError}
          </p>
        )}
      </div>

      {/* One-click admin (magic login) */}
      <div className="settings-card mb-4">
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="icon-tile bg-[#5856d6] w-7 h-7 flex-shrink-0">
            <KeyRound size={15} />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] text-gray-900">Magic Login</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Log into wp-admin without a password. Local access only.
            </p>
          </div>
          {ocaBusy ? (
            <Loader size={14} className="animate-spin text-gray-400" />
          ) : (
            <Toggle
              checked={!!oca.enabled}
              onChange={handleToggleOneClick}
              label="Magic Login"
            />
          )}
        </div>
        {oca.enabled && (
          <div className="flex items-center gap-3 px-4 py-3 border-t border-surface-hairline animate-fade-in">
            <span className="w-7 flex-shrink-0" />
            <label className="text-[13px] text-gray-500 flex-1">Log in as</label>
            <select
              value={selectedUser}
              onChange={(e) => handleChangeUser(Number(e.target.value))}
              disabled={ocaBusy || !adminUsers}
              className="form-input !w-52 !py-1 text-[13px]"
            >
              {!adminUsers && <option>Loading…</option>}
              {(adminUsers || []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.login})
                </option>
              ))}
            </select>
          </div>
        )}
        {ocaError && (
          <p className="px-4 pb-3 text-xs text-red-600 dark:text-red-400">{ocaError}</p>
        )}
      </div>

      <div className="settings-card divide-y divide-surface-hairline">
        {rows.map(({ icon: Icon, label, value }) => (
          <div key={label} className="flex items-center gap-4 px-4 py-3">
            <span className="flex items-center gap-2 w-32 flex-shrink-0 text-[13px] text-gray-500">
              <Icon size={13} />
              {label}
            </span>
            <span
              className="text-[13px] text-gray-900 font-mono truncate flex-1"
              title={value}
            >
              {value}
            </span>
            {label === 'Domain' && (
              <button
                onClick={() => setChangingUrl(true)}
                className="flex items-center gap-1.5 text-xs text-wp-blue hover:underline flex-shrink-0"
              >
                <Pencil size={12} />
                Change
              </button>
            )}
          </div>
        ))}
      </div>

      {changingUrl && (
        <ChangeUrlModal
          site={site}
          onClose={() => setChangingUrl(false)}
          onChanged={() => {
            setChangingUrl(false);
            onSaved?.();
          }}
        />
      )}
    </div>
  );
}

export default function SiteDetail({ sites, refreshSites }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [active, setActive] = useState('overview');

  const site = sites.find((s) => s.id === id);

  if (!site) {
    return (
      <div className="p-6">
        <button onClick={() => navigate('/sites')} className="btn-secondary text-sm mb-4">
          <ChevronLeft size={15} className="mr-1.5" />
          Back to Sites
        </button>
        <p className="text-sm text-gray-500">Site not found.</p>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      {/* Detail header — System Settings back chevron + title */}
      <div className="sticky top-0 z-10 bg-surface/80 backdrop-macos border-b border-surface-border px-4 py-2.5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1 min-w-0">
            <button
              onClick={() => navigate('/sites')}
              title="Back to Sites"
              className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-gray-500 flex-shrink-0"
            >
              <ChevronLeft size={17} />
            </button>
            <span className="text-[15px] font-bold text-gray-900 truncate">
              {site.name}
            </span>
            <span className="text-[13px] text-gray-400 truncate ml-1.5">
              {site.domain}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => window.electronAPI.openSiteInBrowser(site.url)}
              className="btn-secondary text-xs"
            >
              <ExternalLink size={12} className="mr-1.5" />
              Visit Site
            </button>
            <button
              onClick={() => window.electronAPI.openWpAdmin(site.id)}
              className="btn-secondary text-xs"
            >
              <Settings size={12} className="mr-1.5" />
              WP Admin
            </button>
          </div>
        </div>
      </div>

      {/* Body: subnav + content */}
      <div className="flex gap-6 p-6">
        <nav className="w-52 flex-shrink-0 space-y-1">
          {NAV.map((item) =>
            item.group ? (
              <div key={item.label} className="pt-2">
                <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wide">
                  <item.icon size={13} />
                  {item.label}
                </div>
                <div className="space-y-0.5">
                  {item.children.map((child) => (
                    <button
                      key={child.id}
                      onClick={() => setActive(child.id)}
                      className={`w-full text-left pl-9 pr-3 py-1.5 rounded-md text-[13px] transition-colors ${
                        active === child.id
                          ? 'bg-accent text-white font-medium'
                          : 'text-gray-600 hover:bg-black/5 dark:hover:bg-white/10'
                      }`}
                    >
                      {child.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <button
                key={item.id}
                onClick={() => setActive(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] transition-colors ${
                  active === item.id
                    ? 'bg-accent text-white font-medium'
                    : 'text-gray-600 hover:bg-black/5 dark:hover:bg-white/10'
                }`}
              >
                <item.icon size={14} />
                {item.label}
              </button>
            )
          )}
        </nav>

        <div className="flex-1 min-w-0">
          {/* The Agents tab hosts a terminal, so it uses full width; every other
              tab keeps the standard settings column. */}
          {active === 'agents' ? (
            <AgentLauncher site={site} />
          ) : (
            <div className="max-w-3xl">
              {active === 'overview' && <Overview site={site} onSaved={refreshSites} />}
              {active === 'wpconfig' && <WpConfigManager site={site} />}
              {active === 'php' && <SitePhpSettings site={site} onSaved={refreshSites} />}
              {active === 'wp-overview' && (
                <WpOverview site={site} onSaved={refreshSites} />
              )}
              {active === 'wp-plugins' && <WpPlugins site={site} onSaved={refreshSites} />}
              {active === 'wp-themes' && <WpThemes site={site} onSaved={refreshSites} />}
              {active === 'logs' && <SiteLogs site={site} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
