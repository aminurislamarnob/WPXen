import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Globe,
  Server,
  Code2,
  Mail,
  Settings,
  Circle,
} from 'lucide-react';
import logo from '../assets/logo.png';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/sites', icon: Globe, label: 'Sites' },
  { to: '/services', icon: Server, label: 'Services' },
  { to: '/php', icon: Code2, label: 'PHP' },
  { to: '/mail', icon: Mail, label: 'Mail' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function Layout({ serviceStatus }) {
  const allRunning =
    serviceStatus?.nginx?.running &&
    serviceStatus?.php?.running &&
    serviceStatus?.mysql?.running;

  const anyRunning =
    serviceStatus?.nginx?.running ||
    serviceStatus?.php?.running ||
    serviceStatus?.mysql?.running;

  const statusColor = allRunning
    ? 'text-wp-green'
    : anyRunning
      ? 'text-wp-yellow'
      : 'text-gray-400';

  return (
    <div className="h-screen flex overflow-hidden bg-surface">
      {/* Sidebar */}
      <aside className="w-56 flex flex-col bg-sidebar flex-shrink-0">
        {/* App header (title bar drag region — hosts the macOS traffic lights) */}
        <div className="drag-region h-14 flex-shrink-0" />

        {/* Navigation */}
        <nav className="flex-1 px-3 py-2 space-y-0.5">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm sidebar-item no-drag ${
                  isActive
                    ? 'bg-sidebar-active text-white font-medium'
                    : 'text-sidebar-text hover:bg-sidebar-hover hover:text-white'
                }`
              }
            >
              <Icon size={16} className="flex-shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Status footer */}
        <div className="px-4 py-4 border-t border-white/10">
          <div className="flex items-center gap-2">
            <Circle
              size={8}
              className={`${statusColor} fill-current flex-shrink-0 ${
                anyRunning ? 'status-dot-running' : ''
              }`}
            />
            <span className="text-xs text-sidebar-text truncate">
              {allRunning
                ? 'All services running'
                : anyRunning
                  ? 'Partially running'
                  : 'Services stopped'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            <img
              src={logo}
              alt="WPHerd"
              className="h-4 w-auto"
              draggable={false}
            />
            <span className="text-xs text-sidebar-text/50">v1.0</span>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden bg-surface">
        {/* Top bar drag region */}
        <div className="drag-region h-9 bg-surface flex-shrink-0" />
        <div className="flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
