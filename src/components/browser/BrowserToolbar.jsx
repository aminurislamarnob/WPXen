import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Loader2, RotateCw } from 'lucide-react';
import { displayUrl } from '../../lib/browser/sanitizeUrl';
import { Tooltip } from '../ui';

// Address bar for a browser tab. Sits in the editor column's header row, so it
// matches the height and icon-button treatment of the file/diff header there.
//
// The URL field is a button until clicked, the way Superset's is: a full-width
// input on a toolbar reads as a form, and this is chrome.
export default function BrowserToolbar({
  url,
  title,
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
  const inputRef = useRef(null);

  const shown = displayUrl(url);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const startEditing = useCallback(() => {
    setDraft(shown);
    setEditing(true);
  }, [shown]);

  const submit = useCallback(
    (e) => {
      e.preventDefault();
      const value = draft.trim();
      setEditing(false);
      if (value) onNavigate(value);
    },
    [draft, onNavigate]
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

      <div className="flex-1 min-w-0 ml-1">
        {editing ? (
          <form onSubmit={submit}>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => setEditing(false)}
              onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
              placeholder="Enter a URL or search…"
              spellCheck={false}
              autoComplete="off"
              className="form-input h-6 px-2 text-[12px]"
            />
          </form>
        ) : (
          <button
            onClick={startEditing}
            title={shown}
            className="group flex w-full min-w-0 items-baseline gap-1.5 rounded-md px-2 py-0.5 text-left text-[12px] hover:bg-accent"
          >
            {shown ? (
              <>
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
