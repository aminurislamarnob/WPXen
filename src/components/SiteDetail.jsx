import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  ExternalLink,
  Settings,
  LayoutDashboard,
  Wrench,
  Code2,
  Server,
  Globe,
  Database,
  Folder,
} from 'lucide-react';
import WpConfigManager from './WpConfigManager';
import SitePhpSettings from './SitePhpSettings';
import WpOverview from './WpOverview';

const NAV = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  {
    label: 'Configurations',
    icon: Wrench,
    group: true,
    children: [
      { id: 'wpconfig', label: 'WP Config' },
      { id: 'php', label: 'PHP' },
    ],
  },
  {
    label: 'WordPress',
    icon: Globe,
    group: true,
    children: [
      { id: 'wp-overview', label: 'Overview' },
      { id: 'wp-plugins', label: 'Plugins' },
      { id: 'wp-themes', label: 'Themes' },
    ],
  },
];

function Placeholder({ title }) {
  return (
    <div className="bg-white rounded-xl border border-surface-border shadow-card p-10 text-center">
      <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center mx-auto mb-3">
        <Wrench size={22} className="text-gray-400" />
      </div>
      <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      <p className="text-xs text-gray-400 mt-1.5">Coming soon.</p>
    </div>
  );
}

function Overview({ site }) {
  const rows = [
    { icon: Globe, label: 'Domain', value: site.domain },
    { icon: ExternalLink, label: 'URL', value: site.url },
    { icon: Folder, label: 'Path', value: site.path },
    { icon: Database, label: 'Database', value: site.dbName },
    { icon: Code2, label: 'PHP version', value: site.phpVersion },
    { icon: Server, label: 'WordPress', value: site.wpVersion || 'unknown' },
  ];
  return (
    <div>
      <h2 className="text-lg font-bold text-gray-900 mb-5">Overview</h2>
      <div className="bg-white rounded-xl border border-surface-border shadow-card divide-y divide-gray-100">
        {rows.map(({ icon: Icon, label, value }) => (
          <div key={label} className="flex items-center gap-4 px-5 py-3.5">
            <span className="flex items-center gap-2 w-36 flex-shrink-0 text-sm text-gray-500">
              <Icon size={14} />
              {label}
            </span>
            <span className="text-sm text-gray-900 font-mono truncate" title={value}>
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SiteDetail({ sites, refreshSites }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [active, setActive] = useState('wpconfig');

  const site = sites.find((s) => s.id === id);

  if (!site) {
    return (
      <div className="p-6">
        <button
          onClick={() => navigate('/sites')}
          className="btn-secondary text-sm mb-4"
        >
          <ChevronLeft size={15} className="mr-1" />
          Back to Sites
        </button>
        <p className="text-sm text-gray-500">Site not found.</p>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      {/* Detail header */}
      <div className="sticky top-0 z-10 bg-surface/80 backdrop-macos border-b border-surface-border px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <button
            onClick={() => navigate('/sites')}
            className="flex items-center gap-2 min-w-0 text-left"
          >
            <ChevronLeft size={18} className="text-wp-blue flex-shrink-0" />
            <span className="text-lg font-bold text-wp-blue">Back</span>
            <span className="text-lg font-bold text-gray-900 truncate">
              — {site.domain}
            </span>
          </button>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => window.electronAPI.openSiteInBrowser(site.url)}
              className="btn-secondary text-sm"
            >
              <ExternalLink size={14} className="mr-1.5" />
              Visit Site
            </button>
            <button
              onClick={() => window.electronAPI.openWpAdmin(site.url)}
              className="btn-secondary text-sm"
            >
              <Settings size={14} className="mr-1.5" />
              WP Admin
            </button>
          </div>
        </div>
      </div>

      {/* Body: subnav + content */}
      <div className="flex gap-6 p-6">
        <nav className="w-52 flex-shrink-0 space-y-1">
          {NAV.map((item) =>
            item.group ? (
              <div key={item.label} className="pt-2">
                <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wide">
                  <item.icon size={13} />
                  {item.label}
                </div>
                <div className="space-y-0.5">
                  {item.children.map((child) => (
                    <button
                      key={child.id}
                      onClick={() => setActive(child.id)}
                      className={`w-full text-left pl-9 pr-3 py-2 rounded-lg text-sm transition-colors ${
                        active === child.id
                          ? 'bg-wp-blue/10 text-wp-blue font-medium'
                          : 'text-gray-600 hover:bg-gray-100'
                      }`}
                    >
                      {child.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <button
                key={item.id}
                onClick={() => setActive(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                  active === item.id
                    ? 'bg-wp-blue/10 text-wp-blue font-medium'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                <item.icon size={15} />
                {item.label}
              </button>
            )
          )}
        </nav>

        <div className="flex-1 min-w-0 max-w-3xl">
          {active === 'overview' && <Overview site={site} />}
          {active === 'wpconfig' && <WpConfigManager site={site} />}
          {active === 'php' && <SitePhpSettings site={site} onSaved={refreshSites} />}
          {active === 'wp-overview' && (
            <WpOverview site={site} onSaved={refreshSites} />
          )}
          {active === 'wp-plugins' && <Placeholder title="Plugins" />}
          {active === 'wp-themes' && <Placeholder title="Themes" />}
        </div>
      </div>
    </div>
  );
}
