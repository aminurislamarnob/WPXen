import { FolderOpen } from 'lucide-react';
import { Card, SectionLabel, SettingsRow } from '../../ui';
import { TextSetting } from '../controls';
import { useSettings } from '../../../lib/useSettings';
import { useSettingsContext } from '../SettingsLayout';

export default function SitesSection() {
  const { settings, setSetting } = useSettings();
  const { visible } = useSettingsContext();

  async function pickSitesDir() {
    const folder = await window.electronAPI.selectFolder();
    if (folder) setSetting('sites.dir', folder);
  }

  return (
    <div>
      <SectionLabel>Sites</SectionLabel>
      <Card>
        <SettingsRow
          id="sites.dir"
          visible={visible}
          title="Default Sites Directory"
          subtitle="New WordPress sites will be created here"
        >
          <TextSetting
            value={settings['sites.dir']}
            onCommit={(v) => setSetting('sites.dir', v)}
            ariaLabel="Default sites directory"
            className="font-mono !text-xs !w-56"
            placeholder="~/Sites"
          />
          <button
            onClick={pickSitesDir}
            aria-label="Choose sites directory"
            className="btn-secondary !px-2.5 !py-1.5"
          >
            <FolderOpen size={13} />
          </button>
        </SettingsRow>

        <SettingsRow
          id="php.defaultVersion"
          visible={visible}
          title="Default PHP Version"
          subtitle="PHP version new sites are created with"
        >
          <TextSetting
            value={settings['php.defaultVersion']}
            onCommit={(v) => setSetting('php.defaultVersion', v)}
            ariaLabel="Default PHP version"
            className="font-mono !text-xs !w-24 text-center"
            placeholder="8.2"
          />
        </SettingsRow>
      </Card>
    </div>
  );
}
