import { useState, useEffect } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  Circle,
  Loader,
  Lock,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { Tooltip } from './ui';

// Import Laravel Herd WordPress sites by adopting them in place: WPXen serves
// the same folder, domain and database, and Remove later only unregisters
// (see `herd-adopt` in ipc.cjs). Several can be picked at once; they're
// adopted one after another — each `herd-adopt` writes a vhost and reloads
// nginx, so running them side by side would only race the reloads — and one
// site failing never stops the rest.
export default function HerdImportModal({ onClose, onSiteImported, phpVersions }) {
  const [scan, setScan] = useState(null); // { installed, running, mysqlRunning, sites }
  const [scanning, setScanning] = useState(true);
  const [checked, setChecked] = useState(() => new Set()); // herd site paths
  const [php, setPhp] = useState({}); // path -> PHP version to serve it with
  const [phase, setPhase] = useState('select'); // select | running | finished
  const [status, setStatus] = useState({}); // path -> { state, message }
  const [herdRunning, setHerdRunning] = useState(false);
  const [error, setError] = useState('');

  async function load({ keep = null } = {}) {
    setScanning(true);
    setError('');
    const res = await window.electronAPI.herdScan();
    setScanning(false);
    if (!res.success) {
      setError(res.error || 'Could not read Herd’s configuration.');
      return;
    }
    setScan(res);
    setHerdRunning(res.running);
    const adoptable = res.sites.filter((s) => !s.blocker).map((s) => s.path);
    // A first scan selects everything importable; a rescan keeps the choice.
    setChecked((prev) => {
      const base = keep || (scan ? prev : new Set(adoptable));
      return new Set([...base].filter((p) => adoptable.includes(p)));
    });
    setPhp((prev) => {
      const next = { ...prev };
      for (const s of res.sites)
        if (!next[s.path] && s.wpxenPhp) next[s.path] = s.wpxenPhp;
      return next;
    });
  }

  useEffect(() => {
    load();
    window.electronAPI.on('herd-adopt-progress', ({ path, message }) => {
      if (!path) return;
      setStatus((prev) =>
        prev[path]?.state === 'working'
          ? { ...prev, [path]: { state: 'working', message } }
          : prev
      );
    });
    return () => window.electronAPI.off('herd-adopt-progress');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sites = scan?.sites || [];
  const adoptable = sites.filter((s) => !s.blocker);
  const queue = sites.filter((s) => checked.has(s.path));
  const allChecked = adoptable.length > 0 && adoptable.every((s) => checked.has(s.path));

  function toggle(path) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleAll() {
    setChecked(allChecked ? new Set() : new Set(adoptable.map((s) => s.path)));
  }

  async function handleImport() {
    if (queue.length === 0) return;
    setError('');
    setPhase('running');
    setStatus(
      Object.fromEntries(queue.map((s) => [s.path, { state: 'pending', message: '' }]))
    );
    for (const s of queue) {
      setStatus((prev) => ({
        ...prev,
        [s.path]: { state: 'working', message: 'Starting…' },
      }));
      let res;
      try {
        res = await window.electronAPI.herdAdopt({
          path: s.path,
          phpVersion: php[s.path],
        });
      } catch (err) {
        res = { success: false, error: err?.message };
      }
      if (res?.success) {
        if (res.herdRunning) setHerdRunning(true);
        onSiteImported(res.site);
        setStatus((prev) => ({
          ...prev,
          [s.path]: { state: 'done', message: res.site.url, url: res.site.url },
        }));
      } else {
        setStatus((prev) => ({
          ...prev,
          [s.path]: { state: 'failed', message: res?.error || 'Import failed.' },
        }));
      }
    }
    setPhase('finished');
  }

  // Back to the list with only the failures still selected.
  function retryFailed() {
    const failed = new Set(
      Object.entries(status)
        .filter(([, v]) => v.state === 'failed')
        .map(([p]) => p)
    );
    setStatus({});
    setPhase('select');
    load({ keep: failed });
  }

  const counts = Object.values(status).reduce(
    (acc, v) => ({ ...acc, [v.state]: (acc[v.state] || 0) + 1 }),
    {}
  );
  const running = phase === 'running';

  return (
    <div
      className="modal-overlay animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && !running && onClose()}
    >
      <div className="sheet w-[600px] max-h-[90vh] overflow-hidden flex flex-col animate-slide-in">
        <div className="px-6 pt-6 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-bold text-foreground">Import from Herd</h2>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              Serve Laravel Herd WordPress sites from WPXen, in place: same folders,
              databases and domains. Nothing is copied.
            </p>
          </div>
          {phase === 'select' && (
            <Tooltip label="Rescan">
              <button
                onClick={() => load()}
                disabled={scanning}
                aria-label="Rescan Herd sites"
                className="btn-ghost !px-0 w-8 flex-shrink-0"
              >
                <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
              </button>
            </Tooltip>
          )}
        </div>

        <div className="px-6 pt-4 pb-6 overflow-y-auto">
          {scanning && !scan ? (
            <div className="sheet-well flex items-center gap-2 text-xs text-muted-foreground">
              <Loader size={13} className="animate-spin" />
              Reading Herd’s sites…
            </div>
          ) : scan && !scan.installed ? (
            <div className="sheet-well text-sm text-muted-foreground">
              Laravel Herd isn’t installed on this Mac (no configuration was found in
              ~/Library/Application Support/Herd).
            </div>
          ) : scan ? (
            <div className="space-y-3">
              {herdRunning && <HerdRunningNotice />}

              {phase === 'finished' && (
                <div className="flex items-center gap-2 text-[13px] text-foreground">
                  <CheckCircle size={15} className="text-status-running flex-shrink-0" />
                  {counts.done || 0} of {queue.length} imported
                  {counts.failed ? (
                    <span className="text-destructive">· {counts.failed} failed</span>
                  ) : null}
                </div>
              )}

              {sites.length === 0 ? (
                <div className="sheet-well text-sm text-muted-foreground">
                  Herd serves no WordPress sites.
                </div>
              ) : phase === 'select' ? (
                <>
                  <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allChecked}
                        disabled={adoptable.length === 0}
                        onChange={toggleAll}
                      />
                      Select all importable ({adoptable.length})
                    </label>
                    <span>
                      {checked.size} of {sites.length} selected
                    </span>
                  </div>
                  <div className="sheet-well !p-1 max-h-[340px] overflow-y-auto">
                    {sites.map((s) => (
                      <SiteRow
                        key={s.path}
                        site={s}
                        checked={checked.has(s.path)}
                        onToggle={() => toggle(s.path)}
                        php={php[s.path] || ''}
                        onPhp={(v) => setPhp((prev) => ({ ...prev, [s.path]: v }))}
                        phpVersions={phpVersions}
                      />
                    ))}
                  </div>
                  <p className="px-1 text-xs text-muted-foreground">
                    For each site WPXen adds an nginx config (and its own HTTPS
                    certificate where Herd served HTTPS) plus its local-trust mu-plugin.
                    Removing one in WPXen later keeps the folder and database, which Herd
                    still uses.
                  </p>
                </>
              ) : (
                <div className="sheet-well !p-1 max-h-[380px] overflow-y-auto">
                  {queue.map((s) => (
                    <ResultRow key={s.path} site={s} status={status[s.path]} />
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {error && (
            <div className="mt-4 flex items-start gap-2 bg-destructive/10 text-destructive rounded-xl px-4 py-3 text-sm">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 mt-5">
            {phase === 'select' && (
              <>
                <button onClick={onClose} className="btn-secondary">
                  Cancel
                </button>
                <button
                  onClick={handleImport}
                  disabled={scanning || checked.size === 0}
                  className="btn-primary"
                >
                  Import {checked.size || ''} site{checked.size === 1 ? '' : 's'}
                </button>
              </>
            )}
            {running && (
              <button disabled className="btn-primary">
                <Loader size={12} className="animate-spin" />
                Importing {(counts.done || 0) + (counts.failed || 0) + 1} of{' '}
                {queue.length}…
              </button>
            )}
            {phase === 'finished' && (
              <>
                {counts.failed ? (
                  <button onClick={retryFailed} className="btn-secondary">
                    Retry failed
                  </button>
                ) : null}
                <button onClick={onClose} className="btn-primary">
                  Done
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SiteRow({ site, checked, onToggle, php, onPhp, phpVersions }) {
  const disabled = !!site.blocker;
  const herdPhpMissing =
    site.phpVersion && !(phpVersions || []).some((v) => v.version === site.phpVersion);
  return (
    <div
      className={`flex items-start gap-3 rounded-lg px-3 py-2 ${
        disabled ? 'opacity-60' : 'hover:bg-accent'
      }`}
    >
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        aria-label={`Import ${site.domain}`}
      />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          disabled={disabled}
          onClick={onToggle}
          className="flex items-center gap-1.5 text-left text-[13px] font-medium text-foreground disabled:cursor-not-allowed"
        >
          {site.secured && <Lock size={11} className="text-muted-foreground" />}
          {site.domain}
        </button>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {site.path} · {site.dbName || 'no DB_NAME'}
        </div>
        {site.blocker && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {site.blocker.message}
          </div>
        )}
        {checked && herdPhpMissing && (
          <div className="mt-0.5 text-xs text-status-warning">
            Herd uses PHP {site.phpVersion}, which isn’t installed in WPXen.
          </div>
        )}
      </div>
      {disabled ? (
        <span className="text-xs text-muted-foreground flex-shrink-0 pt-0.5">
          PHP {site.phpVersion || '?'}
        </span>
      ) : (
        <select
          className="form-input !h-7 !w-[92px] !py-0 text-xs flex-shrink-0"
          value={php}
          onChange={(e) => onPhp(e.target.value)}
          aria-label={`PHP version for ${site.domain}`}
        >
          {(phpVersions || []).map((v) => (
            <option key={v.version} value={v.version}>
              PHP {v.version}
              {v.version === site.phpVersion ? ' ✓' : ''}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function ResultRow({ site, status }) {
  const state = status?.state || 'pending';
  const Icon = {
    pending: Circle,
    working: Loader,
    done: CheckCircle,
    failed: XCircle,
  }[state];
  const tone = {
    pending: 'text-muted-foreground',
    working: 'text-highlight animate-spin',
    done: 'text-status-running',
    failed: 'text-destructive',
  }[state];
  return (
    <div className="flex items-start gap-3 rounded-lg px-3 py-2">
      <Icon size={14} className={`mt-0.5 flex-shrink-0 ${tone}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{site.domain}</div>
        {state === 'done' && status.url ? (
          <button
            onClick={() => window.electronAPI.openSiteInBrowser(status.url)}
            className="text-xs text-highlight hover:underline"
          >
            {status.url}
          </button>
        ) : status?.message ? (
          <div
            className={`text-xs ${state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {status.message}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">Waiting…</div>
        )}
      </div>
    </div>
  );
}

function HerdRunningNotice() {
  return (
    <div className="flex items-start gap-2 bg-status-warning/10 text-status-warning rounded-xl px-3 py-2.5 text-xs">
      <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
      <span>
        Herd is running. Its nginx answers every .test address while it runs, WPXen’s
        sites included, so quit Herd to have WPXen serve them.
      </span>
    </div>
  );
}
