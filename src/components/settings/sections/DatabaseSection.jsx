import { Card, SectionLabel, SettingsRow } from '../../ui';
import { TextSetting } from '../controls';
import { useSettings } from '../../../lib/useSettings';
import { useSettingsContext } from '../SettingsLayout';

export default function DatabaseSection() {
  const { settings, setSetting } = useSettings();
  const { visible } = useSettingsContext();

  return (
    <div>
      <SectionLabel>Database</SectionLabel>
      <Card>
        <SettingsRow
          id="db.user"
          visible={visible}
          title="MySQL User"
          subtitle="Used to create databases and configure WordPress"
        >
          <TextSetting
            value={settings['db.user']}
            onCommit={(v) => setSetting('db.user', v)}
            ariaLabel="MySQL user"
            className="font-mono !text-xs !w-40"
            placeholder="root"
          />
        </SettingsRow>

        <SettingsRow
          id="db.password"
          visible={visible}
          title="MySQL Password"
          subtitle="Leave blank for a passwordless root"
        >
          <TextSetting
            type="password"
            value={settings['db.password']}
            onCommit={(v) => setSetting('db.password', v)}
            ariaLabel="MySQL password"
            className="font-mono !text-xs !w-40"
            placeholder="(none)"
          />
        </SettingsRow>
      </Card>
    </div>
  );
}
