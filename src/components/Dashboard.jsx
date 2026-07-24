import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Play,
  Square,
  Globe,
  Server,
  Database,
  Wifi,
  Code2,
  Mail,
  Plus,
  ExternalLink,
  ShieldAlert,
} from 'lucide-react';
import { Card, IconTile, Row, SectionLabel, Tooltip } from './ui';
import { StatusBadge } from './StatusBadge';

const SERVICE_ROWS = [
  { id: 'nginx', name: 'nginx', icon: Server, color: 'green' },
  { id: 'php', name: 'PHP-FPM', icon: Code2, color: 'indigo' },
  { id: 'mysql', name: 'MySQL', icon: Database, color: 'orange' },
  { id: 'dnsmasq', name: 'dnsmasq', icon: Wifi, color: 'blue' },
  { id: 'mailpit', name: 'Mailpit', icon: Mail, color: 'red', optional: true },
];

export default function Dashboard({ serviceStatus, sites, refreshStatus }) {
  const navigate = useNavigate();
  const [actionLoading, setActionLoading] = useState(false);
  const [sudoersConfigured, setSudoersConfigured] = useState(true);

  useEffect(() => {
    window.electronAPI
      .checkSudoers()
      .then(({ configured }) => setSudoersConfigured(configured));
  }, []);

  const visibleServices = SERVICE_ROWS.filter(
    (s) => !s.optional || serviceStatus?.[s.id]?.installed
  );
  const totalRunning = visibleServices.filter(
    (s) => serviceStatus?.[s.id]?.running
  ).length;

  async function handleStartAll() {
    setActionLoading(true);
    await window.electronAPI.startServices();
    await refreshStatus();
    setActionLoading(false);
  }

  async function handleStopAll() {
    setActionLoading(true);
    await window.electronAPI.stopServices();
    await refreshStatus();
    setActionLoading(false);
  }

  async function handleService(action, name) {
    setActionLoading(true);
    if (action === 'start') await window.electronAPI.startService(name);
    else await window.electronAPI.stopService(name);
    await refreshStatus();
    setActionLoading(false);
  }

  const recentSites = sites.slice(0, 5);

  return (
    <div className="px-6 pb-6 max-w-[735px] mx-auto animate-fade-in">
      {/* Permissions banner */}
      {!sudoersConfigured && (
        <Card className="mb-4 !bg-status-warning/10">
          <Row
            icon={<ShieldAlert size={18} className="text-status-warning flex-shrink-0" />}
            title={
              <span className="font-semibold text-status-warning">
                Password required for DNS
              </span>
            }
            subtitle="macOS asks for your password when the dnsmasq DNS resolver starts or stops."
          >
            <button
              onClick={() => navigate('/settings')}
              className="text-xs font-semibold text-status-warning bg-status-warning/10 hover:bg-status-warning/20 px-3 py-1.5 rounded-md transition-colors flex-shrink-0"
            >
              Set Up
            </button>
          </Row>
        </Card>
      )}

      {/* Services */}
      <SectionLabel
        right={
          <div className="flex gap-2">
            <button
              onClick={handleStopAll}
              disabled={actionLoading || totalRunning === 0}
              className="btn-secondary gap-1.5"
            >
              <Square size={12} strokeWidth={2.5} />
              Stop All
            </button>
            <button
              onClick={handleStartAll}
              disabled={actionLoading || totalRunning === visibleServices.length}
              className="btn-primary gap-1.5"
            >
              <Play size={12} strokeWidth={2.5} fill="currentColor" />
              Start All
            </button>
          </div>
        }
      >
        Services · {totalRunning} of {visibleServices.length} running
      </SectionLabel>
      <Card className="mb-6">
        {visibleServices.map((svc) => {
          const running = serviceStatus?.[svc.id]?.running ?? false;
          return (
            <Row
              key={svc.id}
              icon={<IconTile icon={svc.icon} color={svc.color} />}
              title={svc.name}
              subtitle={
                serviceStatus?.[svc.id]?.state === 'failed'
                  ? serviceStatus[svc.id].error
                  : undefined
              }
            >
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <StatusBadge running={running} size="xs" />
                {running ? 'Running' : 'Stopped'}
              </span>
              <button
                onClick={() => handleService(running ? 'stop' : 'start', svc.id)}
                disabled={actionLoading}
                className="btn-secondary w-[72px]"
              >
                {running ? 'Stop' : 'Start'}
              </button>
            </Row>
          );
        })}
      </Card>

      {/* Recent sites */}
      <SectionLabel
        right={
          <button
            onClick={() => navigate('/sites')}
            className="text-xs text-highlight hover:underline"
          >
            View all ({sites.length})
          </button>
        }
      >
        Recent Sites
      </SectionLabel>
      <Card className="mb-6">
        {recentSites.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <IconTile icon={Globe} color="teal" size={40} />
            <p className="text-[13px] font-medium text-foreground mt-3">
              No WordPress sites yet
            </p>
            <p className="text-xs text-muted-foreground mt-1 mb-4">
              Create your first local WordPress site to get started
            </p>
            <button onClick={() => navigate('/sites')} className="btn-primary">
              <Plus size={12} strokeWidth={2.5} />
              Add Site
            </button>
          </div>
        ) : (
          recentSites.map((site) => (
            <Row
              key={site.id}
              icon={<IconTile icon={Globe} color="teal" />}
              title={site.name}
              subtitle={site.domain}
              onClick={() => navigate(`/sites/${site.id}`)}
              chevron
            >
              {/* span, not button — Row renders as a <button> when clickable */}
              <Tooltip label="Open in browser">
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    window.electronAPI.openSiteInBrowser(site.url);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && e.stopPropagation()}
                  aria-label="Open in browser"
                  className="p-1.5 rounded-md hover:bg-accent text-muted-foreground flex-shrink-0"
                >
                  <ExternalLink size={13} />
                </span>
              </Tooltip>
            </Row>
          ))
        )}
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Total Sites', value: sites.length },
          {
            label: 'Active Services',
            value: `${totalRunning} / ${visibleServices.length}`,
          },
          { label: 'PHP Version', value: serviceStatus?.php?.version || '—' },
        ].map(({ label, value }) => (
          <Card key={label} className="px-4 py-3">
            <p className="text-[11px] text-muted-foreground">{label}</p>
            <p className="text-xl font-bold text-foreground mt-0.5">{value}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
