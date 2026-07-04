import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Globe,
  Server,
  Code2,
  Mail,
  Settings,
  Search,
  ChevronLeft,
  ChevronRight,
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

export default function Layout() {
  const [filter, setFilter] = useState('');
  const location = useLocation();
  const navigate = useNavigate();

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
    <div className="h-screen flex overflow-hidden">
      {/* Sidebar — raw window vibrancy, one continuous glass sheet with the
          content pane (macOS 26 System Settings) */}
      <aside className="w-56 flex flex-col flex-shrink-0 border-r border-black/[0.06] dark:border-white/[0.06]">
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
              className="w-full pl-8 pr-3 py-1.5 text-[13px] bg-black/[0.06] dark:bg-white/10 border-0 rounded-full placeholder-gray-500 focus:ring-2 focus:ring-accent/40"
            />
          </div>
        </div>

        {/* Navigation groups */}
        <nav className="flex-1 px-3 py-1 overflow-y-auto no-drag">
          {groups.map((group, gi) => (
            <div key={gi} className="space-y-1.5 mb-2 last:mb-0">
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

        {/* Footer — app logo */}
        <div className="flex items-center px-4 py-3">
          <img src={logo} alt="WPHerd" className="h-5 w-auto object-contain" draggable={false} />
        </div>
      </aside>

      {/* Main content — faint tint over the vibrancy, slightly lighter than
          the sidebar like System Settings */}
      <main className="flex-1 flex flex-col overflow-hidden bg-surface/55">
        {/* Top bar: drag region + back/forward capsule + page title */}
        <div className="drag-region h-[62px] flex items-center gap-3 px-4 flex-shrink-0">
          {/* Back/forward capsule: one glass pill, hairline divider between
              the chevrons, forward dimmed — like System Settings */}
          <div className="no-drag flex items-stretch rounded-full glass overflow-hidden">
            <button
              onClick={() => navigate(-1)}
              aria-label="Back"
              className="pl-4 pr-3 py-3 text-gray-800 hover:bg-black/5 active:bg-black/10 dark:hover:bg-white/10 dark:active:bg-white/15 transition-colors"
            >
              <ChevronLeft size={16} strokeWidth={2.6} />
            </button>
            <span className="w-px my-2.5 bg-black/10 dark:bg-white/[0.14]" />
            <button
              onClick={() => navigate(1)}
              aria-label="Forward"
              className="pl-3 pr-4 py-3 text-gray-400 hover:bg-black/5 active:bg-black/10 dark:hover:bg-white/10 dark:active:bg-white/15 transition-colors"
            >
              <ChevronRight size={16} strokeWidth={2.6} />
            </button>
          </div>
          <h1 className="text-[15px] font-bold text-gray-900">{title}</h1>
        </div>
        <div className="flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
