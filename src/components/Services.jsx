import { useState } from 'react';
import {
  Server,
  Database,
  Wifi,
  Play,
  Square,
  RotateCw,
  CheckCircle,
  XCircle,
  Loader,
  Info,
} from 'lucide-react';
import { StatusBadge } from './StatusBadge';

const SERVICE_CONFIG = [
  {
    id: 'nginx',
    name: 'nginx',
    description: 'Web server — serves your WordPress sites via HTTP',
    icon: Server,
    color: 'green',
    brew: 'nginx',
  },
  {
    id: 'php',
    name: 'PHP-FPM',
    description: 'PHP FastCGI Process Manager — processes PHP scripts',
    icon: ({ size, className }) => (
      <span className={`text-base font-bold font-mono ${className}`} style={{ fontSize: size }}>
        P
      </span>
    ),
    color: 'purple',
    brew: 'php',
  },
  {
    id: 'mysql',
    name: 'MySQL',
    description: 'Database server — stores WordPress site data',
    icon: Database,
    color: 'orange',
    brew: 'mysql',
  },
  {
    id: 'dnsmasq',
    name: 'dnsmasq',
    description: 'DNS resolver — routes *.test domains to localhost',
    icon: Wifi,
    color: 'blue',
    brew: 'dnsmasq',
  },
];

const COLOR_MAP = {
  green: { bg: 'bg-green-50', icon: 'text-green-600', ring: 'ring-green-200' },
  purple: { bg: 'bg-purple-50', icon: 'text-purple-600', ring: 'ring-purple-200' },
  orange: { bg: 'bg-orange-50', icon: 'text-orange-600', ring: 'ring-orange-200' },
  blue: { bg: 'bg-blue-50', icon: 'text-blue-600', ring: 'ring-blue-200' },
};

function ServiceRow({ config, running, onAction, loadingAction }) {
  const colors = COLOR_MAP[config.color];
  const Icon = config.icon;
  const isLoading = loadingAction === config.id;

  return (
    <div className="bg-white rounded-xl border border-surface-border shadow-card p-5">
      <div className="flex items-start gap-4">
        {/* Icon */}
        <div
          className={`w-11 h-11 rounded-xl ${colors.bg} flex items-center justify-center flex-shrink-0 ${
            running ? `ring-2 ${colors.ring}` : ''
          }`}
        >
          <Icon size={20} className={colors.icon} />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="text-sm font-semibold text-gray-900">{config.name}</h3>
            <StatusBadge running={running} />
            <span className={`text-xs font-medium ${running ? 'text-wp-green' : 'text-gray-400'}`}>
              {running ? 'Running' : 'Stopped'}
            </span>
          </div>
          <p className="text-xs text-gray-400">{config.description}</p>
          <p className="text-xs text-gray-300 font-mono mt-1">
            brew services {running ? 'stop' : 'start'} {config.brew}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={() => onAction('restart', config.id)}
            disabled={!running || isLoading}
            title="Restart"
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 disabled:opacity-30 transition-colors"
          >
            {isLoading ? (
              <Loader size={14} className="animate-spin" />
            ) : (
              <RotateCw size={14} />
            )}
          </button>
          {running ? (
            <button
              onClick={() => onAction('stop', config.id)}
              disabled={isLoading}
              className="service-toggle bg-red-50 text-red-600 hover:bg-red-100"
            >
              <Square size={11} className="mr-1.5 inline" />
              Stop
            </button>
          ) : (
            <button
              onClick={() => onAction('start', config.id)}
              disabled={isLoading}
              className="service-toggle bg-green-50 text-green-700 hover:bg-green-100"
            >
              <Play size={11} className="mr-1.5 inline" />
              Start
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Services({ serviceStatus, refreshStatus }) {
  const [loadingAction, setLoadingAction] = useState(null);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [message, setMessage] = useState(null);

  async function handleAction(action, serviceId) {
    setLoadingAction(serviceId);
    setMessage(null);
    try {
      let result;
      if (action === 'start') result = await window.electronAPI.startService(serviceId);
      else if (action === 'stop') result = await window.electronAPI.stopService(serviceId);
      else result = await window.electronAPI.restartService(serviceId);

      if (!result.success) {
        setMessage({ type: 'error', text: result.error });
      }
      await refreshStatus();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleStartAll() {
    setGlobalLoading(true);
    await window.electronAPI.startServices();
    await refreshStatus();
    setGlobalLoading(false);
    setMessage({ type: 'success', text: 'All services started' });
  }

  async function handleStopAll() {
    setGlobalLoading(true);
    await window.electronAPI.stopServices();
    await refreshStatus();
    setGlobalLoading(false);
    setMessage({ type: 'success', text: 'All services stopped' });
  }

  const runningCount = SERVICE_CONFIG.filter(
    (s) => serviceStatus?.[s.id]?.running
  ).length;

  return (
    <div className="p-6 max-w-3xl animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Services</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {runningCount} of {SERVICE_CONFIG.length} services running
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleStopAll}
            disabled={globalLoading || runningCount === 0}
            className="btn-secondary text-sm"
          >
            {globalLoading ? <Loader size={13} className="animate-spin mr-1.5" /> : <Square size={13} className="mr-1.5" />}
            Stop All
          </button>
          <button
            onClick={handleStartAll}
            disabled={globalLoading || runningCount === SERVICE_CONFIG.length}
            className="btn-primary text-sm"
          >
            {globalLoading ? <Loader size={13} className="animate-spin mr-1.5" /> : <Play size={13} className="mr-1.5" />}
            Start All
          </button>
        </div>
      </div>

      {/* Status message */}
      {message && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-xl mb-4 text-sm animate-fade-in ${
            message.type === 'error'
              ? 'bg-red-50 text-red-700'
              : 'bg-green-50 text-green-700'
          }`}
        >
          {message.type === 'error' ? (
            <XCircle size={15} />
          ) : (
            <CheckCircle size={15} />
          )}
          {message.text}
        </div>
      )}

      {/* Service rows */}
      <div className="space-y-3">
        {SERVICE_CONFIG.map((config) => (
          <ServiceRow
            key={config.id}
            config={config}
            running={serviceStatus?.[config.id]?.running ?? false}
            onAction={handleAction}
            loadingAction={loadingAction}
          />
        ))}
      </div>

      {/* Info box */}
      <div className="mt-5 flex items-start gap-3 bg-blue-50 rounded-xl px-4 py-3 text-sm text-blue-700">
        <Info size={15} className="flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">Homebrew services</p>
          <p className="text-xs text-blue-600 mt-0.5">
            WPHerd manages services installed via Homebrew. Install missing services with{' '}
            <span className="font-mono bg-blue-100 px-1 rounded">brew install nginx php mysql dnsmasq</span>
          </p>
        </div>
      </div>
    </div>
  );
}
