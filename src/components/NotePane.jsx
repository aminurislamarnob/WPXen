import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { keymap } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { buildEditorMetrics, editorThemes } from '../lib/editorTheme';
import { editorTypography, onTypographyChange } from '../lib/typography';
import { onThemeChange, themeName } from '../lib/theme';
import { previewLinkTarget, renderNoteHtml } from '../lib/notePreview';

// One markdown note in the Floating Workspace: the app's CodeMirror editor in
// markdown mode, a Source / Preview toggle, and autosave.
//
// Saving is automatic — about a second after typing stops, immediately on ⌘S,
// and when the tab is switched away or closed — so there is never an "unsaved
// changes" prompt. The main process refuses a save if the file changed on disk
// since it was loaded; the conflict bar then offers Reload or Overwrite.
//
// The editor is uncontrolled: `value` is the loaded text and only changes on a
// (re)load, while edits live in refs, so typing never re-renders the document.

const AUTOSAVE_MS = 1000;

const STATUS_LABEL = {
  loading: 'Loading…',
  saved: 'Saved',
  dirty: 'Edited',
  saving: 'Saving…',
};

export default function NotePane({ path, onEdited, onOpenLink }) {
  const [doc, setDoc] = useState(null); // { text } | { error }
  const [mode, setMode] = useState('source');
  const [status, setStatus] = useState('loading'); // + 'conflict' | 'error'
  const [saveError, setSaveError] = useState(null);
  const [previewText, setPreviewText] = useState('');

  const textRef = useRef('');
  const mtimeRef = useRef(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef(null);
  const savingRef = useRef(false);
  const againRef = useRef(false);

  const [appearance, setAppearance] = useState(themeName);
  useEffect(() => onThemeChange(setAppearance), []);
  const [typography, setTypography] = useState(editorTypography);
  useEffect(() => onTypographyChange(() => setTypography(editorTypography())), []);

  const load = useCallback(async () => {
    setStatus('loading');
    setSaveError(null);
    const res = await window.electronAPI.notesRead(path);
    if (res?.error) {
      setDoc({ error: res.error });
      setStatus('error');
      return;
    }
    textRef.current = res.content;
    mtimeRef.current = res.mtimeMs;
    dirtyRef.current = false;
    setPreviewText(res.content);
    setDoc({ text: res.content });
    setStatus('saved');
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);

  // One save at a time: a save requested mid-flight runs once the current one
  // lands, with the mtime it returned — two in parallel would conflict with
  // each other.
  const save = useCallback(
    async ({ force = false } = {}) => {
      clearTimeout(timerRef.current);
      if (!dirtyRef.current && !force) return;
      if (savingRef.current) {
        againRef.current = true;
        return;
      }
      savingRef.current = true;
      const text = textRef.current;
      setStatus('saving');
      const res = await window.electronAPI.notesSave(path, text, mtimeRef.current, {
        force,
      });
      savingRef.current = false;
      if (res?.ok) {
        mtimeRef.current = res.mtimeMs;
        if (textRef.current === text) dirtyRef.current = false;
        setSaveError(null);
        setStatus(dirtyRef.current ? 'dirty' : 'saved');
      } else if (res?.conflict) {
        setStatus('conflict');
        return;
      } else {
        setSaveError(res?.error || 'Could not save this note.');
        setStatus('error');
        return;
      }
      if (againRef.current) {
        againRef.current = false;
        save();
      }
    },
    [path]
  );

  const saveRef = useRef(save);
  saveRef.current = save;

  // Leaving the tab (switching away, closing it) saves what's pending.
  useEffect(
    () => () => {
      if (dirtyRef.current) saveRef.current();
    },
    []
  );

  const onChange = useCallback(
    (text) => {
      textRef.current = text;
      if (!dirtyRef.current) {
        dirtyRef.current = true;
        onEdited?.();
      }
      setStatus((s) => (s === 'conflict' ? s : 'dirty'));
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => saveRef.current(), AUTOSAVE_MS);
    },
    [onEdited]
  );

  const extensions = useMemo(
    () => [
      buildEditorMetrics(typography),
      markdown(),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => (saveRef.current(), true) },
      ]),
    ],
    [typography]
  );

  // The editor unmounts during Preview, so coming back re-seeds it with the
  // latest text rather than what was first loaded.
  const switchMode = (next) => {
    if (next === 'preview') setPreviewText(textRef.current);
    else setDoc((d) => (d && !d.error ? { text: textRef.current } : d));
    setMode(next);
  };

  const html = useMemo(
    () => (mode === 'preview' ? renderNoteHtml(previewText) : ''),
    [mode, previewText]
  );

  // Links in the preview never navigate the app's own window.
  const onPreviewClick = (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const url = previewLinkTarget(a.getAttribute('href'));
    if (url) onOpenLink?.(url);
  };

  const name = path.split('/').pop();

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 h-8 px-2 flex-shrink-0 border-b border-border">
        <span className="truncate text-[12px] text-muted-foreground" title={path}>
          {name}
        </span>
        <span className="text-[11px] text-muted-foreground/70 flex-shrink-0">
          {STATUS_LABEL[status] || ''}
        </span>
        <div className="flex-1" />
        <div
          role="tablist"
          className="inline-flex h-6 items-center rounded-md bg-muted p-[2px]"
        >
          {[
            ['source', 'Source'],
            ['preview', 'Preview'],
          ].map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={mode === value}
              onClick={() => switchMode(value)}
              className={`h-full px-2 rounded-[5px] text-[11.5px] font-medium transition-colors ${
                mode === value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {status === 'conflict' && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] border-b border-border bg-status-warning/10">
          <span className="flex-1 text-foreground">
            This note changed on disk since it was opened. Your edits aren’t saved yet.
          </span>
          <button className="btn btn-secondary !h-6 !px-2 !text-[12px]" onClick={load}>
            Reload
          </button>
          <button
            className="btn btn-secondary !h-6 !px-2 !text-[12px]"
            onClick={() => save({ force: true })}
          >
            Overwrite
          </button>
        </div>
      )}
      {status === 'error' && saveError && (
        <div className="px-3 py-1.5 text-[12px] text-destructive border-b border-border">
          {saveError}
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {doc?.error ? (
          <div className="flex-1 flex items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
            {doc.error}
          </div>
        ) : doc && mode === 'source' ? (
          <CodeMirror
            value={doc.text}
            height="100%"
            theme={editorThemes[appearance]}
            extensions={extensions}
            onChange={onChange}
            autoFocus
            className="flex-1 min-h-0"
            basicSetup={{ tabSize: 2, lineNumbers: false, foldGutter: false }}
          />
        ) : doc ? (
          <div
            className="note-preview flex-1 min-h-0 overflow-y-auto px-6 py-4"
            onClick={onPreviewClick}
            // Sanitised by DOMPurify in renderNoteHtml.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : null}
      </div>
    </div>
  );
}
