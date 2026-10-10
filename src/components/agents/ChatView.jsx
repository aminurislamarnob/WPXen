import { useState, useEffect, useRef, useId, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { pinnedIndexes, shouldStickToBottom } from '../../lib/chatList';
import { foldToolRuns, runNeedsAttention } from '../../lib/chatRows';
import { useMemo } from 'react';
import { useAgentSessions, useSelectedSession } from '../../lib/useAgentSessions';
import DiffView from '../DiffView';

import { ChatMarkdown } from './ChatMarkdown';
import { QuestionCard } from './QuestionCard';
import { buildAskAnswerKeys } from '../../lib/agentAsk';
import { SubagentRow } from './SubagentRow';
import { WaitingFallback } from './WaitingFallback';
import * as sessionCache from '../../lib/terminal/sessionCache';
import { ImageRef } from './ImageRef';
import { contextMeter } from '../../lib/contextMeter';
import {
  setViewMode,
  setReturnToChat,
  isEndedSession,
  canResumeSession,
} from '../../lib/chatView';
import { useChatDraft } from '../../lib/chatDraft';
import { shouldShowWaitingFallback } from '../../lib/chatRows';
import { recallStep, matchFiles, matchCommands } from '../../lib/chatComplete';
import { isImageDropPath } from '../../lib/terminal/keys';

export function ChatView({ sessionId, onRestart, onResume, headerActions }) {
  const viewerId = useId();
  const rootRef = useRef(null);
  const [messages, setMessages] = useState([]);
  const [nestedMessages, setNestedMessages] = useState({});
  const [draft, setDraft, clearDraft] = useChatDraft(sessionId);
  const input = draft.text;
  const setInput = (text) => setDraft({ ...draft, text });
  const attachments = useMemo(() => draft.images || [], [draft.images]);
  const setAttachments = (images) => setDraft({ ...draft, images });
  const clearInput = clearDraft;
  const [atStart, setAtStart] = useState(false);
  const [staleNotice, setStaleNotice] = useState(false);
  const [headerTitle, setHeaderTitle] = useState('');
  const [chatState, setChatState] = useState({});
  const sessions = useAgentSessions();
  const selectedSessionId = useSelectedSession();
  // Session rows are keyed `sessionId`; there is no `id`.
  const currentSession = sessions.find((s) => s.sessionId === sessionId);
  const isWorking = currentSession?.state === 'working';

  // Per-Agent model table for the picker. Hidden when the Agent has none.
  // The whole entry is kept: the exit bar also needs its resume flag.
  const [chatAgent, setChatAgent] = useState(null);
  const agentModels = chatAgent?.models?.length ? chatAgent.models : null;
  useEffect(() => {
    let cancelled = false;
    const agentId = currentSession?.agentId;
    if (!agentId) {
      setChatAgent(null);
      return;
    }
    window.electronAPI
      .listAgents()
      .then((list) => {
        if (cancelled) return;
        setChatAgent((list || []).find((a) => a.id === agentId) || null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentSession?.agentId]);

  // After the Agent exits the history stays, but the composer gives way to
  // an exit bar. Resume needs the pinned transcript and a resume-capable
  // Agent — and only shows once the old Session has ended, since two live
  // Sessions must never drive one conversation.
  const isEnded = isEndedSession(currentSession);
  const showResume = canResumeSession(currentSession, chatAgent);

  // The current model is the latest assistant record's model, matched
  // against the table's aliases by substring (the record holds a full id).
  const currentModelId = (() => {
    const model = chatState?.usage?.model;
    if (!model || !agentModels) return '';
    const found = agentModels.find((m) =>
      String(model).toLowerCase().includes(m.id.toLowerCase())
    );
    return found ? found.id : '';
  })();

  // Track auto-scroll state
  const scrollRef = useRef(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [showLatestPill, setShowLatestPill] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);

  const foldedMessages = useMemo(() => foldToolRuns(messages), [messages]);

  const [fallbackSnapshot, setFallbackSnapshot] = useState('');
  const needsFallback = shouldShowWaitingFallback(currentSession?.state, foldedMessages, {
    cards: !!currentSession?.ask,
  });

  const history = useMemo(() => {
    const arr = [];
    const reversed = [...messages].reverse();
    for (const msg of reversed) {
      if (msg.role === 'user' && msg.content && typeof msg.content === 'string') {
        const text = msg.content.trim();
        if (text && arr[arr.length - 1] !== text) {
          arr.push(text);
        }
      }
    }
    return arr;
  }, [messages]);
  const [recallIndex, setRecallIndex] = useState(-1);
  const [siteFiles, setSiteFiles] = useState([]);
  const [siteCommands, setSiteCommands] = useState([]);

  useEffect(() => {
    if (currentSession?.siteId) {
      window.electronAPI
        .chatFiles(currentSession.siteId)
        .then(setSiteFiles)
        .catch(() => {});
      window.electronAPI
        .chatCommands(currentSession.siteId)
        .then(setSiteCommands)
        .catch(() => {});
    }
  }, [currentSession?.siteId]);

  const [mentionState, setMentionState] = useState(null);
  const mentionMatches = useMemo(() => {
    if (!mentionState) return [];
    if (mentionState.type === 'file')
      return matchFiles(mentionState.query, siteFiles, 50);
    return matchCommands(mentionState.query, siteCommands, 50);
  }, [mentionState, siteFiles, siteCommands]);

  const [mentionSelected, setMentionSelected] = useState(0);
  useEffect(() => setMentionSelected(0), [mentionState?.query]);

  useEffect(() => {
    let active = true;
    if (needsFallback) {
      window.electronAPI.chatSnapshot(sessionId, 15).then((snap) => {
        if (active) setFallbackSnapshot(snap);
      });
    } else {
      setFallbackSnapshot('');
    }
    return () => {
      active = false;
    };
  }, [needsFallback, sessionId, currentSession?.state]);

  const handleSwitchToTerminal = useCallback(() => {
    setViewMode(sessionId, 'terminal');
    setReturnToChat(sessionId, true);
    // The xterm is un-hidden on the next render; focus it once it's visible.
    requestAnimationFrame(() => sessionCache.focus(sessionId));
  }, [sessionId]);

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
      ({ sessionId: rowSessionId, rows, header, state }) => {
        if (rowSessionId !== sessionId) return;

        if (header?.title) setHeaderTitle(header.title);
        if (state) setChatState(state);

        let newNestedMessages = null;

        setMessages((prev) => {
          let next = [...prev];
          let changed = false;

          for (const row of rows) {
            if (row.parentId) {
              if (!newNestedMessages) newNestedMessages = {};
              if (!newNestedMessages[row.parentId]) newNestedMessages[row.parentId] = [];

              const list = newNestedMessages[row.parentId];

              if (row.reset) {
                // wait, subagent reset is not supported or needed usually, but if it happens:
                list.length = 0;
              } else if (row.remove) {
                // remove from nested list - we'd need to modify the actual state later
              } else if (row.id) {
                list.push(row);
              }
              continue;
            }

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

        if (newNestedMessages) {
          setNestedMessages((prevNested) => {
            let nextNested = { ...prevNested };
            let nestedChanged = false;
            for (const [parentId, newRows] of Object.entries(newNestedMessages)) {
              let list = nextNested[parentId] ? [...nextNested[parentId]] : [];
              let listChanged = false;

              for (const row of newRows) {
                if (row.reset) {
                  list = [];
                  listChanged = true;
                } else if (row.remove) {
                  list = list.filter((m) => !row.remove.includes(m.id));
                  listChanged = true;
                } else if (row.id) {
                  const idx = list.findIndex((m) => m.id === row.id);
                  if (idx >= 0) {
                    list[idx] = row;
                  } else {
                    list.push(row);
                  }
                  listChanged = true;
                }
              }
              if (listChanged) {
                nextNested[parentId] = list;
                nestedChanged = true;
              }
            }
            return nestedChanged ? nextNested : prevNested;
          });
        }
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
  }, [messages.length, foldedMessages.length, stickToBottom, virtualizer]);

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

  const handleStop = useCallback(() => {
    if (currentSession?.state !== 'working') return;
    window.electronAPI.chatStop(sessionId);
  }, [sessionId, currentSession?.state]);

  const doSend = useCallback(() => {
    if (!input.trim()) return;
    window.electronAPI.chatSend(sessionId, input, attachments);
    clearInput();
    // Force stick to bottom when user sends a message
    setStickToBottom(true);
    setShowLatestPill(false);
  }, [sessionId, input, attachments, clearInput]);

  // ⌘. from the terminal: every Cmd chord bubbles out of the xterm, and
  // nothing in the app menu binds ⌘. Scoped to the focused pane via the
  // selected Session; the composer's own keydown covers focus inside here.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey && !e.ctrlKey && !e.altKey && e.key === '.')) return;
      if (selectedSessionId !== sessionId) return;
      if (rootRef.current?.contains(document.activeElement)) return;
      if (currentSession?.state !== 'working') return;
      e.preventDefault();
      window.electronAPI.chatStop(sessionId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessionId, selectedSessionId, currentSession?.state]);

  const handleModelChange = useCallback(
    (modelId) => {
      if (!modelId) return;
      window.electronAPI.chatModel(sessionId, modelId);
    },
    [sessionId]
  );

  const handlePaste = async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const newAttachments = [];
    for (const item of items) {
      if (item.type.indexOf('image/') === 0) {
        const file = item.getAsFile();
        if (file) {
          const buffer = await file.arrayBuffer();
          const path = await window.electronAPI.chatSaveImage(buffer);
          newAttachments.push(path);
        }
      }
    }
    if (newAttachments.length > 0) {
      e.preventDefault();
      setAttachments([...attachments, ...newAttachments]);
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    const newAttachments = [];
    if (files.length > 0) {
      const paths = files.map((f) => window.electronAPI.pathForFile(f)).filter(Boolean);
      for (const p of paths) {
        if (isImageDropPath(p)) newAttachments.push(p);
      }
    }
    if (newAttachments.length > 0) {
      setAttachments([...attachments, ...newAttachments]);
    }
  };

  const handleKeyDown = (e) => {
    // ⌘. interrupts while working. Focus is in the composer, not the xterm,
    // so the chat view handles its own chord; the window listener covers the
    // terminal-focused case.
    if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === '.') {
      e.preventDefault();
      handleStop();
      return;
    }
    if (mentionState) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionState(null);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionSelected((s) => Math.min(s + 1, mentionMatches.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionSelected((s) => Math.max(s - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const match = mentionMatches[mentionSelected];
        if (match) {
          const val = mentionState.type === 'file' ? match : match.name;
          const before = input.substring(0, mentionState.start);
          const after = input.substring(mentionState.start + mentionState.query.length);
          setInput(before + val + ' ' + after);
          setMentionState(null);
        }
        return;
      }
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const caret = e.target.selectionStart;
      const isFirstLine = !input.substring(0, caret).includes('\n');
      if (e.key === 'ArrowUp' && !isFirstLine) return;

      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const { index: nextIdx, text } = recallStep(history, recallIndex, dir);
      if (nextIdx !== recallIndex) {
        e.preventDefault();
        setRecallIndex(nextIdx);
        if (text !== null) setInput(text);
        else clearInput();
        setRecallIndex(-1);
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
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
    <div
      ref={rootRef}
      className="flex flex-col h-full bg-background text-foreground relative"
    >
      {(headerTitle || headerActions) && (
        <div className="px-4 py-1 border-b border-border bg-tertiary text-[13px] font-medium flex-none flex items-center gap-3">
          <span className="flex-1 truncate">{headerTitle}</span>
          {contextMeter(chatState?.usage) && (
            <span className="text-muted-foreground font-normal">
              {contextMeter(chatState.usage).label}
            </span>
          )}
          {headerActions}
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
                      <details className="text-[13px]" open={runNeedsAttention(msg)}>
                        <summary className="cursor-pointer font-medium">
                          {msg.summary}
                        </summary>
                        <div className="mt-2 pl-2 border-l border-border/50 flex flex-col gap-2">
                          {msg.items.map((item) => (
                            <div
                              key={item.id}
                              className="text-[12px] bg-background/30 p-2 rounded"
                            >
                              {item.subagent ? (
                                <SubagentRow
                                  item={item}
                                  nestedMessages={nestedMessages[item.tool_use?.id]}
                                  sessionId={sessionId}
                                />
                              ) : item.edit ? (
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
                                  {(() => {
                                    // Only Agents with a key map get a card;
                                    // otherwise it stays a plain tool row.
                                    if (
                                      item.tool_use?.name === 'AskUserQuestion' &&
                                      currentSession?.ask
                                    ) {
                                      return (
                                        <QuestionCard
                                          sessionId={sessionId}
                                          toolUseId={item.tool_use.id}
                                          prompt={item.tool_use.input}
                                          recorded={item.result?.answers}
                                          onSubmit={(selections) =>
                                            window.electronAPI.chatAnswer(
                                              sessionId,
                                              buildAskAnswerKeys(
                                                item.tool_use.input,
                                                selections,
                                                currentSession.ask
                                              )
                                            )
                                          }
                                        />
                                      );
                                    }

                                    const taskState = item.taskId
                                      ? chatState?.tasks?.[item.taskId]
                                      : null;
                                    if (!taskState) return null;
                                    return (
                                      <div className="mb-2 flex items-center gap-2 text-[11px]">
                                        <span
                                          className={`px-1.5 py-0.5 rounded font-medium ${taskState.status === 'running' ? 'bg-highlight/15 text-highlight' : 'bg-muted text-muted-foreground'}`}
                                        >
                                          {taskState.status}
                                        </span>
                                        <code
                                          className="font-mono bg-background/50 px-1 rounded truncate flex-1"
                                          title={taskState.command}
                                        >
                                          {taskState.command}
                                        </code>
                                      </div>
                                    );
                                  })()}
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
                                  <ImageList
                                    sessionId={sessionId}
                                    images={item.result?.images}
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
                        {msg.content && (
                          <ChatMarkdown text={msg.content} empty="" onLink={handleLink} />
                        )}
                        <ImageList sessionId={sessionId} images={msg.images} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {needsFallback && (
          <div className="flex flex-col mt-4 mb-4 items-stretch relative z-10">
            <WaitingFallback
              snapshot={fallbackSnapshot}
              onSwitch={handleSwitchToTerminal}
            />
          </div>
        )}

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

      <div className="flex flex-col border-t border-border bg-background z-20">
        {chatState?.tasks &&
          Object.values(chatState.tasks).some((t) => t.status === 'running') && (
            <div className="px-4 py-2 border-b border-border bg-muted/20">
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-highlight/10 text-highlight">
                {backgroundTasksLabel(chatState.tasks)}
              </span>
            </div>
          )}

        {chatState?.todos && chatState.todos.length > 0 && (
          <details className="px-4 py-2 border-b border-border bg-muted/10 text-[12px] group">
            <summary className="cursor-pointer font-medium opacity-80 hover:opacity-100 select-none outline-none">
              To-do list ({chatState.todos.filter((t) => t.status === 'completed').length}
              /{chatState.todos.length})
            </summary>
            <div className="mt-2 flex flex-col gap-1 max-h-[150px] overflow-y-auto">
              {chatState.todos.map((todo, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <div className="mt-0.5 flex-none">
                    {todo.status === 'completed' ? '☑' : '☐'}
                  </div>
                  <div
                    className={`flex-1 ${todo.status === 'completed' ? 'line-through opacity-50' : ''}`}
                  >
                    {todo.content}
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}

        {isEnded ? (
          <div className="p-4 border-t border-border bg-background z-20">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] text-muted-foreground">
                Session ended — history stays readable above.
              </span>
              <div className="flex gap-2">
                {onRestart && (
                  <button className="btn btn-secondary" onClick={() => onRestart()}>
                    Respawn
                  </button>
                )}
                {showResume && onResume && (
                  <button className="btn btn-primary" onClick={() => onResume()}>
                    Resume in new Session
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 flex flex-col gap-2">
            {mentionState && mentionMatches.length > 0 && (
              <div className="absolute bottom-full mb-1 left-4 max-h-[200px] overflow-y-auto bg-popover text-popover-foreground border shadow-lg rounded-md z-50 text-[13px] min-w-[250px]">
                {mentionMatches.map((m, i) => (
                  <div
                    key={mentionState.type === 'file' ? m : m.name}
                    className={`px-3 py-1.5 cursor-pointer flex justify-between gap-4 ${i === mentionSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      const val = mentionState.type === 'file' ? m : m.name;
                      const before = input.substring(0, mentionState.start);
                      const after = input.substring(
                        mentionState.start + mentionState.query.length
                      );
                      setInput(before + val + ' ' + after);
                      setMentionState(null);
                    }}
                  >
                    <span className="truncate">
                      {mentionState.type === 'file' ? m : m.name}
                    </span>
                    {mentionState.type === 'cmd' && (
                      <span className="opacity-50 text-xs shrink-0">{m.description}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {attachments.map((path, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1 bg-muted px-2 py-1 rounded text-[11px] max-w-[200px]"
                  >
                    <span className="truncate flex-1">{path.split(/[\\/]/).pop()}</span>
                    <button
                      onClick={() =>
                        setAttachments(attachments.filter((_, idx) => idx !== i))
                      }
                      className="hover:text-destructive shrink-0"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              className="w-full bg-background border border-input rounded-md px-3 py-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring resize-y min-h-[60px]"
              placeholder="Message..."
              value={input}
              onChange={(e) => {
                const val = e.target.value;
                setInput(val);
                setRecallIndex(-1);

                const caret = e.target.selectionStart;
                const textBeforeCaret = val.substring(0, caret);
                const match = textBeforeCaret.match(/(?:^|\s)([@/])(\S*)$/);
                if (match) {
                  setMentionState({
                    type: match[1] === '@' ? 'file' : 'cmd',
                    query: match[2],
                    start: caret - match[2].length,
                  });
                } else {
                  setMentionState(null);
                }
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
            />
            <div className="flex items-center justify-between gap-2">
              {agentModels ? (
                <select
                  aria-label="Model"
                  value={currentModelId}
                  onChange={(e) => handleModelChange(e.target.value)}
                  className="bg-background border border-input rounded-md px-2 py-1.5 text-[12px] text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring max-w-[160px]"
                >
                  {currentModelId === '' && <option value="">Model</option>}
                  {agentModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span />
              )}
              {isWorking ? (
                <button onClick={handleStop} className="btn btn-danger">
                  Stop
                </button>
              ) : (
                <button
                  onClick={doSend}
                  disabled={!input.trim()}
                  className="btn btn-primary disabled:opacity-50"
                >
                  Send
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function backgroundTasksLabel(tasks) {
  const n = Object.values(tasks).filter((t) => t.status === 'running').length;
  return `${n} background task${n === 1 ? '' : 's'} running`;
}

function ImageList({ sessionId, images }) {
  if (!images?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((ref) => (
        <ImageRef
          key={`${ref.uuid}-${ref.path.join('.')}`}
          sessionId={sessionId}
          refData={ref}
        />
      ))}
    </div>
  );
}
