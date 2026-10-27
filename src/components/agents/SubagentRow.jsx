import { useState, useMemo, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { foldToolRuns, subagentSummary } from '../../lib/chatRows';
import { subagentExpansion } from '../../lib/chatSubagent';
import { ChatItem } from './ChatItems';

const STATUS_DOT = {
  running: 'bg-status-running animate-pulse',
  done: 'bg-muted-foreground',
  failed: 'bg-status-error',
  stopped: 'bg-status-warning',
};

// The nested list isn't virtualised, so it shows the latest rows only and
// pages back on request. A short subagent was read whole by its first tail
// page, so "Show earlier" only appears once there could be more.
const NESTED_PAGE = 200;

// A delegated Agent / Task call, with the subagent's own rows nested inside —
// the same renderers as the main list, so its tool runs and diffs read the
// same. The main process sends its nested rows only while this is open;
// collapsed, the header shows the call count it keeps.
export function SubagentRow({ item, nestedMessages, ctx }) {
  const [expanded, setExpanded] = useState(false);
  const [shown, setShown] = useState(NESTED_PAGE);
  const [atStart, setAtStart] = useState(false);
  const { status, type, description, count } = subagentSummary(item);
  const toolUseId = item.tool_use?.id;

  const folded = useMemo(() => foldToolRuns(nestedMessages || []), [nestedMessages]);
  const visible = folded.slice(-shown);
  const hiddenInMemory = folded.length - visible.length;

  const sessionId = ctx.sessionId;
  const expansion = useMemo(
    () =>
      subagentExpansion((open) =>
        window.electronAPI.chatExpandSubagent(sessionId, toolUseId, open)
      ),
    [sessionId, toolUseId]
  );
  useEffect(() => () => expansion.release(), [expansion]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    expansion.set(next);
  };

  const showEarlier = async () => {
    if (hiddenInMemory > 0) {
      setShown((n) => n + NESTED_PAGE);
      return;
    }
    const res = await ctx.loadOlderNested?.(toolUseId);
    if (res?.atStart) setAtStart(true);
  };

  // Nested rows can't fetch a full result: that reads the parent transcript.
  const nestedCtx = { ...ctx, onFetchFull: null };

  return (
    <div className="rounded border border-border bg-background/40 p-2">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 text-left"
        onClick={toggle}
        aria-expanded={expanded}
      >
        <ChevronRight
          size={13}
          className={`shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {type}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {description}
        </span>
        {count && (
          <span className="shrink-0 text-[11px] text-muted-foreground">{count}</span>
        )}
        {status && (
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
            {status}
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-3 flex flex-col gap-2 border-l-2 border-border pl-3">
          {folded.length === 0 && (
            <div className="text-[12px] text-muted-foreground">Loading transcript…</div>
          )}
          {(hiddenInMemory > 0 || (!atStart && (nestedMessages?.length || 0) >= 50)) && (
            <button
              type="button"
              onClick={showEarlier}
              className="self-start text-[12px] text-muted-foreground underline hover:text-foreground"
            >
              Show earlier
            </button>
          )}
          {visible.map((msg) => (
            <ChatItem key={msg.id} msg={msg} ctx={nestedCtx} />
          ))}
        </div>
      )}
    </div>
  );
}
