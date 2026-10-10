import { useState, useEffect, useRef, useId, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Markdown } from '../tasks/markdown';
import { pinnedIndexes, shouldStickToBottom } from '../../lib/chatList';
import { foldToolRuns } from '../../lib/chatRows';
import { useMemo } from 'react';
import { useAgentSessions } from '../../lib/useAgentSessions';
import DiffView from '../DiffView';

import { HighlightStyle } from '@codemirror/language';
import { highlightCode } from '@lezer/highlight';
import { languageFor } from '../../lib/editorLanguage';
import { highlightSpecs } from '../../lib/editorTheme';
import { themeName, onThemeChange } from '../../lib/theme';

const styleCache = new Map();
function getSharedHighlightStyle(appearance) {
  if (!styleCache.has(appearance)) {
    styleCache.set(appearance, HighlightStyle.define(highlightSpecs(appearance)));
  }
  return styleCache.get(appearance);
}

function ChatMarkdown({ text, onLink, empty }) {
  const containerRef = useRef(null);
  const [appearance, setAppearance] = useState(themeName);
  useEffect(() => onThemeChange(setAppearance), []);
  const style = useMemo(() => getSharedHighlightStyle(appearance), [appearance]);

  useEffect(() => {
    if (!containerRef.current) return;
    const blocks = containerRef.current.querySelectorAll('pre code[class^="language-"]');
    if (blocks.length === 0) return;

    for (const code of blocks) {
      if (code.dataset.highlighted) continue;
      code.dataset.highlighted = 'true';
      const langMatch = code.className.match(/language-([a-zA-Z0-9_+-]+)/);
      if (!langMatch) continue;
      const extList = languageFor(`file.${langMatch[1]}`);
      if (!extList || extList.length === 0) continue;

      let parser = null;
      for (const ext of extList) {
        if (ext.language && ext.language.parser) {
          parser = ext.language.parser;
          break;
        }
      }
      if (!parser) continue;

      const source = code.textContent;
      let fragment = document.createDocumentFragment();
      const putText = (t, classes) => {
        if (!t) return;
        if (classes) {
          const span = document.createElement('span');
          span.className = classes;
          span.textContent = t;
          fragment.appendChild(span);
        } else {
          fragment.appendChild(document.createTextNode(t));
        }
      };
      const putBreak = () => {
        fragment.appendChild(document.createTextNode('\n'));
      };

      try {
        const tree = parser.parse(source);
        highlightCode(source, tree, style, putText, putBreak);
        code.innerHTML = '';
        code.appendChild(fragment);
      } catch (err) {
        // parser failed
      }
    }
  }, [text, style]);

  return (
    <div ref={containerRef}>
      {style.module && (
        <style dangerouslySetInnerHTML={{ __html: style.module.getRules() }} />
      )}
      <Markdown text={text} onLink={onLink} empty={empty} />
    </div>
  );
}

export function ChatView({ sessionId }) {
  const viewerId = useId();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [atStart, setAtStart] = useState(false);
  const [staleNotice, setStaleNotice] = useState(false);
  const [headerTitle, setHeaderTitle] = useState('');
  const sessions = useAgentSessions();
  // Session rows are keyed `sessionId`; there is no `id`.
  const currentSession = sessions.find((s) => s.sessionId === sessionId);

  // Track auto-scroll state
  const scrollRef = useRef(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [showLatestPill, setShowLatestPill] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);

  const foldedMessages = useMemo(() => foldToolRuns(messages), [messages]);

  // Expose virtualizer
  const virtualizer = useVirtualizer({
    count: foldedMessages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    rangeExtractor: (range) => pinnedIndexes(range, { count: foldedMessages.length }),
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
    const unsub = api.on(
      'agent-chat-rows',
      ({ sessionId: rowSessionId, rows, header }) => {
        if (rowSessionId !== sessionId) return;

        if (header?.title) setHeaderTitle(header.title);

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
      }
    );

    api.chatOpen(sessionId, viewerId);
    return () => {
      api.chatClose(sessionId, viewerId);
      unsub();
    };
  }, [sessionId, viewerId, stickToBottom]);

  // Keep at bottom on new messages if sticking
  useEffect(() => {
    if (stickToBottom && messages.length > 0) {
      virtualizer.scrollToIndex(foldedMessages.length - 1, { align: 'end' });
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
          if (
            next.role === 'tool' &&
            next.result &&
            next.result.tool_use_id === toolUseId
          ) {
            next.result = { ...next.result, content, truncated: false };
          } else if (next.blocks) {
            next.blocks = next.blocks.map((b) => {
              if (b.type === 'tool_result' && b.tool_use_id === toolUseId) {
                return { ...b, content, truncated: false };
              }
              return b;
            });
          }
          return next;
        })
      );
    }
  };

  return (
    <div className="flex flex-col h-full bg-background text-foreground relative">
      {headerTitle && (
        <div className="px-4 py-2 border-b border-border bg-muted/30 text-[13px] font-medium flex-none truncate">
          {headerTitle}
        </div>
      )}
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
            const msg = foldedMessages[virtualRow.index];
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
                  {msg.role === 'tool-run' ? (
                    <div>
                      <div className="font-semibold text-[11px] mb-1 opacity-70">
                        Tool Run
                      </div>
                      <details className="text-[13px]">
                        <summary className="cursor-pointer font-medium">
                          {msg.summary}
                        </summary>
                        <div className="mt-2 pl-2 border-l border-border/50 flex flex-col gap-2">
                          {msg.items.map((item) => (
                            <div
                              key={item.id}
                              className="text-[12px] bg-background/30 p-2 rounded"
                            >
                              {item.edit ? (
                                <div>
                                  <div className="font-mono text-[10px] mb-1">
                                    {item.edit.path}
                                  </div>
                                  <DiffView
                                    name={item.edit.path}
                                    original={item.edit.original}
                                    modified={item.edit.modified}
                                  />
                                </div>
                              ) : (
                                <div>
                                  <ChatMarkdown
                                    text={
                                      item.content ||
                                      (item.tool_use
                                        ? `\`\`\`json\n${JSON.stringify(item.tool_use, null, 2)}\n\`\`\``
                                        : '')
                                    }
                                    empty="Empty"
                                    onLink={handleLink}
                                  />
                                  {(item.result?.truncated ||
                                    (item.blocks &&
                                      item.blocks.some((b) => b.truncated))) && (
                                    <div className="mt-2 text-[11px] text-muted-foreground bg-background/50 p-2 rounded">
                                      Output truncated.{' '}
                                      <button
                                        onClick={() =>
                                          fetchFull(
                                            item.id,
                                            item.tool_use?.id ||
                                              item.blocks?.[0]?.tool_use_id
                                          )
                                        }
                                        className="underline hover:text-foreground"
                                      >
                                        Show full output
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    </div>
                  ) : msg.role === 'reasoning' ? (
                    <div>
                      {msg.content ? (
                        <details>
                          <summary className="cursor-pointer font-semibold text-[11px] opacity-70 text-muted-foreground/80">
                            Thinking
                          </summary>
                          <div className="text-[13px] italic opacity-80 break-words mt-1 pl-2 border-l border-border/50">
                            <ChatMarkdown
                              text={msg.content}
                              empty="Empty"
                              onLink={handleLink}
                            />
                          </div>
                        </details>
                      ) : (
                        <div className="font-semibold text-[11px] opacity-70 text-muted-foreground/80">
                          Thought
                        </div>
                      )}
                    </div>
                  ) : msg.role === 'assistant' ? (
                    <div>
                      <div className="font-semibold text-[11px] mb-1 opacity-70">
                        Assistant
                      </div>
                      <div className="text-[13px] break-words">
                        <ChatMarkdown
                          text={msg.content}
                          empty="Empty"
                          onLink={handleLink}
                        />
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="font-semibold text-[11px] mb-1 opacity-70">
                        {msg.role === 'user'
                          ? msg.orphan
                            ? 'Orphan Result'
                            : 'You'
                          : msg.role}
                      </div>
                      <div className="text-[13px] break-words">
                        <ChatMarkdown
                          text={msg.content}
                          empty="Empty"
                          onLink={handleLink}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {currentSession?.state === 'working' && (
          <div className="flex flex-col mt-4 mb-4 items-start relative z-10">
            <div className="max-w-[80%] rounded-lg p-3 bg-muted text-[13px] text-muted-foreground flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              Working...
            </div>
          </div>
        )}
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
