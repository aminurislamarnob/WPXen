import { useEffect, useState } from 'react';
import { Card, Row, SectionLabel } from '../../ui';

export default function AboutSection() {
  const [sysInfo, setSysInfo] = useState(null);

  useEffect(() => {
    window.electronAPI.getSystemInfo().then(setSysInfo);
  }, []);

  if (!sysInfo) return null;

  return (
    <div>
      <SectionLabel>About</SectionLabel>
      <Card>
        {[
          ['Platform', `${sysInfo.platform} (${sysInfo.arch})`],
          ['Homebrew Prefix', sysInfo.brewPrefix || 'Not detected'],
          ['WPHerd Version', sysInfo.appVersion],
          ['Electron', sysInfo.electronVersion],
          ['Node.js', sysInfo.nodeVersion],
        ].map(([label, value]) => (
          <Row key={label} title={<span className="text-muted-foreground">{label}</span>}>
            <span className="font-mono text-xs text-foreground">{value}</span>
          </Row>
        ))}
      </Card>
    </div>
  );
}
