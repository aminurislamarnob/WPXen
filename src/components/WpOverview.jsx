import { useState, useEffect, useCallback } from 'react';
import {
  Loader,
  RefreshCw,
  ArrowUpCircle,
  CheckCircle,
  AlertTriangle,
  Plug,
  Palette,
  Users,
} from 'lucide-react';

function StatCard({ icon: Icon, label, value, description, updates, tint }) {
  return (
    <div className="settings-card p-5">
      <div className="flex items-start justify-between">
        <span className="text-sm font-semibold text-gray-700">{label}</span>
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${tint}`}>
          <Icon size={17} />
        </div>
      </div>
      <div className="text-3xl font-bold text-gray-900 mt-2">{value}</div>
      <div className="flex items-end justify-between gap-2 mt-1.5">
        <p className="text-xs text-gray-500 leading-relaxed">{description}</p>
        {updates > 0 && (
          <span className="flex-shrink-0 px-2 py-0.5 bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300 rounded-full text-xs font-medium">
            {updates} update{updates !== 1 ? 's' : ''}
          </span>
        )}
      </div>
    </div>
  );
}

export default function WpOverview({ site, onSaved }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  // '__core__' | '__all__' | '<type>:<name>' while an update is running.
  const [updating, setUpdating] = useState(null);
  const [message, setMessage] = useState(null);

  const load = useCallback(
    async (initial = false) => {
      if (initial) setLoading(true);
      else setRefreshing(true);
      setError(null);
      const result = await window.electronAPI.getWpOverview(site.id);
      if (result.success) {
        setData(result.overview);
      } else {
        setError(result.error);
      }
      setLoading(false);
      setRefreshing(false);
    },
    [site.id]
  );

  useEffect(() => {
    load(true);
  }, [load]);

  async function run(key, fn, successText) {
    setUpdating(key);
    setMessage(null);
    const result = await fn();
    if (result.success) {
      setMessage({ type: 'success', text: successText });
      await load();
      onSaved?.();
    } else {
      setMessage({ type: 'error', text: result.error });
    }
    setUpdating(null);
  }

  const busy = !!updating;
  const core = data?.core;
  const pending = (data?.updates.length || 0) + (core?.updateVersion ? 1 : 0);

  return (
    <div>
      <div className="flex items-start justify-between mb-5">
        <div>
          <h2 className="text-lg font-bold text-gray-900">WordPress Overview</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Core, plugin and theme inventory with pending updates.
          </p>
        </div>
        <button
          onClick={() => {
            setMessage(null);
            load();
          }}
          disabled={loading || refreshing || busy}
          title="Refresh"
          className="btn-secondary text-sm"
        >
          <RefreshCw size={14} className={loading || refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {message && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl mb-4 text-sm ${
            message.type === 'error'
              ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
              : 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400'
          }`}
        >
          {message.type === 'error' ? (
            <AlertTriangle size={15} className="flex-shrink-0" />
          ) : (
            <CheckCircle size={15} className="flex-shrink-0" />
          )}
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader size={22} className="animate-spin text-wp-blue" />
        </div>
      ) : error ? (
        <div className="bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400 rounded-xl px-4 py-3 text-sm">
          <p>{error}</p>
          <button onClick={() => load(true)} className="btn-secondary text-xs mt-3">
            Try again
          </button>
        </div>
      ) : data ? (
        <div className="space-y-4">
          {/* WordPress Core */}
          <div className="settings-card p-5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                    core.updateVersion
                      ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400'
                      : 'bg-green-50 text-wp-green dark:bg-green-500/15'
                  }`}
                >
                  {core.updateVersion ? (
                    <ArrowUpCircle size={19} />
                  ) : (
                    <CheckCircle size={19} />
                  )}
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-gray-900">WordPress Core</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {core.updateVersion
                      ? `Update available from ${core.version} to ${core.updateVersion}.`
                      : `WordPress ${core.version} is up to date.`}
                  </p>
                </div>
              </div>
              {core.updateVersion && (
                <button
                  onClick={() =>
                    run(
                      '__core__',
                      () => window.electronAPI.updateWpCore(site.id),
                      `WordPress core updated to ${core.updateVersion}.`
                    )
                  }
                  disabled={busy}
                  className="btn-primary text-sm flex-shrink-0"
                >
                  {updating === '__core__' ? (
                    <>
                      <Loader size={14} className="animate-spin mr-1.5" />
                      Updating…
                    </>
                  ) : (
                    `Update to ${core.updateVersion}`
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Stat cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard
              icon={Plug}
              label="Plugins"
              value={data.counts.plugins}
              description="Installed plugins currently available on this site."
              updates={data.counts.pluginUpdates}
              tint="bg-blue-50 text-wp-blue dark:bg-blue-500/15"
            />
            <StatCard
              icon={Palette}
              label="Themes"
              value={data.counts.themes}
              description="Installed themes ready for editors and site admins."
              updates={data.counts.themeUpdates}
              tint="bg-green-50 text-wp-green dark:bg-green-500/15"
            />
            <StatCard
              icon={Users}
              label="Users"
              value={data.counts.users}
              description="WordPress user accounts on this site."
              updates={0}
              tint="bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400"
            />
          </div>

          {/* Available updates */}
          <div className="settings-card">
            <div className="flex items-center justify-between gap-3 p-5 pb-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Available Updates</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Review pending plugin and theme updates before applying them.
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="px-2.5 py-1 bg-gray-100 text-gray-600 rounded-full text-xs font-medium">
                  {pending} pending update{pending !== 1 ? 's' : ''}
                </span>
                {data.updates.length > 0 && (
                  <button
                    onClick={() =>
                      run(
                        '__all__',
                        () => window.electronAPI.updateWpAll(site.id),
                        'All plugins and themes updated.'
                      )
                    }
                    disabled={busy}
                    className="btn-primary text-xs"
                  >
                    {updating === '__all__' ? (
                      <>
                        <Loader size={12} className="animate-spin mr-1.5" />
                        Updating…
                      </>
                    ) : (
                      'Update All'
                    )}
                  </button>
                )}
              </div>
            </div>

            {data.updates.length === 0 ? (
              <div className="px-5 pb-5">
                <p className="text-xs text-gray-400">
                  All plugins and themes are up to date.
                </p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
                    <th className="px-5 py-2.5 font-medium">Name</th>
                    <th className="px-3 py-2.5 font-medium">Type</th>
                    <th className="px-3 py-2.5 font-medium">Version</th>
                    <th className="px-3 py-2.5 font-medium">Latest</th>
                    <th className="px-5 py-2.5 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.updates.map((u) => {
                    const key = `${u.type}:${u.name}`;
                    return (
                      <tr key={key} className="border-t border-gray-100">
                        <td className="px-5 py-3 text-gray-900 font-medium">{u.title}</td>
                        <td className="px-3 py-3 text-gray-500 capitalize">{u.type}</td>
                        <td className="px-3 py-3 text-gray-500 font-mono text-xs">
                          {u.version}
                        </td>
                        <td className="px-3 py-3 text-gray-500 font-mono text-xs">
                          {u.latest || '—'}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <button
                            onClick={() =>
                              run(
                                key,
                                () =>
                                  window.electronAPI.updateWpItem(
                                    site.id,
                                    u.type,
                                    u.name
                                  ),
                                `${u.title} updated.`
                              )
                            }
                            disabled={busy}
                            className="btn-secondary text-xs"
                          >
                            {updating === key ? (
                              <>
                                <Loader size={12} className="animate-spin mr-1.5" />
                                Updating…
                              </>
                            ) : (
                              'Update'
                            )}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <p className="text-xs text-gray-400">
            Last synced{' '}
            {new Date(data.syncedAt).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}{' '}
            — live data from WP-CLI.
          </p>
        </div>
      ) : null}
    </div>
  );
}
