import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Button, Card, ConfirmDialog, SectionLabel, SettingsRow, Toggle } from '../../ui';
import { SelectSetting, TextSetting } from '../controls';
import { useSettings } from '../../../lib/useSettings';
import { useSettingsContext } from '../SettingsLayout';

export default function GeneralSection() {
  const { settings, setSetting } = useSettings();
  const { visible } = useSettingsContext();
  // 'history' | 'data' while the matching confirmation is up.
  const [confirming, setConfirming] = useState(null);
  const [cleared, setCleared] = useState(null);

  const pickTerminalDir = async () => {
    const folder = await window.electronAPI.selectFolder();
    if (folder) setSetting('floatingWorkspace.terminalDirectory', folder);
  };

  const clear = async () => {
    const what = confirming;
    setConfirming(null);
    if (what === 'history') await window.electronAPI.browserHistoryClear();
    else await window.electronAPI.browserClearData();
    setCleared(what);
  };

  return (
    <div>
      <SectionLabel>General</SectionLabel>
      <Card>
        <SettingsRow
          id="app.startAtLogin"
          visible={visible}
          title="Start at Login"
          subtitle="Launch WPXen when you log into macOS"
        >
          <Toggle
            checked={!!settings['app.startAtLogin']}
            onChange={(v) => setSetting('app.startAtLogin', v)}
            label="Start at Login"
          />
        </SettingsRow>

        <SettingsRow
          id="app.confirmOnQuit"
          visible={visible}
          title="Confirm before quitting"
          subtitle="Quitting stops every service and takes your local sites offline"
        >
          <Toggle
            checked={settings['app.confirmOnQuit'] !== false}
            onChange={(v) => setSetting('app.confirmOnQuit', v)}
            label="Confirm before quitting"
          />
        </SettingsRow>

        <SettingsRow
          id="app.closeAction"
          visible={visible}
          title="When the window is closed"
          subtitle="Hiding keeps your sites serving in the background"
        >
          <SelectSetting
            value={settings['app.closeAction']}
            onChange={(v) => setSetting('app.closeAction', v)}
            ariaLabel="Close button behaviour"
            options={[
              { value: 'tray', label: 'Hide to menu bar' },
              { value: 'quit', label: 'Quit WPXen' },
            ]}
          />
        </SettingsRow>
      </Card>

      <SectionLabel>Floating Workspace</SectionLabel>
      <Card>
        <SettingsRow
          id="floatingWorkspace.enabled"
          visible={visible}
          title="Show floating workspace"
          subtitle="A button in the corner of every page opens a floating terminal (⌘⌥A)"
        >
          <Toggle
            checked={settings['floatingWorkspace.enabled'] !== false}
            onChange={(v) => setSetting('floatingWorkspace.enabled', v)}
            label="Show floating workspace"
          />
        </SettingsRow>

        <SettingsRow
          id="floatingWorkspace.terminalDirectory"
          visible={visible}
          title="Terminal directory"
          subtitle="Where a new terminal opens when you’re not on a site"
        >
          <TextSetting
            value={settings['floatingWorkspace.terminalDirectory']}
            onCommit={(v) => setSetting('floatingWorkspace.terminalDirectory', v)}
            ariaLabel="Floating terminal directory"
            className="font-mono !text-xs !w-56"
            placeholder="~"
          />
          <button
            onClick={pickTerminalDir}
            aria-label="Choose terminal directory"
            className="btn-secondary !px-2.5 !py-1.5"
          >
            <FolderOpen size={13} />
          </button>
        </SettingsRow>
      </Card>

      <SectionLabel>In-App Browser</SectionLabel>
      <Card>
        <SettingsRow
          id="app.openLinksIn"
          visible={visible}
          title="Open links in"
          subtitle="Where a site’s Open, wp-admin and phpMyAdmin actions land"
        >
          <SelectSetting
            value={settings['app.openLinksIn']}
            onChange={(v) => setSetting('app.openLinksIn', v)}
            ariaLabel="Open links in"
            options={[
              { value: 'system', label: 'Default browser' },
              { value: 'app', label: 'WPXen' },
            ]}
          />
        </SettingsRow>

        <SettingsRow
          id="browser.clearHistory"
          visible={visible}
          title="Clear browsing history"
          subtitle={
            cleared === 'history'
              ? 'History cleared.'
              : 'Removes the address-bar suggestions in the Agents browser'
          }
        >
          <Button variant="secondary" onClick={() => setConfirming('history')}>
            Clear
          </Button>
        </SettingsRow>

        <SettingsRow
          id="browser.clearData"
          visible={visible}
          title="Clear cookies & cache"
          subtitle={
            cleared === 'data'
              ? 'Cookies and cache cleared.'
              : 'Signs you out of every site you signed into in the app'
          }
        >
          <Button variant="secondary" onClick={() => setConfirming('data')}>
            Clear
          </Button>
        </SettingsRow>
      </Card>

      <ConfirmDialog
        open={confirming != null}
        title={
          confirming === 'data' ? 'Clear cookies & cache?' : 'Clear browsing history?'
        }
        description={
          confirming === 'data'
            ? 'This signs you out of every site you signed into in the in-app browser, and empties its cache. Your sites and their data are untouched.'
            : 'This removes every address-bar suggestion in the in-app browser. Open tabs stay where they are.'
        }
        confirmLabel="Clear"
        danger
        onConfirm={clear}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
