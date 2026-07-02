import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Globe,
  Server,
  Code2,
  Mail,
  Settings,
  Search,
} from 'lucide-react';
import logo from '../assets/logo.png';

// System Settings-style nav: grouped items, each with its own colored tile.
const NAV_GROUPS = [
  [
    { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', color: 'blue' },
    { to: '/sites', icon: Globe, label: 'Sites', color: 'teal' },
  ],
  [
    { to: '/services', icon: Server, label: 'Services', color: 'green' },
    { to: '/php', icon: Code2, label: 'PHP', color: 'indigo' },
    { to: '/mail', icon: Mail, label: 'Mail', color: 'red' },
  ],
  [{ to: '/settings', icon: Settings, label: 'Settings', color: 'gray' }],
];

const TILE_COLORS = {
  blue: 'bg-[#0a7aff]',
  teal: 'bg-[#30b0c7]',
  green: 'bg-[#28c840]',
  indigo: 'bg-[#5856d6]',
  red: 'bg-[#ff3b30]',
  gray: 'bg-[#8e8e93]',
};

const PAGE_TITLES = {
  '/dashboard': 'Dashboard',
  '/sites': 'Sites',
  '/services': 'Services',
  '/php': 'PHP',
  '/mail': 'Mail',
  '/settings': 'Settings',
};

export default function Layout({ serviceStatus }) {
  const [filter, setFilter] = useState('');
  const location = useLocation();

  const allRunning =
    serviceStatus?.nginx?.running &&
    serviceStatus?.php?.running &&
    serviceStatus?.mysql?.running;

  const anyRunning =
    serviceStatus?.nginx?.running ||
    serviceStatus?.php?.running ||
    serviceStatus?.mysql?.running;

  const statusText = allRunning
    ? 'All services running'
    : anyRunning
      ? 'Partially running'
      : 'Services stopped';

  const statusColor = allRunning
    ? 'bg-wp-green'
    : anyRunning
      ? 'bg-wp-yellow'
      : 'bg-gray-400';

  const title =
    PAGE_TITLES[
      Object.keys(PAGE_TITLES).find((p) => location.pathname.startsWith(p)) || ''
    ] || 'WPHerd';

  const q = filter.trim().toLowerCase();
  const groups = q
    ? NAV_GROUPS.map((g) => g.filter((i) => i.label.toLowerCase().includes(q))).filter(
        (g) => g.length > 0
      )
    : NAV_GROUPS;

  return (
    <div className="h-screen flex overflow-hidden bg-surface">
      {/* Sidebar — light, translucent, System Settings style */}
      <aside className="w-56 flex flex-col bg-sidebar/80 backdrop-macos border-r border-black/10 dark:border-white/10 flex-shrink-0">
        {/* Title bar drag region (hosts the traffic lights) */}
        <div className="drag-region h-12 flex-shrink-0" />

        {/* Search */}
        <div className="px-3 pb-2 no-drag">
          <div className="relative">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500"
            />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search"
              className="w-full pl-8 pr-3 py-1.5 text-[13px] bg-black/[0.06] dark:bg-white/10 border-0 rounded-lg placeholder-gray-500 focus:ring-2 focus:ring-accent/40"
            />
          </div>
        </div>

        {/* App identity */}
        <div className="flex items-center px-4 py-2 mb-1">
          <img src={logo} alt="WPHerd" className="h-6 w-auto object-contain" draggable={false} />
        </div>

        {/* Navigation groups */}
        <nav className="flex-1 px-3 py-1 overflow-y-auto no-drag">
          {groups.map((group, gi) => (
            <div key={gi} className={gi > 0 ? 'mt-4' : ''}>
              {group.map(({ to, icon: Icon, label, color }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 px-2 py-[5px] rounded-md text-[13px] sidebar-item ${
                      isActive
                        ? 'bg-sidebar-active text-white font-medium'
                        : 'text-gray-800 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className={`icon-tile w-[22px] h-[22px] ${
                          isActive ? 'bg-white/25' : TILE_COLORS[color]
                        }`}
                      >
                        <Icon size={13} strokeWidth={2.2} />
                      </span>
                      {label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-4 py-3">
          <p className="text-[11px] text-gray-500 flex items-center gap-1.5 mb-1">
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${statusColor} ${anyRunning ? 'status-dot-running' : ''}`}
            />
            {statusText}
          </p>
          <span className="text-[11px] text-gray-400">WPHerd v1.0</span>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden bg-surface">
        {/* Top bar: drag region + centered-left page title */}
        <div className="drag-region h-12 flex items-center px-6 flex-shrink-0">
          <h1 className="text-[15px] font-bold text-gray-900">{title}</h1>
        </div>
        <div className="flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
