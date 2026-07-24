import { useEffect, useMemo, useRef, useState } from 'react';
import { CaseSensitive, ChevronUp, ChevronDown, X } from 'lucide-react';
import { Tooltip } from './ui';

// Canvas match colors (not CSS) — the same in both themes, so literals are fine.
const DECORATIONS = {
  matchBackground: '#515c6a',
  matchBorder: '#74879f',
  matchOverviewRuler: '#d186167e',
  activeMatchBackground: '#515c6a',
  activeMatchBorder: '#ffd33d',
  activeMatchColorOverviewRuler: '#ffd33d',
};

// Find-in-terminal overlay driven by xterm's SearchAddon. Rendered by Terminal
// when open; positioned top-right inside the terminal wrapper.
export default function TerminalSearchBar({ searchAddon, onClose }) {
  const inputRef = useRef(null);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [noResults, setNoResults] = useState(false);

  const options = useMemo(
    () => ({ caseSensitive, regex: false, decorations: DECORATIONS }),
    [caseSensitive]
  );

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const run = (dir) => {
    if (!searchAddon || !query) return;
    const found =
      dir === 'prev'
        ? searchAddon.findPrevious(query, options)
        : searchAddon.findNext(query, options);
    setNoResults(!found);
  };

  const onChange = (e) => {
    const q = e.target.value;
    setQuery(q);
    if (!searchAddon) return;
    if (q) {
      setNoResults(!searchAddon.findNext(q, options));
    } else {
      setNoResults(false);
      searchAddon.clearDecorations();
    }
  };

  // Re-run when case sensitivity flips.
  useEffect(() => {
    if (searchAddon && query) {
      setNoResults(!searchAddon.findNext(query, options));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseSensitive]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(e.shiftKey ? 'prev' : 'next');
    }
  };

  return (
    <div className="panel absolute top-1 right-2 z-10 flex items-center gap-1 pl-2 pr-1 py-1">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder="Find"
        className="h-6 w-28 min-w-0 bg-transparent text-[12.5px] text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
      {noResults && query && (
        <span className="whitespace-nowrap px-1 text-[11px] text-muted-foreground">
          No results
        </span>
      )}
      <div className="flex items-center">
        <Tooltip label="Match case">
          <button
            onClick={() => setCaseSensitive((v) => !v)}
            aria-label="Match case"
            className={`rounded p-1 hover:bg-accent ${
              caseSensitive
                ? 'text-highlight'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <CaseSensitive size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Previous (Shift+Enter)">
          <button
            onClick={() => run('prev')}
            aria-label="Previous match"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronUp size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Next (Enter)">
          <button
            onClick={() => run('next')}
            aria-label="Next match"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronDown size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Close (Esc)">
          <button
            onClick={onClose}
            aria-label="Close search"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X size={14} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
