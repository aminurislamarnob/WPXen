import { useState, useEffect, useRef, useId, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Markdown } from '../tasks/markdown';
import { pinnedIndexes, shouldStickToBottom } from '../../lib/chatList';

export function ChatView({ sessionId }) {
  const viewerId = useId();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [atStart, setAtStart] = useState(false);
  const [staleNotice, setStaleNotice] = useState(false);

  // Track auto-scroll state
  const scrollRef = useRef(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [showLatestPill, setShowLatestPill] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);

  // Expose virtualizer
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    rangeExtractor: (range) => pinnedIndexes(range, { count: messages.length }),
    onChange: (instance) => {
      // Check if we hit top to load older
      if (!atStart && !isLoadingOlder && instance.scrollElement) {
        if (instance.scrollElement.scrollTop < 100) {
          loadOlder();
        }
      }
    },
  });

  const loadOlder = useCallback(async () => {
    setIsLoadingOlder(true);
    try {
      const res = await window.electronAPI.chatLoadOlder(sessionId);
      if (res) {
        setAtStart(res.atStart);
        if (res.rows && res.rows.length > 0) {
          setMessages((prev) => {
            let next = [...res.rows, ...prev];
            // loadOlder might have brought a tool call that resolves an orphan.
            // The newer messages might need to be filtered out if `remove` is present on the new rows.
            for (const row of res.rows) {
              if (row.remove) {
                next = next.filter((m) => !row.remove.includes(m.id));
              }
            }
            return next;
          });
        }
      }
    } finally {
      setIsLoadingOlder(false);
    }
  }, [sessionId]);

  useEffect(() => {
    const api = window.electronAPI;
    const unsub = api.on('agent-chat-rows', ({ sessionId: rowSessionId, rows }) => {
      if (rowSessionId !== sessionId) return;

      setMessages((prev) => {
        let next = [...prev];
        let changed = false;

        for (const row of rows) {
          if (row.reset) {
            next = [];
            setAtStart(false);
            setStaleNotice(false);
            changed = true;
            continue;
          }
          if (row.notice) {
            if (row.kind === 'transcript-changed') setStaleNotice(true);
            continue;
          }

          if (row.remove) {
            next = next.filter((m) => !row.remove.includes(m.id));
            changed = true;
          }

          if (!row.id) continue;
          changed = true;

          const idx = next.findIndex((m) => m.id === row.id);
          if (idx >= 0) {
            next[idx] = row;
          } else {
            next.push(row);
          }
        }

        if (changed) {
          if (!stickToBottom) {
            setShowLatestPill(true);
          }
        }
        return changed ? next : prev;
      });
    });

    api.chatOpen(sessionId, viewerId);
    return () => {
      api.chatClose(sessionId, viewerId);
      unsub();
    };
  }, [sessionId, viewerId, stickToBottom]);

  // Keep at bottom on new messages if sticking
  useEffect(() => {
    if (stickToBottom && messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
      setShowLatestPill(false);
    }
  }, [messages.length, stickToBottom, virtualizer]);

  const onScroll = useCallback((e) => {
    const el = e.target;
    const isAtBottom = shouldStickToBottom({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    setStickToBottom(isAtBottom);
    if (isAtBottom) {
      setShowLatestPill(false);
    }
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!input.trim()) return;
      window.electronAPI.chatSend(sessionId, input);
      setInput('');
      // Force stick to bottom when user sends a message
      setStickToBottom(true);
      setShowLatestPill(false);
    }
  };

  const handleLink = useCallback((url) => {
    window.electronAPI.openSiteInBrowser(url);
  }, []);

  const fetchFull = async (msgId, toolUseId) => {
    const content = await window.electronAPI.chatFetchFull(sessionId, toolUseId);
    if (content) {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== msgId) return m;
          const next = { ...m };
          if (next.blocks) {
            next.blocks = next.blocks.map((b) => {
              if (b.type === 'tool_result' && b.tool_use_id === toolUseId) {
                return { ...b, content, truncated: false };
              }
              return b;
            });
            // Rebuild content string for markdown
            let combinedContent = '';
            for (const block of next.blocks) {
              if (block.type === 'text') {
                combinedContent += block.text + '\n';
              } else if (block.type === 'tool_use') {
                combinedContent += `\`\`\`tool_use\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
              } else if (block.type === 'thinking') {
                combinedContent += `> Thinking...\n`;
              } else if (block.type === 'tool_result') {
                // orphan result rendering? The spec just cares about assistant block, but for orphan we have content
                if (next.orphan) {
                  combinedContent += block.content + '\n';
                }
              }
            }
            next.content = combinedContent.trim();
          }
          return next;
        })
      );
    }
  };

  return (
    <div className="flex flex-col h-full bg-background text-foreground relative">
      <div className="flex-1 overflow-y-auto p-4" ref={scrollRef} onScroll={onScroll}>
        {staleNotice && (
          <div className="text-center p-2 mb-4 bg-destructive/10 text-destructive text-[12px] rounded">
            Transcript changed — reopen chat
          </div>
        )}
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const msg = messages[virtualRow.index];
            if (!msg) return null;
            return (
              <div
                key={msg.id}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className={`flex flex-col mb-4 ${msg.role === 'user' && !msg.orphan ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg p-3 ${
                    msg.role === 'user' && !msg.orphan
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted'
                  }`}
                >
                  <div className="font-semibold text-[11px] mb-1 opacity-70">
                    {msg.role === 'user'
                      ? msg.orphan
                        ? 'Orphan Result'
                        : 'You'
                      : 'Assistant'}
                  </div>
                  <div className="text-[13px] break-words">
                    <Markdown text={msg.content} empty="Empty" onLink={handleLink} />

                    {/* Render truncated notice and fetch full button */}
                    {msg.blocks?.map((b, i) => {
                      if (b.type === 'tool_result' && b.truncated) {
                        return (
                          <div
                            key={i}
                            className="mt-2 text-[11px] text-muted-foreground bg-background/50 p-2 rounded"
                          >
                            Output truncated.{' '}
                            <button
                              onClick={() => fetchFull(msg.id, b.tool_use_id)}
                              className="underline hover:text-foreground"
                            >
                              Show full output
                            </button>
                          </div>
                        );
                      }
                      // If it's an assistant tool_use that has a truncated result attached
                      if (b.type === 'tool_use' && b.result && b.result.truncated) {
                        return (
                          <div
                            key={i}
                            className="mt-2 text-[11px] text-muted-foreground bg-background/50 p-2 rounded"
                          >
                            Tool result truncated.{' '}
                            <button
                              onClick={() => fetchFull(msg.id, b.id)}
                              className="underline hover:text-foreground"
                            >
                              Show full output
                            </button>
                          </div>
                        );
                      }
                      return null;
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {showLatestPill && (
        <button
          onClick={() => {
            setStickToBottom(true);
            if (messages.length > 0) {
              virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
            }
            setShowLatestPill(false);
          }}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 bg-accent text-accent-foreground px-3 py-1.5 rounded-full text-[12px] shadow-md hover:bg-accent/80 transition-colors z-10"
        >
          Jump to latest
        </button>
      )}

      <div className="p-4 border-t border-border bg-background z-20">
        <textarea
          className="w-full bg-background border border-input rounded-md px-3 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring resize-y min-h-[60px]"
          placeholder="Message..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  );
}
