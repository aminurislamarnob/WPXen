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
  Archive,
  CopyPlus,
  Layers,
} from 'lucide-react';
import { WordPressIcon } from './icons';
import { Tooltip } from './ui';

function ContextMenu({
  site,
  onDelete,
  onManage,
  onExport,
  onClone,
  onSaveBlueprint,
  onClose,
}) {
  return (
    <div
      className="absolute right-0 top-8 z-50 panel-menu p-1 w-48 animate-fade-in"
      onMouseLeave={onClose}
    >
      <button
        onClick={() => {
          onManage();
          onClose();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-foreground hover:bg-accent"
      >
        <SlidersHorizontal size={13} />
        Manage / Settings
      </button>
      <div className="border-t border-border my-1" />
      <button
        onClick={() => {
          navigator.clipboard.writeText(site.url);
          onClose();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-foreground hover:bg-accent"
      >
        <Copy size={13} />
        Copy URL
      </button>
      <button
        onClick={() => {
          navigator.clipboard.writeText(site.path);
          onClose();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-foreground hover:bg-accent"
      >
        <Copy size={13} />
        Copy Path
      </button>
      <div className="border-t border-border my-1" />
      <button
        onClick={() => {
          onClone(site);
          onClose();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-foreground hover:bg-accent"
      >
        <CopyPlus size={13} />
        Clone…
      </button>
      <button
        onClick={() => {
          onExport(site);
          onClose();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-foreground hover:bg-accent"
      >
        <Archive size={13} />
        Export…
      </button>
      <button
        onClick={() => {
          onSaveBlueprint(site);
          onClose();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-foreground hover:bg-accent"
      >
        <Layers size={13} />
        Save as Blueprint…
      </button>
      <div className="border-t border-border my-1" />
      <button
        onClick={() => {
          onDelete(site);
          onClose();
        }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-destructive hover:bg-destructive/10"
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
  onExport,
  onClone,
  onSaveBlueprint,
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
      icon: tunnelActive ? Loader : Share2,
      label: 'Expose',
      onClick: handleShareClick,
      spinning: tunnel?.status === 'starting',
      active: tunnelActive,
    },
  ];

  return (
    <div className={`site-card settings-card group relative ${menuOpen ? 'z-40' : ''}`}>
      {/* Main row: tile · [ title + chips + HTTPS / domain · path ] · menu */}
      <div className="flex items-start gap-3 px-4 py-3">
        <Tooltip label="Manage site">
          <button
            onClick={openDetail}
            aria-label="Manage site"
            className="icon-tile w-9 h-9 bg-[#30b0c7] hover:brightness-95 transition-all flex-shrink-0"
          >
            <span className="text-white text-sm font-bold">
              {site.name.charAt(0).toUpperCase()}
            </span>
          </button>
        </Tooltip>

        <div className="min-w-0 flex-1">
          {/* Top line: title · version chips · db name · HTTPS */}
          <div className="flex items-center gap-2">
            <Tooltip label="Manage site">
              <button
                onClick={openDetail}
                className="text-sm font-semibold text-foreground truncate hover:text-highlight transition-colors text-left min-w-0"
              >
                {site.name}
              </button>
            </Tooltip>

            <div className="flex items-center gap-1.5 flex-shrink-0 ml-auto">
              <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                PHP {site.phpVersion}
              </span>
              {site.wpVersion && (
                <span className="inline-flex items-center rounded-full border border-highlight/30 bg-highlight/10 px-2 py-0.5 text-xs font-medium text-highlight">
                  WP {site.wpVersion}
                </span>
              )}
              <span
                className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground"
                title={site.dbName}
              >
                <Database size={9} className="flex-shrink-0" />
                {site.dbName}
              </span>

              {/* HTTPS lock toggle — click the icon to enable/disable HTTPS */}
              <Tooltip label={site.https ? 'Disable HTTPS' : 'Enable HTTPS'}>
                <button
                  onClick={handleToggleHttps}
                  disabled={httpsBusy}
                  aria-label={site.https ? 'Disable HTTPS' : 'Enable HTTPS'}
                  aria-pressed={!!site.https}
                  className="p-1.5 rounded-lg hover:bg-accent disabled:opacity-50 transition-colors"
                >
                  {httpsBusy ? (
                    <Loader size={14} className="animate-spin text-muted-foreground" />
                  ) : site.https ? (
                    <Lock size={14} className="text-status-running" />
                  ) : (
                    <Unlock size={14} className="text-muted-foreground" />
                  )}
                </button>
              </Tooltip>
            </div>
          </div>

          {/* Bottom line: domain · full folder path */}
          <div className="flex items-center gap-1.5 mt-0.5">
            <button
              onClick={() => window.electronAPI.openSiteInBrowser(site.url)}
              className="text-xs text-highlight hover:underline flex items-center gap-1 flex-shrink-0"
            >
              <Globe size={10} />
              {site.domain}
            </button>
            <span className="text-xs text-muted-foreground flex-shrink-0">·</span>
            <span
              className="text-xs text-muted-foreground font-mono break-all"
              title={site.path}
            >
              {site.path}
            </span>
          </div>
        </div>

        {/* More menu */}
        <div className="relative flex-shrink-0">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-accent text-muted-foreground transition-opacity"
          >
            <MoreHorizontal size={15} />
          </button>
          {menuOpen && (
            <ContextMenu
              site={site}
              onDelete={onDelete}
              onManage={openDetail}
              onExport={onExport}
              onClone={onClone}
              onSaveBlueprint={onSaveBlueprint}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>
      </div>

      {httpsError && <p className="px-4 pb-2 text-xs text-destructive">{httpsError}</p>}

      {/* Quick actions: second line, icon + label */}
      <div className="flex items-center gap-1 px-4 py-2 border-t border-border">
        {actions.map(({ icon: Icon, label, onClick, spinning, disabled, active }) => (
          <button
            key={label}
            onClick={onClick}
            disabled={disabled}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors font-medium disabled:opacity-50 ${
              active
                ? 'bg-highlight/10 text-highlight hover:bg-highlight/15'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            <Icon
              size={12}
              className={`flex-shrink-0 ${spinning ? 'animate-spin' : ''}`}
            />
            {label}
          </button>
        ))}
      </div>

      {/* Share tunnel panel */}
      {panelOpen && (
        <div className="px-4 py-3 border-t border-border bg-muted/60 rounded-b-2xl animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Share2 size={12} />
              Public share tunnel
            </span>
            {!tunnelActive && (
              <Tooltip label="Close">
                <button
                  onClick={() => {
                    setShareOpen(false);
                    if (tunnel?.status === 'error') onStopTunnel(site);
                  }}
                  aria-label="Close"
                  className="text-muted-foreground hover:text-muted-foreground"
                >
                  <X size={13} />
                </button>
              </Tooltip>
            )}
          </div>

          {/* cloudflared not installed yet */}
          {cfInstalled === false ? (
            <div>
              <p className="text-xs text-muted-foreground mb-2">
                Sharing needs Cloudflare&apos;s{' '}
                <span className="font-mono">cloudflared</span> tool. Install it once to
                expose sites over a public HTTPS URL.
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
                <div className="mt-2 px-3 py-2 bg-tertiary border border-border rounded-md">
                  <p
                    className="text-xs text-status-running font-mono truncate"
                    title={cfLog}
                  >
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
                    onClick={() => onStopTunnel(site)}
                    aria-label="Stop sharing"
                    className="p-1.5 rounded-lg text-destructive hover:bg-destructive/10"
                  >
                    <X size={13} />
                  </button>
                </Tooltip>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Anyone with this link can reach your local site while it&apos;s open.
              </p>
            </div>
          ) : tunnel?.status === 'starting' ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader size={13} className="animate-spin" />
              Creating public URL…
            </div>
          ) : tunnel?.status === 'error' ? (
            <div>
              <p className="text-xs text-destructive mb-2">
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
              <p className="text-xs text-muted-foreground mb-2">
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
