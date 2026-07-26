import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
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
import { Toggle, Tooltip } from './ui';
import ChangeUrlModal from './ChangeUrlModal';
import WpConfigManager from './WpConfigManager';
import SitePhpSettings from './SitePhpSettings';
import WpOverview from './WpOverview';
import WpPlugins from './WpPlugins';
import WpThemes from './WpThemes';
import SiteLogs from './SiteLogs';
import BrowserPane from './browser/BrowserPane';
import * as webviewCache from '../lib/browser/webviewCache';
import { WordPressIcon } from './icons';
import { useOpenLink } from '../lib/useOpenLink';

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
  { id: 'logs', label: 'Logs', icon: FileText },
];

function Overview({ site, onSaved, onOpenPma }) {
  const openLink = useOpenLink();
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

  // phpMyAdmin installs and configures itself on first use, so this resolves
  // before it can be opened — hence the spinner. Where it opens (default
  // browser or an in-app tab) is useOpenLink's call, not ours.
  async function handlePhpMyAdmin() {
    setPmaBusy(true);
    setActionError(null);
    const result = await window.electronAPI.getPhpMyAdminUrl(site.dbName);
    if (result?.success) onOpenPma(result.url);
    else setActionError(result?.error || 'Failed to open phpMyAdmin.');
    setPmaBusy(false);
  }

  async function handleWpAdmin() {
    const result = await window.electronAPI.getWpAdminUrl(site.id);
    if (result?.success) openLink(result.url, site.id);
    else setActionError(result?.error || 'Failed to open wp-admin.');
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
      onClick: () => openLink(site.url, site.id),
    },
    {
      icon: WordPressIcon,
      label: 'wp-admin',
      onClick: handleWpAdmin,
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
      <h2 className="text-[15px] font-bold text-foreground mb-4">Overview</h2>

      {/* Quick actions */}
      <div className="settings-card p-3 mb-4">
        <div className="grid grid-cols-3 gap-1.5">
          {actions.map(({ icon: Icon, label, onClick, spinning, disabled, active }) => (
            <button
              key={label}
              onClick={onClick}
              disabled={disabled}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors font-medium disabled:opacity-50 justify-start ${
                active
                  ? 'bg-highlight/10 text-highlight hover:bg-highlight/15'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              <Icon size={12} className={spinning ? 'animate-spin' : ''} />
              {label}
            </button>
          ))}
        </div>

        {/* Live tunnel state */}
        {tunnel?.status === 'running' && (
          <div className="mt-2 px-2.5 py-2 bg-muted rounded-lg flex items-center gap-1.5 animate-fade-in">
            <button
              onClick={() => window.electronAPI.openSiteInBrowser(tunnel.url)}
              className="flex-1 min-w-0 text-left text-xs text-highlight font-mono truncate hover:underline"
              title={tunnel.url}
            >
              {tunnel.url}
            </button>
            <Tooltip label={copied ? 'Copied' : 'Copy URL'}>
              <button
                onClick={copyTunnelUrl}
                aria-label="Copy URL"
                className="p-1.5 rounded-lg text-muted-foreground hover:bg-border"
              >
                {copied ? (
                  <Check size={13} className="text-status-running" />
                ) : (
                  <Copy size={13} />
                )}
              </button>
            </Tooltip>
            <Tooltip label="Stop sharing">
              <button
                onClick={handleStopTunnel}
                aria-label="Stop sharing"
                className="p-1.5 rounded-lg text-destructive hover:bg-destructive/10"
              >
                <X size={13} />
              </button>
            </Tooltip>
          </div>
        )}
        {tunnel?.status === 'error' && (
          <p className="mt-2 px-2.5 text-xs text-destructive">
            {tunnel.error || 'Failed to start the tunnel.'}
          </p>
        )}
        {actionError && (
          <p className="mt-2 px-2.5 text-xs text-destructive">{actionError}</p>
        )}
      </div>

      {/* One-click admin (magic login) */}
      <div className="settings-card mb-4">
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="icon-tile bg-[#5856d6] w-7 h-7 flex-shrink-0">
            <KeyRound size={15} />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] text-foreground">Magic Login</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Log into wp-admin without a password. Local access only.
            </p>
          </div>
          {ocaBusy ? (
            <Loader size={14} className="animate-spin text-muted-foreground" />
          ) : (
            <Toggle
              checked={!!oca.enabled}
              onChange={handleToggleOneClick}
              label="Magic Login"
            />
          )}
        </div>
        {oca.enabled && (
          <div className="flex items-center gap-3 px-4 py-3 border-t border-border animate-fade-in">
            <span className="w-7 flex-shrink-0" />
            <label className="text-[13px] text-muted-foreground flex-1">Log in as</label>
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
        {ocaError && <p className="px-4 pb-3 text-xs text-destructive">{ocaError}</p>}
      </div>

      <div className="settings-card divide-y divide-border">
        {rows.map(({ icon: Icon, label, value }) => (
          <div key={label} className="flex items-center gap-4 px-4 py-3">
            <span className="flex items-center gap-2 w-32 flex-shrink-0 text-[13px] text-muted-foreground">
              <Icon size={13} />
              {label}
            </span>
            <span
              className="text-[13px] text-foreground font-mono truncate flex-1"
              title={value}
            >
              {value}
            </span>
            {label === 'Domain' && (
              <button
                onClick={() => setChangingUrl(true)}
                className="flex items-center gap-1.5 text-xs text-highlight hover:underline flex-shrink-0"
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
  const location = useLocation();
  const openLink = useOpenLink();
  const [active, setActive] = useState('overview');

  // In-app phpMyAdmin browser state
  const pmaSeq = useRef(0);
  const [pmaTabKey, setPmaTabKey] = useState(null);
  const [pmaBrowserState, setPmaBrowserState] = useState(null);

  const site = sites.find((s) => s.id === id);

  // Open phpMyAdmin in the embedded browser pane.
  const openPma = useCallback((url) => {
    // Dispose previous webview if the tab key changed
    if (pmaTabKey) webviewCache.dispose(pmaTabKey);
    const key = `pma:${id}:${++pmaSeq.current}`;
    setPmaTabKey(key);
    setPmaBrowserState({ url, title: '', loading: true, error: null });
    setActive('phpmyadmin');
  }, [id, pmaTabKey]);

  const closePma = useCallback(() => {
    if (pmaTabKey) webviewCache.dispose(pmaTabKey);
    setPmaTabKey(null);
    setPmaBrowserState(null);
    setActive('overview');
  }, [pmaTabKey]);

  const handlePmaBrowserState = useCallback((_key, patch) => {
    setPmaBrowserState((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  // If navigated here with a pmaUrl in state (from SiteCard), auto-open the
  // in-app browser. The nonce ensures repeated clicks open fresh tabs.
  useEffect(() => {
    if (location.state?.pmaUrl) {
      openPma(location.state.pmaUrl);
    }
    // Only run when location changes, not when openPma ref changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  // Dispose any leftover webview when the site changes or component unmounts.
  useEffect(() => {
    return () => {
      if (pmaSeq.current > 0) {
        // Dispose all pma webviews created for this site
        for (let i = 1; i <= pmaSeq.current; i++) {
          webviewCache.dispose(`pma:${id}:${i}`);
        }
      }
    };
  }, [id]);

  // The header's WP Admin button, resolved through the same magic-login path
  // the Overview quick action uses. Failures are silent here — the header has
  // nowhere to put an error, and Overview surfaces the same call's reason.
  const openWpAdmin = async () => {
    const res = await window.electronAPI.getWpAdminUrl(site.id);
    if (res?.success) openLink(res.url, site.id);
  };

  if (!site) {
    return (
      <div className="p-6">
        <button onClick={() => navigate('/sites')} className="btn-secondary text-sm mb-4">
          <ChevronLeft size={15} className="mr-1.5" />
          Back to Sites
        </button>
        <p className="text-sm text-muted-foreground">Site not found.</p>
      </div>
    );
  }

  const isPma = active === 'phpmyadmin' && pmaTabKey && pmaBrowserState;

  return (
    <div className="animate-fade-in flex flex-col h-full">
      {/* Detail header — System Settings back chevron + title */}
      <div className="sticky top-0 z-10 bg-background border-b border-border px-4 py-2.5 flex-shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1 min-w-0">
            <Tooltip label={isPma ? 'Back to Site' : 'Back to Sites'}>
              <button
                onClick={isPma ? closePma : () => navigate('/sites')}
                aria-label={isPma ? 'Back to Site' : 'Back to Sites'}
                className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground flex-shrink-0"
              >
                <ChevronLeft size={17} />
              </button>
            </Tooltip>
            <span className="text-[15px] font-bold text-foreground truncate">
              {site.name}
            </span>
            <span className="text-[13px] text-muted-foreground truncate ml-1.5">
              {site.domain}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => openLink(site.url, site.id)}
              className="btn-secondary text-xs"
            >
              <ExternalLink size={12} className="mr-1.5" />
              Visit Site
            </button>
            <button onClick={openWpAdmin} className="btn-secondary text-xs">
              <Settings size={12} className="mr-1.5" />
              WP Admin
            </button>
          </div>
        </div>
      </div>

      {/* phpMyAdmin in-app browser — full width, no sidebar */}
      {isPma ? (
        <div className="flex-1 flex flex-col min-h-0">
          <BrowserPane
            tabKey={pmaTabKey}
            initialUrl={pmaBrowserState.url}
            state={pmaBrowserState}
            onStateChange={handlePmaBrowserState}
            onClose={closePma}
          />
        </div>
      ) : (
        /* Body: subnav + content */
        <div className="flex gap-6 p-6">
          <nav className="w-52 flex-shrink-0 space-y-1">
            {NAV.map((item) =>
              item.group ? (
                <div key={item.label} className="pt-2">
                  <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
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
                            ? 'bg-highlight text-highlight-foreground font-medium'
                            : 'text-muted-foreground hover:bg-accent'
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
                      ? 'bg-highlight text-highlight-foreground font-medium'
                      : 'text-muted-foreground hover:bg-accent'
                  }`}
                >
                  <item.icon size={14} />
                  {item.label}
                </button>
              )
            )}
          </nav>

          <div className="flex-1 min-w-0 max-w-3xl">
            {active === 'overview' && <Overview site={site} onSaved={refreshSites} onOpenPma={openPma} />}
            {active === 'wpconfig' && <WpConfigManager site={site} />}
            {active === 'php' && <SitePhpSettings site={site} onSaved={refreshSites} />}
            {active === 'wp-overview' && <WpOverview site={site} onSaved={refreshSites} />}
            {active === 'wp-plugins' && <WpPlugins site={site} onSaved={refreshSites} />}
            {active === 'wp-themes' && <WpThemes site={site} onSaved={refreshSites} />}
            {active === 'logs' && <SiteLogs site={site} />}
          </div>
        </div>
      )}
    </div>
  );
}
