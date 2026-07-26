import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { keymap, EditorView } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import { buildEditorMetrics, editorThemes } from '../lib/editorTheme';
import { editorTypography, onTypographyChange } from '../lib/typography';
import { onThemeChange, themeName } from '../lib/theme';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { Copy, ExternalLink, Save, X, GitCompare, RefreshCw, Globe } from 'lucide-react';
import { FileGlyph } from '../lib/fileIcons';
import { Tooltip } from './ui';
import BrowserPane from './browser/BrowserPane';

// Pick CodeMirror language extensions from a file's extension.
function languageFor(name) {
  const base = name.toLowerCase();
  if (base === 'dockerfile') return [];
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return [javascript({ jsx: true })];
    case 'ts':
      return [javascript({ typescript: true })];
    case 'tsx':
      return [javascript({ jsx: true, typescript: true })];
    case 'json':
      return [json()];
    case 'css':
    case 'scss':
    case 'less':
      return [css()];
    case 'html':
    case 'htm':
    case 'xml':
    case 'vue':
    case 'svg':
      return [html()];
    case 'php':
      return [php()];
    case 'py':
      return [python()];
    case 'md':
    case 'markdown':
      return [markdown()];
    case 'yml':
    case 'yaml':
      return [yaml()];
    case 'sql':
      return [sql()];
    default:
      return [];
  }
}

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

// Editable, syntax-highlighted code editor (CodeMirror 6) with tabs. Handles
// three tab kinds: 'file' (editable, dirty tracking + save), 'diff' (a
// read-only unified diff against a git revision), and 'browser' (an in-app
// <webview> preview, which renders its own chrome). Tabs are keyed by `key`
// (a path for files, `diff:<source>:<rel>` for diffs, `browser:<n>` for
// browsers) so a file and its diff can be open at once. `files` is the open-tab
// list owned by the parent.
export default function CodeEditor({
  rootPath,
  files,
  activeKey,
  onSelect,
  onClose,
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
    if (isDiff && data?.diff) {
      return [
        editorMetrics,
        unifiedMergeView({ original: data.diff.original, mergeControls: false }),
        ...languageFor(active.name),
      ];
    }
    return [...base, ...languageFor(active.name)];
  }, [active, isDiff, data, typography]);

  return (
    <div className="h-full flex flex-col bg-background text-foreground">
      {/* Tab strip — pane chrome sits on `tertiary`, content on `background` */}
      <div className="flex items-stretch h-9 bg-tertiary border-b border-border overflow-x-auto flex-shrink-0">
        {files.map((f) => {
          const isActive = f.key === activeKey;
          const tabIsDiff = f.kind === 'diff';
          const tabIsBrowser = f.kind === 'browser';
          const isDirty =
            !tabIsDiff &&
            !tabIsBrowser &&
            cache[f.key]?.text !== undefined &&
            cache[f.key].text !== cache[f.key].original;
          return (
            <div
              key={f.key}
              onClick={() => onSelect(f.key)}
              title={
                tabIsBrowser
                  ? browserState?.[f.key]?.url || 'Browser'
                  : tabIsDiff
                    ? `${f.rel} — diff (${f.source})`
                    : f.path
              }
              className={`group flex items-center gap-2 pl-3 pr-2 text-[13px] cursor-pointer border-r border-border whitespace-nowrap transition-colors ${
                isActive
                  ? 'bg-background text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tabIsBrowser ? (
                <Globe size={13} className="flex-shrink-0 text-muted-foreground" />
              ) : (
                <FileGlyph name={f.name} size={13} className="flex-shrink-0" />
              )}
              <span className="truncate max-w-[160px]">
                {tabIsBrowser ? browserState?.[f.key]?.title || f.name : f.name}
              </span>
              {tabIsDiff && (
                <GitCompare size={11} className="flex-shrink-0 text-muted-foreground" />
              )}
              {isDirty ? (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-highlight group-hover:hidden flex-shrink-0"
                  title="Unsaved changes"
                />
              ) : null}
              <Tooltip label="Close tab">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    requestClose(f.key);
                  }}
                  aria-label="Close tab"
                  className={`p-0.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent ${
                    isDirty ? 'hidden group-hover:block' : ''
                  }`}
                >
                  <X size={13} />
                </button>
              </Tooltip>
            </div>
          );
        })}
      </div>

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
              <CodeMirror
                value={data.diff.modified}
                height="100%"
                theme={theme}
                extensions={extensions}
                editable={false}
                className="flex-1 min-h-0"
                basicSetup={{ tabSize: 2 }}
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
