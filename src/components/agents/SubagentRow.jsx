import { useState, useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { ChatMarkdown } from './ChatMarkdown';
import { foldToolRuns, subagentSummary } from '../../lib/chatRows';

const STATUS_CLASS = {
  running: 'text-highlight',
  done: 'text-muted-foreground',
  failed: 'text-destructive',
};

// A delegated Agent / Task call, with the subagent's own rows nested inside.
// The main process tails the subagent while it runs or while this is open.
export function SubagentRow({ item, nestedMessages, sessionId }) {
  const [expanded, setExpanded] = useState(false);
  const { status, type, description, count } = subagentSummary(item);
  const toolUseId = item.tool_use?.id;

  const folded = useMemo(() => foldToolRuns(nestedMessages || []), [nestedMessages]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    window.electronAPI.chatExpandSubagent(sessionId, toolUseId, next);
  };

  const handleLink = (url) => {
    window.electronAPI.openSiteInBrowser(url);
  };

  return (
    <div className="bg-background/40 border border-border/50 rounded p-2 mb-2">
      <div className="flex items-center gap-2 cursor-pointer" onClick={toggle}>
        <ChevronRight
          size={13}
          className={`shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <div className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
          {type}
        </div>
        <div className="text-sm font-medium flex-1 truncate">{description}</div>
        {count && <div className="text-xs text-muted-foreground">{count}</div>}
        <div className={`flex items-center gap-1.5 text-xs ${STATUS_CLASS[status]}`}>
          {status === 'running' && (
            <span className="w-1.5 h-1.5 rounded-full bg-highlight animate-pulse" />
          )}
          {status}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pl-3 border-l-2 border-border/40 flex flex-col gap-3">
          {folded.length === 0 && (
            <div className="text-xs text-muted-foreground">Loading transcript...</div>
          )}
          {folded.map((msg) => (
            <div key={msg.id} className="text-[13px] bg-background/60 rounded p-2">
              <div className="font-semibold text-[11px] mb-1 opacity-70">
                {msg.role === 'tool-run'
                  ? msg.summary
                  : msg.role === 'user'
                    ? msg.orphan
                      ? 'Orphan'
                      : 'User'
                    : msg.role}
              </div>
              {msg.role === 'tool-run' ? (
                <div className="text-[12px] opacity-80">{msg.items.length} items</div>
              ) : (
                <ChatMarkdown text={msg.content} empty="Empty" onLink={handleLink} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
