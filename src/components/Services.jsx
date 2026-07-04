import { useState } from 'react';
import {
  Server,
  Database,
  Wifi,
  Mail,
  Code2,
  Play,
  Square,
  RotateCw,
  CheckCircle,
  XCircle,
  Loader,
  Info,
} from 'lucide-react';
import { Card, Row, SectionLabel, IconTile } from './ui';
import { StatusBadge } from './StatusBadge';

const SERVICE_CONFIG = [
  {
    id: 'nginx',
    name: 'nginx',
    description: 'Web server — serves your WordPress sites via HTTP',
    icon: Server,
    color: 'green',
  },
  {
    id: 'php',
    name: 'PHP-FPM',
    description: 'PHP FastCGI Process Manager — processes PHP scripts',
    icon: Code2,
    color: 'indigo',
  },
  {
    id: 'mysql',
    name: 'MySQL',
    description: 'Database server — stores WordPress site data',
    icon: Database,
    color: 'orange',
  },
  {
    id: 'dnsmasq',
    name: 'dnsmasq',
    description: 'DNS resolver — routes *.test domains to localhost',
    icon: Wifi,
    color: 'blue',
    system: true,
  },
  {
    id: 'mailpit',
    name: 'Mailpit',
    description: 'Email catcher — captures outgoing mail from your sites',
    icon: Mail,
    color: 'red',
    // Optional add-on — only listed once installed (see the Mail page).
    optional: true,
  },
];

function ServiceRow({ config, status, onAction, loadingAction }) {
  const running = status?.running ?? false;
  const failed = status?.state === 'failed';
  const isLoading = loadingAction === config.id;

  return (
    <Row
      icon={<IconTile icon={config.icon} color={config.color} size={30} />}
      title={
        <span className="font-medium flex items-center gap-2">
          {config.name}
          <StatusBadge running={running} size="xs" />
          <span className={`text-xs font-normal ${running ? 'text-wp-green' : 'text-gray-400'}`}>
            {running ? 'Running' : 'Stopped'}
          </span>
        </span>
      }
      subtitle={
        failed && status?.error ? (
          <span className="text-red-600 dark:text-red-400">
            {status.error}{' '}
            <span
              role="button"
              tabIndex={0}
              onClick={() => window.electronAPI.openServiceLog(config.id)}
              className="underline cursor-pointer"
            >
              View log
            </span>
          </span>
        ) : (
          config.description
        )
      }
    >
      <button
        onClick={() => onAction('restart', config.id)}
        disabled={!running || isLoading}
        title="Restart"
        className="p-1.5 rounded-md hover:bg-black/5 dark:hover:bg-white/10 text-gray-400 disabled:opacity-30 transition-colors"
      >
        {isLoading ? <Loader size={13} className="animate-spin" /> : <RotateCw size={13} />}
      </button>
      {running ? (
        <button
          onClick={() => onAction('stop', config.id)}
          disabled={isLoading}
          className="btn-secondary text-xs w-[72px] text-red-600 dark:text-red-400"
        >
          Stop
        </button>
      ) : (
        <button
          onClick={() => onAction('start', config.id)}
          disabled={isLoading}
          className="btn-secondary text-xs w-[72px] text-green-700 dark:text-green-400"
        >
          Start
        </button>
      )}
    </Row>
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
      else if (action === 'stop')
        result = await window.electronAPI.stopService(serviceId);
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

  // Optional services (Mailpit) appear only once installed.
  const visibleServices = SERVICE_CONFIG.filter(
    (s) => !s.optional || serviceStatus?.[s.id]?.installed
  );

  const runningCount = visibleServices.filter(
    (s) => serviceStatus?.[s.id]?.running
  ).length;

  const appManaged = visibleServices.filter((s) => !s.system);
  const systemManaged = visibleServices.filter((s) => s.system);

  return (
    <div className="px-6 pb-6 max-w-[735px] mx-auto animate-fade-in">
      {/* Header actions */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-gray-500">
          {runningCount} of {visibleServices.length} services running
        </p>
        <div className="flex gap-2">
          <button
            onClick={handleStopAll}
            disabled={globalLoading || runningCount === 0}
            className="btn-secondary"
          >
            {globalLoading ? (
              <Loader size={12} className="animate-spin" />
            ) : (
              <Square size={12} strokeWidth={2.5} />
            )}
            Stop All
          </button>
          <button
            onClick={handleStartAll}
            disabled={globalLoading || runningCount === visibleServices.length}
            className="btn-primary"
          >
            {globalLoading ? (
              <Loader size={12} className="animate-spin" />
            ) : (
              <Play size={12} strokeWidth={2.5} fill="currentColor" />
            )}
            Start All
          </button>
        </div>
      </div>

      {/* Status message */}
      {message && (
        <Card
          className={`mb-4 ${
            message.type === 'error'
              ? '!bg-red-50 dark:!bg-red-500/10'
              : '!bg-green-50 dark:!bg-green-500/10'
          }`}
        >
          <div
            className={`flex items-center gap-2 px-4 py-3 text-[13px] ${
              message.type === 'error'
                ? 'text-red-700 dark:text-red-400'
                : 'text-green-700 dark:text-green-400'
            }`}
          >
            {message.type === 'error' ? <XCircle size={14} /> : <CheckCircle size={14} />}
            {message.text}
          </div>
        </Card>
      )}

      {/* App-managed services */}
      <SectionLabel>Managed by WPHerd</SectionLabel>
      <Card className="mb-6">
        {appManaged.map((config) => (
          <ServiceRow
            key={config.id}
            config={config}
            status={serviceStatus?.[config.id]}
            onAction={handleAction}
            loadingAction={loadingAction}
          />
        ))}
      </Card>

      {/* System services */}
      <SectionLabel>System Services</SectionLabel>
      <Card className="mb-4">
        {systemManaged.map((config) => (
          <ServiceRow
            key={config.id}
            config={config}
            status={serviceStatus?.[config.id]}
            onAction={handleAction}
            loadingAction={loadingAction}
          />
        ))}
      </Card>

      {/* Info */}
      <Card className="!bg-blue-50/70 dark:!bg-blue-500/10">
        <div className="flex items-start gap-3 px-4 py-3 text-[13px] text-blue-700 dark:text-blue-300">
          <Info size={14} className="flex-shrink-0 mt-0.5" />
          <p className="text-xs">
            nginx, PHP-FPM, MySQL, and Mailpit run as part of WPHerd — they stop when
            the app quits and don&apos;t appear as background items in macOS. dnsmasq
            runs as a system service so <span className="font-mono">*.test</span> DNS
            keeps working when the app is closed. Install missing services with{' '}
            <span className="font-mono bg-blue-100 dark:bg-blue-500/20 px-1 rounded">
              brew install nginx php mysql dnsmasq
            </span>
          </p>
        </div>
      </Card>
    </div>
  );
}
