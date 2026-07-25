import { FolderOpen } from 'lucide-react';
import { Card, SectionLabel, SettingsRow, Toggle } from '../../ui';
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
    <div className="space-y-6">
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

      <div>
        <SectionLabel>New Site Defaults</SectionLabel>
        <Card>
          <SettingsRow
            id="sites.defaultWpVersion"
            visible={visible}
            title="WordPress Version"
            subtitle="“latest”, or a specific version like 6.5.2"
          >
            <TextSetting
              value={settings['sites.defaultWpVersion']}
              onCommit={(v) => setSetting('sites.defaultWpVersion', v)}
              ariaLabel="Default WordPress version"
              className="font-mono !text-xs !w-28 text-center"
              placeholder="latest"
            />
          </SettingsRow>

          <SettingsRow
            id="sites.defaultLocale"
            visible={visible}
            title="Locale"
            subtitle="Language pack new installs download"
          >
            <TextSetting
              value={settings['sites.defaultLocale']}
              onCommit={(v) => setSetting('sites.defaultLocale', v)}
              ariaLabel="Default locale"
              className="font-mono !text-xs !w-28 text-center"
              placeholder="en_US"
            />
          </SettingsRow>

          <SettingsRow
            id="sites.defaultAdminUser"
            visible={visible}
            title="Admin Username"
          >
            <TextSetting
              value={settings['sites.defaultAdminUser']}
              onCommit={(v) => setSetting('sites.defaultAdminUser', v)}
              ariaLabel="Default admin username"
              className="font-mono !text-xs !w-40"
              placeholder="admin"
            />
          </SettingsRow>

          <SettingsRow
            id="sites.defaultAdminEmail"
            visible={visible}
            title="Admin Email"
            subtitle="Leave blank to use admin@<site-domain>"
          >
            <TextSetting
              value={settings['sites.defaultAdminEmail']}
              onCommit={(v) => setSetting('sites.defaultAdminEmail', v)}
              ariaLabel="Default admin email"
              className="font-mono !text-xs !w-56"
              placeholder="admin@example.com"
            />
          </SettingsRow>

          <SettingsRow
            id="sites.httpsOnCreate"
            visible={visible}
            title="Enable HTTPS on create"
            subtitle="Mint a locally-trusted certificate as part of site creation"
          >
            <Toggle
              checked={!!settings['sites.httpsOnCreate']}
              onChange={(v) => setSetting('sites.httpsOnCreate', v)}
              label="Enable HTTPS on create"
            />
          </SettingsRow>
        </Card>
        <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
          These prefill the Add Site sheet. Every field stays editable per site.
        </p>
      </div>
    </div>
  );
}
