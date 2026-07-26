import { useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import { Card, SectionLabel, SettingsRow, Toggle } from '../../ui';
import { useSettings } from '../../../lib/useSettings';
import { useSettingsContext } from '../SettingsLayout';

export default function MailSection() {
  const { settings } = useSettings();
  const { visible } = useSettingsContext();
  const [status, setStatus] = useState(null);

  useEffect(() => {
    window.electronAPI
      .getMailpitStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);

  // Catching goes through the dedicated handler rather than a plain setting
  // write: it also has to bring Mailpit up so mail isn't black-holed.
  async function toggleCatch(enabled) {
    await window.electronAPI.setMailCatching(enabled);
  }

  return (
    <div>
      <SectionLabel>Mail</SectionLabel>
      <Card>
        <SettingsRow
          id="mail.catch"
          visible={visible}
          icon={<Inbox size={18} className="text-muted-foreground flex-shrink-0" />}
          title="Catch outgoing mail"
          subtitle="Route PHP mail() into Mailpit instead of sending it for real"
        >
          <Toggle
            checked={!!settings['mail.catch']}
            onChange={toggleCatch}
            disabled={status?.installed === false}
            label="Catch outgoing mail"
          />
        </SettingsRow>
      </Card>
      {status?.installed === false && (
        <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
          Mailpit isn’t installed yet — install it from the Mail page to enable catching.
        </p>
      )}
    </div>
  );
}
