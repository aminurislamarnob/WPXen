import { NavLink } from 'react-router-dom';
import {
  Palette,
  SlidersHorizontal,
  Globe,
  Database,
  Mail,
  Layers,
  Wifi,
  Package,
  Info,
  Search,
  X,
} from 'lucide-react';
import { SECTIONS } from '../../lib/settingsRegistry';

const ICONS = {
  palette: Palette,
  sliders: SlidersHorizontal,
  globe: Globe,
  database: Database,
  mail: Mail,
  layers: Layers,
  wifi: Wifi,
  package: Package,
  info: Info,
};

// Left rail of the settings surface: search on top, then the section groups.
// When a query is active, sections with no matching rows drop out entirely and
// the rest carry a match count — Superset's SettingsSidebar behaviour.
export default function SettingsSidebar({ query, onQueryChange, matchCounts }) {
  return (
    <div className="w-52 flex-shrink-0 flex flex-col gap-4 py-1">
      <div className="relative">
        <Search
          size={13}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
        />
        <input
          type="text"
          aria-label="Search settings"
          placeholder="Search settings…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          className="form-input !text-xs !w-full !pl-7 !pr-7"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X size={13} />
          </button>
        )}
      </div>

      <nav className="flex flex-col gap-4">
        {SECTIONS.map((group) => {
          const items = matchCounts
            ? group.items.filter((i) => (matchCounts[i.id] ?? 0) > 0)
            : group.items;
          if (items.length === 0) return null;

          return (
            <div key={group.group}>
              <h2 className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-[0.1em] px-2 mb-1">
                {group.group}
              </h2>
              <div className="flex flex-col gap-0.5">
                {items.map((item) => {
                  const Icon = ICONS[item.icon] || Info;
                  const count = matchCounts?.[item.id];
                  return (
                    <NavLink
                      key={item.id}
                      to={`/settings/${item.id}`}
                      className={({ isActive }) =>
                        `flex items-center gap-2.5 px-2 py-1.5 text-[13px] rounded-md transition-colors ${
                          isActive
                            ? 'bg-accent text-foreground'
                            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                        }`
                      }
                    >
                      <Icon size={14} className="flex-shrink-0" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {count > 0 && (
                        <span className="text-[11px] text-muted-foreground bg-muted px-1.5 rounded">
                          {count}
                        </span>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
    </div>
  );
}
