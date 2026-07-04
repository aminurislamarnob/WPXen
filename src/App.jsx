import { useState, useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import Sites from './components/Sites';
import SiteDetail from './components/SiteDetail';
import Services from './components/Services';
import PHPVersions from './components/PHPVersions';
import Mail from './components/Mail';
import Settings from './components/Settings';
import logo from './assets/logo.png';

export default function App() {
  const [serviceStatus, setServiceStatus] = useState({
    nginx: { running: false, name: 'nginx' },
    php: { running: false, name: 'PHP-FPM', version: null },
    mysql: { running: false, name: 'MySQL' },
    dnsmasq: { running: false, name: 'dnsmasq' },
    mailpit: { running: false, name: 'Mailpit', installed: false },
  });
  const [sites, setSites] = useState([]);
  const [deps, setDeps] = useState(null);
  const [loading, setLoading] = useState(true);

  // Initial load
  useEffect(() => {
    async function init() {
      try {
        const [status, siteList, dependencies] = await Promise.all([
          window.electronAPI.getServiceStatus(),
          window.electronAPI.getSites(),
          window.electronAPI.checkDependencies(),
        ]);
        setServiceStatus(status);
        setSites(siteList);
        setDeps(dependencies);
      } catch (err) {
        console.error('Init error:', err);
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  // Listen for service status updates from main process
  useEffect(() => {
    window.electronAPI.on('service-status-update', (status) => {
      setServiceStatus(status);
    });
    return () => window.electronAPI.off('service-status-update');
  }, []);

  const refreshSites = async () => {
    const siteList = await window.electronAPI.getSites();
    setSites(siteList);
  };

  const refreshStatus = async () => {
    const status = await window.electronAPI.getServiceStatus();
    setServiceStatus(status);
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-surface/60">
        <div className="flex flex-col items-center gap-4">
          <img src={logo} alt="WPHerd" className="h-9 w-auto" draggable={false} />
          <p className="text-sm text-gray-500">Starting WPHerd…</p>
        </div>
      </div>
    );
  }

  const sharedProps = {
    serviceStatus,
    sites,
    setSites,
    refreshSites,
    refreshStatus,
    deps,
  };

  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Layout serviceStatus={serviceStatus} />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard {...sharedProps} />} />
          <Route path="sites" element={<Sites {...sharedProps} />} />
          <Route path="sites/:id" element={<SiteDetail {...sharedProps} />} />
          <Route path="services" element={<Services {...sharedProps} />} />
          <Route path="php" element={<PHPVersions {...sharedProps} />} />
          <Route path="mail" element={<Mail {...sharedProps} />} />
          <Route path="settings" element={<Settings {...sharedProps} />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
