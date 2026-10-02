import { NavLink } from 'react-router-dom';
import { Tooltip } from './ui';
import { NAV_GROUPS } from '../lib/navItems';
import {
  ACTIVITY_BAR_WIDTH,
  downCoreServices,
  servicesLabel,
  agentsLabel,
} from '../lib/activityBar';

// VS Code-style activity bar for the Agents screen: a slim icon strip on the
// window's left edge that keeps every main screen one click away while the
// sidebar beside it is given over to the Sites tree. It stays put when ⌘B
// collapses that tree; clicking the active Agents icon toggles the tree too.
export default function ActivityBar({ serviceStatus, onToggleTree, agentsUnread = 0 }) {
  const down = downCoreServices(serviceStatus);
  const body = NAV_GROUPS.slice(0, -1);
  const pinned = NAV_GROUPS[NAV_GROUPS.length - 1];

  const item = ({ to, icon: Icon, label }) => {
    const isAgents = to === '/agents';
    const badge = to === '/services' && down.length > 0;
    // Amber, not red: an agent waiting on you isn't something broken.
    const attention = isAgents && agentsUnread > 0;
    const tip = badge
      ? servicesLabel(down)
      : isAgents
        ? agentsLabel(agentsUnread)
        : label;
    return (
      <Tooltip key={to} side="right" label={tip}>
        <NavLink
          to={to}
          aria-label={tip}
          onClick={(e) => {
            // Already here: behave like VS Code and toggle the side bar
            // rather than navigating to a bare /agents.
            if (isAgents) {
              e.preventDefault();
              onToggleTree();
            }
          }}
          className={({ isActive }) =>
            `relative flex items-center justify-center w-full h-11 transition-colors ${
              isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`
          }
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-r bg-highlight" />
              )}
              <Icon size={20} strokeWidth={1.7} />
              {badge && (
                <span className="absolute top-2.5 right-3 size-2 rounded-full bg-status-error ring-2 ring-sidebar" />
              )}
              {attention && (
                <span className="absolute top-2.5 right-3 size-2 rounded-full bg-status-warning ring-2 ring-sidebar" />
              )}
            </>
          )}
        </NavLink>
      </Tooltip>
    );
  };

  return (
    <nav
      aria-label="Main screens"
      style={{ width: ACTIVITY_BAR_WIDTH }}
      className="flex flex-col flex-shrink-0 bg-sidebar border-r border-sidebar-border"
    >
      {/* Clears the traffic lights and keeps the window draggable above the icons. */}
      <div className="drag-region h-12 flex-shrink-0" />
      <div className="flex-1 flex flex-col no-drag">
        {body.map((group, gi) => (
          <div key={gi} className="flex flex-col">
            {gi > 0 && <div className="mx-3 my-1 border-t border-sidebar-border" />}
            {group.map(item)}
          </div>
        ))}
        <div className="mt-auto pb-2">{pinned.map(item)}</div>
      </div>
    </nav>
  );
}
