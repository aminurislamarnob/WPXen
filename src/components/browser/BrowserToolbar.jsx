import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Globe, Loader2, RotateCw } from 'lucide-react';
import { displayUrl } from '../../lib/browser/sanitizeUrl';
import { Tooltip } from '../ui';

// A history entry's favicon, falling back to the generic globe. Remote favicon
// URLs are fetched by the renderer itself, so a dead one must not leave a
// broken-image glyph behind.
function Favicon({ src }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (!src || failed) {
    return <Globe size={13} className="flex-shrink-0 text-muted-foreground" />;
  }
  return (
    <img
      src={src}
      alt=""
      width={13}
      height={13}
      className="flex-shrink-0 rounded-sm"
      onError={() => setFailed(true)}
    />
  );
}

// Address bar for a browser tab. Sits in the editor column's header row, so it
// matches the height and icon-button treatment of the file/diff header there.
//
// The URL field is a button until clicked, the way Superset's is: a full-width
// input on a toolbar reads as a form, and this is chrome.
export default function BrowserToolbar({
  url,
  title,
  favicon,
  loading,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onReload,
  onNavigate,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [highlighted, setHighlighted] = useState(-1);
  const inputRef = useRef(null);

  const shown = displayUrl(url);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  // Suggestions come from browsing history in the main process. The request is
  // cheap (a JsonStore read), so it runs per keystroke, guarded against
  // out-of-order replies.
  useEffect(() => {
    if (!editing) return setSuggestions([]);
    let stale = false;
    window.electronAPI.browserHistorySearch(draft, 8).then((rows) => {
      if (!stale) {
        setSuggestions(rows || []);
        setHighlighted(-1);
      }
    });
    return () => {
      stale = true;
    };
  }, [draft, editing]);

  const stopEditing = useCallback(() => {
    setEditing(false);
    setSuggestions([]);
    setHighlighted(-1);
  }, []);

  const go = useCallback(
    (value) => {
      stopEditing();
      if (value) onNavigate(value);
    },
    [onNavigate, stopEditing]
  );

  const startEditing = useCallback(() => {
    setDraft(shown);
    setEditing(true);
  }, [shown]);

  const submit = useCallback(
    (e) => {
      e.preventDefault();
      // Enter takes the highlighted suggestion when there is one, otherwise
      // whatever was typed.
      go(suggestions[highlighted]?.url ?? draft.trim());
    },
    [draft, go, highlighted, suggestions]
  );

  const onKeyDown = useCallback(
    (e) => {
      if (e.key === 'Escape') return stopEditing();
      if (!suggestions.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlighted((i) => (i + 1) % suggestions.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlighted((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
      }
    },
    [stopEditing, suggestions.length]
  );

  const navButton = 'p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground';

  return (
    <div className="flex items-center gap-1 flex-1 min-w-0">
      <Tooltip label="Back">
        <button
          className={navButton}
          aria-label="Back"
          disabled={!canGoBack}
          onClick={onGoBack}
        >
          <ArrowLeft size={14} />
        </button>
      </Tooltip>
      <Tooltip label="Forward">
        <button
          className={navButton}
          aria-label="Forward"
          disabled={!canGoForward}
          onClick={onGoForward}
        >
          <ArrowRight size={14} />
        </button>
      </Tooltip>
      <Tooltip label="Reload">
        <button className={navButton} aria-label="Reload" onClick={onReload}>
          {loading ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RotateCw size={14} />
          )}
        </button>
      </Tooltip>

      <div className="relative flex-1 min-w-0 ml-1">
        {editing ? (
          <form onSubmit={submit}>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              // Delayed so a click on a suggestion lands before the list goes.
              onBlur={() => setTimeout(stopEditing, 120)}
              onKeyDown={onKeyDown}
              placeholder="Enter a URL or search…"
              spellCheck={false}
              autoComplete="off"
              className="form-input h-6 px-2 text-[12px]"
            />
            {suggestions.length > 0 && (
              <div className="panel absolute left-0 right-0 top-7 z-50 py-1 max-h-64 overflow-y-auto">
                {suggestions.map((s, i) => (
                  <button
                    key={s.url}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => go(s.url)}
                    onMouseEnter={() => setHighlighted(i)}
                    className={`w-full flex items-center gap-2 px-2.5 py-1 text-left text-[12px] ${
                      i === highlighted ? 'bg-accent text-foreground' : 'text-foreground'
                    }`}
                  >
                    <Favicon src={s.faviconUrl} />
                    <span className="truncate">{displayUrl(s.url)}</span>
                    {s.title && (
                      <span className="truncate text-muted-foreground/70">{s.title}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </form>
        ) : (
          <button
            onClick={startEditing}
            title={shown}
            className="group flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-[12px] hover:bg-accent"
          >
            {shown ? (
              <>
                <Favicon src={favicon} />
                <span className="min-w-0 truncate text-muted-foreground group-hover:text-foreground">
                  {shown}
                </span>
                {title && (
                  <span className="min-w-0 truncate text-muted-foreground/60 group-hover:opacity-0">
                    {title}
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">Enter a URL or search…</span>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
