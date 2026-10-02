import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Search, ArrowLeft, ArrowRight, PanelLeft } from 'lucide-react';
import logo from '../assets/logo.png';
import ActivityBar from './ActivityBar';
import AgentsSidebar from './AgentsSidebar';
import { Tooltip } from './ui';
import { NAV_GROUPS } from '../lib/navItems';
import { ACTIVITY_BAR_WIDTH, WINDOW_CONTROLS_END } from '../lib/activityBar';

// System Settings-style nav (NAV_GROUPS): grouped items, each with its own
// colored tile.

const TILE_COLORS = {
  blue: 'bg-[#0a7aff]',
  teal: 'bg-[#30b0c7]',
  green: 'bg-[#28c840]',
  indigo: 'bg-[#5856d6]',
  red: 'bg-[#ff3b30]',
  gray: 'bg-[#8e8e93]',
  purple: 'bg-[#af52de]',
};

export default function Layout({ serviceStatus }) {
  const [filter, setFilter] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const agentsMode = location.pathname.startsWith('/agents');

  // How far content flush against the left of <main> must inset to clear the
  // floating window controls — only needed once the sidebar is collapsed, and
  // less on Agents, where the activity bar already covers part of the span.
  const controlsInset = sidebarCollapsed
    ? WINDOW_CONTROLS_END - (agentsMode ? ACTIVITY_BAR_WIDTH : 0)
    : 0;

  // Shortcuts for the window controls, matching the keycaps in their tooltips.
  // ⌘[ / ⌘] are the macOS system bindings for history; ⌘B is the usual
  // sidebar toggle. Keep these in sync with the `keys` props below.
  useEffect(() => {
    const run = (key) => {
      if (key === 'b') setSidebarCollapsed((v) => !v);
      else if (key === '[') navigate(-1);
      else if (key === ']') navigate(1);
      else return false;
      return true;
    };

    const onKey = (e) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      if (run(e.key.toLowerCase())) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);

    // An in-app browser page has its own renderer and swallows keystrokes
    // before this listener sees them, so the main process intercepts these
    // chords and forwards them here (see electron/services/browser.cjs).
    const offForwarded = window.electronAPI.on('browser-shortcut', ({ key }) => run(key));

    return () => {
      window.removeEventListener('keydown', onKey);
      offForwarded();
    };
  }, [navigate]);

  // A clicked agent notification (or tray entry) opens its session.
  useEffect(
    () =>
      window.electronAPI.on('agent-open-session', ({ siteId, sessionId }) =>
        navigate(`/agents/${encodeURIComponent(siteId)}`, {
          state: { focus: sessionId, nonce: Date.now() },
        })
      ),
    [navigate]
  );

  const q = filter.trim().toLowerCase();
  const groups = q
    ? NAV_GROUPS.map((g) => g.filter((i) => i.label.toLowerCase().includes(q))).filter(
        (g) => g.length > 0
      )
    : NAV_GROUPS;

  return (
    <div className="h-screen flex overflow-hidden relative">
      {/* Agents mode: a VS Code-style activity bar to the left of the Sites
          tree, so every main screen stays one click away. ⌘B collapses only
          the tree beside it. */}
      {agentsMode && (
        <ActivityBar
          serviceStatus={serviceStatus}
          onToggleTree={() => setSidebarCollapsed((v) => !v)}
        />
      )}

      {/* Sidebar — opaque, one shade off the content pane. Collapsible from the
          top bar. */}
      <aside
        className={`flex flex-col flex-shrink-0 overflow-hidden bg-sidebar text-sidebar-foreground border-r border-sidebar-border transition-[width] duration-200 ease-out ${
          sidebarCollapsed ? 'w-0 border-r-0' : agentsMode ? 'w-64' : 'w-56'
        }`}
      >
        {/* Title bar drag region (hosts the traffic lights) */}
        <div className="drag-region h-12 flex-shrink-0" />

        {agentsMode ? (
          // Agents mode: the sidebar becomes the Projects list (Sites → agent
          // Sessions), in place of the main menu.
          <AgentsSidebar />
        ) : (
          <>
            {/* Search */}
            <div className="px-3 pb-2 no-drag">
              <div className="relative">
                <Search
                  size={13}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Search"
                  className="w-full h-7 pl-8 pr-3 text-[13px] bg-muted border-0 rounded-md placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/60"
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
                            : 'text-sidebar-foreground/90 hover:bg-sidebar-accent'
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
            alt="WPXen"
            className="h-5 w-auto object-contain"
            draggable={false}
          />
        </div>
      </aside>

      {/* Main content — the app background, a shade lighter than the sidebar */}
      <main className="flex-1 flex flex-col overflow-hidden bg-background">
        {/* Slim drag region so the window stays movable and content clears the
            traffic-light controls. The Agents screens run their own top strip
            (tabs) up against the controls, so drop the gap there. */}
        <div className={`drag-region flex-shrink-0 ${agentsMode ? 'h-0' : 'h-11'}`} />
        <div className="flex-1 overflow-y-auto">
          <Outlet context={{ sidebarCollapsed, agentsMode, controlsInset }} />
        </div>
      </main>

      {/* Window controls, docked just after the native macOS traffic lights.
          Absolutely positioned so they stay put whether the sidebar is shown
          or hidden — sidebar toggle, then thin back/forward arrows.

          These MUST stay the last child: macOS builds the window's draggable
          region by walking the DOM in order, adding `drag` rects and
          subtracting `no-drag` ones. The sidebar/content drag strips overlap
          this cluster, so if they were processed afterwards they'd re-cover it
          and the OS would swallow every click as a title-bar drag.

          Horizontal geometry matches Superset's TopBar: the cluster starts
          12px past the last traffic light (which ends at x=68).

          Vertically, the 12px lights render centered on y=26 — macOS insets
          them ~2px below the configured trafficLightPosition y=18, so don't
          derive this from that value. top-2.5 puts the 32px toggle's center on
          the same line (10 + 16 = 26). Fixed square hit targets (32px toggle,
          28px arrows) rather than padding keep every glyph optically centered,
          so resizing an icon never shifts the row off the lights. */}
      <div className="no-drag absolute top-2.5 left-20 z-30 flex items-center gap-1.5">
        <Tooltip label="Toggle sidebar" keys={['⌘', 'B']}>
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            className="no-drag flex items-center justify-center size-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <PanelLeft size={17} strokeWidth={1.7} />
          </button>
        </Tooltip>
        {/* The arrows are a pair: no gap between them, the hit targets space them. */}
        <div className="flex items-center">
          <Tooltip label="Go back" keys={['⌘', '[']}>
            <button
              onClick={() => navigate(-1)}
              aria-label="Back"
              className="no-drag flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              <ArrowLeft size={17} strokeWidth={1.7} />
            </button>
          </Tooltip>
          <Tooltip label="Go forward" keys={['⌘', ']']}>
            <button
              onClick={() => navigate(1)}
              aria-label="Forward"
              className="no-drag flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              <ArrowRight size={17} strokeWidth={1.7} />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
