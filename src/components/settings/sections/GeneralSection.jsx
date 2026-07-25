import { Card, SectionLabel, SettingsRow, Toggle } from '../../ui';
import { useSettings } from '../../../lib/useSettings';
import { useSettingsContext } from '../SettingsLayout';

export default function GeneralSection() {
  const { settings, setSetting } = useSettings();
  const { visible } = useSettingsContext();

  const rows = (
    <>
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
    </>
  );

  return (
    <div>
      <SectionLabel>General</SectionLabel>
      <Card>{rows}</Card>
    </div>
  );
}
