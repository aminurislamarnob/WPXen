import { Card, SectionLabel, SettingsRow, Toggle } from '../../ui';
import { SelectSetting } from '../controls';
import { useSettings } from '../../../lib/useSettings';
import { useSettingsContext } from '../SettingsLayout';

export default function GeneralSection() {
  const { settings, setSetting } = useSettings();
  const { visible } = useSettingsContext();

  return (
    <div>
      <SectionLabel>General</SectionLabel>
      <Card>
        <SettingsRow
          id="app.startAtLogin"
          visible={visible}
          title="Start at Login"
          subtitle="Launch WPHerd when you log into macOS"
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
              { value: 'quit', label: 'Quit WPHerd' },
            ]}
          />
        </SettingsRow>
      </Card>
    </div>
  );
}
