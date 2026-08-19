import { useMemo, useState } from 'react';
import { Outlet, useOutletContext } from 'react-router-dom';
import { AlertTriangle, X } from 'lucide-react';
import SettingsSidebar from './SettingsSidebar';
import { matchCountsBySection, visibleItems } from '../../lib/settingsSearch';
import { useSettings } from '../../lib/useSettings';

// Settings shell: sidebar + the active section. Search state lives here so the
// sidebar's match counts and the section's row filtering stay in step.
export default function SettingsLayout(props) {
  const [query, setQuery] = useState('');
  const { error, dismissError } = useSettings();

  const matchCounts = useMemo(() => matchCountsBySection(query), [query]);
  const visible = useMemo(() => visibleItems(query), [query]);

  return (
    <div className="px-6 pb-6 max-w-[935px] mx-auto animate-fade-in">
      {/* A rejected write is never silent — the control has already rolled
          back, so this says why. */}
      {error && (
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg mb-4 text-[13px] bg-destructive/10 text-destructive">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <span className="flex-1">
            Couldn’t save <span className="font-mono">{error.key}</span> — {error.reason}
          </span>
          <button onClick={dismissError} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex gap-6 items-start">
        <SettingsSidebar
          query={query}
          onQueryChange={setQuery}
          matchCounts={matchCounts}
        />
        <div className="flex-1 min-w-0">
          {query && (
            <p className="text-xs text-muted-foreground mb-3 px-1">
              Showing settings matching “{query}”.{' '}
              <button onClick={() => setQuery('')} className="underline">
                Clear
              </button>
            </p>
          )}
          <Outlet context={{ ...props, visible }} />
        </div>
      </div>
    </div>
  );
}

// Sections read their shared props and the active search filter from here.
export function useSettingsContext() {
  return useOutletContext();
}
