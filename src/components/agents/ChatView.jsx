import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useId,
  useCallback,
  useMemo,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { pinnedIndexes, shouldStickToBottom } from '../../lib/chatList';
import {
  foldToolRuns,
  partitionChatRows,
  prependOlder,
  shouldShowWaitingFallback,
  upsertRows,
} from '../../lib/chatRows';
import { useAgentSessions, useSelectedSession } from '../../lib/useAgentSessions';
import { Button } from '../ui';
import { ChatItem } from './ChatItems';
import { WaitingFallback } from './WaitingFallback';
import * as sessionCache from '../../lib/terminal/sessionCache';
import { contextMeter } from '../../lib/contextMeter';
import {
  setViewMode,
  setReturnToChat,
  isEndedSession,
  canResumeSession,
} from '../../lib/chatView';
import { useChatDraft } from '../../lib/chatDraft';
import {
  applyCompletion,
  completionTrigger,
  matchCommands,
  matchFiles,
  recallKey,
  recallStep,
} from '../../lib/chatComplete';
import { imagePastePath, isImageDropPath } from '../../lib/terminal/keys';
import { useOpenLink } from '../../lib/useOpenLink';

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
  const [atStart, setAtStart] = useState(false);
  const [staleNotice, setStaleNotice] = useState(false);
  const [headerTitle, setHeaderTitle] = useState('');
  const [chatState, setChatState] = useState({});
  const sessions = useAgentSessions();
  const selectedSessionId = useSelectedSession();
  // Session rows are keyed `sessionId`; there is no `id`.
  const currentSession = sessions.find((s) => s.sessionId === sessionId);
  const isWorking = currentSession?.state === 'working';
  const openLink = useOpenLink();
  const siteId = currentSession?.siteId;
  // Links follow Settings → General → Open links in, like every other link.
  const handleLink = useCallback((url) => openLink(url, siteId), [openLink, siteId]);

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

  // Autoscroll. Whether to follow new rows is decided from the scroll
  // position before they render; a ref, so the row subscription never has
  // to be torn down (and the transcript re-read) when it changes.
  const scrollRef = useRef(null);
  const stickRef = useRef(true);
  const [showLatestPill, setShowLatestPill] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  // Scroll position to restore once an older page has rendered above.
  const anchorRef = useRef(null);

  const foldedMessages = useMemo(() => foldToolRuns(messages), [messages]);

  const [fallbackSnapshot, setFallbackSnapshot] = useState('');
  const needsFallback = shouldShowWaitingFallback(currentSession?.state, foldedMessages, {
    cards: !!currentSession?.ask,
  });

  const history = useMemo(() => {
    const arr = [];
    const reversed = [...messages].reverse();
    for (const msg of reversed) {
      if (msg.role === 'user' && !msg.orphan && typeof msg.content === 'string') {
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
    if (siteId) {
      window.electronAPI
        .chatFiles(siteId)
        .then(setSiteFiles)
        .catch(() => {});
      window.electronAPI
        .chatCommands(siteId)
        .then(setSiteCommands)
        .catch(() => {});
    }
  }, [siteId]);

  const [completion, setCompletion] = useState(null);
  const completionMatches = useMemo(() => {
    if (!completion) return [];
    if (completion.type === 'file') return matchFiles(completion.query, siteFiles, 50);
    return matchCommands(completion.query, siteCommands, 50);
  }, [completion, siteFiles, siteCommands]);

  const [completionSelected, setCompletionSelected] = useState(0);
  useEffect(() => setCompletionSelected(0), [completion?.query, completion?.type]);

  useEffect(() => {
    let active = true;
    if (needsFallback) {
      window.electronAPI
        .chatSnapshot(sessionId, 15)
        .then((snap) => {
          if (active) setFallbackSnapshot(snap);
        })
        .catch(() => {});
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

  const virtualizer = useVirtualizer({
    count: foldedMessages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    rangeExtractor: (range) => pinnedIndexes(range, { count: foldedMessages.length }),
  });

  // "Load older" pages backwards; the rows already on screen stay where they
  // are, so the reader isn't thrown to the top of the new page.
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setIsLoadingOlder(true);
    try {
      const res = await window.electronAPI.chatLoadOlder(sessionId);
      if (!res) return;
      setAtStart(!!res.atStart);
      if (res.rows?.length) {
        const el = scrollRef.current;
        if (el) anchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
        setMessages((prev) => prependOlder(prev, res.rows));
      }
    } catch {
      // the next click tries again
    } finally {
      loadingOlderRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [sessionId]);

  const loadOlderNested = useCallback(
    async (parentId) => {
      const res = await window.electronAPI
        .chatLoadOlderSubagent(sessionId, parentId)
        .catch(() => null);
      if (res?.rows?.length) {
        setNestedMessages((prev) => ({
          ...prev,
          [parentId]: prependOlder(prev[parentId] || [], res.rows),
        }));
      }
      return res;
    },
    [sessionId]
  );

  useEffect(() => {
    const api = window.electronAPI;
    const unsub = api.on('agent-chat-rows', (push) => {
      if (push.sessionId !== sessionId) return;
      const { rows, header, state } = push;
      if (header?.title) setHeaderTitle(header.title);
      if (state) setChatState(state);
      if (typeof push.atStart === 'boolean') setAtStart(push.atStart);

      // Split first, then apply: the nested rows must not depend on when
      // React runs a state updater.
      const { reset, stale, top, nested } = partitionChatRows(rows);
      if (reset) {
        setAtStart(false);
        setStaleNotice(false);
      }
      if (stale) setStaleNotice(true);
      if (reset || top.length > 0) {
        setMessages((prev) => upsertRows(reset ? [] : prev, top));
        if (!stickRef.current && top.length > 0) setShowLatestPill(true);
      }
      const parents = Object.keys(nested);
      if (parents.length > 0) {
        setNestedMessages((prev) => {
          let next = prev;
          for (const parentId of parents) {
            const before = prev[parentId] || [];
            const after = upsertRows(before, nested[parentId]);
            if (after !== before || !prev[parentId])
              next = { ...next, [parentId]: after };
          }
          return next;
        });
      }
    });

    api.chatOpen(sessionId, viewerId);
    return () => {
      api.chatClose(sessionId, viewerId);
      unsub();
    };
  }, [sessionId, viewerId]);

  // Keep the older page's arrival from moving what the reader is looking at.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const el = scrollRef.current;
    if (!anchor || !el) return;
    anchorRef.current = null;
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
  }, [messages]);

  // Follow new and growing rows while the reader is at the bottom.
  useEffect(() => {
    if (stickRef.current && foldedMessages.length > 0 && !anchorRef.current) {
      virtualizer.scrollToIndex(foldedMessages.length - 1, { align: 'end' });
      setShowLatestPill(false);
    }
  }, [messages, foldedMessages.length, virtualizer]);

  const onScroll = useCallback((e) => {
    const el = e.target;
    const isAtBottom = shouldStickToBottom({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    stickRef.current = isAtBottom;
    if (isAtBottom) setShowLatestPill(false);
  }, []);

  const jumpToLatest = useCallback(() => {
    stickRef.current = true;
    if (foldedMessages.length > 0) {
      virtualizer.scrollToIndex(foldedMessages.length - 1, { align: 'end' });
    }
    setShowLatestPill(false);
  }, [foldedMessages.length, virtualizer]);

  const handleStop = useCallback(() => {
    if (currentSession?.state !== 'working') return;
    window.electronAPI.chatStop(sessionId).catch(() => {});
  }, [sessionId, currentSession?.state]);

  const doSend = useCallback(() => {
    if (!input.trim() && attachments.length === 0) return;
    // Each attachment goes into the TUI as a paste frame; a dropped path with
    // spaces is escaped the way a terminal drop escapes it, or Codex splits it.
    const images = attachments.map(imagePastePath);
    window.electronAPI.chatSend(sessionId, input, images).catch(() => {});
    clearDraft();
    setRecallIndex(-1);
    setCompletion(null);
    // Sending is a request to see the answer: follow the bottom again.
    stickRef.current = true;
    setShowLatestPill(false);
  }, [sessionId, input, attachments, clearDraft]);

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
      window.electronAPI.chatStop(sessionId).catch(() => {});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessionId, selectedSessionId, currentSession?.state]);

  const handleModelChange = useCallback(
    (modelId) => {
      if (!modelId) return;
      window.electronAPI.chatModel(sessionId, modelId).catch(() => {});
    },
    [sessionId]
  );

  const handlePaste = async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const images = [...items].filter((item) => item.type.startsWith('image/'));
    if (images.length === 0) return;
    e.preventDefault();
    const paths = [];
    for (const item of images) {
      const file = item.getAsFile();
      if (!file) continue;
      try {
        paths.push(await window.electronAPI.chatSaveImage(await file.arrayBuffer()));
      } catch {
        // an unsaved image is just not attached
      }
    }
    if (paths.length > 0) setAttachments([...attachments, ...paths]);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const paths = [...e.dataTransfer.files]
      .map((f) => window.electronAPI.pathForFile(f))
      .filter((p) => p && isImageDropPath(p));
    if (paths.length > 0) setAttachments([...attachments, ...paths]);
  };

  const insertCompletion = (match) => {
    if (!completion || !match) return;
    const value = completion.type === 'file' ? match : match.name;
    setInput(applyCompletion(input, completion, value));
    setCompletion(null);
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
    if (e.nativeEvent?.isComposing) return;
    // The completion list takes the keys only while it shows something;
    // otherwise Enter still sends.
    if (completion && e.key === 'Escape') {
      e.preventDefault();
      setCompletion(null);
      return;
    }
    if (completion && completionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCompletionSelected((s) => Math.min(s + 1, completionMatches.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCompletionSelected((s) => Math.max(s - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertCompletion(completionMatches[completionSelected]);
        return;
      }
    }
    if (
      (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
      recallKey({
        key: e.key,
        text: input,
        caret: e.target.selectionStart,
        recalling: recallIndex >= 0,
      })
    ) {
      const { index, text } = recallStep(
        history,
        recallIndex,
        e.key === 'ArrowUp' ? 1 : -1
      );
      if (index !== recallIndex) {
        e.preventDefault();
        setRecallIndex(index);
        setInput(text ?? '');
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  const fetchFull = useCallback(
    async (msgId, toolUseId) => {
      const content = await window.electronAPI
        .chatFetchFull(sessionId, toolUseId)
        .catch(() => null);
      if (!content) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== msgId) return m;
          const next = { ...m };
          if (next.role === 'tool' && next.result?.tool_use_id === toolUseId) {
            next.result = { ...next.result, content, truncated: false };
          } else if (next.blocks) {
            next.blocks = next.blocks.map((b) =>
              b.type === 'tool_result' && b.tool_use_id === toolUseId
                ? { ...b, content, truncated: false }
                : b
            );
          }
          return next;
        })
      );
    },
    [sessionId]
  );

  const ctx = useMemo(
    () => ({
      sessionId,
      ask: currentSession?.ask || null,
      tasks: chatState?.tasks,
      nested: nestedMessages,
      onLink: handleLink,
      onFetchFull: fetchFull,
      loadOlderNested,
    }),
    [
      sessionId,
      currentSession?.ask,
      chatState?.tasks,
      nestedMessages,
      handleLink,
      fetchFull,
      loadOlderNested,
    ]
  );

  const meter = contextMeter(chatState?.usage);

  return (
    <div
      ref={rootRef}
      className="flex flex-col h-full bg-background text-foreground relative"
    >
      {(headerTitle || headerActions || meter) && (
        <div className="px-4 py-1 border-b border-border bg-tertiary text-[13px] font-medium flex-none flex items-center gap-3">
          <span className="flex-1 truncate">{headerTitle}</span>
          {meter && (
            <span className="text-muted-foreground font-normal">{meter.label}</span>
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
        {!atStart && foldedMessages.length > 0 && (
          <div className="mb-4 flex justify-center">
            <Button variant="ghost" onClick={loadOlder} disabled={isLoadingOlder}>
              {isLoadingOlder ? 'Loading…' : 'Load older'}
            </Button>
          </div>
        )}
        {foldedMessages.length === 0 && !staleNotice && (
          <div className="py-10 text-center text-[13px] text-muted-foreground">
            No messages yet. Send a prompt to start.
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
                className="pb-4"
              >
                <ChatItem msg={msg} ctx={ctx} />
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

        {isWorking && (
          <div className="flex flex-col mt-4 mb-4 items-start relative z-10">
            <div className="max-w-[80%] rounded-lg p-3 bg-muted text-[13px] text-muted-foreground flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              Working…
            </div>
          </div>
        )}
      </div>

      {showLatestPill && (
        <button
          type="button"
          onClick={jumpToLatest}
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
                    className={`flex-1 ${todo.status === 'completed' ? 'line-through opacity-50' : todo.status === 'in_progress' ? 'font-medium' : ''}`}
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
                  <Button variant="secondary" onClick={() => onRestart()}>
                    Respawn
                  </Button>
                )}
                {showResume && onResume && (
                  <Button variant="primary" onClick={() => onResume()}>
                    Resume in new Session
                  </Button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="relative p-4 flex flex-col gap-2">
            {completion && completionMatches.length > 0 && (
              <div className="panel-menu absolute bottom-full left-4 mb-1 max-h-[200px] min-w-[250px] max-w-[calc(100%-2rem)] overflow-y-auto p-1 z-50">
                {completionMatches.map((m, i) => (
                  <div
                    key={completion.type === 'file' ? m : m.name}
                    className={`panel-item cursor-pointer justify-between gap-4 ${i === completionSelected ? 'bg-accent' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      insertCompletion(m);
                    }}
                  >
                    <span className="truncate">
                      {completion.type === 'file' ? m : m.name}
                    </span>
                    {completion.type === 'cmd' && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {m.description}
                      </span>
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
                      type="button"
                      aria-label="Remove image"
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
              placeholder="Message…"
              value={input}
              onChange={(e) => {
                const val = e.target.value;
                setInput(val);
                setRecallIndex(-1);
                setCompletion(completionTrigger(val, e.target.selectionStart));
              }}
              onKeyDown={handleKeyDown}
              onBlur={() => setCompletion(null)}
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
                <Button variant="danger" onClick={handleStop}>
                  Stop
                </Button>
              ) : (
                <Button
                  variant="primary"
                  onClick={doSend}
                  disabled={!input.trim() && attachments.length === 0}
                >
                  Send
                </Button>
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
