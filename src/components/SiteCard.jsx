import { useState } from 'react';
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
} from 'lucide-react';

function ContextMenu({ site, onDelete, onClose }) {
  return (
    <div
      className="absolute right-0 top-8 z-50 bg-white rounded-xl shadow-card-hover border border-gray-100 py-1 w-48 animate-fade-in"
      onMouseLeave={onClose}
    >
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

export default function SiteCard({ site, onDelete, onToggleHttps }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [httpsBusy, setHttpsBusy] = useState(false);
  const [httpsError, setHttpsError] = useState(null);

  const [pmaBusy, setPmaBusy] = useState(false);

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
      label: 'Open in Browser',
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
      label: 'Open in Finder',
      onClick: () => window.electronAPI.openSiteInFinder(site.path),
    },
    {
      icon: Terminal,
      label: 'Open Terminal',
      onClick: () => window.electronAPI.openSiteInTerminal(site.path),
    },
  ];

  return (
    <div className="site-card bg-white rounded-xl border border-surface-border shadow-card group">
      {/* Card header */}
      <div className="p-4 pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-wp-blue flex items-center justify-center flex-shrink-0">
              <span className="text-white text-sm font-bold">
                {site.name.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-gray-900 truncate">
                {site.name}
              </h3>
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
          <button
            role="switch"
            aria-checked={!!site.https}
            onClick={handleToggleHttps}
            disabled={httpsBusy}
            title={site.https ? 'Disable HTTPS' : 'Enable HTTPS'}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              site.https ? 'bg-wp-green' : 'bg-gray-300'
            } ${httpsBusy ? 'opacity-50' : ''}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                site.https ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
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
      <div className="px-4 py-3 border-t border-gray-100 flex gap-1.5 flex-wrap">
        {actions.map(({ icon: Icon, label, onClick, spinning, disabled }) => (
          <button
            key={label}
            onClick={onClick}
            disabled={disabled}
            title={label}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors font-medium disabled:opacity-50"
          >
            <Icon size={12} className={spinning ? 'animate-spin' : ''} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
