import { useEffect, useState } from 'react';
import { Info, Wand2 } from 'lucide-react';
import { Button, Card, Row, SectionLabel } from '../../ui';
import { useSettingsContext } from '../SettingsLayout';

export default function DependenciesSection() {
  const { onOpenWizard } = useSettingsContext();
  const [deps, setDeps] = useState(null);

  useEffect(() => {
    window.electronAPI.checkDependencies().then(setDeps);
  }, []);

  // Main process re-checks dependencies whenever the app regains focus (e.g.
  // after installing something via Homebrew), so the list stays current
  // without a manual refresh.
  useEffect(() => {
    window.electronAPI.on('dependencies-update', (fresh) => setDeps(fresh));
    return () => window.electronAPI.off('dependencies-update');
  }, []);

  return (
    <div>
      <SectionLabel
        right={
          onOpenWizard && (
            <Button variant="secondary" onClick={onOpenWizard}>
              <Wand2 size={12} strokeWidth={2.5} />
              Run setup wizard
            </Button>
          )
        }
      >
        Dependencies
      </SectionLabel>
      <Card>
        {deps &&
          Object.entries(deps).map(([name, installed]) => (
            <Row
              key={name}
              icon={
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${installed ? 'bg-status-running' : 'bg-border'}`}
                />
              }
              title={
                <span className="font-mono text-xs">
                  {name === 'wpCli' ? 'wp-cli' : name}
                </span>
              }
            >
              <span
                className={`text-xs font-medium ${
                  installed ? 'text-status-running' : 'text-muted-foreground'
                }`}
              >
                {installed ? 'Installed' : 'Not found'}
              </span>
            </Row>
          ))}
      </Card>
      {deps && !deps.brew && (
        <div className="flex items-start gap-2 bg-status-warning/10 rounded-lg px-3 py-2.5 mt-2 text-xs text-status-warning">
          <Info size={13} className="flex-shrink-0 mt-0.5" />
          <span>
            Install Homebrew first:{' '}
            <button
              onClick={() => window.electronAPI.openSiteInBrowser('https://brew.sh')}
              className="underline"
            >
              brew.sh
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
