import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Globe,
  Server,
  Code2,
  Mail,
  Settings,
  Search,
  ArrowLeft,
  ArrowRight,
  PanelLeft,
  Terminal,
} from 'lucide-react';
import logo from '../assets/logo.png';
import AgentsSidebar from './AgentsSidebar';
import { Tooltip } from './ui';

// System Settings-style nav: grouped items, each with its own colored tile.
const NAV_GROUPS = [
  [
    { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', color: 'blue' },
    { to: '/sites', icon: Globe, label: 'Sites', color: 'teal' },
    { to: '/agents', icon: Terminal, label: 'Agents', color: 'purple' },
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
  purple: 'bg-[#af52de]',
};

export default function Layout() {
  const [filter, setFilter] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const agentsMode = location.pathname.startsWith('/agents');

  // Shortcuts for the window controls, matching the keycaps in their tooltips.
  // ⌘[ / ⌘] are the macOS system bindings for history; ⌘B is the usual
  // sidebar toggle. Keep these in sync with the `keys` props below.
  useEffect(() => {
    const onKey = (e) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'b' || e.key === 'B') setSidebarCollapsed((v) => !v);
      else if (e.key === '[') navigate(-1);
      else if (e.key === ']') navigate(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  const q = filter.trim().toLowerCase();
  const groups = q
    ? NAV_GROUPS.map((g) => g.filter((i) => i.label.toLowerCase().includes(q))).filter(
        (g) => g.length > 0
      )
    : NAV_GROUPS;

  return (
    <div className="h-screen flex overflow-hidden relative">
      {/* Sidebar — raw window vibrancy, one continuous glass sheet with the
          content pane (macOS 26 System Settings). Collapsible from the top bar. */}
      <aside
        className={`flex flex-col flex-shrink-0 overflow-hidden border-r border-black/[0.06] dark:border-white/[0.06] transition-[width] duration-200 ease-out ${
          sidebarCollapsed ? 'w-0 border-r-0' : 'w-56'
        }`}
      >
        {/* Title bar drag region (hosts the traffic lights) */}
        <div className="drag-region h-12 flex-shrink-0" />

        {agentsMode ? (
          // Agents mode: the sidebar becomes a Sites → providers tree with a
          // back button, in place of the main menu.
          <AgentsSidebar onBack={() => navigate('/sites')} />
        ) : (
          <>
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
          </>
        )}

        {/* Footer — app logo */}
        <div className="flex items-center px-4 py-3">
          <img
            src={logo}
            alt="WPHerd"
            className="h-5 w-auto object-contain"
            draggable={false}
          />
        </div>
      </aside>

      {/* Main content — faint tint over the vibrancy, slightly lighter than
          the sidebar like System Settings */}
      <main className="flex-1 flex flex-col overflow-hidden bg-surface/55">
        {/* Slim drag region so the window stays movable and content clears the
            traffic-light controls. The Agents screens run their own top strip
            (tabs) up against the controls, so drop the gap there. */}
        <div className={`drag-region flex-shrink-0 ${agentsMode ? 'h-0' : 'h-11'}`} />
        <div className="flex-1 overflow-y-auto">
          <Outlet context={{ sidebarCollapsed, agentsMode }} />
        </div>
      </main>

      {/* Window controls, docked just after the native macOS traffic lights.
          Absolutely positioned so they stay put whether the sidebar is shown
          or hidden — sidebar toggle, then thin back/forward arrows.

          These MUST stay the last child: macOS builds the window's draggable
          region by walking the DOM in order, adding `drag` rects and
          subtracting `no-drag` ones. The sidebar/content drag strips overlap
          this cluster, so if they were processed afterwards they'd re-cover it
          and the OS would swallow every click as a title-bar drag. */}
      <div className="no-drag absolute top-2 left-[84px] z-30 flex items-center gap-1.5">
        <Tooltip label="Toggle sidebar" keys={['⌘', 'B']}>
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            className="no-drag p-1.5 rounded-lg text-gray-600 hover:text-gray-900 hover:bg-black/[0.06] active:bg-black/10 dark:hover:bg-white/10 dark:active:bg-white/15 transition-colors"
          >
            <PanelLeft size={18} strokeWidth={1.8} />
          </button>
        </Tooltip>
        <Tooltip label="Go back" keys={['⌘', '[']}>
          <button
            onClick={() => navigate(-1)}
            aria-label="Back"
            className="no-drag p-1.5 rounded-lg text-gray-700 hover:text-gray-900 hover:bg-black/[0.06] active:bg-black/10 dark:hover:bg-white/10 dark:active:bg-white/15 transition-colors"
          >
            <ArrowLeft size={18} strokeWidth={1.8} />
          </button>
        </Tooltip>
        <Tooltip label="Go forward" keys={['⌘', ']']}>
          <button
            onClick={() => navigate(1)}
            aria-label="Forward"
            className="no-drag p-1.5 rounded-lg text-gray-400 hover:text-gray-900 hover:bg-black/[0.06] active:bg-black/10 dark:hover:bg-white/10 dark:active:bg-white/15 transition-colors"
          >
            <ArrowRight size={18} strokeWidth={1.8} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
