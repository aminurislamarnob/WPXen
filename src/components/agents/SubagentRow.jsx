import { useState, useMemo, useEffect } from 'react';
import { ChatMarkdown } from './ChatMarkdown';
import { foldToolRuns } from '../../lib/chatRows';
import { pinnedIndexes } from '../../lib/chatList';

// Nested items are rendered similarly to standard chat, but simpler (no input, no load-older for now, though we could add loadOlder Subagent).
export function SubagentRow({ item, nestedMessages, sessionId }) {
  const [expanded, setExpanded] = useState(false);

  const meta = item.subagent || {};
  const parentId = item.tool_use?.id;
  const isRunning = meta.live;

  const folded = useMemo(() => foldToolRuns(nestedMessages || []), [nestedMessages]);

  useEffect(() => {
    if (expanded && (!nestedMessages || nestedMessages.length === 0)) {
      window.electronAPI.chatExpandSubagent(sessionId, parentId);
    }
  }, [expanded, nestedMessages, sessionId, parentId]);

  const handleLink = (url) => {
    window.electronAPI.openSiteInBrowser(url);
  };

  return (
    <div className="bg-background/40 border border-border/50 rounded p-2 mb-2">
      <div
        className="flex items-center gap-2 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
          {meta.type || 'Subagent'}
        </div>
        <div className="text-sm font-medium flex-1 truncate">{meta.role || 'Task'}</div>
        {isRunning && (
          <div className="flex items-center gap-1.5 text-xs text-blue-400">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            Running
          </div>
        )}
        <div className="text-xs text-muted-foreground flex gap-2">
          {meta.toolCounts &&
            Object.entries(meta.toolCounts).map(([name, count]) => (
              <span key={name} title={name}>
                {count} 🛠️
              </span>
            ))}
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
