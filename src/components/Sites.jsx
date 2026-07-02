import { useState, useEffect } from 'react';
import { Plus, Search, Globe, AlertTriangle, Loader } from 'lucide-react';
import SiteCard from './SiteCard';
import AddSiteModal from './AddSiteModal';

function DeleteConfirmModal({ site, onConfirm, onClose }) {
  const [removeFiles, setRemoveFiles] = useState(false);
  const [removeDb, setRemoveDb] = useState(true);
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    await onConfirm(site.id, { removeFiles, removeDatabase: removeDb });
  }

  return (
    <div
      className="modal-overlay animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="panel rounded-2xl shadow-window w-96 animate-slide-in">
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-red-100 dark:bg-red-500/15 flex items-center justify-center">
              <AlertTriangle size={20} className="text-red-600 dark:text-red-400" />
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900">Remove Site</h3>
              <p className="text-xs text-gray-500">This cannot be undone</p>
            </div>
          </div>

          <p className="text-sm text-gray-700 mb-4">
            Remove <span className="font-semibold">{site.name}</span> ({site.domain})?
          </p>

          <div className="space-y-2 mb-5">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 rounded border-gray-300 text-wp-red"
                checked={removeDb}
                onChange={(e) => setRemoveDb(e.target.checked)}
              />
              <span className="text-sm text-gray-700">Drop database ({site.dbName})</span>
            </label>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 rounded border-gray-300 text-wp-red"
                checked={removeFiles}
                onChange={(e) => setRemoveFiles(e.target.checked)}
              />
              <span className="text-sm text-gray-700">
                Delete site files{' '}
                <span className="text-gray-400 text-xs">(irreversible)</span>
              </span>
            </label>
          </div>

          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary flex-1 text-sm">
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="btn-danger flex-1 text-sm"
            >
              {loading ? <Loader size={14} className="animate-spin mr-2" /> : null}
              Remove Site
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Sites({ sites, setSites, refreshSites }) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [search, setSearch] = useState('');
  const [deletingSite, setDeletingSite] = useState(null);
  const [phpVersions, setPhpVersions] = useState([]);

  // Share tunnels: cloudflared availability + per-site tunnel state, keyed by
  // site id. Lifted here so a single 'tunnel-update' subscription serves every
  // card (the preload event bridge removes all listeners per channel on off()).
  const [cfInstalled, setCfInstalled] = useState(null);
  const [cfInstalling, setCfInstalling] = useState(false);
  const [cfLog, setCfLog] = useState('');
  const [tunnels, setTunnels] = useState({});

  useEffect(() => {
    window.electronAPI.getPhpVersions().then(setPhpVersions).catch(console.error);
  }, []);

  useEffect(() => {
    window.electronAPI
      .checkCloudflared()
      .then((r) => setCfInstalled(!!r.installed))
      .catch(() => setCfInstalled(false));

    window.electronAPI
      .getTunnels()
      .then((list) => {
        const map = {};
        for (const t of list || []) map[t.siteId] = t;
        setTunnels(map);
      })
      .catch(console.error);

    const onTunnel = (t) => {
      if (!t) return;
      setTunnels((prev) => {
        const next = { ...prev };
        if (t.status === 'stopped') {
          delete next[t.siteId];
        } else {
          next[t.siteId] = t;
        }
        return next;
      });
    };
    const onInstallLog = (data) => data && setCfLog(data.line);

    window.electronAPI.on('tunnel-update', onTunnel);
    window.electronAPI.on('cloudflared-install-progress', onInstallLog);
    return () => {
      window.electronAPI.off('tunnel-update');
      window.electronAPI.off('cloudflared-install-progress');
    };
  }, []);

  async function handleInstallCloudflared() {
    setCfInstalling(true);
    setCfLog('');
    const result = await window.electronAPI.installCloudflared();
    setCfInstalling(false);
    setCfLog('');
    if (result.success) setCfInstalled(true);
    return result;
  }

  async function handleStartTunnel(site) {
    // Optimistically show a "starting" state until the URL (or an error) lands.
    setTunnels((prev) => ({
      ...prev,
      [site.id]: { siteId: site.id, domain: site.domain, status: 'starting' },
    }));
    const result = await window.electronAPI.startTunnel(site.id);
    if (!result.success) {
      setTunnels((prev) => ({
        ...prev,
        [site.id]: {
          siteId: site.id,
          domain: site.domain,
          status: 'error',
          error: result.error,
        },
      }));
    }
    return result;
  }

  async function handleStopTunnel(site) {
    await window.electronAPI.stopTunnel(site.id);
    setTunnels((prev) => {
      const next = { ...prev };
      delete next[site.id];
      return next;
    });
  }

  const filtered = sites.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.domain.toLowerCase().includes(search.toLowerCase())
  );

  async function handleDelete(id, opts) {
    const result = await window.electronAPI.removeSite(id, opts);
    if (result.success) {
      await refreshSites();
    }
    setDeletingSite(null);
  }

  function handleSiteAdded(site) {
    setSites((prev) => [...prev, site]);
  }

  async function handleToggleHttps(site) {
    const result = await window.electronAPI.setSiteHttps(site.id, !site.https);
    if (result.success) {
      await refreshSites();
    }
    return result;
  }

  return (
    <div className="px-6 pb-6 max-w-4xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 gap-3">
        {sites.length > 0 ? (
          <div className="relative flex-1 max-w-xs">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type="text"
              placeholder="Search sites…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="form-input !pl-8"
            />
          </div>
        ) : (
          <p className="text-xs text-gray-500">
            {sites.length} WordPress site{sites.length !== 1 ? 's' : ''}
          </p>
        )}
        <button onClick={() => setShowAddModal(true)} className="btn-primary text-xs">
          <Plus size={13} className="mr-1.5" />
          Add Site
        </button>
      </div>

      {/* Sites grid */}
      {sites.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-16 h-16 rounded-2xl bg-wp-blue/10 flex items-center justify-center mb-4">
            <Globe size={28} className="text-wp-blue" />
          </div>
          <h2 className="text-base font-bold text-gray-800">No sites yet</h2>
          <p className="text-sm text-gray-400 mt-2 mb-6 max-w-xs">
            Create your first local WordPress site. It&apos;ll be up and running in
            minutes.
          </p>
          <button onClick={() => setShowAddModal(true)} className="btn-primary">
            <Plus size={15} className="mr-2" />
            Add Your First Site
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-sm text-gray-400">No sites match &quot;{search}&quot;</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((site) => (
            <SiteCard
              key={site.id}
              site={site}
              onDelete={setDeletingSite}
              onToggleHttps={handleToggleHttps}
              tunnel={tunnels[site.id]}
              cfInstalled={cfInstalled}
              cfInstalling={cfInstalling}
              cfLog={cfLog}
              onStartTunnel={handleStartTunnel}
              onStopTunnel={handleStopTunnel}
              onInstallCloudflared={handleInstallCloudflared}
            />
          ))}
        </div>
      )}

      {/* Add site modal */}
      {showAddModal && (
        <AddSiteModal
          phpVersions={phpVersions}
          onClose={() => setShowAddModal(false)}
          onSiteAdded={(site) => {
            handleSiteAdded(site);
            setShowAddModal(false);
          }}
        />
      )}

      {/* Delete confirm modal */}
      {deletingSite && (
        <DeleteConfirmModal
          site={deletingSite}
          onConfirm={handleDelete}
          onClose={() => setDeletingSite(null)}
        />
      )}
    </div>
  );
}
