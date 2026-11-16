import { useEffect, useState } from 'react';
import { ArrowUpCircle, Download, RefreshCw } from 'lucide-react';
import { Button, Card, Row, SectionLabel, SettingsRow, Toggle } from '../../ui';
import { appUpdateStatusText, useAppUpdates } from '../../../lib/useAppUpdates';
import { isItemVisible } from '../../../lib/settingsSearch';
import { useSettings } from '../../../lib/useSettings';
import { useSettingsContext } from '../SettingsLayout';

export default function AboutSection() {
  const [sysInfo, setSysInfo] = useState(null);
  const { visible } = useSettingsContext();

  useEffect(() => {
    window.electronAPI.getSystemInfo().then(setSysInfo);
  }, []);

  return (
    <div className="space-y-6">
      <UpdatesCard />
      {sysInfo && isItemVisible('about.system', visible) && (
        <SystemInfoCard sysInfo={sysInfo} />
      )}
    </div>
  );
}

function SystemInfoCard({ sysInfo }) {
  return (
    <div>
      <SectionLabel>About</SectionLabel>
      <Card>
        {[
          ['Platform', `${sysInfo.platform} (${sysInfo.arch})`],
          ['Homebrew Prefix', sysInfo.brewPrefix || 'Not detected'],
          ['WPXen Version', sysInfo.appVersion],
          ['Electron', sysInfo.electronVersion],
          ['Node.js', sysInfo.nodeVersion],
        ].map(([label, value]) => (
          <Row key={label} title={<span className="text-muted-foreground">{label}</span>}>
            <span className="font-mono text-xs text-foreground">{value}</span>
          </Row>
        ))}
      </Card>
    </div>
  );
}

// Finds updates only: Download opens the DMG for this Mac in the browser, and
// the new app replaces the old one in Applications by hand. WPXen builds aren't
// Developer ID signed, which an in-place updater would need.
function UpdatesCard() {
  const { settings, setSetting } = useSettings();
  const { visible } = useSettingsContext();
  const updates = useAppUpdates();
  const ids = ['about.updates', 'app.checkForUpdates', 'app.updateNotifications'];
  if (!ids.some((id) => isItemVisible(id, visible))) return null;

  const checking = !!updates?.checking;
  const available = !!updates?.available;
  const checked = updates?.checkedAt
    ? `Last checked ${new Date(updates.checkedAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })}`
    : null;

  return (
    <div>
      <SectionLabel>Updates</SectionLabel>
      <Card>
        <SettingsRow
          id="about.updates"
          visible={visible}
          icon={
            available ? (
              <ArrowUpCircle size={18} className="text-highlight flex-shrink-0" />
            ) : null
          }
          title={appUpdateStatusText(updates) || 'WPXen Updates'}
          subtitle={checked}
        >
          {available ? (
            <>
              <Button
                variant="ghost"
                onClick={() => window.electronAPI.openAppUpdate('notes').catch(() => {})}
                className="flex-shrink-0"
              >
                Release notes
              </Button>
              <Button
                variant="primary"
                onClick={() =>
                  window.electronAPI.openAppUpdate('download').catch(() => {})
                }
                className="flex-shrink-0"
              >
                <Download size={13} />
                Download {updates.latest.version}
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              disabled={checking || !updates}
              onClick={() => window.electronAPI.checkAppUpdates().catch(() => {})}
              className="flex-shrink-0"
            >
              <RefreshCw size={13} className={checking ? 'animate-spin' : ''} />
              Check for updates
            </Button>
          )}
        </SettingsRow>
        <SettingsRow
          id="app.checkForUpdates"
          visible={visible}
          title="Check for WPXen updates"
          subtitle="Once a day, ask GitHub whether a newer WPXen release is out"
        >
          <Toggle
            checked={!!settings['app.checkForUpdates']}
            onChange={(v) => setSetting('app.checkForUpdates', v)}
            label="Check for WPXen updates"
          />
        </SettingsRow>
        <SettingsRow
          id="app.updateNotifications"
          visible={visible}
          title="Notify about WPXen updates"
          subtitle="Show a macOS notification when a new release is found"
        >
          <Toggle
            checked={!!settings['app.updateNotifications']}
            onChange={(v) => setSetting('app.updateNotifications', v)}
            label="Notify about WPXen updates"
          />
        </SettingsRow>
      </Card>
      <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
        Download opens the new version’s installer. Drag WPXen into Applications to
        replace this one; your sites and settings stay.
      </p>
    </div>
  );
}
