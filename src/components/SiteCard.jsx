import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Globe,
  Folder,
  Terminal,
  ExternalLink,
  Database,
  MoreHorizontal,
  Trash2,
  Settings,
  Copy,
  Lock,
  Unlock,
  Loader,
  HardDrive,
  Share2,
  Check,
  Download,
  X,
  SlidersHorizontal,
} from 'lucide-react';
import { Toggle } from './ui';

function ContextMenu({ site, onDelete, onManage, onClose }) {
  return (
    <div
      className="absolute right-0 top-8 z-50 bg-white rounded-xl shadow-card-hover border border-gray-100 py-1 w-48 animate-fade-in"
      onMouseLeave={onClose}
    >
      <button
        onClick={() => {
          onManage();
          onClose();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
      >
        <SlidersHorizontal size={13} />
        Manage / Settings
      </button>
      <div className="border-t border-gray-100 my-1" />
      <button
        onClick={() => {
          navigator.clipboard.writeText(site.url);
          onClose();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
      >
        <Copy size={13} />
        Copy URL
      </button>
      <button
        onClick={() => {
          navigator.clipboard.writeText(site.path);
          onClose();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
      >
        <Copy size={13} />
        Copy Path
      </button>
      <div className="border-t border-gray-100 my-1" />
      <button
        onClick={() => {
          onDelete(site);
          onClose();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-red-600 hover:bg-red-50"
      >
        <Trash2 size={13} />
        Remove Site…
      </button>
    </div>
  );
}

export default function SiteCard({
  site,
  onDelete,
  onToggleHttps,
  tunnel,
  cfInstalled,
  cfInstalling,
  cfLog,
  onStartTunnel,
  onStopTunnel,
  onInstallCloudflared,
}) {
  const navigate = useNavigate();
  const openDetail = () => navigate(`/sites/${site.id}`);

  const [menuOpen, setMenuOpen] = useState(false);
  const [httpsBusy, setHttpsBusy] = useState(false);
  const [httpsError, setHttpsError] = useState(null);

  const [pmaBusy, setPmaBusy] = useState(false);

  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const tunnelActive =
    tunnel && (tunnel.status === 'starting' || tunnel.status === 'running');
  const panelOpen = shareOpen || !!tunnel;

  function handleShareClick() {
    // If a tunnel is already live, just reveal the panel; otherwise toggle it.
    if (tunnel) setShareOpen(true);
    else setShareOpen((v) => !v);
  }

  function copyTunnelUrl() {
    if (!tunnel?.url) return;
    navigator.clipboard.writeText(tunnel.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleToggleHttps() {
    setHttpsBusy(true);
    setHttpsError(null);
    const result = await onToggleHttps(site);
    if (!result?.success) {
      setHttpsError(result?.error || 'Failed to update HTTPS.');
    }
    setHttpsBusy(false);
  }

  async function handlePhpMyAdmin() {
    setPmaBusy(true);
    setHttpsError(null);
    const result = await window.electronAPI.openPhpMyAdmin(site.dbName);
    if (!result?.success) {
      setHttpsError(result?.error || 'Failed to open phpMyAdmin.');
    }
    setPmaBusy(false);
  }

  const actions = [
    {
      icon: ExternalLink,
      label: 'Open',
      onClick: () => window.electronAPI.openSiteInBrowser(site.url),
    },
    {
      icon: Settings,
      label: 'wp-admin',
      onClick: () => window.electronAPI.openWpAdmin(site.url),
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
      icon: tunnelActive ? Loader : Share2,
      label: 'Expose',
      onClick: handleShareClick,
      spinning: tunnel?.status === 'starting',
      active: tunnelActive,
    },
  ];

  return (
    <div className="site-card settings-card group">
      {/* Card header */}
      <div className="p-4 pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={openDetail}
              title="Manage site"
              className="icon-tile w-9 h-9 bg-[#30b0c7] hover:brightness-95 transition-all flex-shrink-0"
            >
              <span className="text-white text-sm font-bold">
                {site.name.charAt(0).toUpperCase()}
              </span>
            </button>
            <div className="min-w-0">
              <button
                onClick={openDetail}
                className="text-sm font-semibold text-gray-900 truncate hover:text-wp-blue transition-colors block max-w-full text-left"
                title="Manage site"
              >
                {site.name}
              </button>
              <button
                onClick={() => window.electronAPI.openSiteInBrowser(site.url)}
                className="text-xs text-wp-blue hover:underline flex items-center gap-1 mt-0.5"
              >
                <Globe size={10} />
                {site.domain}
              </button>
            </div>
          </div>

          {/* More menu */}
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-gray-100 text-gray-400 transition-opacity"
            >
              <MoreHorizontal size={15} />
            </button>
            {menuOpen && (
              <ContextMenu
                site={site}
                onDelete={onDelete}
                onManage={openDetail}
                onClose={() => setMenuOpen(false)}
              />
            )}
          </div>
        </div>

        {/* Tags */}
        <div className="flex flex-wrap gap-1.5 mt-3">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-50 text-purple-700 rounded-full text-xs font-medium">
            PHP {site.phpVersion}
          </span>
          {site.wpVersion && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full text-xs font-medium">
              WP {site.wpVersion}
            </span>
          )}
          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full text-xs font-mono">
            <Database size={9} />
            {site.dbName}
          </span>
        </div>

        {/* HTTPS toggle */}
        <div className="mt-3 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs text-gray-600">
            {site.https ? (
              <Lock size={12} className="text-wp-green" />
            ) : (
              <Unlock size={12} className="text-gray-400" />
            )}
            HTTPS
            {httpsBusy && <Loader size={11} className="animate-spin text-gray-400" />}
          </span>
          <Toggle
            checked={!!site.https}
            onChange={handleToggleHttps}
            disabled={httpsBusy}
            label={site.https ? 'Disable HTTPS' : 'Enable HTTPS'}
          />
        </div>
        {httpsError && <p className="mt-1.5 text-xs text-red-600">{httpsError}</p>}
      </div>

      {/* Path */}
      <div className="px-4 py-2 bg-gray-50 border-t border-gray-100">
        <p className="text-xs text-gray-400 font-mono truncate" title={site.path}>
          {site.path}
        </p>
      </div>

      {/* Quick actions */}
      <div className="px-4 py-3 border-t border-gray-100 grid grid-cols-3 gap-1.5">
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

      {/* Share tunnel panel */}
      {panelOpen && (
        <div className="px-4 py-3 border-t border-gray-100 bg-gray-50/60 animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
              <Share2 size={12} />
              Public share tunnel
            </span>
            {!tunnelActive && (
              <button
                onClick={() => {
                  setShareOpen(false);
                  if (tunnel?.status === 'error') onStopTunnel(site);
                }}
                className="text-gray-400 hover:text-gray-600"
                title="Close"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* cloudflared not installed yet */}
          {cfInstalled === false ? (
            <div>
              <p className="text-xs text-gray-500 mb-2">
                Sharing needs Cloudflare&apos;s <span className="font-mono">cloudflared</span>{' '}
                tool. Install it once to expose sites over a public HTTPS URL.
              </p>
              <button
                onClick={onInstallCloudflared}
                disabled={cfInstalling}
                className="btn-secondary text-xs justify-center w-full"
              >
                {cfInstalling ? (
                  <>
                    <Loader size={12} className="animate-spin mr-1.5" />
                    Installing…
                  </>
                ) : (
                  <>
                    <Download size={12} className="mr-1.5" />
                    Install cloudflared
                  </>
                )}
              </button>
              {cfInstalling && cfLog && (
                <div className="mt-2 px-3 py-2 bg-gray-900 rounded-lg">
                  <p className="text-xs text-green-400 font-mono truncate" title={cfLog}>
                    {cfLog}
                  </p>
                </div>
              )}
            </div>
          ) : tunnel?.status === 'running' ? (
            <div>
              <div className="flex items-center gap-1.5">
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
                  onClick={() => onStopTunnel(site)}
                  title="Stop sharing"
                  className="p-1.5 rounded-lg text-red-500 hover:bg-red-50"
                >
                  <X size={13} />
                </button>
              </div>
              <p className="mt-1.5 text-xs text-gray-400">
                Anyone with this link can reach your local site while it&apos;s open.
              </p>
            </div>
          ) : tunnel?.status === 'starting' ? (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Loader size={13} className="animate-spin" />
              Creating public URL…
            </div>
          ) : tunnel?.status === 'error' ? (
            <div>
              <p className="text-xs text-red-600 mb-2">
                {tunnel.error || 'Failed to start the tunnel.'}
              </p>
              <button
                onClick={() => onStartTunnel(site)}
                className="btn-secondary text-xs justify-center w-full"
              >
                <Share2 size={12} className="mr-1.5" />
                Try again
              </button>
            </div>
          ) : (
            <div>
              <p className="text-xs text-gray-500 mb-2">
                Expose <span className="font-mono">{site.domain}</span> over a temporary
                public HTTPS URL powered by Cloudflare.
              </p>
              <button
                onClick={() => onStartTunnel(site)}
                disabled={cfInstalled === null}
                className="btn-secondary text-xs justify-center w-full"
              >
                <Share2 size={12} className="mr-1.5" />
                Start
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
