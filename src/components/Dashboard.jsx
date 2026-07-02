import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Play,
  Square,
  Globe,
  Server,
  Database,
  Wifi,
  Plus,
  ExternalLink,
  ArrowRight,
  ShieldAlert,
} from 'lucide-react';
import { StatusBadge } from './StatusBadge';

function ServiceCard({ name, icon: Icon, running, onStart, onStop, loading }) {
  return (
    <div className="bg-white rounded-xl border border-surface-border p-4 shadow-card">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`w-9 h-9 rounded-lg flex items-center justify-center ${
              running ? 'bg-green-100' : 'bg-gray-100'
            }`}
          >
            <Icon size={18} className={running ? 'text-wp-green' : 'text-gray-400'} />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900">{name}</p>
            <p
              className={`text-xs mt-0.5 ${running ? 'text-wp-green' : 'text-gray-400'}`}
            >
              {running ? 'Running' : 'Stopped'}
            </p>
          </div>
        </div>
        <StatusBadge running={running} size="md" />
      </div>
      <div className="mt-4 flex gap-2">
        <button
          onClick={onStart}
          disabled={running || loading}
          className="btn-primary flex-1 text-xs py-1.5"
        >
          <Play size={11} className="mr-1.5" />
          Start
        </button>
        <button
          onClick={onStop}
          disabled={!running || loading}
          className="btn-secondary flex-1 text-xs py-1.5"
        >
          <Square size={11} className="mr-1.5" />
          Stop
        </button>
      </div>
    </div>
  );
}

function QuickSiteCard({ site }) {
  return (
    <div className="flex items-center justify-between py-3 px-4 bg-white rounded-xl border border-surface-border shadow-card hover:shadow-card-hover transition-all duration-200 group">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-8 h-8 rounded-lg bg-wp-blue/10 flex items-center justify-center flex-shrink-0">
          <Globe size={15} className="text-wp-blue" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{site.name}</p>
          <p className="text-xs text-gray-400 truncate">{site.domain}</p>
        </div>
      </div>
      <button
        onClick={() => window.electronAPI.openSiteInBrowser(site.url)}
        className="opacity-0 group-hover:opacity-100 transition-opacity ml-3 p-1.5 rounded-lg hover:bg-gray-100"
      >
        <ExternalLink size={14} className="text-gray-500" />
      </button>
    </div>
  );
}

export default function Dashboard({ serviceStatus, sites, refreshStatus }) {
  const navigate = useNavigate();
  const [actionLoading, setActionLoading] = useState(false);
  const [sudoersConfigured, setSudoersConfigured] = useState(true);

  useEffect(() => {
    window.electronAPI
      .checkSudoers()
      .then(({ configured }) => setSudoersConfigured(configured));
  }, []);

  const { nginx, php, mysql, dnsmasq } = serviceStatus;

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

  const totalRunning = [nginx, php, mysql, dnsmasq].filter((s) => s?.running).length;
  const recentSites = sites.slice(0, 4);

  return (
    <div className="p-6 max-w-5xl space-y-6 animate-fade-in">
      {/* Permissions banner */}
      {!sudoersConfigured && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 animate-fade-in">
          <ShieldAlert size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-800">
              Password required for DNS
            </p>
            <p className="text-xs text-amber-700 mt-0.5">
              macOS will ask for your password when the dnsmasq DNS resolver starts or
              stops. Set up passwordless permissions once to fix this.
            </p>
          </div>
          <button
            onClick={() => navigate('/settings')}
            className="flex-shrink-0 text-xs font-semibold text-amber-800 bg-amber-100 hover:bg-amber-200 px-3 py-1.5 rounded-lg transition-colors"
          >
            Fix Now
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {totalRunning} of 4 services running
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleStopAll}
            disabled={actionLoading || totalRunning === 0}
            className="btn-secondary text-xs"
          >
            <Square size={12} className="mr-1.5" />
            Stop All
          </button>
          <button
            onClick={handleStartAll}
            disabled={actionLoading || totalRunning === 4}
            className="btn-primary text-xs"
          >
            <Play size={12} className="mr-1.5" />
            Start All
          </button>
        </div>
      </div>

      {/* Service cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <ServiceCard
          name="nginx"
          icon={Server}
          running={nginx?.running}
          onStart={() => handleService('start', 'nginx')}
          onStop={() => handleService('stop', 'nginx')}
          loading={actionLoading}
        />
        <ServiceCard
          name="PHP-FPM"
          icon={({ size, className }) => (
            <svg
              viewBox="0 0 24 24"
              width={size}
              height={size}
              className={className}
              fill="currentColor"
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" />
            </svg>
          )}
          running={php?.running}
          onStart={() => handleService('start', 'php')}
          onStop={() => handleService('stop', 'php')}
          loading={actionLoading}
        />
        <ServiceCard
          name="MySQL"
          icon={Database}
          running={mysql?.running}
          onStart={() => handleService('start', 'mysql')}
          onStop={() => handleService('stop', 'mysql')}
          loading={actionLoading}
        />
        <ServiceCard
          name="dnsmasq"
          icon={Wifi}
          running={dnsmasq?.running}
          onStart={() => handleService('start', 'dnsmasq')}
          onStop={() => handleService('stop', 'dnsmasq')}
          loading={actionLoading}
        />
      </div>

      {/* Sites overview */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-900">
            Recent Sites{' '}
            <span className="text-gray-400 font-normal ml-1">({sites.length})</span>
          </h2>
          <button
            onClick={() => navigate('/sites')}
            className="text-xs text-wp-blue hover:underline flex items-center gap-1"
          >
            View all <ArrowRight size={12} />
          </button>
        </div>

        {sites.length === 0 ? (
          <div className="bg-white rounded-xl border border-dashed border-gray-300 p-8 text-center">
            <div className="w-12 h-12 rounded-xl bg-wp-blue/10 flex items-center justify-center mx-auto mb-3">
              <Globe size={22} className="text-wp-blue" />
            </div>
            <p className="text-sm font-medium text-gray-700">No WordPress sites yet</p>
            <p className="text-xs text-gray-400 mt-1 mb-4">
              Create your first local WordPress site to get started
            </p>
            <button onClick={() => navigate('/sites')} className="btn-primary text-xs">
              <Plus size={13} className="mr-1.5" />
              Add Site
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {recentSites.map((site) => (
              <QuickSiteCard key={site.id} site={site} />
            ))}
          </div>
        )}
      </div>

      {/* Quick info */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Sites', value: sites.length, color: 'text-wp-blue' },
          {
            label: 'Active Services',
            value: `${totalRunning} / 4`,
            color: totalRunning === 4 ? 'text-wp-green' : 'text-wp-yellow',
          },
          {
            label: 'PHP Version',
            value: php?.version || '—',
            color: 'text-purple-600',
          },
        ].map(({ label, value, color }) => (
          <div
            key={label}
            className="bg-white rounded-xl border border-surface-border shadow-card p-4"
          >
            <p className="text-xs text-gray-400">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
