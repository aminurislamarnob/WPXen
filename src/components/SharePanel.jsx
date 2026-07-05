import { useState } from 'react';
import {
  Share2,
  Loader,
  Copy,
  Check,
  X,
  Download,
  Lock,
  ChevronRight,
} from 'lucide-react';
import { Toggle } from './ui';
import ShareQR from './ShareQR';

// Shared share-tunnel panel body — one status machine used by both the site
// card (Sites page) and the site detail Overview, so the two surfaces can't
// drift. The parent owns tunnel state and cloudflared availability (a single
// 'tunnel-update' subscription per page) and passes everything down.
export default function SharePanel({
  site,
  tunnel,
  cfInstalled,
  cfInstalling,
  cfLog,
  onStartTunnel,
  onStopTunnel,
  onInstallCloudflared,
  onSaved,
  onClose,
}) {
  const [copied, setCopied] = useState(false);

  // Share options (persisted per site as site.share). The password is
  // write-only: it's sent on save, hashed into an htpasswd file in the main
  // process, and never echoed back.
  const share = site.share || {};
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(!!share.authEnabled);
  const [authUser, setAuthUser] = useState(share.authUser || 'guest');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const tunnelActive =
    tunnel && (tunnel.status === 'starting' || tunnel.status === 'running');

  function copyTunnelUrl() {
    if (!tunnel?.url) return;
    navigator.clipboard.writeText(tunnel.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleSaveOptions() {
    setSaving(true);
    setSaveError(null);
    const res = await window.electronAPI.setShareSettings(site.id, {
      authEnabled,
      authUser: authUser.trim(),
      ...(password ? { password } : {}),
    });
    setSaving(false);
    if (!res?.success) {
      setSaveError(res?.error || 'Failed to save share options.');
      return;
    }
    setPassword('');
    onSaved?.();
  }

  const options = (
    <div className="mt-2">
      <button
        onClick={() => setOptionsOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
      >
        <ChevronRight
          size={11}
          className={`transition-transform ${optionsOpen ? 'rotate-90' : ''}`}
        />
        Share options
        {share.authEnabled && <Lock size={10} className="text-wp-green ml-0.5" />}
      </button>
      {optionsOpen && (
        <div className="mt-2 space-y-2 animate-fade-in">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs text-gray-600">Password protection</span>
            <Toggle
              checked={authEnabled}
              onChange={setAuthEnabled}
              label="Password protection"
            />
          </div>
          {authEnabled && (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={authUser}
                onChange={(e) => setAuthUser(e.target.value)}
                placeholder="Username"
                className="form-input !py-1 text-xs flex-1 min-w-0"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={share.authEnabled ? '••••••• (unchanged)' : 'Password'}
                className="form-input !py-1 text-xs flex-1 min-w-0"
              />
            </div>
          )}
          <button
            onClick={handleSaveOptions}
            disabled={saving}
            className="btn-secondary text-xs justify-center w-full"
          >
            {saving ? <Loader size={12} className="animate-spin mr-1.5" /> : null}
            Save options
          </button>
          {saveError && (
            <p className="text-xs text-red-600 dark:text-red-400">{saveError}</p>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
          <Share2 size={12} />
          Public share tunnel
        </span>
        {!tunnelActive && onClose && (
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" title="Close">
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
            <div className="mt-2 px-3 py-2 bg-zinc-900 rounded-lg">
              <p className="text-xs text-green-400 font-mono truncate" title={cfLog}>
                {cfLog}
              </p>
            </div>
          )}
        </div>
      ) : tunnel?.status === 'running' ? (
        <div>
          <div className="flex items-center gap-1.5">
            {tunnel.authEnabled && (
              <Lock size={12} className="text-wp-green flex-shrink-0" title="Password protected" />
            )}
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
              {copied ? <Check size={13} className="text-wp-green" /> : <Copy size={13} />}
            </button>
            <button
              onClick={() => onStopTunnel(site)}
              title="Stop sharing"
              className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10"
            >
              <X size={13} />
            </button>
          </div>
          <div className="mt-2 flex items-start gap-3">
            <ShareQR url={tunnel.url} />
            <p className="text-xs text-gray-400 pt-1">
              Scan to open on your phone.
              <br />
              {tunnel.authEnabled
                ? 'Visitors need the share username and password.'
                : "Anyone with this link can reach your local site while it's open."}
            </p>
          </div>
          {options}
        </div>
      ) : tunnel?.status === 'starting' ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader size={13} className="animate-spin" />
          Creating public URL…
        </div>
      ) : tunnel?.status === 'error' ? (
        <div>
          <p className="text-xs text-red-600 dark:text-red-400 mb-2">
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
          {options}
        </div>
      )}
    </div>
  );
}
