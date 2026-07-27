import { Card, SectionLabel, SettingsRow, Toggle } from '../../ui';
import { NumberSetting } from '../controls';
import { useSettings } from '../../../lib/useSettings';
import { useSettingsContext } from '../SettingsLayout';

const SERVICES = [
  { id: 'nginx', label: 'nginx' },
  { id: 'php', label: 'PHP-FPM' },
  { id: 'mysql', label: 'MySQL' },
  { id: 'mailpit', label: 'Mailpit' },
];

export default function ServicesSection() {
  const { settings, setSetting } = useSettings();
  const { visible } = useSettingsContext();

  const autoStart = settings['services.autoStart'] || [];

  function toggleService(id, enabled) {
    // Persist in the canonical order rather than click order, so the stored
    // list reads the same regardless of how it was assembled.
    const next = SERVICES.filter((s) =>
      s.id === id ? enabled : autoStart.includes(s.id)
    ).map((s) => s.id);
    setSetting('services.autoStart', next);
  }

  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>Start on Launch</SectionLabel>
        <Card>
          {SERVICES.map((s) => (
            <SettingsRow
              key={s.id}
              id="services.autoStart"
              visible={visible}
              title={<span className="font-mono text-xs">{s.label}</span>}
            >
              <Toggle
                checked={autoStart.includes(s.id)}
                onChange={(v) => toggleService(s.id, v)}
                label={`Start ${s.label} on launch`}
              />
            </SettingsRow>
          ))}
        </Card>
        <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
          Services WPDevPilot brings up when it starts. Mailpit is skipped when it isn’t
          installed. You can always start a service by hand from the Services page.
        </p>
      </div>

      <div>
        <SectionLabel>Logs</SectionLabel>
        <Card>
          <SettingsRow
            id="services.logMaxSizeMb"
            visible={visible}
            title="Rotate service logs at"
            subtitle="A log past this size is moved aside so it can’t grow without bound"
          >
            <div className="flex items-center gap-1.5">
              <NumberSetting
                value={settings['services.logMaxSizeMb']}
                onCommit={(v) => setSetting('services.logMaxSizeMb', v)}
                min={1}
                max={200}
                ariaLabel="Log rotation size in megabytes"
                className="!w-20 text-center"
              />
              <span className="text-xs text-muted-foreground">MB</span>
            </div>
          </SettingsRow>
        </Card>
      </div>
    </div>
  );
}
