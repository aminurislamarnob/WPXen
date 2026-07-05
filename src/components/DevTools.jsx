import { useState, useEffect, useRef } from 'react';
import { Loader, Download, Play, RefreshCw, Package, Hexagon, Server } from 'lucide-react';
import { Card, Row, SectionLabel } from './ui';

// Composer + Node + webserver per-site dev tooling (Tier 2 #11 + #8).
export default function DevTools({ site, onSaved }) {
  const [composer, setComposer] = useState(null);
  const [nodeData, setNodeData] = useState(null);
  const [apacheStatus, setApacheStatus] = useState(null);
  const [installing, setInstalling] = useState(false); // 'composer' | 'apache' | false
  const [running, setRunning] = useState(null); // 'install' | 'update' | null
  const [switching, setSwitching] = useState(false);
  const [log, setLog] = useState([]);
  const [error, setError] = useState(null);
  const [nodeSaving, setNodeSaving] = useState(false);
  const logRef = useRef(null);

  const webserver = site.webserver === 'apache' ? 'apache' : 'nginx';

  useEffect(() => {
    load();

    const onInstall = (data) => data?.line && appendLog(data.line);
    const onRun = (data) => data?.id === site.id && data?.line && appendLog(data.line);
    window.electronAPI.on('composer-install-progress', onInstall);
    window.electronAPI.on('composer-run-progress', onRun);
    window.electronAPI.on('apache-install-progress', onInstall);
    return () => {
      window.electronAPI.off('composer-install-progress');
      window.electronAPI.off('composer-run-progress');
      window.electronAPI.off('apache-install-progress');
    };
  }, [site.id]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  function appendLog(line) {
    setLog((prev) => [...prev, line].slice(-200));
  }

  async function load() {
    const [c, n, a] = await Promise.all([
      window.electronAPI.getComposerStatus(),
      window.electronAPI.getNodeVersions(),
      window.electronAPI.getApacheStatus(),
    ]);
    if (c.success) setComposer(c);
    if (n.success) setNodeData(n);
    if (a.success) setApacheStatus(a);
  }

  async function handleInstallComposer() {
    setError(null);
    setLog([]);
    setInstalling('composer');
    const res = await window.electronAPI.installComposer();
    setInstalling(false);
    if (!res.success) setError(res.error);
    await load();
  }

  async function handleInstallApache() {
    setError(null);
    setLog([]);
    setInstalling('apache');
    const res = await window.electronAPI.installApache();
    setInstalling(false);
    if (!res.success) setError(res.error);
    await load();
  }

  async function handleSetWebserver(target) {
    if (target === webserver) return;
    setError(null);
    if (target === 'apache') setLog([]);
    setSwitching(true);
    const res = await window.electronAPI.setSiteWebserver(site.id, target);
    setSwitching(false);
    if (res.success) onSaved?.();
    else setError(res.error);
  }

  async function handleRunComposer(cmd) {
    setError(null);
    setLog([]);
    setRunning(cmd);
    const res = await window.electronAPI.runComposer(site.id, cmd);
    setRunning(null);
    if (!res.success) setError(res.error);
  }

  async function handleSetNode(version) {
    setNodeSaving(true);
    const res = await window.electronAPI.setSiteNodeVersion(site.id, version);
    setNodeSaving(false);
    if (res.success) onSaved?.();
    else setError(res.error);
  }

  const busy = installing !== false || running != null || switching;

  return (
    <div className="space-y-6">
      {error && (
        <div className="px-4 py-2.5 rounded-xl bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Webserver */}
      <div>
        <SectionLabel>Webserver</SectionLabel>
        <Card>
          <Row
            icon={<Server size={18} className="text-gray-500" />}
            title="Webserver"
            subtitle={
              webserver === 'apache'
                ? 'Apache — nginx proxies this site to httpd'
                : 'nginx (default)'
            }
          >
            <div className="flex items-center gap-2">
              {switching && <Loader size={13} className="animate-spin text-gray-400" />}
              <div className="inline-flex rounded-full bg-gray-100 dark:bg-white/10 p-0.5">
                {['nginx', 'apache'].map((ws) => (
                  <button
                    key={ws}
                    onClick={() => handleSetWebserver(ws)}
                    disabled={busy}
                    className={`px-3 py-1 rounded-full text-xs capitalize transition-colors ${
                      webserver === ws
                        ? 'bg-white dark:bg-white/15 text-gray-900 shadow-sm'
                        : 'text-gray-500 hover:text-gray-800'
                    }`}
                  >
                    {ws}
                  </button>
                ))}
              </div>
            </div>
          </Row>
          {apacheStatus && !apacheStatus.installed && (
            <div className="px-4 py-2.5 border-t border-gray-100 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-500">
                Apache (httpd) is not installed.
              </p>
              <button
                onClick={handleInstallApache}
                disabled={busy}
                className="btn-secondary text-xs min-w-[90px] justify-center"
              >
                {installing === 'apache' ? (
                  <>
                    <Loader size={11} className="animate-spin mr-1.5" />
                    Installing…
                  </>
                ) : (
                  <>
                    <Download size={11} className="mr-1.5" />
                    Install httpd
                  </>
                )}
              </button>
            </div>
          )}
        </Card>
        <p className="text-[11px] text-gray-400 mt-1.5 px-1">
          nginx stays the front door on ports 80/443. Apache-flagged sites are
          reverse-proxied to a local httpd and served via mod_proxy_fcgi.
        </p>
      </div>

      {/* Composer */}
      <div>
        <SectionLabel>Composer</SectionLabel>
        <Card>
          <Row
            icon={<Package size={18} className="text-gray-500" />}
            title="Composer"
            subtitle={
              composer == null
                ? 'Checking…'
                : composer.installed
                  ? composer.version
                    ? `Version ${composer.version}`
                    : 'Installed'
                  : 'Not installed'
            }
          >
            {composer && !composer.installed && (
              <button
                onClick={handleInstallComposer}
                disabled={busy}
                className="btn-secondary text-xs min-w-[90px] justify-center"
              >
                {installing === 'composer' ? (
                  <>
                    <Loader size={11} className="animate-spin mr-1.5" />
                    Installing…
                  </>
                ) : (
                  <>
                    <Download size={11} className="mr-1.5" />
                    Install
                  </>
                )}
              </button>
            )}
            {composer && composer.installed && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleRunComposer('install')}
                  disabled={busy}
                  className="btn-secondary text-xs"
                >
                  {running === 'install' ? (
                    <Loader size={11} className="animate-spin mr-1.5" />
                  ) : (
                    <Play size={11} fill="currentColor" className="mr-1.5" />
                  )}
                  Install
                </button>
                <button
                  onClick={() => handleRunComposer('update')}
                  disabled={busy}
                  className="btn-secondary text-xs"
                >
                  {running === 'update' ? (
                    <Loader size={11} className="animate-spin mr-1.5" />
                  ) : (
                    <RefreshCw size={11} className="mr-1.5" />
                  )}
                  Update
                </button>
              </div>
            )}
          </Row>
        </Card>
        <p className="text-[11px] text-gray-400 mt-1.5 px-1">
          Runs <span className="font-mono">composer</span> in this site&apos;s directory
          using PHP {site.phpVersion}.
        </p>
      </div>

      {/* Node */}
      <div>
        <SectionLabel>Node.js</SectionLabel>
        <Card>
          <Row
            icon={<Hexagon size={18} className="text-gray-500" />}
            title="Node version"
            subtitle="Used when opening this site in Terminal"
          >
            {nodeData == null ? (
              <Loader size={13} className="animate-spin text-gray-400" />
            ) : nodeData.versions.length === 0 ? (
              <span className="text-xs text-gray-400">No versions found</span>
            ) : (
              <div className="flex items-center gap-2">
                <select
                  value={site.nodeVersion || ''}
                  disabled={nodeSaving}
                  onChange={(e) => handleSetNode(e.target.value)}
                  className="form-input text-sm py-1.5"
                >
                  <option value="">System default</option>
                  {nodeData.versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      {v.version} ({v.source})
                    </option>
                  ))}
                </select>
                {nodeSaving && <Loader size={13} className="animate-spin text-gray-400" />}
              </div>
            )}
          </Row>
        </Card>
        {nodeData && nodeData.versions.length === 0 && (
          <p className="text-[11px] text-gray-400 mt-1.5 px-1">
            Install Node versions with{' '}
            <span className="font-mono">nvm</span> or <span className="font-mono">fnm</span>{' '}
            and they&apos;ll appear here.
          </p>
        )}
      </div>

      {/* Shared command output */}
      {(busy || log.length > 0) && (
        <div className="rounded-xl overflow-hidden bg-zinc-900">
          <div
            ref={logRef}
            className="px-4 py-3 max-h-56 overflow-y-auto font-mono text-xs text-zinc-300 space-y-0.5"
          >
            {log.length === 0 ? (
              <p className="text-zinc-500">Starting…</p>
            ) : (
              log.map((line, i) => (
                <p key={i} className="whitespace-pre-wrap break-words">
                  {line}
                </p>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
