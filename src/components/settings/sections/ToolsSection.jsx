import { useEffect, useState } from 'react';
import { Card, SectionLabel, SettingsRow } from '../../ui';
import { SelectSetting, TextSetting } from '../controls';
import { useSettings } from '../../../lib/useSettings';
import { useSettingsContext } from '../SettingsLayout';

// Options carry a "not installed" hint rather than being hidden, so a user who
// hasn't installed the CLI shim yet understands why their pick won't stick.
function toOptions(tools, systemLabel) {
  return [
    { value: 'system', label: systemLabel },
    ...(tools || []).map((t) => ({
      value: t.id,
      label: t.detected ? t.label : `${t.label} (not detected)`,
    })),
  ];
}

export default function ToolsSection() {
  const { settings, setSetting } = useSettings();
  const { visible } = useSettingsContext();
  const [tools, setTools] = useState(null);

  useEffect(() => {
    window.electronAPI
      .listExternalTools()
      .then(setTools)
      .catch(() => setTools({ editors: [], terminals: [] }));
  }, []);

  const editorOptions = [
    ...toOptions(tools?.editors, 'System default'),
    { value: 'custom', label: 'Custom command…' },
  ];

  return (
    <div>
      <SectionLabel>External Tools</SectionLabel>
      <Card>
        <SettingsRow
          id="tools.editor"
          visible={visible}
          title="Open files with"
          subtitle="Used by “Open in editor” across sites, logs and the file explorer"
        >
          <SelectSetting
            value={settings['tools.editor']}
            onChange={(v) => setSetting('tools.editor', v)}
            ariaLabel="Editor"
            options={editorOptions}
          />
        </SettingsRow>

        {settings['tools.editor'] === 'custom' && (
          <SettingsRow
            id="tools.editor"
            visible={visible}
            title="Custom editor command"
            subtitle="The file path is appended as the last argument"
          >
            <TextSetting
              value={settings['tools.editorCustomCommand']}
              onCommit={(v) => setSetting('tools.editorCustomCommand', v)}
              ariaLabel="Custom editor command"
              className="font-mono !text-xs !w-48"
              placeholder="mate -w"
            />
          </SettingsRow>
        )}

        <SettingsRow
          id="tools.terminalApp"
          visible={visible}
          title="Open terminals with"
          subtitle="Used by “Open in Terminal” on a site’s folder"
        >
          <SelectSetting
            value={settings['tools.terminalApp']}
            onChange={(v) => setSetting('tools.terminalApp', v)}
            ariaLabel="Terminal app"
            options={toOptions(tools?.terminals, 'System default')}
          />
        </SettingsRow>
      </Card>
      <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
        WPHerd looks for each editor’s command-line shim (
        <span className="font-mono">code</span>, <span className="font-mono">subl</span>,
        …) and falls back to the app bundle, then to whatever macOS would open the file
        with.
      </p>
    </div>
  );
}
