import { Smartphone } from 'lucide-react';
import { Card, Row, SectionLabel, SettingsRow, Toggle } from '../../ui';
import { NumberSetting } from '../controls';
import { useSettings } from '../../../lib/useSettings';
import { useSettingsContext } from '../SettingsLayout';
import { useRemoteAccessStatus } from '../../../lib/useRemoteAccess';

// Bounds mirror services/remoteAccess.cjs (the schema enforces them; these
// only clamp the field). Keep the three in sync.
const DEFAULT_PORT = 6780;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

// Settings → Mobile: the Remote Access tracer (#140) — a switch, a bounded
// port, and the server's live state. No tunnel, pairing or phone yet.
export default function MobileSection() {
  const { settings, setSetting } = useSettings();
  const { visible } = useSettingsContext();
  const status = useRemoteAccessStatus();

  const enabled = settings['remote.enabled'] === true;

  const stateLine =
    status.state === 'listening'
      ? `Listening on ${status.host}:${status.actualPort}`
      : status.state === 'error'
        ? `Error — ${status.reason || 'the server failed to start'}`
        : 'Off';

  // The status row is live state, not a setting, so it answers to either
  // registry entry rather than carrying an id of its own.
  const showStatus =
    !visible || visible.includes('remote.enabled') || visible.includes('remote.port');

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
            <Row title="Status" subtitle={stateLine}>
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
        {status.state === 'error' && status.actualPort != null && (
          <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
            Still listening on {status.host}:{status.actualPort} with the previous port.
          </p>
        )}
        <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
          Listens on 127.0.0.1 only — nothing on your network can reach it directly. The
          tunnel and phone pairing arrive in later tickets.
        </p>
      </div>
    </div>
  );
}
