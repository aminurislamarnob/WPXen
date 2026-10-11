import { useState, useRef, useEffect } from 'react';

const DRAFT_PREFIX = 'wpxen.chatDraft.';

export function useChatDraft(sessionId) {
  const [draft, setDraft] = useState(() => {
    try {
      const stored = localStorage.getItem(DRAFT_PREFIX + sessionId);
      if (!stored) return { text: '', images: [] };
      return stored.startsWith('{') ? JSON.parse(stored) : { text: stored, images: [] };
    } catch {
      return { text: '', images: [] };
    }
  });

  const timerRef = useRef(null);

  // When sessionId changes, load its draft
  useEffect(() => {
    try {
      const stored = localStorage.getItem(DRAFT_PREFIX + sessionId);
      if (!stored) setDraft({ text: '', images: [] });
      else
        setDraft(
          stored.startsWith('{') ? JSON.parse(stored) : { text: stored, images: [] }
        );
    } catch {
      setDraft({ text: '', images: [] });
    }
  }, [sessionId]);

  const updateDraft = (val) => {
    setDraft(val);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      try {
        if (val.text || val.images?.length) {
          localStorage.setItem(DRAFT_PREFIX + sessionId, JSON.stringify(val));
        } else {
          localStorage.removeItem(DRAFT_PREFIX + sessionId);
        }
      } catch {
        /* ignore */
      }
    }, 300);
  };

  const clearDraft = () => {
    setDraft({ text: '', images: [] });
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      localStorage.removeItem(DRAFT_PREFIX + sessionId);
    } catch {
      /* ignore */
    }
  };

  return [draft, updateDraft, clearDraft];
}

export function cleanupOrphanedDrafts(activeSessionIds) {
  try {
    const active = new Set(activeSessionIds.map((id) => DRAFT_PREFIX + id));
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(DRAFT_PREFIX) && !active.has(key)) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}
