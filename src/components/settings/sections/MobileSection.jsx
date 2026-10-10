import { useCallback, useEffect, useState } from 'react';
import { Download, Loader, Moon, Smartphone } from 'lucide-react';
import {
  Button,
  Card,
  ConfirmDialog,
  Row,
  SectionLabel,
  SettingsRow,
  Toggle,
} from '../../ui';
import { NumberSetting, TextSetting } from '../controls';
import { useSettings } from '../../../lib/useSettings';
import { useSettingsContext } from '../SettingsLayout';
import {
  useRemoteAccessDevices,
  useRemoteAccessStatus,
} from '../../../lib/useRemoteAccess';

// Bounds mirror services/remoteAccess.cjs (the schema enforces them; these
// only clamp the field). Keep the three in sync.
const DEFAULT_PORT = 6780;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
// The supervised child's procman name (cloudflared.cjs REMOTE_TUNNEL_NAME),
// for the View-log link. Keep in sync.
const TUNNEL_LOG_NAME = 'wpxen-remote-tunnel';

const TUNNEL_STATE_LABEL = {
  'not-configured': 'Not configured',
  starting: 'Starting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  error: 'Error',
};

const VERIFY_REASON_COPY = {
  dns: 'The hostname doesn’t resolve — check it in the Cloudflare dashboard.',
  connection: 'Can’t reach the hostname — check the tunnel and your network.',
  'wrong-server': 'A different server answered — check the hostname points at this Mac.',
  'wrong-port':
    'The route doesn’t answer like WPXen — point it at the localhost port below.',
  timeout: 'Timed out waiting for the hostname.',
};

function formatRelativeTime(timestamp) {
  if (typeof timestamp !== 'number') return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function formatDate(timestamp) {
  if (typeof timestamp !== 'number') return '—';
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// Settings → Mobile: Remote Access (#140 tracer, #141 tunnel) — the switch,
// the port, the tunnel token and hostname, and the live tunnel and
// verification state. Pairing and the phone arrive in later tickets.
export default function MobileSection() {
  const { settings, setSetting } = useSettings();
  const { visible } = useSettingsContext();
  const status = useRemoteAccessStatus();

  const [tokenDraft, setTokenDraft] = useState('');
  const [editingToken, setEditingToken] = useState(false);
  const [tokenError, setTokenError] = useState(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [cfInstalled, setCfInstalled] = useState(null);
  const [cfInstalling, setCfInstalling] = useState(false);
  const [cfLog, setCfLog] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [pairing, setPairing] = useState(null);
  const [pairingError, setPairingError] = useState(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [, setTick] = useState(0);
  const [renamingId, setRenamingId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [revoking, setRevoking] = useState(null);
  const [deviceError, setDeviceError] = useState(null);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const devices = useRemoteAccessDevices();

  const tokenSaved = status.tokenSaved === true;
  const enabled = settings['remote.enabled'] === true;
  const hostname = settings['remote.hostname'] || '';
  const port = settings['remote.port'];

  const refreshInstallState = useCallback(() => {
    window.electronAPI
      .checkCloudflared()
      .then((r) => setCfInstalled(r?.installed !== false))
      .catch(() => setCfInstalled(null));
  }, []);

  useEffect(() => {
    refreshInstallState();
    const onInstallLog = (data) => data && setCfLog(data.line);
    window.electronAPI.on('cloudflared-install-progress', onInstallLog);
    return () => window.electronAPI.off('cloudflared-install-progress');
  }, [refreshInstallState]);

  async function saveToken() {
    setTokenError(null);
    setTokenBusy(true);
    try {
      const result = await window.electronAPI.setRemoteToken(tokenDraft);
      if (result?.ok) {
        setTokenDraft('');
        setEditingToken(false);
      } else {
        setTokenError(result?.error || 'Could not save the token.');
      }
    } catch {
      setTokenError('Could not save the token.');
    } finally {
      setTokenBusy(false);
    }
  }

  async function removeToken() {
    setTokenError(null);
    setTokenBusy(true);
    try {
      const result = await window.electronAPI.clearRemoteToken();
      if (!result?.ok) setTokenError(result?.error || 'Could not remove the token.');
    } catch {
      setTokenError('Could not remove the token.');
    } finally {
      setTokenBusy(false);
    }
  }

  async function installCloudflared() {
    setCfInstalling(true);
    setCfLog('');
    try {
      const result = await window.electronAPI.installCloudflared();
      if (result?.success) setCfInstalled(true);
      else setCfLog(result?.error || 'Install failed.');
    } catch {
      setCfLog('Install failed.');
    } finally {
      setCfInstalling(false);
    }
  }

  async function checkAgain() {
    setVerifying(true);
    try {
      await window.electronAPI.verifyRemoteHostname();
    } catch {
      // The result lands through the status broadcast regardless.
    } finally {
      setVerifying(false);
    }
  }

  async function newPairing() {
    setPairingError(null);
    setPairingBusy(true);
    try {
      const result = await window.electronAPI.newRemotePairing();
      if (result?.ok) setPairing({ qr: result.qr, expiresAt: result.expiresAt });
      else setPairingError(result?.error || 'Could not create a pairing code.');
    } catch {
      setPairingError('Could not create a pairing code.');
    } finally {
      setPairingBusy(false);
    }
  }

  // Countdown for the open offer; the secret dies with it.
  useEffect(() => {
    if (!pairing) return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [pairing]);
  const pairingSecondsLeft = pairing
    ? Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000))
    : 0;

  async function saveRename(id) {
    setDeviceError(null);
    setDeviceBusy(true);
    try {
      const result = await window.electronAPI.renameRemoteDevice(id, renameDraft);
      if (result?.ok) {
        setRenamingId(null);
        setRenameDraft('');
      } else {
        setDeviceError(result?.error || 'Could not rename the device.');
      }
    } catch {
      setDeviceError('Could not rename the device.');
    } finally {
      setDeviceBusy(false);
    }
  }

  async function confirmRevoke() {
    if (!revoking) return;
    setDeviceError(null);
    setDeviceBusy(true);
    try {
      const result = await window.electronAPI.revokeRemoteDevice(revoking.id);
      if (!result?.ok) setDeviceError(result?.error || 'Could not revoke the device.');
    } catch {
      setDeviceError('Could not revoke the device.');
    } finally {
      setDeviceBusy(false);
      setRevoking(null);
    }
  }

  async function disconnectAll() {
    setDeviceError(null);
    setDeviceBusy(true);
    try {
      const result = await window.electronAPI.disconnectRemoteDevices();
      if (!result?.ok)
        setDeviceError(result?.error || 'Could not disconnect the devices.');
    } catch {
      setDeviceError('Could not disconnect the devices.');
    } finally {
      setDeviceBusy(false);
    }
  }

  const canPair =
    enabled &&
    status.state === 'listening' &&
    status.verification?.state === 'ok' &&
    hostname;

  const serverLine =
    status.state === 'listening'
      ? `Listening on ${status.host}:${status.actualPort}`
      : status.state === 'error'
        ? `Error — ${status.reason || 'the server failed to start'}`
        : 'Off';

  const tunnelState = status.tunnel?.state || 'not-configured';
  const tunnelReason = status.tunnel?.reason || null;
  const tunnelLine =
    tunnelState === 'error'
      ? `Error — ${tunnelReason || 'the tunnel failed'}`
      : TUNNEL_STATE_LABEL[tunnelState] || tunnelState;

  const verification = status.verification || { state: 'idle' };
  const verificationLine =
    verification.state === 'ok' && hostname
      ? `Reachable at https://${hostname}`
      : verification.state === 'failed'
        ? VERIFY_REASON_COPY[verification.reason] || 'Verification failed.'
        : verification.state === 'verifying'
          ? 'Checking…'
          : 'Not checked yet';

  // The status rows are live state, not settings, so they answer to the
  // registry entries above them rather than carrying ids of their own.
  const showStatus =
    !visible ||
    visible.includes('remote.enabled') ||
    visible.includes('remote.port') ||
    visible.includes('remote.hostname');

  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>Remote Access</SectionLabel>
        <Card>
          <SettingsRow
            id="remote.enabled"
            visible={visible}
            icon={
              <Smartphone size={18} className="text-muted-foreground flex-shrink-0" />
            }
            title="Remote Access"
            subtitle="Serve this Mac on localhost so a paired phone can reach it"
          >
            <Toggle
              checked={enabled}
              onChange={(v) => setSetting('remote.enabled', v)}
              label="Remote Access"
            />
          </SettingsRow>
          <SettingsRow
            id="remote.port"
            visible={visible}
            title="Port"
            subtitle={`Localhost port, ${MIN_PORT}–${MAX_PORT} (default ${DEFAULT_PORT})`}
          >
            <NumberSetting
              value={settings['remote.port']}
              onCommit={(v) => setSetting('remote.port', v)}
              min={MIN_PORT}
              max={MAX_PORT}
              ariaLabel="Remote Access port"
              className="!w-24"
            />
          </SettingsRow>
          {showStatus && (
            <Row title="Status" subtitle={serverLine}>
              <span
                className={`text-xs ${status.state === 'error' ? 'text-destructive' : status.state === 'listening' ? 'text-status-running' : 'text-muted-foreground'}`}
              >
                {status.state === 'listening'
                  ? 'On'
                  : status.state === 'error'
                    ? 'Error'
                    : 'Off'}
              </span>
            </Row>
          )}
        </Card>
        <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
          Listens on 127.0.0.1 only — nothing on your network can reach it directly.
        </p>
      </div>

      <div>
        <SectionLabel>Staying Reachable</SectionLabel>
        <Card>
          <SettingsRow
            id="remote.keepAwake"
            visible={visible}
            icon={<Moon size={18} className="text-muted-foreground flex-shrink-0" />}
            title="Keep Mac awake for remote access"
            subtitle="Hold the Mac awake while an Agent works or a phone is connected"
          >
            <Toggle
              checked={settings['remote.keepAwake'] !== false}
              onChange={(v) => setSetting('remote.keepAwake', v)}
              label="Keep Mac awake for remote access"
            />
          </SettingsRow>
        </Card>
        <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
          Closing the lid on battery still puts the Mac to sleep. No app can prevent that.
        </p>
      </div>

      <div>
        <SectionLabel>Cloudflare Tunnel</SectionLabel>
        <Card>
          <SettingsRow
            id="remote.hostname"
            visible={visible}
            title="Public hostname"
            subtitle="The hostname your tunnel routes at this Mac"
          >
            <TextSetting
              value={settings['remote.hostname'] || ''}
              onCommit={(v) => setSetting('remote.hostname', v.trim())}
              ariaLabel="Public hostname"
              className="font-mono !text-xs !w-56"
              placeholder="wpxen.example.com"
            />
          </SettingsRow>
          {showStatus && (
            <div className="settings-row">
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-foreground">Tunnel token</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {tokenSaved && !editingToken
                    ? 'Token saved · stored encrypted, never shown again'
                    : 'Pasted from the Cloudflare dashboard · stored encrypted'}
                </p>
                {(editingToken || !tokenSaved) && (
                  <input
                    type="password"
                    aria-label="Tunnel token"
                    autoComplete="off"
                    spellCheck={false}
                    className="form-input font-mono !text-xs !w-64 mt-2"
                    placeholder="Paste the tunnel token"
                    value={tokenDraft}
                    onChange={(e) => setTokenDraft(e.target.value)}
                  />
                )}
                {tokenError && (
                  <p className="text-[11px] text-destructive mt-1">{tokenError}</p>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {tokenSaved && !editingToken ? (
                  <>
                    <button
                      onClick={() => {
                        setEditingToken(true);
                        setTokenDraft('');
                        setTokenError(null);
                      }}
                      className="btn-secondary text-xs"
                    >
                      Replace
                    </button>
                    <button
                      onClick={removeToken}
                      disabled={tokenBusy}
                      className="btn-ghost text-xs text-muted-foreground hover:text-destructive"
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <>
                    {editingToken && (
                      <button
                        onClick={() => {
                          setEditingToken(false);
                          setTokenDraft('');
                          setTokenError(null);
                        }}
                        className="btn-ghost text-xs"
                      >
                        Cancel
                      </button>
                    )}
                    <Button
                      variant="secondary"
                      onClick={saveToken}
                      disabled={tokenBusy || !tokenDraft.trim()}
                    >
                      Save
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
          {showStatus && (
            <Row title="Tunnel" subtitle={tunnelLine}>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span
                  className={`text-xs ${tunnelState === 'error' ? 'text-destructive' : tunnelState === 'connected' ? 'text-status-running' : 'text-muted-foreground'}`}
                >
                  {TUNNEL_STATE_LABEL[tunnelState] || tunnelState}
                </span>
                {(tunnelState === 'connected' ||
                  tunnelState === 'reconnecting' ||
                  tunnelState === 'error') && (
                  <button
                    onClick={() => window.electronAPI.openServiceLog(TUNNEL_LOG_NAME)}
                    className="btn-ghost text-xs"
                  >
                    View log
                  </button>
                )}
              </div>
            </Row>
          )}
          {showStatus && (
            <Row title="Reachability" subtitle={verificationLine}>
              <button
                onClick={checkAgain}
                disabled={verifying || !hostname}
                className="btn-secondary text-xs flex-shrink-0"
              >
                {verifying ? 'Checking…' : 'Check again'}
              </button>
            </Row>
          )}
        </Card>
        {cfInstalled === false && showStatus && (
          <div className="mt-1.5 px-1">
            <p className="text-[11px] text-muted-foreground">
              cloudflared isn’t installed yet — the tunnel needs it.
            </p>
            <Button
              variant="secondary"
              onClick={installCloudflared}
              disabled={cfInstalling}
              aria-label="Install cloudflared"
            >
              {cfInstalling ? (
                <Loader size={13} className="animate-spin" />
              ) : (
                <Download size={13} />
              )}
              {cfInstalling ? 'Installing…' : 'Install cloudflared'}
            </Button>
            {cfLog && <p className="text-[11px] text-muted-foreground mt-1">{cfLog}</p>}
          </div>
        )}
        <div className="text-[11px] text-muted-foreground mt-1.5 px-1 space-y-1">
          <p>To create the tunnel:</p>
          <ol className="list-decimal list-inside space-y-0.5">
            <li>In the Cloudflare dashboard, open Zero Trust → Networks → Tunnels.</li>
            <li>
              Add a public hostname pointing at{' '}
              <span className="font-mono">http://localhost:{port || DEFAULT_PORT}</span>.
            </li>
            <li>Copy the token here.</li>
          </ol>
        </div>
      </div>

      <div>
        <SectionLabel>Pair a Device</SectionLabel>
        <Card>
          <div className="settings-row">
            <div className="flex-1 min-w-0">
              <p className="text-[13px] text-foreground">Pair a new phone or tablet</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {canPair
                  ? 'Shows a QR code for the phone to scan, then asks you to allow it'
                  : 'Turn Remote Access on and verify the hostname first'}
              </p>
              {pairingError && (
                <p className="text-[11px] text-destructive mt-1">{pairingError}</p>
              )}
            </div>
            <Button
              variant="secondary"
              onClick={newPairing}
              disabled={!canPair || pairingBusy}
            >
              {pairing ? 'New code' : 'Pair a device'}
            </Button>
          </div>
          {pairing && (
            <div className="px-4 pb-4">
              {pairingSecondsLeft > 0 ? (
                <div className="flex items-start gap-4">
                  <img
                    src={pairing.qr}
                    alt="Pairing QR code"
                    className="w-44 h-44 rounded-md border border-border"
                  />
                  <div className="text-xs text-muted-foreground space-y-1 pt-1">
                    <p>Scan this with WPXen Mobile.</p>
                    <p>
                      Expires in {Math.floor(pairingSecondsLeft / 60)}:
                      {String(pairingSecondsLeft % 60).padStart(2, '0')} · one scan only.
                    </p>
                    <p>Both screens show a code — allow it only if they match.</p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  That code expired. Make a new one to pair.
                </p>
              )}
            </div>
          )}
        </Card>
      </div>

      <div>
        <SectionLabel>Paired Devices</SectionLabel>
        <Card>
          {devices.length === 0 ? (
            <p className="settings-row text-xs text-muted-foreground">
              No phones or tablets paired yet.
            </p>
          ) : (
            devices.map((device, i) => (
              <div
                key={device.id}
                className={i > 0 ? 'border-t border-border' : undefined}
              >
                <div className="settings-row gap-2">
                  <span
                    aria-label={device.connected ? 'Connected now' : 'Not connected'}
                    title={device.connected ? 'Connected now' : 'Not connected'}
                    className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${
                      device.connected ? 'bg-status-running' : 'bg-muted-foreground/40'
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    {renamingId === device.id ? (
                      <input
                        type="text"
                        aria-label="Device name"
                        autoFocus
                        className="form-input !text-xs !w-48"
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveRename(device.id);
                          else if (e.key === 'Escape') setRenamingId(null);
                        }}
                      />
                    ) : (
                      <>
                        <p className="text-[13px] text-foreground truncate">
                          {device.name}
                        </p>
                        <p className="text-xs text-muted-foreground truncate mt-0.5">
                          {device.platform} · paired {formatDate(device.pairedAt)} · seen{' '}
                          {formatRelativeTime(device.lastSeen)}
                          {device.connected ? ' · connected now' : ''}
                        </p>
                      </>
                    )}
                  </div>
                  {renamingId === device.id ? (
                    <>
                      <button
                        onClick={() => saveRename(device.id)}
                        disabled={deviceBusy}
                        className="btn-secondary text-xs flex-shrink-0"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setRenamingId(null)}
                        className="btn-ghost text-xs flex-shrink-0"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => {
                          setRenamingId(device.id);
                          setRenameDraft(device.name);
                          setDeviceError(null);
                        }}
                        className="btn-ghost text-xs flex-shrink-0"
                      >
                        Rename
                      </button>
                      <Button
                        variant="danger"
                        onClick={() => setRevoking(device)}
                        disabled={deviceBusy}
                      >
                        Revoke
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </Card>
        {deviceError && (
          <p className="text-[11px] text-destructive mt-1.5 px-1">{deviceError}</p>
        )}
        {devices.some((d) => d.connected) && (
          <div className="mt-1.5 px-1">
            <Button variant="secondary" onClick={disconnectAll} disabled={deviceBusy}>
              Disconnect all devices
            </Button>
          </div>
        )}
        <ConfirmDialog
          open={revoking != null}
          title={`Revoke ${revoking?.name || 'this device'}?`}
          description="It loses access immediately and its live connection drops. It can only come back by pairing again."
          confirmLabel="Revoke"
          danger
          onConfirm={confirmRevoke}
          onCancel={() => setRevoking(null)}
        />
      </div>
    </div>
  );
}
