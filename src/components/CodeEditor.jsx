import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { keymap, EditorView } from '@codemirror/view';
import { buildEditorMetrics, editorThemes } from '../lib/editorTheme';
import { editorTypography, onTypographyChange } from '../lib/typography';
import { onThemeChange, themeName } from '../lib/theme';
import { Copy, ExternalLink, Save, X, RefreshCw } from 'lucide-react';
import { Tooltip } from './ui';
import BrowserPane from './browser/BrowserPane';
import DiffView from './DiffView';
import { languageFor } from '../lib/editorLanguage';

// Load both sides of a diff tab. Original is the pre-change version (HEAD, or
// the index when the file also has staged edits); modified is what the change
// produced. Reads are confined to the repo/site root in the main process.
async function loadDiff(rootPath, entry) {
  const { rel, source, status, hasStagedTwin, path, repoRoot } = entry;
  const gitAt = (rev) => window.electronAPI.gitFileAt(rootPath, repoRoot, rel, rev);

  let original;
  let modified;
  if (source === 'staged') {
    original = await gitAt('HEAD');
    modified = status === 'D' ? { content: '' } : await gitAt('index');
  } else {
    const baseRev = hasStagedTwin ? 'index' : 'HEAD';
    original = status === '?' ? { content: '' } : await gitAt(baseRev);
    modified =
      status === 'D'
        ? { content: '' }
        : await window.electronAPI.readFile(rootPath, path);
  }

  if (original?.error || modified?.error) {
    return { error: original?.error || modified?.error };
  }
  if (original?.binary || modified?.binary) return { binary: true };
  if (original?.tooLarge || modified?.tooLarge) {
    return { tooLarge: true, size: original?.size || modified?.size };
  }
  return {
    diff: { original: original?.content ?? '', modified: modified?.content ?? '' },
  };
}

// Editable, syntax-highlighted code editor (CodeMirror 6). Renders the active
// tab only — the tab strip belongs to the parent, which shows these tabs in
// the same strip as its terminal Sessions. Handles three tab kinds: 'file' (editable, dirty tracking + save), 'diff' (a
// read-only unified diff against a git revision), and 'browser' (an in-app
// <webview> preview, which renders its own chrome). Tabs are keyed by `key`
// (a path for files, `diff:<source>:<rel>` for diffs, `browser:<n>` for
// browsers) so a file and its diff can be open at once. `files` is the open-tab
// list owned by the parent; `activeKey` may be null while the parent shows
// something else, which keeps unsaved edits here without rendering a page.
// `onDirtyChange` reports the keys with unsaved edits, for the parent's tab
// dots and close confirmation.
export default function CodeEditor({
  rootPath,
  files,
  activeKey,
  onClose,
  onDirtyChange,
  browserState,
  onBrowserStateChange,
}) {
  // key -> { text, original } | { diff } | { binary } | { tooLarge } | { error }
  const [cache, setCache] = useState({});
  const [saving, setSaving] = useState(false);
  // The editor palette is derived from the app tokens, so it has to follow the
  // macOS appearance the same way the CSS does.
  const [appearance, setAppearance] = useState(themeName);
  useEffect(() => onThemeChange(setAppearance), []);
  const theme = editorThemes[appearance];

  // Font family/size/spacing come from Settings → Appearance and can change
  // while the editor is open, so the metrics extension is rebuilt on each one.
  const [typography, setTypography] = useState(editorTypography);
  useEffect(() => onTypographyChange(() => setTypography(editorTypography())), []);

  const viewRef = useRef(null);

  const active = files.find((f) => f.key === activeKey) || null;
  const data = activeKey ? cache[activeKey] : null;
  const isDiff = active?.kind === 'diff';

  // Jump to a requested line (from a terminal file-path link) once the editor
  // and its content exist. Re-runs when the tab is re-opened at a new line.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || isDiff || !active?.line || data?.text === undefined) return;
    const lineNo = Math.min(Math.max(1, active.line), view.state.doc.lines);
    const pos = view.state.doc.line(lineNo).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    view.focus();
  }, [activeKey, active?.line, isDiff, data?.text]);
  const editable = !isDiff && !!data && data.text !== undefined;
  const dirty = editable && data.text !== data.original;

  // Load the active tab's contents on first open. Browser tabs have no file
  // behind them — they load themselves.
  useEffect(() => {
    if (!activeKey || cache[activeKey]) return;
    const entry = files.find((f) => f.key === activeKey);
    if (!entry || entry.kind === 'browser') return;
    let cancelled = false;
    (async () => {
      let normalized;
      if (entry.kind === 'diff') {
        normalized = await loadDiff(rootPath, entry);
      } else {
        const res = await window.electronAPI.readFile(rootPath, entry.path);
        normalized =
          res?.content !== undefined ? { text: res.content, original: res.content } : res;
      }
      if (cancelled) return;
      setCache((prev) => ({ ...prev, [activeKey]: normalized }));
    })();
    return () => {
      cancelled = true;
    };
  }, [activeKey, rootPath, cache, files]);

  const onChange = useCallback(
    (value) => {
      setCache((prev) => {
        const cur = prev[activeKey];
        if (!cur || cur.text === undefined) return prev;
        return { ...prev, [activeKey]: { ...cur, text: value } };
      });
    },
    [activeKey]
  );

  const save = useCallback(async () => {
    if (!active || active.kind === 'diff') return;
    const cur = cache[activeKey];
    if (!cur || cur.text === undefined || cur.text === cur.original) return;
    setSaving(true);
    const res = await window.electronAPI.writeFile(rootPath, active.path, cur.text);
    setSaving(false);
    if (res?.error) {
      setCache((prev) => ({
        ...prev,
        [activeKey]: { ...prev[activeKey], error: res.error },
      }));
      return;
    }
    setCache((prev) => {
      const c = prev[activeKey];
      return { ...prev, [activeKey]: { ...c, original: c.text, error: undefined } };
    });
  }, [active, activeKey, rootPath, cache]);

  // Keep a stable ref so the Mod-s keymap always calls the latest save().
  const saveRef = useRef(save);
  saveRef.current = save;

  // Re-fetch the active tab (drops its cache entry so the load effect reruns).
  // Used to refresh a diff after an agent edits the file out-of-band.
  const reloadActive = useCallback(() => {
    if (!activeKey) return;
    setCache((prev) => {
      const next = { ...prev };
      delete next[activeKey];
      return next;
    });
  }, [activeKey]);

  // Reported as a joined string so the parent only hears about real changes,
  // not every keystroke.
  const dirtyKeys = Object.keys(cache)
    .filter((k) => cache[k]?.text !== undefined && cache[k].text !== cache[k].original)
    .join('\n');
  useEffect(() => {
    onDirtyChange?.(dirtyKeys ? dirtyKeys.split('\n') : []);
  }, [dirtyKeys, onDirtyChange]);

  // Drop state for tabs the parent closed, so a reopened file loads fresh.
  useEffect(() => {
    const open = new Set(files.map((f) => f.key));
    setCache((prev) => {
      const gone = Object.keys(prev).filter((k) => !open.has(k));
      if (!gone.length) return prev;
      const next = { ...prev };
      for (const k of gone) delete next[k];
      return next;
    });
  }, [files]);

  const requestClose = (key) => {
    const c = cache[key];
    if (c && c.text !== undefined && c.text !== c.original) {
      if (!window.confirm('Discard unsaved changes?')) return;
    }
    onClose(key);
  };

  const extensions = useMemo(() => {
    const editorMetrics = buildEditorMetrics(typography);
    const base = [
      editorMetrics,
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => (saveRef.current(), true) },
      ]),
    ];
    if (!active) return base;
    return [...base, ...languageFor(active.name)];
  }, [active, typography]);

  return (
    <div className="h-full flex flex-col bg-background text-foreground">
      {active?.kind === 'browser' && (
        <BrowserPane
          key={active.key}
          tabKey={active.key}
          initialUrl={active.url}
          state={browserState?.[active.key] || {}}
          onStateChange={onBrowserStateChange}
          onClose={onClose}
        />
      )}

      {active && active.kind !== 'browser' && (
        <>
          {/* Header actions */}
          <div className="flex items-center justify-between h-8 px-3 border-b border-border flex-shrink-0">
            <span className="text-[11px] font-medium tracking-[0.01em] text-muted-foreground truncate">
              {active.name}
              {isDiff ? ' — diff' : dirty ? ' •' : ''}
            </span>
            <div className="flex items-center gap-0.5">
              {isDiff ? (
                <Tooltip label="Reload diff">
                  <button
                    className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
                    aria-label="Reload diff"
                    onClick={reloadActive}
                  >
                    <RefreshCw size={14} />
                  </button>
                </Tooltip>
              ) : (
                <Tooltip label="Save" keys={['⌘', 'S']}>
                  <button
                    className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent"
                    aria-label="Save"
                    disabled={!dirty || saving}
                    onClick={save}
                  >
                    <Save size={14} />
                  </button>
                </Tooltip>
              )}
              <Tooltip label="Copy contents">
                <button
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
                  aria-label="Copy contents"
                  onClick={() => {
                    const text = isDiff
                      ? data?.diff?.modified
                      : editable
                        ? data.text
                        : null;
                    if (text != null) navigator.clipboard?.writeText(text);
                  }}
                >
                  <Copy size={14} />
                </button>
              </Tooltip>
              <Tooltip label="Open in default app">
                <button
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
                  aria-label="Open in default app"
                  onClick={() => window.electronAPI.openFilePath(active.path)}
                >
                  <ExternalLink size={14} />
                </button>
              </Tooltip>
              <Tooltip label="Close">
                <button
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
                  aria-label="Close"
                  onClick={() => requestClose(active.key)}
                >
                  <X size={14} />
                </button>
              </Tooltip>
            </div>
          </div>

          {/* Editor / diff / status */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {!data ? (
              <div className="p-4 text-muted-foreground text-[13px]">Loading…</div>
            ) : data.tooLarge ? (
              <div className="p-4 text-muted-foreground text-[13px]">
                File is too large to {isDiff ? 'diff' : 'edit'}
                {data.size ? ` (${Math.round(data.size / 1024)} KB)` : ''}.
              </div>
            ) : data.binary ? (
              <div className="p-4 text-muted-foreground text-[13px]">
                Binary file — cannot {isDiff ? 'diff' : 'edit'}.
              </div>
            ) : data.error ? (
              <div className="p-4 text-destructive text-[13px]">{data.error}</div>
            ) : isDiff ? (
              <DiffView
                name={active.name}
                original={data.diff.original}
                modified={data.diff.modified}
                className="flex-1 min-h-0"
              />
            ) : (
              <>
                {data.error && (
                  <div className="px-3 py-1 text-[11px] text-destructive border-b border-border">
                    {data.error}
                  </div>
                )}
                <CodeMirror
                  value={data.text}
                  height="100%"
                  theme={theme}
                  extensions={extensions}
                  onChange={onChange}
                  onCreateEditor={(view) => (viewRef.current = view)}
                  className="flex-1 min-h-0"
                  basicSetup={{ tabSize: 2 }}
                />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
