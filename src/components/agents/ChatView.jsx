import { useState, useEffect, useRef, useId, useCallback } from 'react';
import { Markdown } from '../tasks/markdown';

export function ChatView({ sessionId }) {
  const viewerId = useId();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const scrollRef = useRef(null);

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
            changed = true;
            continue;
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

        return changed ? next : prev;
      });
    });

    api.chatOpen(sessionId, viewerId);
    return () => {
      api.chatClose(sessionId, viewerId);
      unsub();
    };
  }, [sessionId, viewerId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!input.trim()) return;
      window.electronAPI.chatSend(sessionId, input);
      setInput('');
    }
  };

  const handleLink = useCallback((url) => {
    window.electronAPI.openSiteInBrowser(url);
  }, []);

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      <div className="flex-1 overflow-y-auto p-4 space-y-4" ref={scrollRef}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-lg p-3 ${msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
            >
              <div className="font-semibold text-[11px] mb-1 opacity-70">
                {msg.role === 'user' ? 'You' : 'Assistant'}
              </div>
              <div className="text-[13px]">
                <Markdown text={msg.content} empty="Empty" onLink={handleLink} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="p-4 border-t border-border">
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
